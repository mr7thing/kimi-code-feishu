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
import type { Dashboard } from './dashboard.js';
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

/** 审批决定的展示文案（卡片回调内联返回与 resolve 更新共用，防止漂移）。 */
function decidedTextFor(decision: string): string | null {
  if (decision === 'allow') return '✅ 已批准';
  if (decision === 'allow_session') return '✅ 已批准（本会话同类自动放行）';
  if (decision === 'deny') return '❌ 已拒绝';
  return null;
}

type HookResponse = { decision: string; reason?: string };

type AuqQuestion = { question: string; header?: string; multi: boolean; options: string[] };

/** 解析 AskUserQuestion 的 tool_input；解析不出有效问题返回空数组（调用方回退普通审批）。 */
export function parseAuqQuestions(ti: unknown): AuqQuestion[] {
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

  constructor(
    private cfg: Config,
    private state: StateStore,
    channel?: Channel,
    private dashboard?: Dashboard,
  ) {
    if (channel) this.channel = channel;
    this.runner = new KimiRunner(cfg, state, this, (chatId, kind, text) => this.dashboard?.publish(chatId, kind, text));
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

    // 2.5) AskUserQuestion：把问题渲染成飞书选项卡片，作答后以 deny+理由 回传答案
    if (tool === 'AskUserQuestion') {
      const r = await this.handleAskUserQuestion(payload);
      if (r) return r; // null = 问题格式无法解析，回退为普通审批卡
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
    this.dashboard?.publish(chatId, 'progress', `🔐 审批请求：${tool} — ${truncate(summary, 200)}`);

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
    if (ap.chatId) this.dashboard?.publish(ap.chatId, 'progress', `${decidedText}：${ap.toolName}${operator ? `（${operator}）` : ''}`);
    return resp;
  }

  private timeoutDecision(reason: string): HookResponse {
    if (this.cfg.onTimeout === 'allow') return { decision: 'allow', reason };
    return { decision: 'deny', reason: `飞书审批超时：${reason}` };
  }

  // ================================================================
  // AskUserQuestion：飞书答题
  // hook 协议无法把用户输入回传给工具，做法是：选项做成飞书按钮，
  // 集齐答案后 hook 返回 deny + 理由（理由进上下文，模型拿答案继续）。
  // ================================================================
  private async handleAskUserQuestion(payload: Record<string, unknown>): Promise<HookResponse | null> {
    const questions = parseAuqQuestions(payload.tool_input);
    if (!questions.length) return null;

    const chatId = this.routeChat(payload);
    if (!chatId) return this.timeoutDecision('尚未有任何飞书聊天与桥绑定（先给机器人发条消息）');

    const ap = this.approvals.create(payload);
    ap.chatId = chatId;
    ap.auq = { questions, sel: questions.map(() => new Set<string>()), answers: questions.map(() => null) };
    try {
      ap.messageId = await this.channel.sendCard(chatId, this.auqCard(ap));
    } catch (err) {
      console.error('[bridge] 发送提问卡片失败:', err);
    }
    if (!ap.messageId) return this.timeoutDecision('提问卡片发送失败');
    this.dashboard?.publish(chatId, 'progress', `❓ 模型提问：${truncate(questions.map((q) => q.question).join('；'), 200)}`);

    const result = await this.approvals.wait(ap, this.cfg.approvalTimeout * 1000);
    if (result.decision === null) {
      await this.updateCardQuiet(ap, this.auqResultCard(ap, '⏰ 超时未作答'));
      return this.timeoutDecision(`${this.cfg.approvalTimeout}s 未作答`);
    }
    if (result.decision === 'deny') {
      await this.updateCardQuiet(ap, this.auqResultCard(ap, '🚫 用户拒绝回答'));
      return { decision: 'deny', reason: '用户拒绝回答该提问。请不要再问同一问题，自行决定或换个方案继续。' };
    }
    const qa = questions.map((q, i) => `Q${i + 1}「${q.question}」答：${(ap.auq!.answers[i] ?? []).join('、')}`).join('\n');
    await this.updateCardQuiet(ap, this.auqResultCard(ap, '✅ 已作答', qa));
    this.dashboard?.publish(chatId, 'progress', `✅ 飞书作答：${truncate(qa, 200)}`);
    return {
      decision: 'deny',
      reason: `注意：该提问已由用户通过飞书远程作答（本次工具调用被拒绝是预期行为，并非用户不愿回答）。\n${qa}\n请以上述回答为准继续工作，不要再次询问同一问题。`,
    };
  }

  private async updateCardQuiet(ap: Approval, card: Record<string, unknown>): Promise<void> {
    if (!ap.messageId) return;
    try {
      await this.channel.updateCard(ap.messageId, card);
    } catch (err) {
      console.error('[bridge] 更新卡片失败:', err);
    }
  }

  private async handleAuqClick(value: Record<string, unknown>, operator: string): Promise<void> {
    const reqId = String(value.req_id ?? '');
    const ap = this.approvals.get(reqId);
    if (!ap?.auq) {
      console.info(`[bridge] 答题 ${reqId} 已处理或不存在（可能超时/重复点击）`);
      return;
    }
    if (String(value.d ?? '') === 'deny') {
      this.approvals.decide(reqId, 'deny', operator);
      return;
    }
    const q = Number(value.q);
    const a = String(value.a ?? '');
    const auq = ap.auq;
    if (!Number.isInteger(q) || q < 0 || q >= auq.questions.length || auq.answers[q]) return;
    const sel = auq.sel[q];
    if (a === '__confirm__') {
      if (!sel.size) return;
      auq.answers[q] = [...sel];
    } else if (auq.questions[q].multi) {
      if (sel.has(a)) sel.delete(a);
      else sel.add(a);
    } else {
      auq.answers[q] = [a];
    }
    // 全部题答完 → 结束挂起；否则更新卡片显示已选状态
    if (auq.answers.every((ans) => ans && ans.length > 0)) {
      this.approvals.decide(reqId, 'allow', operator);
      return;
    }
    if (ap.messageId) {
      try {
        await this.channel.updateCard(ap.messageId, this.auqCard(ap));
      } catch (err) {
        console.error('[bridge] 更新答题卡片失败:', err);
      }
    }
  }

  // ---------------- 提问卡片 ----------------
  private auqCard(ap: Approval): Record<string, unknown> {
    const auq = ap.auq!;
    const elements: unknown[] = [];
    auq.questions.forEach((q, qi) => {
      const head = `**Q${qi + 1}${q.multi ? '（多选，选完点确认）' : ''}：${truncate(q.question, 400)}**`;
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: q.header ? `${head}\n${q.header}` : head } });
      const answered = auq.answers[qi];
      if (answered) {
        elements.push({ tag: 'div', text: { tag: 'lark_md', content: `✅ 已选：**${answered.join('、')}**` } });
        return;
      }
      const btns = q.options.map((opt) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: truncate(auq.sel[qi].has(opt) ? `✅ ${opt}` : opt, 30) },
        type: auq.sel[qi].has(opt) ? 'primary' : 'default',
        value: { kcf: 'auq', req_id: ap.reqId, q: qi, a: opt },
      }));
      if (q.multi) {
        btns.push({
          tag: 'button',
          text: { tag: 'plain_text', content: '✔️ 确认本题' },
          type: 'primary',
          value: { kcf: 'auq', req_id: ap.reqId, q: qi, a: '__confirm__' },
        });
      }
      elements.push({ tag: 'action', actions: btns });
    });
    elements.push({
      tag: 'action',
      actions: [{ tag: 'button', text: { tag: 'plain_text', content: '🚫 拒绝回答' }, type: 'danger', value: { kcf: 'auq', req_id: ap.reqId, d: 'deny' } }],
    });
    const timeoutText = this.cfg.onTimeout === 'deny' ? '拒绝（模型自行决定）' : '放行到终端作答';
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: `${this.cfg.approvalTimeout} 秒未作答将${timeoutText}；自定义答案请点「拒绝回答」后直接在聊天里补充` }] });
    elements.push(...this.dashNote());
    return {
      config: { wide_screen_mode: true, update_multi: true },
      header: { template: 'blue', title: { tag: 'plain_text', content: '❓ Kimi Code 等待你的回答' } },
      elements,
    };
  }

  private auqResultCard(ap: Approval, decidedText: string, detail = ''): Record<string, unknown> {
    const ok = decidedText.startsWith('✅');
    return {
      config: { wide_screen_mode: true, update_multi: true },
      header: { template: ok ? 'green' : 'red', title: { tag: 'plain_text', content: `❓ 提问 ${decidedText}` } },
      elements: [{ tag: 'div', text: { tag: 'lark_md', content: truncate(detail || decidedText, 1000) } }],
    };
  }

  /** 配置了 dashboard_public_url 时，卡片底部附「查看实时输出」链接。 */
  private dashNote(): unknown[] {
    if (!this.cfg.dashboardPublicUrl) return [];
    const sep = this.cfg.dashboardPublicUrl.includes('?') ? '&' : '?';
    const url = `${this.cfg.dashboardPublicUrl}${sep}token=${this.cfg.dashboardToken}`;
    return [{ tag: 'note', elements: [{ tag: 'lark_md', content: `[📊 查看实时输出](${url})` }] }];
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
      this.dashboard?.publish(chatId, 'progress', '✅ 本轮任务结束');
    } else if (ev === 'stopfailure') {
      await this.progressFlush(key, true);
      await this.channel.sendText(chatId, `⚠️ 本轮出错结束：${truncate(String(payload.error_message ?? ''), 200)}`);
      this.dashboard?.publish(chatId, 'progress', `⚠️ 本轮出错结束：${truncate(String(payload.error_message ?? ''), 200)}`);
    } else if (ev === 'interrupt') {
      await this.progressFlush(key, true);
      await this.channel.sendText(chatId, '⛔ 本轮被用户中断');
      this.dashboard?.publish(chatId, 'progress', '⛔ 本轮被用户中断');
    } else if (ev === 'sessionstart') {
      await this.channel.sendText(chatId, `🚀 新会话开始（${payload.source ?? ''}）：${sessionId.slice(0, 12)}`);
      this.dashboard?.publish(chatId, 'progress', `🚀 新会话开始：${sessionId.slice(0, 12)}`);
    }
  }

  private progressLine(key: string, chatId: string, line: string): void {
    this.dashboard?.publish(chatId, 'progress', line);
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
    const kind = String(value.kcf ?? '');
    if (kind !== 'approval' && kind !== 'auq') return null;
    if (!this.cfg.allowedUserIds.includes(operator)) {
      console.warn(`[bridge] 非白名单用户 ${operator} 尝试操作审批卡片`);
      return null;
    }
    if (kind === 'auq') {
      void this.handleAuqClick(value, operator);
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
/id           查看你的 open_id
/help         本帮助

提示：终端里手动运行的 kimi 会话也会推送进度与审批到这里（可在配置里关闭）。`;
