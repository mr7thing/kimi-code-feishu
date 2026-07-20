/**
 * 桥核心：编排 飞书通道 ⇄ Kimi 运行器 ⇄ hook 事件。
 *
 * 三条主链路：
 * 1. 审批：hook PreToolUse → handlePreToolUse → 飞书卡片 → 等点击 → 返回 allow/deny
 * 2. 进度：hook 观察事件 → handleHookEvent → 飞书进度消息（滚动更新）
 * 3. 指令：飞书消息 → onFeishuMessage → headless kimi 任务 → 流式回推结果
 */
import type { Approval, ApprovalManager as AM } from './approvals.js';
import { ApprovalManager } from './approvals.js';
import type { Channel } from './channel.js';
import type { Config } from './config.js';
import crypto from 'node:crypto';
import { Dashboard, serveDashboard, type DashboardServer } from './dashboard.js';
import { KimiRunner, type ChatTask } from './kimiRunner.js';
import type { StateStore } from './state.js';
import type { StreamEvent } from './streamParser.js';
import { startCloudflaredTunnel, type TunnelHandle } from './tunnel.js';
import { captureTmux, listKimiSessions, sendTmuxText } from './tmux.js';

const MAX_TEXT = 3500;         // 飞书单条文本消息的保守上限
const PROGRESS_INTERVAL = 1500; // 进度消息最小更新间隔（毫秒）

export function truncate(s: string, n = MAX_TEXT): string {
  return s.length <= n ? s : s.slice(0, n - 20) + '\n…（内容过长已截断）';
}

export function toolInputSummary(payload: Record<string, unknown>, limit = 1200): string {
  const ti = payload.tool_input;
  if (ti && typeof ti === 'object' && !Array.isArray(ti)) {
    const rec = ti as Record<string, unknown>;
    for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url']) {
      if (typeof rec[key] === 'string') return truncate(rec[key] as string, limit);
    }
  }
  try {
    return truncate(JSON.stringify(ti, null, 1), limit);
  } catch {
    return truncate(String(ti), limit);
  }
}

/** 审批决定的展示文案（卡片回调内联返回与 resolve 更新共用，防止漂移）。 */
function decidedTextFor(decision: string): string | null {
  if (decision === 'allow') return '✅ 已批准';
  if (decision === 'allow_session') return '✅ 已批准（本会话同类自动放行）';
  if (decision === 'deny') return '❌ 已拒绝';
  return null;
}

type HookResponse = { decision: string; reason?: string };

interface ProgressState {
  messageId?: string;
  lines: string[];
  lastUpdate: number;
  chatId: string;
}

export class Bridge {
  approvals = new ApprovalManager();
  runner: KimiRunner;
  channel!: Channel;
  private progress = new Map<string, ProgressState>();
  private taskMessages = new Map<string, string>();
  private taskMsgPending = new Map<string, Promise<string | undefined>>();
  private taskStatus = new Map<string, { text?: string; tool?: string; lastPush: number }>();
  /** dashboard 事件总线（始终存在）；HTTP 服务按需开启 */
  private dashboardBus = new Dashboard();
  private dashServer?: DashboardServer;
  private dashToken?: string;
  private dashPublic?: string;
  private tunnel?: TunnelHandle;
  private dashChat?: string;

  constructor(
    private cfg: Config,
    private state: StateStore,
    channel?: Channel,
  ) {
    if (channel) this.channel = channel;
    this.runner = new KimiRunner(cfg, state, this, (chatId, kind, text) => this.dashboardBus.publish(chatId, kind, text));
  }

  // ================================================================
  // Dashboard 生命周期：飞书 /dashboard 命令按需开启，闲置自动关闭
  // ================================================================
  /** 开启 dashboard（幂等，已开则直接返回当前链接）。返回带 token 的完整 URL。 */
  async openDashboard(chatId: string): Promise<string> {
    this.dashChat = chatId;
    if (this.dashServer) return this.dashboardUrl()!;

    const token = crypto.randomBytes(8).toString('hex');
    this.dashServer = await serveDashboard(this.dashboardBus, this.cfg.dashboardHost, this.cfg.dashboardPort, token, {
      idlePageMs: this.cfg.dashboardIdleTimeoutPage * 1000,
      idleNopageMs: this.cfg.dashboardIdleTimeoutNopage * 1000,
      onClose: (reason) => void this.onDashboardClosed(reason),
    });
    this.dashToken = token;

    // 公网地址：优先固定配置（named tunnel），否则临时拉 quick tunnel，失败回退局域网
    if (this.cfg.dashboardPublicUrl) {
      this.dashPublic = this.cfg.dashboardPublicUrl.replace(/\/+$/, '');
    } else {
      this.tunnel = (await startCloudflaredTunnel(this.cfg.cloudflaredBin, this.cfg.dashboardPort)) ?? undefined;
      if (!this.tunnel) console.warn('[bridge] cloudflared 不可用，dashboard 只有局域网链接');
    }
    return this.dashboardUrl()!;
  }

  /** 当前 dashboard URL；未开启返回 null。 */
  dashboardUrl(): string | null {
    if (!this.dashServer || !this.dashToken) return null;
    const base = this.dashPublic ?? this.tunnel?.url ?? `http://${this.cfg.dashboardHost}:${this.cfg.dashboardPort}`;
    return `${base}?token=${this.dashToken}`;
  }

  /** 主动关闭（/dashboard off）。返回是否真有在跑。 */
  async closeDashboard(reason: string): Promise<boolean> {
    if (!this.dashServer) return false;
    await this.dashServer.close(reason);
    return true;
  }

  /** 服务端任何路径关闭后的统一收尾：杀隧道 + 通知开启者。 */
  private async onDashboardClosed(reason: string): Promise<void> {
    this.dashServer = undefined;
    this.dashToken = undefined;
    this.dashPublic = undefined;
    if (this.tunnel) {
      this.tunnel.proc.kill('SIGTERM');
      this.tunnel = undefined;
    }
    const chat = this.dashChat ?? this.state.defaultNotifyChat();
    if (chat) {
      try {
        await this.channel.sendText(chat, `📊 Dashboard 已关闭（${reason}）`);
      } catch {
        /* 通知失败不影响关闭 */
      }
    }
  }

  // ================================================================
  // 链路 1：审批
  // ================================================================
  async handlePreToolUse(payload: Record<string, unknown>): Promise<HookResponse> {
    const tool = String(payload.tool_name ?? 'unknown');
    const sessionId = String(payload.session_id ?? '');
    const summary = toolInputSummary(payload);

    // 1) 只读工具直接放行
    if (this.cfg.autoAllowTools.includes(tool)) return { decision: 'allow', reason: 'auto_allow_tool' };

    // 2) 危险模式直接拒绝
    for (const pat of this.cfg.autoDenyPatterns) {
      try {
        if (new RegExp(pat).test(summary)) return { decision: 'deny', reason: `命中自动拒绝规则: ${pat}` };
      } catch {
        /* 忽略坏正则 */
      }
    }

    // 3) 用户之前点过"本会话允许"
    if (this.approvals.isSessionAllowed(sessionId, tool)) return { decision: 'allow', reason: 'session_allowed' };

    // 4) 找通知目标聊天
    const chatId = this.routeChat(payload);
    if (!chatId) {
      console.warn(`[bridge] 无可用飞书会话，按 on_timeout=${this.cfg.onTimeout} 处理 ${tool}`);
      return this.timeoutDecision('尚未有任何飞书聊天与桥绑定（先给机器人发条消息）');
    }

    // 5) 发卡片并等待
    const ap = this.approvals.create(payload);
    ap.chatId = chatId;
    try {
      ap.messageId = await this.channel.sendCard(chatId, this.approvalCard(ap, tool, summary, payload));
    } catch (err) {
      console.error('[bridge] 发送审批卡片失败:', err);
    }
    if (!ap.messageId) return this.timeoutDecision('审批卡片发送失败');
    this.dashboardBus.publish(chatId, 'progress', `🔐 审批请求：${tool} — ${truncate(summary, 200)}`);

    const result = await this.approvals.wait(ap, this.cfg.approvalTimeout * 1000);
    return this.resolve(ap, result.decision, result.operator);
  }

  private async resolve(ap: Approval, decision: string | null, operator?: string): Promise<HookResponse> {
    let resp: HookResponse;
    let decidedText: string;
    if (decision === null) {
      resp = this.timeoutDecision(`${this.cfg.approvalTimeout}s 未操作`);
      decidedText = '⏰ 超时自动' + (resp.decision === 'deny' ? '拒绝' : '放行');
    } else if (decision === 'allow' || decision === 'allow_session') {
      resp = { decision: 'allow', reason: `approved by ${operator}` };
      decidedText = decidedTextFor(decision)!;
    } else {
      resp = { decision: 'deny', reason: `用户在飞书上拒绝了 ${ap.toolName}` };
      decidedText = decidedTextFor(decision)!;
    }
    if (ap.messageId) {
      try {
        await this.channel.updateCard(ap.messageId, this.approvalResultCard(ap, decidedText, operator));
      } catch (err) {
        console.error('[bridge] 更新审批卡片失败:', err);
      }
    }
    if (ap.chatId) this.dashboardBus.publish(ap.chatId, 'progress', `${decidedText}：${ap.toolName}${operator ? `（${operator}）` : ''}`);
    return resp;
  }

  private timeoutDecision(reason: string): HookResponse {
    if (this.cfg.onTimeout === 'allow') return { decision: 'allow', reason };
    return { decision: 'deny', reason: `飞书审批超时：${reason}` };
  }

  /** dashboard 开启中 → 卡片底部附当前链接；未开启 → 提示 /dashboard 命令。 */
  private dashNote(): unknown[] {
    if (!this.cfg.dashboardEnabled) return [];
    const url = this.dashboardUrl();
    if (url) return [{ tag: 'note', elements: [{ tag: 'lark_md', content: `[📊 查看实时输出](${url})` }] }];
    return [{ tag: 'note', elements: [{ tag: 'plain_text', content: '📊 发 /dashboard 开启实时输出' }] }];
  }

  // ---------------- 审批卡片 ----------------
  private approvalCard(req: Approval, tool: string, summary: string, payload: Record<string, unknown>): Record<string, unknown> {
    const cwd = String(payload.cwd ?? '');
    const sid = String(payload.session_id ?? '').slice(0, 12);
    const timeoutText = this.cfg.onTimeout === 'deny' ? '拒绝' : '放行';
    const btn = (text: string, type: string, d: string) => ({
      tag: 'button',
      text: { tag: 'plain_text', content: text },
      type,
      value: { kcf: 'approval', req_id: req.reqId, d },
    });
    return {
      config: { wide_screen_mode: true, update_multi: true },
      header: { template: 'orange', title: { tag: 'plain_text', content: '🔐 Kimi Code 请求操作权限' } },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: `**工具**：\`${tool}\`\n**目录**：${cwd}\n**会话**：${sid}` } },
        { tag: 'div', text: { tag: 'lark_md', content: '```\n' + summary + '\n```' } },
        {
          tag: 'action',
          actions: [
            btn('✅ 批准', 'primary', 'allow'),
            btn('🔁 本会话允许', 'default', 'allow_session'),
            btn('❌ 拒绝', 'danger', 'deny'),
          ],
        },
        { tag: 'note', elements: [{ tag: 'plain_text', content: `${this.cfg.approvalTimeout} 秒未操作将自动${timeoutText}` }] },
        ...this.dashNote(),
      ],
    };
  }

  private approvalResultCard(ap: Approval, decidedText: string, operator?: string): Record<string, unknown> {
    const ok = decidedText.startsWith('✅');
    const summary = toolInputSummary(ap.payload);
    return {
      config: { wide_screen_mode: true, update_multi: true },
      header: { template: ok ? 'green' : 'red', title: { tag: 'plain_text', content: `🔐 权限请求 ${decidedText}` } },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: `**工具**：\`${ap.toolName}\`\n**操作者**：${operator ?? '-'}\n\`\`\`\n${summary}\n\`\`\`` } },
      ],
    };
  }

  // ================================================================
  // 链路 2：进度事件（观察型 hook）
  // ================================================================
  async handleHookEvent(event: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.cfg.progressEnabled) return;
    const sessionId = String(payload.session_id ?? '');
    const cwd = payload.cwd as string | undefined;

    // 学习 session_id → chat 路由
    const chatId = this.routeChat(payload);
    if (sessionId && chatId) this.state.bindSession(sessionId, chatId);
    if (!chatId) return;

    // 桥自己拉起的任务已由 stream-json 覆盖进度，避免重复刷屏
    if (this.runner.isBusy(chatId)) return;
    if (!this.cfg.forwardTerminalSessions) return;

    const tool = String(payload.tool_name ?? '');
    const key = sessionId || cwd || 'default';
    const ev = event.toLowerCase();

    if (ev === 'posttooluse') {
      this.progressLine(key, chatId, `🔧 \`${tool}\` ✅`);
    } else if (ev === 'posttoolusefailure') {
      this.progressLine(key, chatId, `🔧 \`${tool}\` ❌ ${truncate(String(payload.error ?? ''), 120)}`);
    } else if (ev === 'subagentstart') {
      this.progressLine(key, chatId, `🧩 子任务开始: ${payload.agent_name ?? ''}`);
    } else if (ev === 'subagentstop') {
      this.progressLine(key, chatId, `🧩 子任务完成: ${payload.agent_name ?? ''}`);
    } else if (ev === 'stop') {
      await this.progressFlush(key, true);
      await this.channel.sendText(chatId, '✅ 本轮任务结束');
      this.dashboardBus.publish(chatId, 'progress', '✅ 本轮任务结束');
    } else if (ev === 'stopfailure') {
      await this.progressFlush(key, true);
      await this.channel.sendText(chatId, `⚠️ 本轮出错结束：${truncate(String(payload.error_message ?? ''), 200)}`);
      this.dashboardBus.publish(chatId, 'progress', `⚠️ 本轮出错结束：${truncate(String(payload.error_message ?? ''), 200)}`);
    } else if (ev === 'interrupt') {
      await this.progressFlush(key, true);
      await this.channel.sendText(chatId, '⛔ 本轮被用户中断');
      this.dashboardBus.publish(chatId, 'progress', '⛔ 本轮被用户中断');
    } else if (ev === 'sessionstart') {
      await this.channel.sendText(chatId, `🚀 新会话开始（${payload.source ?? ''}）：${sessionId.slice(0, 12)}`);
      this.dashboardBus.publish(chatId, 'progress', `🚀 新会话开始：${sessionId.slice(0, 12)}`);
    }
  }

  private progressLine(key: string, chatId: string, line: string): void {
    this.dashboardBus.publish(chatId, 'progress', line);
    let p = this.progress.get(key);
    if (!p) {
      p = { lines: [], lastUpdate: 0, chatId };
      this.progress.set(key, p);
      void this.channel.sendText(chatId, '⏳ Kimi Code 执行中…').then((mid) => {
        p!.messageId = mid;
      });
    }
    p.lines.push(line);
    if (p.lines.length > 12) p.lines.shift();
    const now = Date.now();
    if (now - p.lastUpdate >= PROGRESS_INTERVAL && p.messageId) {
      p.lastUpdate = now;
      void this.channel.updateText(p.messageId, this.progressRender(p));
    }
  }

  private async progressFlush(key: string, done: boolean): Promise<void> {
    const p = this.progress.get(key);
    this.progress.delete(key);
    if (p?.messageId) await this.channel.updateText(p.messageId, this.progressRender(p, done));
  }

  private progressRender(p: ProgressState, done = false): string {
    const head = done ? '✅ 执行完成' : '⏳ Kimi Code 执行中…';
    return truncate(head + '\n' + p.lines.join('\n'));
  }

  // ================================================================
  // 链路 3：飞书消息 → Kimi 任务
  // ================================================================
  async onFeishuMessage(chatId: string, openId: string, text: string): Promise<void> {
    this.state.touchChat(chatId);

    // /id 对所有人开放（方便首次配置白名单）
    if (text.trim() === '/id') {
      await this.channel.sendText(chatId, `你的 open_id：\n\`${openId}\``);
      return;
    }

    if (!this.cfg.allowedUserIds.includes(openId)) {
      await this.channel.sendText(chatId, '⛔ 未授权用户。请先把你的 open_id 加入配置 allowed_user_ids（发送 /id 查看）。');
      return;
    }

    const [cmdRaw, ...rest] = text.trim().split(/\s+/);
    const cmd = cmdRaw.toLowerCase();
    const arg = rest.join(' ');

    if (cmd === '/bind') {
      if (!arg) {
        await this.channel.sendText(chatId, '用法：/bind /绝对/路径/项目目录');
        return;
      }
      this.state.setWorkDir(chatId, arg);
      this.state.setHasSession(chatId, false);
      await this.channel.sendText(chatId, `📁 已绑定工作目录：\n\`${arg}\`\n（会话已重置，下一条消息开启新会话）`);
    } else if (cmd === '/new') {
      this.state.setHasSession(chatId, false);
      await this.channel.sendText(chatId, '🆗 已重置，下一条消息将开启新会话');
    } else if (cmd === '/stop') {
      await this.channel.sendText(chatId, this.runner.stop(chatId) ? '🛑 已终止当前任务' : '当前没有正在运行的任务');
    } else if (cmd === '/status') {
      const busy = this.runner.isBusy(chatId);
      const wd = this.state.getWorkDir(chatId, this.cfg.workDir);
      await this.channel.sendText(
        chatId,
        `📊 状态\n任务：${busy ? '🏃 运行中' : '💤 空闲'}\n目录：\`${wd}\`\n` +
        `会话：${this.state.hasSession(chatId) ? '续接模式' : '新会话'}\n待审批：${this.approvals.pendingCount()} 条`,
      );
    } else if (cmd === '/dashboard') {
      if (!this.cfg.dashboardEnabled) {
        await this.channel.sendText(chatId, 'Dashboard 已在配置中禁用（dashboard_enabled = false）');
        return;
      }
      if (arg === 'off') {
        // closeDashboard 的 onClose 回调会统一发关闭通知，这里只处理"未开启"的情况
        if (!(await this.closeDashboard('飞书命令关闭'))) {
          await this.channel.sendText(chatId, 'Dashboard 当前未开启');
        }
        return;
      }
      await this.channel.sendText(chatId, '⏳ 正在开启 Dashboard（拉起隧道，约几秒）…');
      try {
        const url = await this.openDashboard(chatId);
        const pub = this.dashPublic ?? this.tunnel?.url;
        await this.channel.sendText(
          chatId,
          `📊 Dashboard 已开启：\n${url}\n页面只读，可手动关闭；无人观看约 ${Math.round(this.cfg.dashboardIdleTimeoutNopage / 60)} 分钟、停看 ${Math.round(this.cfg.dashboardIdleTimeoutPage / 60)} 分钟自动关闭` +
            (pub ? '' : '\n⚠️ cloudflared 不可用，此为局域网链接（公网访问需安装 cloudflared）'),
        );
      } catch (err) {
        await this.channel.sendText(chatId, `❌ 开启 Dashboard 失败：${err instanceof Error ? err.message : err}`);
      }
    } else if (cmd === '/a') {
      const sessions = await listKimiSessions();
      if (arg) {
        const n = Number(arg);
        if (!Number.isInteger(n) || n < 1 || n > sessions.length) {
          await this.channel.sendText(chatId, '序号无效，发 /a 查看列表');
          return;
        }
        const s = sessions[n - 1];
        this.state.setAttach(chatId, s.target);
        await this.channel.sendText(chatId, `🔗 已绑定终端会话：${s.name}\n目录：\`${s.cwd}\`\n/t <文本> 注入回车，/s 查看画面，/a 重新选择`);
        return;
      }
      if (!sessions.length) {
        await this.channel.sendText(chatId, '没有发现 tmux 里的 kimi 会话。\n先在终端用 `kimi-code-feishu tmux` 启动（或在任意 tmux 里跑 kimi）');
        return;
      }
      const cur = this.state.getAttach(chatId);
      await this.channel.sendText(
        chatId,
        '🖥 终端会话（/a 序号 绑定）：\n' +
          sessions.map((s, i) => `${i + 1}. ${s.name}  \`${s.cwd}\`${s.target === cur ? '  ← 当前绑定' : ''}`).join('\n'),
      );
    } else if (cmd === '/t') {
      const target = this.state.getAttach(chatId);
      if (!target) {
        await this.channel.sendText(chatId, '先用 /a 绑定一个终端会话');
        return;
      }
      try {
        await sendTmuxText(target, arg);
        this.dashboardBus.publish(chatId, 'progress', `⌨️ /t 注入：${truncate(arg || '(回车)', 120)}`);
      } catch {
        await this.channel.sendText(chatId, '❌ 注入失败（会话可能已退出），/a 重新选择');
      }
    } else if (cmd === '/s') {
      const target = this.state.getAttach(chatId);
      if (!target) {
        await this.channel.sendText(chatId, '先用 /a 绑定一个终端会话');
        return;
      }
      try {
        const shot = await captureTmux(target, 30);
        await this.channel.sendText(chatId, '🖥 当前画面：\n```\n' + truncate(shot.trimEnd() || '（空）', 2600) + '\n```');
      } catch {
        await this.channel.sendText(chatId, '❌ 读取画面失败（会话可能已退出），/a 重新选择');
      }
    } else if (cmd === '/help') {
      await this.channel.sendText(chatId, HELP_TEXT);
    } else {
      if (this.runner.isBusy(chatId)) {
        await this.channel.sendText(chatId, '⏳ 上一个任务还在执行，先 /stop 或等它完成');
        return;
      }
      try {
        const ok = this.runner.submit(chatId, text);
        if (ok) await this.channel.sendText(chatId, `🚀 已开工：${truncate(text, 80)}`);
      } catch {
        await this.channel.sendText(chatId, `❌ 找不到 kimi 命令（kimi_bin=${this.cfg.kimiBin}），请检查配置`);
      }
    }
  }

  // ---------------- 运行器回调 ----------------
  onTaskStream(chatId: string, event: StreamEvent): void {
    // 记录最新状态（assistant 说明文本 + 当前工具），占位消息就绪前到的事件不再丢弃
    const st = this.taskStatus.get(chatId) ?? { lastPush: 0 };
    this.taskStatus.set(chatId, st);
    if (event.kind === 'text' && event.text?.trim()) st.text = event.text.trim();
    else if (event.kind === 'tool_call') {
      st.tool = event.tool;
      if (event.text?.trim()) st.text = event.text.trim();
    }

    const mid = this.taskMessages.get(chatId);
    if (!mid) {
      // 占位消息只发一次；就绪后立即渲染当前状态
      if (!this.taskMsgPending.has(chatId)) {
        const p = this.channel.sendText(chatId, '⏳ Kimi Code 执行中…');
        this.taskMsgPending.set(chatId, p);
        void p.then((m) => {
          this.taskMsgPending.delete(chatId);
          if (m) {
            this.taskMessages.set(chatId, m);
            this.pushTaskStatus(chatId, m, true);
          }
        });
      }
      return;
    }
    this.pushTaskStatus(chatId, mid);
  }

  /** 把当前任务状态渲染到进度消息（节流，避免触发飞书更新频控）。 */
  private pushTaskStatus(chatId: string, mid: string, force = false): void {
    const st = this.taskStatus.get(chatId);
    if (!st) return;
    const now = Date.now();
    if (!force && now - st.lastPush < PROGRESS_INTERVAL) return;
    st.lastPush = now;
    const lines = ['⏳ Kimi Code 执行中…'];
    if (st.text) lines.push(`💬 ${truncate(st.text, 300)}`);
    if (st.tool) lines.push(`🔧 调用工具：\`${st.tool}\``);
    void this.channel.updateText(mid, lines.join('\n'));
  }

  async onTaskDone(chatId: string, task: ChatTask, exitCode: number | null, stderrTail: string): Promise<void> {
    // 占位消息可能在任务结束后才送达，送达后清掉映射避免下个任务复用旧消息
    const pend = this.taskMsgPending.get(chatId);
    if (pend) void pend.finally(() => this.taskMessages.delete(chatId));
    this.taskMsgPending.delete(chatId);
    this.taskStatus.delete(chatId);
    this.taskMessages.delete(chatId);
    let result = task.textParts.join('').trim();
    if (!result) result = task.rawTail.join('\n').trim();
    let body: string;
    if (exitCode !== 0) {
      body = `⚠️ 任务异常结束（exit=${exitCode}）\n` + truncate(result || stderrTail || '(无输出)');
    } else {
      body = '✅ 任务完成\n' + truncate(result || '(无文本输出)');
    }
    await this.channel.sendText(chatId, body);
  }

  // ---------------- 卡片回调 ----------------
  /**
   * 返回结果卡片 JSON（或 null）：卡片更新内联在回调响应里返回，
   * 飞书才会立即在点击者的所有设备上同步更新卡片（PATCH API 不保证跨端同步）。
   */
  onCardAction(value: Record<string, unknown>, operator: string): Record<string, unknown> | null {
    if (String(value.kcf ?? '') !== 'approval') return null;
    if (!this.cfg.allowedUserIds.includes(operator)) {
      console.warn(`[bridge] 非白名单用户 ${operator} 尝试操作审批卡片`);
      return null;
    }
    const decision = String(value.d ?? '') as 'allow' | 'deny' | 'allow_session';
    const ap = this.approvals.decide(String(value.req_id ?? ''), decision, operator);
    if (!ap) {
      console.info(`[bridge] 审批 ${value.req_id} 已处理或不存在（可能超时/重复点击）`);
      return null;
    }
    return this.approvalResultCard(ap, decidedTextFor(decision) ?? '❌ 已拒绝', operator);
  }

  // ---------------- 路由 ----------------
  private routeChat(payload: Record<string, unknown>): string | null {
    return (
      this.state.chatForSession(String(payload.session_id ?? '')) ??
      this.state.chatForCwd(payload.cwd as string | undefined) ??
      this.state.defaultNotifyChat()
    );
  }
}

export const HELP_TEXT = `🤖 kimi-code-feishu 使用指南

直接发消息 = 让 Kimi Code 执行任务（流式回报进度，危险操作会弹审批卡片）

命令：
/bind <目录>  绑定本项目的工作目录
/new          开启新会话（默认会续接上次会话）
/stop         终止正在执行的任务
/status       查看当前状态
/dashboard    临时开启实时输出面板（/dashboard off 关闭）
/a            列出终端 tmux 会话；/a 序号 绑定到本聊天
/t <文本>     向绑定会话注入文本+回车（空文本=只回车）
/s            查看绑定会话当前画面
/id           查看你的 open_id
/help         本帮助

提示：终端里手动运行的 kimi 会话也会推送进度与审批到这里（可在配置里关闭）。`;
