/**
 * 待审批请求注册表：hook HTTP 处理在 Promise 上挂起，飞书卡片回调来 resolve。
 * 这是 TS 版相比 Python 版最自然的部分——单线程事件循环，无需 threading.Event。
 */
import crypto from 'node:crypto';

export type Decision = 'allow' | 'deny' | 'allow_session';

export interface ApprovalResult {
  decision: Decision | null; // null = 超时
  operator?: string;
}

export interface Approval {
  reqId: string;
  payload: Record<string, unknown>;
  toolName: string;
  sessionId: string;
  createdAt: number;
  messageId?: string;
  chatId?: string;
  result: ApprovalResult | null;
  resolve: (r: ApprovalResult) => void;
  promise: Promise<ApprovalResult>;
}

export class ApprovalManager {
  private pending = new Map<string, Approval>();
  /** (sessionId\0toolName)：用户点了"本会话允许" */
  private sessionAllowed = new Set<string>();

  create(payload: Record<string, unknown>): Approval {
    let resolveFn!: (r: ApprovalResult) => void;
    const promise = new Promise<ApprovalResult>((res) => { resolveFn = res; });
    const ap: Approval = {
      reqId: crypto.randomBytes(6).toString('hex'),
      payload,
      toolName: String(payload.tool_name ?? 'unknown'),
      sessionId: String(payload.session_id ?? ''),
      createdAt: Date.now(),
      result: null,
      resolve: resolveFn,
      promise,
    };
    this.pending.set(ap.reqId, ap);
    return ap;
  }

  isSessionAllowed(sessionId: string, toolName: string): boolean {
    return this.sessionAllowed.has(`${sessionId}\0${toolName}`);
  }

  /** 取待处理请求（飞书答题需要中途读取/累积选择，而非一次 decide）。 */
  get(reqId: string): Approval | undefined {
    return this.pending.get(reqId);
  }

  decide(reqId: string, decision: Decision, operator = ''): Approval | undefined {
    const ap = this.pending.get(reqId);
    if (!ap || ap.result !== null) return undefined; // 不存在或已处理（重复点击/超时后点击）
    if (decision === 'allow_session') {
      this.sessionAllowed.add(`${ap.sessionId}\0${ap.toolName}`);
    }
    ap.result = { decision, operator };
    this.pending.delete(reqId);
    ap.resolve(ap.result);
    return ap;
  }

  /** 挂起直到用户点击或超时；超时返回 decision=null。 */
  async wait(ap: Approval, timeoutMs: number): Promise<ApprovalResult> {
    const timeout = new Promise<ApprovalResult>((res) =>
      setTimeout(() => res({ decision: null }), timeoutMs),
    );
    const result = await Promise.race([ap.promise, timeout]);
    if (result.decision === null) {
      ap.result = result;
      this.pending.delete(ap.reqId);
      ap.resolve(result); // 解除 promise 悬挂，便于 GC
    }
    return result;
  }

  pendingCount(): number {
    return this.pending.size;
  }

  /** 待审批列表（dashboard 状态面板用）。 */
  pendingList(): Approval[] {
    return [...this.pending.values()];
  }
}
