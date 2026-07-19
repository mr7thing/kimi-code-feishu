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
import { KimiRunner, type ChatTask } from './kimiRunner.js';
import type { StateStore } from './state.js';
import type { StreamEvent } from './streamParser.js';

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

  constructor(
    private cfg: Config,
    private state: StateStore,
    channel?: Channel,
  ) {
    if (channel) this.channel = channel;
    this.runner = new KimiRunner(cfg, state, this);
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
      decidedText = '✅ 已批准' + (decision === 'allow_session' ? '（本会话同类自动放行）' : '');
    } else {
      resp = { decision: 'deny', reason: `用户在飞书上拒绝了 ${ap.toolName}` };
      decidedText = '❌ 已拒绝';
    }
    if (ap.messageId) {
      try {
        await this.channel.updateCard(ap.messageId, this.approvalResultCard(ap, decidedText, operator));
      } catch (err) {
        console.error('[bridge] 更新审批卡片失败:', err);
      }
    }
    return resp;
  }

  private timeoutDecision(reason: string): HookResponse {
    if (this.cfg.onTimeout === 'allow') return { decision: 'allow', reason };
    return { decision: 'deny', reason: `飞书审批超时：${reason}` };
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
      config: { wide_screen_mode: true },
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
      ],
    };
  }

  private approvalResultCard(ap: Approval, decidedText: string, operator?: string): Record<string, unknown> {
    const ok = decidedText.startsWith('✅');
    const summary = toolInputSummary(ap.payload);
    return {
      config: { wide_screen_mode: true },
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
    } else if (ev === 'stopfailure') {
      await this.progressFlush(key, true);
      await this.channel.sendText(chatId, `⚠️ 本轮出错结束：${truncate(String(payload.error_message ?? ''), 200)}`);
    } else if (ev === 'sessionstart') {
      await this.channel.sendText(chatId, `🚀 新会话开始（${payload.source ?? ''}）：${sessionId.slice(0, 12)}`);
    }
  }

  private progressLine(key: string, chatId: string, line: string): void {
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
    const mid = this.taskMessages.get(chatId);
    if (!mid) {
      void this.channel.sendText(chatId, '⏳ Kimi Code 执行中…').then((m) => {
        if (m) this.taskMessages.set(chatId, m);
      });
      return;
    }
    if (event.kind === 'tool_call') {
      void this.channel.updateText(mid, `⏳ 执行中…\n🔧 调用工具：\`${event.tool}\``);
    }
  }

  async onTaskDone(chatId: string, task: ChatTask, exitCode: number | null, stderrTail: string): Promise<void> {
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
  onCardAction(value: Record<string, unknown>, operator: string): void {
    if (value.kcf !== 'approval') return;
    if (!this.cfg.allowedUserIds.includes(operator)) {
      console.warn(`[bridge] 非白名单用户 ${operator} 尝试操作审批卡片`);
      return;
    }
    const ap = this.approvals.decide(String(value.req_id ?? ''), String(value.d ?? '') as 'allow' | 'deny' | 'allow_session', operator);
    if (!ap) console.info(`[bridge] 审批 ${value.req_id} 已处理或不存在（可能超时/重复点击）`);
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
/id           查看你的 open_id
/help         本帮助

提示：终端里手动运行的 kimi 会话也会推送进度与审批到这里（可在配置里关闭）。`;
