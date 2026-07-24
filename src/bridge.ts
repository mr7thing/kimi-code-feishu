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
import { ChatLogger, type LogDir } from './chatLogger.js';
import { ChatSessionManager } from './chatSession.js';
import type { Config } from './config.js';
import crypto from 'node:crypto';
import path from 'node:path';
import { Dashboard, serveDashboard, type DashboardServer, type DashKind } from './dashboard.js';
import type { StateStore } from './state.js';
import { WireWatcher, renderWireEvent, type WireEvent } from './sessionWire.js';
import type { StreamEvent } from './streamParser.js';
import { startCloudflaredTunnel, type TunnelHandle } from './tunnel.js';
import { canInjectPts, captureTmux, listKimiSessions, sendPtsCtrlS, sendPtsKeys, sendPtsText, sendTmuxCtrlS, sendTmuxKeys, sendTmuxText } from './tmux.js';

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

type AuqQuestion = { question: string; header?: string; multi: boolean; options: string[] };

/** 解析 AskUserQuestion 的 tool_input；解析不出有效问题返回空数组。 */
function parseAuqQuestions(ti: unknown): AuqQuestion[] {
  if (!ti || typeof ti !== 'object' || Array.isArray(ti)) return [];
  const qs = (ti as Record<string, unknown>).questions;
  if (!Array.isArray(qs)) return [];
  const out: AuqQuestion[] = [];
  for (const q of qs.slice(0, 4)) {
    if (!q || typeof q !== 'object') continue;
    const rec = q as Record<string, unknown>;
    const question = String(rec.question ?? '').trim();
    const options = (Array.isArray(rec.options) ? rec.options : [])
      .map((o) => String((o as Record<string, unknown>)?.label ?? '').trim())
      .filter(Boolean)
      .slice(0, 4);
    if (!question || options.length < 2) continue;
    const header = String(rec.header ?? '').trim();
    out.push({ question, header: header || undefined, multi: rec.multi_select === true, options });
  }
  return out;
}

/** 进行中的提问（等用户点卡片）：reqId → 注入目标与状态。 */
interface PendingAuq {
  chatId: string;
  kind: 'tmux' | 'pts';
  tmuxTarget: string;
  messageId?: string;
  question: AuqQuestion;
  sel: Set<number>;
}

/** 解析绑定的会话目标（'tmux|%3' 或 'pts|/dev/pts/2'；旧格式裸 %N 按 tmux 处理）。 */
function parseAttach(v: string): { kind: 'tmux' | 'pts'; target: string } {
  const i = v.indexOf('|');
  if (i < 0) return { kind: 'tmux', target: v };
  return { kind: v.slice(0, i) === 'pts' ? 'pts' : 'tmux', target: v.slice(i + 1) };
}

interface ProgressState {
  messageId?: string;
  lines: string[];
  lastUpdate: number;
  chatId: string;
}

export class Bridge {
  approvals = new ApprovalManager();
  readonly chatSessions: ChatSessionManager;
  channel!: Channel;
  private progress = new Map<string, ProgressState>();
  private taskMessages = new Map<string, string>();
  private taskMsgPending = new Map<string, Promise<string | undefined>>();
  private taskStatus = new Map<string, { text?: string; tool?: string; lastPush: number }>();
  /** dashboard 事件总线（始终存在）；HTTP 服务按需开启 */
  readonly dashboardBus = new Dashboard();
  readonly logger: ChatLogger;
  private dashServer?: DashboardServer;
  private dashToken?: string;
  private dashPublic?: string;
  private tunnel?: TunnelHandle;
  private dashChat?: string;
  private auqPending = new Map<string, PendingAuq>();
  readonly wires: WireWatcher;

  constructor(
    private cfg: Config,
    private state: StateStore,
    channel?: Channel,
  ) {
    if (channel) this.channel = channel;
    this.logger = new ChatLogger(cfg.logDir || undefined);
    this.logger.fileEnabled = cfg.logEnabled;
    // 对话日志全量条目同时进 dashboard feed（实时对话显示）：sys 按原 kind，收/发标记 👤/🤖
    this.logger.onEntry = (e) => {
      const prefix = e.dir === 'in' ? '👤 ' : e.dir === 'out' ? '🤖 ' : '';
      this.dashboardBus.publish(e.chat, e.dir === 'sys' ? (e.kind as DashKind) : e.dir, prefix + e.text);
    };
    this.wires = new WireWatcher(cfg.kimiSessionsDir || undefined);
    // 飞书聊天 = 桥托管的常驻 tmux 交互会话（编号 0）；wire 转录驱动进度与结果
    this.chatSessions = new ChatSessionManager(state, this.wires, {
      onStream: (chatId, ev) => this.onChatStream(chatId, ev),
      onTurnDone: (chatId, text, tools) => void this.onChatTurnDone(chatId, text, tools),
      onError: (chatId, message) => void this.channel.sendText(chatId, `❌ ${message}`),
    }, cfg.kimiBin, cfg.kimiSessionsDir || undefined);
  }

  /** 日志（onEntry 进 dashboard；fileEnabled 时落盘；绝不抛错影响主流程）。 */
  log(chatId: string, dir: LogDir, kind: string, text: string): void {
    this.logger.log(chatId, dir, kind, text);
  }

  /** 总线事件统一出口：日志（钩子转发 dashboard）。 */
  private publish(chatId: string, kind: Parameters<Dashboard['publish']>[1], text: string): void {
    this.log(chatId, 'sys', kind, text);
  }

  // ================================================================
  // Dashboard 生命周期：飞书 /dashboard 命令按需开启，闲置自动关闭
  // ================================================================
  /** 开启 dashboard（幂等；opts.tunnel=true 时才拉 cloudflared 公网隧道，默认只开本地）。 */
  async openDashboard(chatId: string, opts: { tunnel?: boolean } = {}): Promise<string> {
    this.dashChat = chatId;
    if (!this.dashServer) {
      const token = crypto.randomBytes(8).toString('hex');
      this.dashServer = await serveDashboard(this.dashboardBus, this.cfg.dashboardHost, this.cfg.dashboardPort, token, {
        idlePageMs: this.cfg.dashboardIdleTimeoutPage * 1000,
        idleNopageMs: this.cfg.dashboardIdleTimeoutNopage * 1000,
        onClose: (reason) => void this.onDashboardClosed(reason),
        statusProvider: () => this.dashboardStatus(),
        screenProvider: async (target) => {
          // 只允许抓 tmux 窗格（%N 格式）；其余目标拒绝
          if (!target || !/^%\d+$/.test(target)) return '';
          try {
            return await captureTmux(target, 40);
          } catch {
            return '(会话已退出或不可读)';
          }
        },
      });
      this.dashToken = token;
    }

    // 公网：显式配置（named tunnel）优先；opts.tunnel 时才临时拉 quick tunnel（server/token 不变）
    if (this.cfg.dashboardPublicUrl) {
      this.dashPublic = this.cfg.dashboardPublicUrl.replace(/\/+$/, '');
    } else if (opts.tunnel && !this.tunnel) {
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

  /** 状态面板数据：终端会话（含 tmux 画面）、进行中任务、待审批、待回答提问。 */
  private async dashboardStatus(): Promise<Record<string, unknown>> {
    const sessions = await listKimiSessions().catch(() => []);
    const withScreens = await Promise.all(
      sessions.map(async (s) => {
        let screen: string | null = null;
        if (s.kind === 'tmux') {
          try {
            screen = (await captureTmux(s.target, 12)).trimEnd() || null;
          } catch {
            screen = '(读取失败)';
          }
        }
        return { name: s.name, kind: s.kind, cwd: s.cwd, injectable: s.injectable, target: s.target, screen };
      }),
    );
    return {
      sessions: withScreens,
      tasks: this.chatSessions.activeTasks(),
      approvals: this.approvals.pendingList().map((ap) => ({
        reqId: ap.reqId,
        tool: ap.toolName,
        summary: toolInputSummary(ap.payload, 200),
        chatId: ap.chatId,
        ageSec: Math.round((Date.now() - ap.createdAt) / 1000),
      })),
      questions: [...this.auqPending.entries()].map(([reqId, p]) => ({
        reqId,
        question: p.question.question,
        options: p.question.options,
        chatId: p.chatId,
      })),
    };
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

    // 3.5) 终端会话未进审批池 → 放行回落终端原生权限（桥自己派的任务除外）
    const chatId = this.routeChat(payload);
    const isBridgeTask = chatId ? this.chatSessions.has(chatId) : false;
    if (!isBridgeTask && !this.state.inPool(String(payload.cwd ?? ''))) {
      return { decision: 'allow', reason: '会话未进审批池，回落终端原生权限' };
    }

    // 3.6) AskUserQuestion（tmux 交互会话）：放行 + 选项卡片，点击后 send-keys 真实作答
    if (tool === 'AskUserQuestion') {
      const r = await this.handleAskUserQuestion(payload, chatId);
      if (r) return r; // null = 多题/找不到 tmux 会话等，回落普通审批卡
    }

    // 4) 找通知目标聊天
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
    this.publish(chatId, 'progress', `🔐 审批请求：${tool} — ${truncate(summary, 200)}`);

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
    if (ap.chatId) this.publish(ap.chatId, 'progress', `${decidedText}：${ap.toolName}${operator ? `（${operator}）` : ''}`);
    return resp;
  }

  private timeoutDecision(reason: string): HookResponse {
    if (this.cfg.onTimeout === 'allow') return { decision: 'allow', reason };
    return { decision: 'deny', reason: `飞书审批超时：${reason}` };
  }

  // ================================================================
  // AskUserQuestion：放行 hook 让 TUI 出题，飞书选项卡片 → send-keys 作答
  // （仅支持单题；多题/找不到 tmux 会话返回 null 回落普通审批卡）
  // ================================================================
  private async handleAskUserQuestion(payload: Record<string, unknown>, chatId: string | null): Promise<HookResponse | null> {
    const questions = parseAuqQuestions(payload.tool_input);
    if (questions.length !== 1) return null;

    const cwd = String(payload.cwd ?? '');
    const sess = (await listKimiSessions()).find((s) => {
      if (!s.injectable) return false; // 只有 tmux 会话可注入按键
      try {
        return path.resolve(s.cwd) === path.resolve(cwd);
      } catch {
        return false;
      }
    });
    if (!sess) return null;

    if (!chatId) return { decision: 'allow', reason: '提问在终端等待，无聊天可通知' };

    const reqId = crypto.randomBytes(6).toString('hex');
    const pending: PendingAuq = { chatId, kind: sess.kind, tmuxTarget: sess.target, question: questions[0], sel: new Set() };
    this.auqPending.set(reqId, pending);
    setTimeout(() => this.auqPending.delete(reqId), 30 * 60_000).unref(); // 防泄漏

    pending.messageId = await this.channel.sendCard(chatId, this.auqCard(reqId, pending));
    if (!pending.messageId) {
      this.auqPending.delete(reqId);
      return { decision: 'allow', reason: '提问在终端等待（卡片发送失败）' };
    }
    this.publish(chatId, 'progress', `❓ 模型提问：${truncate(questions[0].question, 150)}`);
    return { decision: 'allow', reason: '问题已转飞书卡片，等待用户作答' };
  }

  private auqCard(reqId: string, p: PendingAuq): Record<string, unknown> {
    const q = p.question;
    const btns: Array<Record<string, unknown>> = q.options.map((opt, i) => ({
      tag: 'button',
      text: { tag: 'plain_text', content: truncate(p.sel.has(i) ? `✅ ${opt}` : opt, 30) },
      type: p.sel.has(i) ? 'primary' : 'default',
      value: { kcf: 'auq', req_id: reqId, a: i },
    }));
    if (q.multi) {
      btns.push({
        tag: 'button',
        text: { tag: 'plain_text', content: '✔️ 确认选择' },
        type: 'primary',
        value: { kcf: 'auq', req_id: reqId, a: '__confirm__' },
      });
    }
    return {
      config: { wide_screen_mode: true, update_multi: true },
      header: { template: 'blue', title: { tag: 'plain_text', content: '❓ Kimi Code 等待你的回答' } },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: `**${truncate(q.question, 400)}**${q.header ? `\n${q.header}` : ''}${q.multi ? '\n（多选，选完点确认）' : ''}` } },
        { tag: 'action', actions: btns },
        {
          tag: 'action',
          actions: [{ tag: 'button', text: { tag: 'plain_text', content: '🚫 拒绝回答' }, type: 'danger', value: { kcf: 'auq', req_id: reqId, d: 'deny' } }],
        },
        { tag: 'note', elements: [{ tag: 'plain_text', content: '点击后注入终端真实作答；自定义答案请用 /t 直接输入' }] },
        ...this.dashNote(),
      ],
    };
  }

  private auqResultCard(text: string, ok: boolean): Record<string, unknown> {
    return {
      config: { wide_screen_mode: true, update_multi: true },
      header: { template: ok ? 'green' : 'red', title: { tag: 'plain_text', content: `❓ 提问 ${text}` } },
      elements: [{ tag: 'div', text: { tag: 'lark_md', content: truncate(text, 800) } }],
    };
  }

  /** 处理答题卡点击：同步算出结果卡片内联返回；tmux 注入 fire-and-forget。 */
  private handleAuqClick(value: Record<string, unknown>, operator: string): Record<string, unknown> | null {
    const reqId = String(value.req_id ?? '');
    const p = this.auqPending.get(reqId);
    if (!p) {
      console.info(`[bridge] 提问 ${reqId} 已作答或不存在（重复点击）`);
      return null;
    }
    const send = (keys: string[]): void => {
      const job = p.kind === 'pts' ? sendPtsKeys(p.tmuxTarget, keys) : sendTmuxKeys(p.tmuxTarget, keys);
      job
        .then(() => this.publish(p.chatId, 'progress', `⌨️ 提问作答注入：${keys.join(' ')}`))
        .catch((err) => console.error('[bridge] 提问作答注入失败:', err));
    };

    if (String(value.d ?? '') === 'deny') {
      this.auqPending.delete(reqId);
      send(['Escape']); // TUI 里 Esc = 拒绝
      return this.auqResultCard('🚫 已拒绝（模型将自行决定）', false);
    }

    const q = p.question;
    // 确认（多选）：注入各选项数字键 + Enter
    if (String(value.a ?? '') === '__confirm__') {
      if (!p.sel.size) return null;
      const picks = [...p.sel].sort();
      this.auqPending.delete(reqId);
      send([...picks.map((i) => String(i + 1)), 'Enter']);
      return this.auqResultCard(`✅ 已作答：${picks.map((i) => q.options[i]).join('、')}（${operator}）`, true);
    }

    const idx = Number(value.a);
    if (!Number.isInteger(idx) || idx < 0 || idx >= q.options.length) return null;

    if (q.multi) {
      // 多选：切换选中并刷新卡片
      if (p.sel.has(idx)) p.sel.delete(idx);
      else p.sel.add(idx);
      return this.auqCard(reqId, p);
    }

    // 单选：数字键直接选中（TUI 数字键即确认，不再补 Enter 避免误发空消息）
    this.auqPending.delete(reqId);
    send([String(idx + 1)]);
    return this.auqResultCard(`✅ 已作答：${q.options[idx]}（${operator}）`, true);
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

    // 桥托管的会话（飞书聊天会话）已由 wire 转录覆盖进度，避免重复刷屏
    if (this.chatSessions.has(chatId)) return;
    if (!this.cfg.forwardTerminalSessions) return;

    // 本地会话转录（wire.jsonl）流式进 dashboard：终端会话的完整对话
    if (sessionId) {
      void this.wires.watch(sessionId, (ev) => this.dashboardBus.publish(chatId, 'session', renderWireEvent(ev)));
    }

    const tool = String(payload.tool_name ?? '');
    const key = sessionId || cwd || 'default';
    const ev = event.toLowerCase();

    // 终端会话进入权限等待（未进池）：被动通知兜底，提醒加池或 /t 作答
    if (ev === 'permissionrequest') {
      if (!this.state.inPool(String(cwd ?? ''))) {
        await this.channel.sendText(
          chatId,
          `⚠️ 终端会话等待权限确认：\`${tool}\`\n/c 加池后走审批卡；/a 绑定后 /t 直接作答`,
        );
        this.publish(chatId, 'progress', `⚠️ 终端等待权限：${tool}`);
      }
      return;
    }

    // 未进审批池的终端会话不转发进度
    if (!this.state.inPool(String(cwd ?? ''))) return;

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
      this.publish(chatId, 'progress', '✅ 本轮任务结束');
    } else if (ev === 'stopfailure') {
      await this.progressFlush(key, true);
      await this.channel.sendText(chatId, `⚠️ 本轮出错结束：${truncate(String(payload.error_message ?? ''), 200)}`);
      this.publish(chatId, 'progress', `⚠️ 本轮出错结束：${truncate(String(payload.error_message ?? ''), 200)}`);
    } else if (ev === 'interrupt') {
      await this.progressFlush(key, true);
      await this.channel.sendText(chatId, '⛔ 本轮被用户中断');
      this.publish(chatId, 'progress', '⛔ 本轮被用户中断');
    } else if (ev === 'sessionstart') {
      await this.channel.sendText(chatId, `🚀 新会话开始（${payload.source ?? ''}）：${sessionId.slice(0, 12)}`);
      this.publish(chatId, 'progress', `🚀 新会话开始：${sessionId.slice(0, 12)}`);
    }
  }

  private progressLine(key: string, chatId: string, line: string): void {
    this.publish(chatId, 'progress', line);
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
    this.log(chatId, 'in', 'text', `${openId}: ${text}`);

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
    // /d 是 /dashboard 的短别名
    const alias: Record<string, string> = { '/d': '/dashboard' };
    const cmd = alias[cmdRaw.toLowerCase()] ?? cmdRaw.toLowerCase();
    const arg = rest.join(' ');

    if (cmd === '/bind') {
      if (!arg) {
        await this.channel.sendText(chatId, '用法：/bind /绝对/路径/项目目录');
        return;
      }
      this.state.setWorkDir(chatId, arg);
      await this.chatSessions.reset(chatId);
      await this.channel.sendText(chatId, `📁 已绑定工作目录：\n\`${arg}\`\n（会话已重置，下一条消息开启新会话）`);
    } else if (cmd === '/new') {
      await this.chatSessions.reset(chatId);
      await this.channel.sendText(chatId, '🆗 已重置，下一条消息将开启新会话');
    } else if (cmd === '/stop') {
      await this.channel.sendText(chatId, (await this.chatSessions.interrupt(chatId)) ? '🛑 已发送中断（Esc）' : '当前没有正在运行的会话');
    } else if (cmd === '/status') {
      const busy = this.chatSessions.isBusy(chatId);
      const wd = this.state.getWorkDir(chatId, this.cfg.workDir);
      const attach = this.state.getAttach(chatId);
      await this.channel.sendText(
        chatId,
        `📊 状态\n模式：${attach ? `⌨️ 终端模式（${attach}，纯文本=注入）` : '💬 飞书任务模式（纯文本=派任务）'}\n` +
        `任务：${busy ? '🏃 运行中' : '💤 空闲'}\n目录：\`${wd}\`\n` +
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
      const wantTunnel = ['public', 'pub', 'tunnel'].includes(arg.toLowerCase());
      await this.channel.sendText(chatId, wantTunnel ? '⏳ 正在开启 Dashboard（拉起公网隧道，约几秒）…' : '⏳ 正在开启 Dashboard…');
      try {
        const url = await this.openDashboard(chatId, { tunnel: wantTunnel });
        const isPublic = !!(this.dashPublic ?? this.tunnel?.url);
        await this.channel.sendText(
          chatId,
          `📊 Dashboard 已开启：\n${url}\n页面只读，可手动关闭；无人观看约 ${Math.round(this.cfg.dashboardIdleTimeoutNopage / 60)} 分钟、停看 ${Math.round(this.cfg.dashboardIdleTimeoutPage / 60)} 分钟自动关闭` +
            (wantTunnel && !isPublic
              ? '\n⚠️ cloudflared 不可用，回退为局域网链接'
              : isPublic
                ? ''
                : '\n（本地/局域网链接；要公网链接发 /dashboard public）'),
        );
      } catch (err) {
        await this.channel.sendText(chatId, `❌ 开启 Dashboard 失败：${err instanceof Error ? err.message : err}`);
      }
    } else if (cmd === '/a') {
      // /a free 或 /a 0：释放绑定，切回飞书任务模式
      if (['free', '0', 'off'].includes(arg.toLowerCase())) {
        const had = this.state.getAttach(chatId);
        this.state.setAttach(chatId, null);
        await this.channel.sendText(chatId, had ? '🔓 已释放终端会话绑定，切回飞书任务模式（直接发消息派任务）' : '当前没有绑定的终端会话');
        return;
      }
      const sessions = await listKimiSessions();
      if (arg) {
        const n = Number(arg);
        if (!Number.isInteger(n) || n < 1 || n > sessions.length) {
          await this.channel.sendText(chatId, '序号无效，发 /a 查看列表');
          return;
        }
        const s = sessions[n - 1];
        this.state.setAttach(chatId, `${s.kind}|${s.target}`);
        const hint =
          s.kind === 'tmux'
            ? '\n已进入终端模式：直接发消息即注入该会话（/task 派飞书任务，/s 看画面，/a free 切回）'
            : s.injectable
              ? '\n已进入终端模式：直接发消息即注入；pts 无法抓屏（/a free 切回）'
              : '\n⚠️ 该会话不在 tmux，无法注入/抓屏（用 kimi-code-feishu tmux 重启可管控）';
        await this.channel.sendText(chatId, `🔗 已绑定：${s.name}\n目录：\`${s.cwd}\`${hint}`);
        return;
      }
      if (!sessions.length) {
        await this.channel.sendText(chatId, '没有发现 kimi 终端会话。\n在终端用 `kimi-code-feishu tmux` 启动即可被远程管控');
        return;
      }
      const cur = this.state.getAttach(chatId);
      await this.channel.sendText(
        chatId,
        '🖥 终端会话（/a 序号 绑定，/a free 释放）：\n' +
          sessions
            .map((s, i) => {
              const tag = s.kind === 'tmux' ? '⌨️可控' : s.injectable ? '⌨️仅注入' : '👀仅发现';
              const bound = `${s.kind}|${s.target}` === cur ? '  ← 当前绑定' : '';
              return `${i + 1}. [${tag}] ${s.name}  \`${s.cwd}\`${bound}`;
            })
            .join('\n') +
          '\n⌨️可控=tmux（可注入+抓屏）；⌨️仅注入=pts（可注入，无抓屏）；👀仅发现=无法注入',
      );
    } else if (cmd === '/c') {
      const sessions = await listKimiSessions();
      if (arg) {
        let cwd = arg;
        const n = Number(arg);
        if (Number.isInteger(n) && n >= 1 && n <= sessions.length) cwd = sessions[n - 1].cwd;
        const inPool = this.state.togglePool(cwd);
        await this.channel.sendText(chatId, `${inPool ? '✅ 已加入' : '❌ 已移出'}审批池：\`${cwd}\``);
        return;
      }
      const pool = this.state.getPool();
      const lines = sessions.map((s, i) => `${this.state.inPool(s.cwd) ? '✅' : '❌'} ${i + 1}. ${s.name}  \`${s.cwd}\``);
      const extra = pool.filter((p) => !sessions.some((s) => s.cwd === p));
      await this.channel.sendText(
        chatId,
        '🗂 审批池（进池的终端会话才弹审批卡/推进度）：\n' +
          (lines.join('\n') || '（未发现 tmux 会话）') +
          (extra.length ? `\n池内其他目录：${extra.map((p) => `\`${p}\``).join(' ')}` : '') +
          '\n/c 序号 或 /c 路径 切换',
      );
    } else if (cmd === '/t') {
      const target = this.state.getAttach(chatId);
      if (!target) {
        await this.channel.sendText(chatId, '先用 /a 绑定一个终端会话');
        return;
      }
      const { kind, target: pane } = parseAttach(target);
      if (kind !== 'tmux') {
        if (!(await canInjectPts())) {
          await this.channel.sendText(chatId, '⚠️ 绑定的会话不在 tmux，且 pts 注入不可用（需 legacy_tiocsti=1 + 免密 sudo）。用 `kimi-code-feishu tmux` 重启会话后可管控');
          return;
        }
        try {
          await sendPtsText(pane, arg);
          this.publish(chatId, 'progress', `⌨️ /t 注入(pts)：${truncate(arg || '(回车)', 120)}`);
        } catch {
          await this.channel.sendText(chatId, '❌ 注入失败（终端可能已关闭），/a 重新选择');
        }
        return;
      }
      try {
        await sendTmuxText(pane, arg);
        this.publish(chatId, 'progress', `⌨️ /t 注入：${truncate(arg || '(回车)', 120)}`);
      } catch {
        await this.channel.sendText(chatId, '❌ 注入失败（会话可能已退出），/a 重新选择');
      }
    } else if (cmd === '/s') {
      const target = this.state.getAttach(chatId);
      if (!target) {
        await this.channel.sendText(chatId, '先用 /a 绑定一个终端会话');
        return;
      }
      const { kind, target: pane } = parseAttach(target);
      if (kind !== 'tmux') {
        // pts 屏幕读不到，改读该会话的磁盘转录尾部（cwd 匹配最近活跃的 wire 文件）
        const sess = (await listKimiSessions()).find((s) => s.kind === 'pts' && s.target === pane);
        const tail = sess ? this.wires.readTail({ cwd: sess.cwd }, 20) : null;
        if (tail) {
          await this.channel.sendText(chatId, '📡 该会话最近对话（磁盘转录，pts 无法抓屏）：\n```\n' + truncate(tail, 2400) + '\n```');
        } else {
          await this.channel.sendText(chatId, '⚠️ pts 终端无法抓屏，且未找到该会话的转录文件；tmux 会话 /s 可直接抓屏');
        }
        return;
      }
      try {
        const shot = await captureTmux(pane, 30);
        await this.channel.sendText(chatId, '🖥 当前画面：\n```\n' + truncate(shot.trimEnd() || '（空）', 2600) + '\n```');
      } catch {
        await this.channel.sendText(chatId, '❌ 读取画面失败（会话可能已退出），/a 重新选择');
      }
    } else if (cmd === '/i') {
      // 优先插话：绑定终端会话 → 按键 Ctrl+S；飞书会话（0号） → steer 注入
      if (!arg) {
        await this.channel.sendText(chatId, '用法：/i <文本>\n绑定终端会话：等同终端输入后按 Ctrl+S，立即插入运行中的轮次\n飞书会话：同样 Ctrl+S 插话');
        return;
      }
      const attach = this.state.getAttach(chatId);
      if (attach) {
        const { kind, target: pane } = parseAttach(attach);
        try {
          if (kind === 'tmux') {
            await sendTmuxCtrlS(pane, arg);
          } else {
            if (!(await canInjectPts())) {
              await this.channel.sendText(chatId, '⚠️ pts 注入不可用（需 legacy_tiocsti=1 + 免密 sudo）');
              return;
            }
            await sendPtsCtrlS(pane, arg);
          }
          this.publish(chatId, 'progress', `⚡ /i 优先插入：${truncate(arg, 120)}`);
        } catch {
          await this.channel.sendText(chatId, '❌ 注入失败（会话可能已退出），/a 重新选择');
        }
        return;
      }
      if (this.chatSessions.has(chatId)) {
        await this.chatSessions.steer(chatId, this.state.getWorkDir(chatId, this.cfg.workDir), arg);
        this.publish(chatId, 'progress', `⚡ /i 优先插入(飞书会话)：${truncate(arg, 120)}`);
        return;
      }
      await this.channel.sendText(chatId, '当前没有运行中的会话，也没有绑定的终端会话（/i 用于执行中插话）');
    } else if (cmd === '/help') {
      await this.channel.sendText(chatId, HELP_TEXT);
    } else if (cmd === '/0' || cmd === '/task') {
      // /0 = 发给 0 号会话（飞书本身的常驻会话）；/task 为其旧别名
      if (!arg) {
        await this.channel.sendText(chatId, '用法：/0 <文本>（发给飞书会话本身，即 0 号会话）');
        return;
      }
      try {
        await this.chatSessions.send(chatId, this.state.getWorkDir(chatId, this.cfg.workDir), arg);
      } catch (err) {
        await this.channel.sendText(chatId, `❌ 拉起飞书会话失败：${err instanceof Error ? err.message : err}`);
      }
    } else if (cmdRaw.startsWith('/')) {
      // 其余 /命令 不再透传：终端命令一律 /t 注入
      await this.channel.sendText(chatId, `❓ 未知命令 ${cmdRaw}。飞书命令见 /help；要执行终端的 /命令 请用 /t ${cmdRaw}`);
    } else {
      // 绑定终端会话时：纯文本自动注入该会话（终端模式）；否则发到飞书会话（0 号）
      const attach = this.state.getAttach(chatId);
      if (attach) {
        const { kind, target: pane } = parseAttach(attach);
        try {
          if (kind === 'tmux') {
            await sendTmuxText(pane, text);
          } else {
            if (!(await canInjectPts())) {
              await this.channel.sendText(chatId, '⚠️ pts 注入不可用（需 legacy_tiocsti=1 + 免密 sudo）。/a free 切回飞书模式');
              return;
            }
            await sendPtsText(pane, text);
          }
          this.publish(chatId, 'progress', `⌨️ 注入：${truncate(text, 120)}`);
        } catch {
          await this.channel.sendText(chatId, '❌ 注入失败（会话可能已退出），/a 重新选择或 /a free 切回');
        }
        return;
      }
      try {
        await this.chatSessions.send(chatId, this.state.getWorkDir(chatId, this.cfg.workDir), text);
      } catch (err) {
        await this.channel.sendText(chatId, `❌ 拉起飞书会话失败：${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // ---------------- 飞书会话（0号）回调 ----------------
  /** wire 流事件 → 进度消息（复用节流渲染机制）。 */
  private onChatStream(chatId: string, ev: WireEvent): void {
    // dashboard 进度线（think 不推飞书，太吵）
    if (ev.kind !== 'think') this.publish(chatId, 'progress', renderWireEvent(ev));
    // StreamEvent 转换，复用 taskStatus/pushTaskStatus 节流渲染
    const mapped: StreamEvent | null =
      ev.kind === 'text' ? { kind: 'text', text: ev.text }
      : ev.kind === 'tool_call' ? { kind: 'tool_call', tool: ev.tool, text: ev.text }
      : ev.kind === 'tool_result' ? { kind: 'tool_result', tool: ev.tool, text: ev.text }
      : null;
    if (!mapped) return;

    const st = this.taskStatus.get(chatId) ?? { lastPush: 0 };
    this.taskStatus.set(chatId, st);
    if (mapped.kind === 'text' && mapped.text?.trim()) st.text = mapped.text.trim();
    else if (mapped.kind === 'tool_call') {
      st.tool = mapped.tool;
      if (mapped.text?.trim()) st.text = mapped.text.trim();
    }

    const mid = this.taskMessages.get(chatId);
    if (!mid) {
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

  /** 一轮结束：发结果消息并清理进度状态。 */
  private async onChatTurnDone(chatId: string, text: string, tools: string[]): Promise<void> {
    const pend = this.taskMsgPending.get(chatId);
    if (pend) void pend.finally(() => this.taskMessages.delete(chatId));
    this.taskMsgPending.delete(chatId);
    this.taskStatus.delete(chatId);
    this.taskMessages.delete(chatId);
    const toolLine = tools.length ? `\n🔧 本轮工具：${tools.join('、')}` : '';
    await this.channel.sendText(chatId, '✅ 本轮完成\n' + truncate(text || '(无文本输出)') + toolLine);
  }

  // ---------------- 卡片回调 ----------------
  /**
   * 返回结果卡片 JSON（或 null）：卡片更新内联在回调响应里返回，
   * 飞书才会立即在点击者的所有设备上同步更新卡片（PATCH API 不保证跨端同步）。
   */
  onCardAction(value: Record<string, unknown>, operator: string): Record<string, unknown> | null {
    const kind = String(value.kcf ?? '');
    if (kind !== 'approval' && kind !== 'auq') return null;
    if (!this.cfg.allowedUserIds.includes(operator)) {
      console.warn(`[bridge] 非白名单用户 ${operator} 尝试操作审批卡片`);
      this.log('-', 'in', 'action_denied', `${operator}: ${JSON.stringify(value).slice(0, 300)}`);
      return null;
    }
    if (kind === 'auq') {
      const card = this.handleAuqClick(value, operator);
      this.log('-', 'in', 'action', `${operator} auq: ${JSON.stringify(value).slice(0, 300)}`);
      return card;
    }
    const decision = String(value.d ?? '') as 'allow' | 'deny' | 'allow_session';
    const ap = this.approvals.decide(String(value.req_id ?? ''), decision, operator);
    if (!ap) {
      console.info(`[bridge] 审批 ${value.req_id} 已处理或不存在（可能超时/重复点击）`);
      return null;
    }
    this.log(ap.chatId ?? '-', 'in', 'action', `${operator} ${decision}: ${ap.toolName}`);
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

会话模型：每个聊天一个常驻交互式 kimi 会话（tmux 托管，编号 0）——上下文连续，模型可以提问（弹卡片作答）。
💬 飞书模式（默认）：直接发消息 = 发给 0 号会话
⌨️ 终端模式（/a 绑定后）：直接发消息 = 注入终端会话；/0 发给 0 号会话；/t 注入终端

命令：
/0 <文本>     发给 0 号会话（飞书本身的常驻会话）
/new          新开会话（杀掉当前 0 号会话重新开始）
/stop         中断当前轮次（Esc）
/status       查看当前状态（含模式）
/bind <目录>  绑定 0 号会话的工作目录
/a            列出终端会话；/a 序号 绑定进入终端模式；/a free 或 /a 0 切回
/t <文本>     注入绑定会话（终端的 /命令 也走这里，如 /t /model）
/i <文本>     优先插话（Ctrl+S，立即插入运行中的轮次）
/s            查看绑定会话：tmux=实时抓屏；pts=读磁盘转录尾部
/c            审批池；/c 序号或路径 切换（进池的终端会话才弹审批卡）
/dashboard    实时输出面板（/d 短别名；public 公网隧道；off 关闭）
/id           查看你的 open_id
/help         本帮助`;
