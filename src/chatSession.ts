/**
 * 飞书聊天的常驻交互会话：每个聊天一个 tmux 托管的 kimi 交互进程（编号 0 的会话）。
 *
 * 与终端模式完全同构：消息 send-keys 注入，优先插话 Ctrl+S，中断 Esc；
 * 结果不从进程 stdout 解析，而是监听该会话的 wire.jsonl 转录——
 * assistant 文本聚合，最后一个事件静默 turnEndMs 后判定轮次结束。
 * 常驻进程 = 进程内连续上下文 + 服务端 prefix cache 友好的同一会话前缀。
 */
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { StateStore } from './state.js';
import type { WireEvent, WireWatcher } from './sessionWire.js';
import { sendTmuxKeys, sendTmuxText } from './tmux.js';

const run = promisify(execFile);

export interface ChatSessionEvents {
  /** wire 流事件（进度展示用；think/user 也会来，调用方自行过滤） */
  onStream(chatId: string, ev: WireEvent): void;
  /** 一轮结束：聚合的 assistant 文本（可能为空）与本轮用过的工具 */
  onTurnDone(chatId: string, text: string, tools: string[]): void;
  /** 错误（会话拉起失败等）→ 通知文本 */
  onError(chatId: string, message: string): void;
}

interface SessionEntry {
  chatId: string;
  name: string;
  target: string;
  workDir: string;
  sessionId?: string;
  wireWatching: boolean;
  discovering: boolean;
  busy: boolean;
  textParts: string[];
  tools: string[];
  flushTimer?: NodeJS.Timeout;
}

export class ChatSessionManager {
  /** 轮次结束判定：最后一个 wire 事件后静默多久 flush（测试可调小）。 */
  turnEndMs = 4000;

  private sessions = new Map<string, SessionEntry>();

  constructor(
    private state: StateStore,
    private wires: WireWatcher,
    private events: ChatSessionEvents,
    private kimiBin: string,
    private sessionsDir = path.join(os.homedir(), '.kimi-code', 'sessions'),
  ) {}

  has(chatId: string): boolean {
    return this.sessions.has(chatId);
  }

  isBusy(chatId: string): boolean {
    return this.sessions.get(chatId)?.busy ?? false;
  }

  targetOf(chatId: string): string | null {
    return this.sessions.get(chatId)?.target ?? null;
  }

  activeTasks(): Array<{ chatId: string; prompt: string; ageSec: number }> {
    return [...this.sessions.values()]
      .filter((s) => s.busy)
      .map((s) => ({ chatId: s.chatId, prompt: s.textParts.join(' ').slice(0, 80) || '(进行中)', ageSec: 0 }));
  }

  private nameFor(chatId: string): string {
    return `kcf-chat-${crypto.createHash('sha1').update(chatId).digest('hex').slice(0, 8)}`;
  }

  /** 发送消息到飞书会话（没有就先拉起）。 */
  async send(chatId: string, workDir: string, text: string): Promise<void> {
    const s = await this.ensure(chatId, workDir);
    await sendTmuxText(s.target, text);
    this.beginTurn(s);
  }

  /** 优先插话（Ctrl+S，立即插入运行中的轮次）。 */
  async steer(chatId: string, workDir: string, text: string): Promise<void> {
    const s = await this.ensure(chatId, workDir);
    const flat = text.replace(/\s*\n+\s*/g, ' ').trim();
    if (flat) await run('tmux', ['send-keys', '-t', s.target, '-l', '--', flat]);
    await run('tmux', ['send-keys', '-t', s.target, 'C-s']);
    this.beginTurn(s);
  }

  /** 中断当前轮次（Esc）。返回是否有会话在。 */
  async interrupt(chatId: string): Promise<boolean> {
    const s = this.sessions.get(chatId);
    if (!s) return false;
    try {
      await sendTmuxKeys(s.target, ['Escape']);
      return true;
    } catch {
      return false;
    }
  }

  /** 重置会话（/new）：杀掉 tmux 会话，下条消息全新开始。 */
  async reset(chatId: string): Promise<void> {
    const s = this.sessions.get(chatId);
    if (s) {
      if (s.flushTimer) clearTimeout(s.flushTimer);
      await run('tmux', ['kill-session', '-t', s.name]).catch(() => {});
      this.sessions.delete(chatId);
    }
    this.state.setHasSession(chatId, false);
  }

  async stopAll(): Promise<void> {
    for (const s of this.sessions.values()) {
      if (s.flushTimer) clearTimeout(s.flushTimer);
      await run('tmux', ['kill-session', '-t', s.name]).catch(() => {});
    }
    this.sessions.clear();
  }

  // ---------------------------------------------------------------- 内部

  private async ensure(chatId: string, workDir: string): Promise<SessionEntry> {
    const name = this.nameFor(chatId);
    let s = this.sessions.get(chatId);
    if (s) {
      const alive = await run('tmux', ['has-session', '-t', name]).then(() => true, () => false);
      if (alive) return s;
      this.sessions.delete(chatId);
      s = undefined;
    }

    fs.mkdirSync(workDir, { recursive: true });
    const spawnedAt = Date.now();
    await run('tmux', ['new-session', '-d', '-s', name, '-c', workDir, this.kimiBin]);
    const { stdout } = await run('tmux', ['list-panes', '-t', name, '-F', '#{pane_id}']);
    const target = stdout.trim().split('\n')[0];

    s = {
      chatId, name, target, workDir,
      wireWatching: false, discovering: false, busy: false,
      textParts: [], tools: [],
    };
    this.sessions.set(chatId, s);
    this.state.setHasSession(chatId, true);
    void this.discoverWire(s, spawnedAt);
    return s;
  }

  /** 从新创建的 session 目录发现 kimi session id（会话目录在首个 prompt 前后创建，轮询兜底）。 */
  private async discoverWire(s: SessionEntry, sinceMs: number): Promise<void> {
    if (s.discovering) return;
    s.discovering = true;
    for (let i = 0; i < 20; i++) {
      if (!this.sessions.has(s.chatId)) return; // 会话被重置
      const sessionId = this.findNewestSessionDir(sinceMs);
      if (sessionId) {
        s.sessionId = sessionId;
        const ok = await this.wires.watch(sessionId, (ev) => this.onWire(s, ev));
        if (ok) {
          s.wireWatching = true;
          return;
        }
      }
      await new Promise((r) => setTimeout(r, 800));
    }
  }

  private findNewestSessionDir(sinceMs: number): string | null {
    let best: { id: string; birth: number } | null = null;
    try {
      for (const wd of fs.readdirSync(this.sessionsDir)) {
        const wdDir = path.join(this.sessionsDir, wd);
        for (const sess of fs.readdirSync(wdDir)) {
          const p = path.join(wdDir, sess);
          try {
            const st = fs.statSync(p);
            if (!st.isDirectory() || !sess.startsWith('session_')) continue;
            if (st.birthtimeMs < sinceMs - 5000) continue;
            if (!best || st.birthtimeMs > best.birth) best = { id: sess, birth: st.birthtimeMs };
          } catch {
            /* 竞争删除 */
          }
        }
      }
    } catch {
      /* sessions 目录不存在 */
    }
    return best?.id ?? null;
  }

  /** wire 事件 → 进度回调 + 轮次聚合 + 防抖 flush。 */
  private onWire(s: SessionEntry, ev: WireEvent): void {
    this.events.onStream(s.chatId, ev);
    if (ev.kind === 'text' && ev.text.trim()) s.textParts.push(ev.text);
    else if (ev.kind === 'tool_call' && ev.tool) s.tools.push(ev.tool);

    if (ev.kind === 'user') return; // 注入的回显不算轮次活动
    if (s.flushTimer) clearTimeout(s.flushTimer);
    s.flushTimer = setTimeout(() => this.flush(s), this.turnEndMs);
    s.flushTimer.unref();
  }

  private beginTurn(s: SessionEntry): void {
    s.busy = true;
    s.textParts = [];
    s.tools = [];
    if (s.flushTimer) clearTimeout(s.flushTimer);
    // 兜底：即使 wire 还没就绪/无事件，也在 3 倍防抖后 flush，避免 busy 卡死
    s.flushTimer = setTimeout(() => this.flush(s), this.turnEndMs * 3);
    s.flushTimer.unref();
    // wire 还没就绪（首个 prompt 前）时兜底再发现一次
    if (!s.wireWatching) void this.discoverWire(s, Date.now() - 5000);
  }

  private flush(s: SessionEntry): void {
    s.busy = false;
    const text = s.textParts.join('').trim();
    const tools = [...new Set(s.tools)];
    s.textParts = [];
    s.tools = [];
    this.events.onTurnDone(s.chatId, text, tools);
  }
}
