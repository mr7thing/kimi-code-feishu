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

/** wire.jsonl 一行 → dashboard 一行；不关心的类型返回 null。 */
export function renderWireLine(line: string): string | null {
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
    return text ? `👤 ${trunc(text, 200)}` : null;
  }

  if (t === 'context.append_loop_event') {
    const ev = e.event as Record<string, unknown> | undefined;
    const et = String(ev?.type ?? '');
    if (et === 'content.part') {
      const part = ev?.part as Record<string, unknown> | undefined;
      if (part?.type === 'think') return `💭 ${trunc(String(part.think ?? ''), 150)}`;
      if (part?.type === 'text') return `🤖 ${trunc(String(part.text ?? ''), 300)}`;
      return null;
    }
    if (et === 'tool.call') {
      return `🔧 ${String(ev?.name ?? '?')}${toolArgsBrief(ev?.args) ? `：${toolArgsBrief(ev?.args)}` : ''}`;
    }
    if (et === 'tool.result') {
      const out = String((ev?.result as Record<string, unknown>)?.output ?? '');
      return out.trim() ? `📎 ${trunc(out.replace(/\s+/g, ' '), 120)}` : null;
    }
    return null;
  }

  if (t === 'turn.steer') return '⚡ 用户插话干预';
  if (t === 'turn.cancel') return '⛔ 本轮被取消';
  return null;
}

interface WatchEntry {
  sessionId: string;
  timer: NodeJS.Timeout;
  offset: number;
}

export class WireWatcher {
  private watches = new Map<string, WatchEntry>();

  constructor(private sessionsDir = path.join(os.homedir(), '.kimi-code', 'sessions')) {}

  /** 开始监听某会话的 wire 转录（幂等）。找不到转录文件返回 false。 */
  async watch(sessionId: string, cb: (line: string) => void): Promise<boolean> {
    if (!sessionId || this.watches.has(sessionId)) return this.watches.has(sessionId);
    const file = this.findWirePath(sessionId);
    if (!file) return false;

    // 首次回放慢最近 15 条（从文件尾 64KB 里解析）
    this.backfill(file, cb);

    const offset = fs.statSync(file).size;
    const timer = setInterval(() => this.pump(sessionId, file, cb), 1500);
    timer.unref();
    this.watches.set(sessionId, { sessionId, timer, offset });
    return true;
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

  private backfill(file: string, cb: (line: string) => void): void {
    try {
      const stat = fs.statSync(file);
      const start = Math.max(0, stat.size - 64 * 1024);
      const buf = Buffer.alloc(stat.size - start);
      const fd = fs.openSync(file, 'r');
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      const lines = buf
        .toString('utf-8')
        .split('\n')
        .map(renderWireLine)
        .filter((l): l is string => !!l);
      for (const l of lines.slice(-15)) cb('⏪ ' + l);
    } catch {
      /* 回放失败不阻塞 */
    }
  }

  private pump(sessionId: string, file: string, cb: (line: string) => void): void {
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
        const rendered = renderWireLine(line);
        if (rendered) cb(rendered);
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
