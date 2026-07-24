/**
 * 本地 kimi 会话转录（wire.jsonl）监听：把任意会话（tmux 或普通终端）的
 * 完整对话流式推到 dashboard——这是 pts 会话「画面」的替代（pts 屏幕读不到，
 * 但磁盘转录是全量的：用户输入、思考、回复、工具调用与结果）。
 *
 * 转录位置：~/.kimi-code/sessions/<wd>/<sessionId>/agents/main/wire.jsonl
 * 增量轮询读取（1.5s），从文件末尾开始，只推新事件；首次回放慢最近 15 条。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const trunc = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + '…');

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => (p && typeof p === 'object' && (p as Record<string, unknown>).type === 'text' ? String((p as Record<string, unknown>).text ?? '') : ''))
    .filter(Boolean)
    .join('\n');
}

function toolArgsBrief(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const rec = args as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt']) {
    if (typeof rec[key] === 'string') return trunc(rec[key] as string, 120);
  }
  return '';
}

/** wire.jsonl 一行 → 结构化事件；不关心的类型返回 null。 */
export interface WireEvent {
  kind: 'user' | 'think' | 'text' | 'tool_call' | 'tool_result' | 'steer' | 'cancel';
  text: string;
  tool?: string;
}

export function parseWireLine(line: string): WireEvent | null {
  const s = line.trim();
  if (!s) return null;
  let e: Record<string, unknown>;
  try {
    e = JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
  const t = String(e.type ?? '');

  if (t === 'context.append_message') {
    const msg = e.message as Record<string, unknown> | undefined;
    if (msg?.role !== 'user') return null;
    const text = contentText(msg.content);
    return text ? { kind: 'user', text } : null;
  }

  if (t === 'context.append_loop_event') {
    const ev = e.event as Record<string, unknown> | undefined;
    const et = String(ev?.type ?? '');
    if (et === 'content.part') {
      const part = ev?.part as Record<string, unknown> | undefined;
      if (part?.type === 'think') return { kind: 'think', text: String(part.think ?? '') };
      if (part?.type === 'text') return { kind: 'text', text: String(part.text ?? '') };
      return null;
    }
    if (et === 'tool.call') {
      const name = String(ev?.name ?? '?');
      return { kind: 'tool_call', text: toolArgsBrief(ev?.args), tool: name };
    }
    if (et === 'tool.result') {
      const out = String((ev?.result as Record<string, unknown>)?.output ?? '');
      return out.trim() ? { kind: 'tool_result', text: out.replace(/\s+/g, ' ') } : null;
    }
    return null;
  }

  if (t === 'turn.steer') return { kind: 'steer', text: '用户插话干预' };
  if (t === 'turn.cancel') return { kind: 'cancel', text: '本轮被取消' };
  return null;
}

const WIRE_ICON: Record<WireEvent['kind'], string> = {
  user: '👤', think: '💭', text: '🤖', tool_call: '🔧', tool_result: '📎', steer: '⚡', cancel: '⛔',
};

/** wire.jsonl 一行 → dashboard 一行；不关心的类型返回 null。 */
export function renderWireLine(line: string): string | null {
  const ev = parseWireLine(line);
  if (!ev) return null;
  const limit = ev.kind === 'text' ? 300 : ev.kind === 'user' ? 200 : 150;
  const tool = ev.tool ? `${ev.tool}${ev.text ? `：${trunc(ev.text, 120)}` : ''}` : trunc(ev.text, limit);
  return `${WIRE_ICON[ev.kind]} ${tool}`;
}

interface WatchEntry {
  sessionId: string;
  timer: NodeJS.Timeout;
  offset: number;
  cbs: Set<(ev: WireEvent) => void>;
}

/** 结构化 wire 事件 → dashboard 文本行。 */
export function renderWireEvent(ev: WireEvent): string {
  const limit = ev.kind === 'text' ? 300 : ev.kind === 'user' ? 200 : 150;
  const body = ev.tool ? `${ev.tool}${ev.text ? `：${trunc(ev.text, 120)}` : ''}` : trunc(ev.text, limit);
  return `${WIRE_ICON[ev.kind]} ${body}`;
}

/** 按 cwd 定位某工作目录下最近活跃的 wire 文件（wd_<basename>_* 下 mtime 最新）。 */
export class WireWatcher {
  private watches = new Map<string, WatchEntry>();

  constructor(private sessionsDir = path.join(os.homedir(), '.kimi-code', 'sessions')) {}

  /** 读取会话转录尾部（渲染后最近 lines 行）；sessionId 或 cwd 二选一，找不到返回 null。 */
  readTail(opts: { sessionId?: string; cwd?: string }, lines = 20): string | null {
    const file = opts.sessionId
      ? this.findWirePath(opts.sessionId)
      : opts.cwd
        ? this.findLatestWireByCwd(opts.cwd)
        : null;
    if (!file) return null;
    try {
      const stat = fs.statSync(file);
      const start = Math.max(0, stat.size - 64 * 1024);
      const buf = Buffer.alloc(stat.size - start);
      const fd = fs.openSync(file, 'r');
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      const rendered = buf
        .toString('utf-8')
        .split('\n')
        .map(renderWireLine)
        .filter((l): l is string => !!l);
      return rendered.slice(-lines).join('\n') || null;
    } catch {
      return null;
    }
  }

  private findLatestWireByCwd(cwd: string): string | null {
    const base = path.basename(cwd.replace(/\/+$/, ''));
    if (!base) return null;
    let best: { p: string; mtime: number } | null = null;
    try {
      for (const wd of fs.readdirSync(this.sessionsDir)) {
        if (!wd.startsWith(`wd_${base}_`)) continue;
        const wdDir = path.join(this.sessionsDir, wd);
        for (const sess of fs.readdirSync(wdDir)) {
          const p = path.join(wdDir, sess, 'agents', 'main', 'wire.jsonl');
          try {
            const mtime = fs.statSync(p).mtimeMs;
            if (!best || mtime > best.mtime) best = { p, mtime };
          } catch {
            /* 无 wire 文件 */
          }
        }
      }
    } catch {
      /* sessions 目录不存在 */
    }
    return best?.p ?? null;
  }


  /** 开始监听某会话的 wire 转录（同一会话可多订阅；找不到转录文件返回 false）。 */
  async watch(sessionId: string, cb: (ev: WireEvent) => void): Promise<boolean> {
    const existing = this.watches.get(sessionId);
    if (existing) {
      existing.cbs.add(cb);
      return true;
    }
    if (!sessionId) return false;
    const file = this.findWirePath(sessionId);
    if (!file) return false;

    const entry: WatchEntry = { sessionId, timer: null as unknown as NodeJS.Timeout, offset: 0, cbs: new Set([cb]) };
    // 首次回放慢最近 15 条（从文件尾 64KB 里解析）
    this.backfill(file, entry.cbs);

    entry.offset = fs.statSync(file).size;
    entry.timer = setInterval(() => this.pump(sessionId, file), 1500);
    entry.timer.unref();
    this.watches.set(sessionId, entry);
    return true;
  }

  private emit(cbs: Set<(ev: WireEvent) => void>, ev: WireEvent, prefix = ''): void {
    for (const cb of cbs) {
      try {
        cb(prefix ? { ...ev, text: prefix + ev.text } : ev);
      } catch {
        /* 订阅者异常不影响其他 */
      }
    }
  }

  private findWirePath(sessionId: string): string | null {
    try {
      for (const wd of fs.readdirSync(this.sessionsDir)) {
        const p = path.join(this.sessionsDir, wd, sessionId, 'agents', 'main', 'wire.jsonl');
        if (fs.existsSync(p)) return p;
      }
    } catch {
      /* sessions 目录不存在 */
    }
    return null;
  }

  private backfill(file: string, cbs: Set<(ev: WireEvent) => void>): void {
    try {
      const stat = fs.statSync(file);
      const start = Math.max(0, stat.size - 64 * 1024);
      const buf = Buffer.alloc(stat.size - start);
      const fd = fs.openSync(file, 'r');
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      const events = buf
        .toString('utf-8')
        .split('\n')
        .map(parseWireLine)
        .filter((l): l is WireEvent => !!l);
      for (const ev of events.slice(-15)) this.emit(cbs, ev, '⏪ ');
    } catch {
      /* 回放失败不阻塞 */
    }
  }

  private pump(sessionId: string, file: string): void {
    const w = this.watches.get(sessionId);
    if (!w) return;
    try {
      const size = fs.statSync(file).size;
      if (size <= w.offset) return;
      const buf = Buffer.alloc(size - w.offset);
      const fd = fs.openSync(file, 'r');
      fs.readSync(fd, buf, 0, buf.length, w.offset);
      fs.closeSync(fd);
      w.offset = size;
      for (const line of buf.toString('utf-8').split('\n')) {
        const ev = parseWireLine(line);
        if (ev) this.emit(w.cbs, ev);
      }
    } catch {
      /* 读取失败下轮再试 */
    }
  }

  stopAll(): void {
    for (const w of this.watches.values()) clearInterval(w.timer);
    this.watches.clear();
  }
}
