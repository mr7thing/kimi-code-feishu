/**
 * 轻量持久化状态：聊天绑定、会话标记、session/cwd → chat 路由。JSON 文件。
 * Node 单线程事件循环，无需锁。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG_DIR } from './config.js';

interface ChatInfo {
  work_dir?: string;
  has_session?: boolean;
  attach?: string;
}

interface StateData {
  chats: Record<string, ChatInfo>;
  session_routes: Record<string, string>;
  default_notify_chat: string | null;
  /** 审批池：进池的目录（cwd）对应的终端会话才弹审批卡/推进度 */
  approval_pool: string[];
}

export class StateStore {
  private file: string;
  private data: StateData;

  constructor(file?: string) {
    this.file = file ?? path.join(DEFAULT_CONFIG_DIR, 'state.json');
    this.data = { chats: {}, session_routes: {}, default_notify_chat: null, approval_pool: [] };
    if (fs.existsSync(this.file)) {
      try {
        Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf-8')));
      } catch {
        /* 状态文件损坏就从零开始 */
      }
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1), 'utf-8');
    fs.renameSync(tmp, this.file);
  }

  // ---- 聊天绑定 ----
  getWorkDir(chatId: string, fallback: string): string {
    return this.data.chats[chatId]?.work_dir ?? fallback;
  }

  setWorkDir(chatId: string, workDir: string): void {
    (this.data.chats[chatId] ??= {}).work_dir = workDir;
    this.save();
  }

  hasSession(chatId: string): boolean {
    return !!this.data.chats[chatId]?.has_session;
  }

  setHasSession(chatId: string, value: boolean): void {
    (this.data.chats[chatId] ??= {}).has_session = value;
    this.save();
  }

  /** 聊天绑定的 tmux 会话目标（/a 绑定，/t /s 使用） */
  getAttach(chatId: string): string | null {
    return this.data.chats[chatId]?.attach ?? null;
  }

  setAttach(chatId: string, target: string | null): void {
    if (target === null) delete this.data.chats[chatId]?.attach;
    else (this.data.chats[chatId] ??= {}).attach = target;
    this.save();
  }

  touchChat(chatId: string): void {
    this.data.default_notify_chat = chatId;
    this.save();
  }

  defaultNotifyChat(): string | null {
    return this.data.default_notify_chat;
  }

  // ---- 审批池（按目录） ----
  getPool(): string[] {
    return [...this.data.approval_pool];
  }

  inPool(cwd?: string): boolean {
    if (!cwd) return false;
    const norm = path.resolve(cwd);
    return this.data.approval_pool.some((p) => path.resolve(p) === norm);
  }

  /** 切换池状态，返回切换后是否在池。 */
  togglePool(cwd: string): boolean {
    const norm = path.resolve(cwd);
    const i = this.data.approval_pool.findIndex((p) => path.resolve(p) === norm);
    if (i >= 0) {
      this.data.approval_pool.splice(i, 1);
      this.save();
      return false;
    }
    this.data.approval_pool.push(norm);
    this.save();
    return true;
  }

  // ---- session_id / cwd → chat 路由 ----
  bindSession(sessionId: string, chatId: string): void {
    this.data.session_routes[sessionId] = chatId;
    this.save();
  }

  chatForSession(sessionId?: string): string | null {
    if (!sessionId) return null;
    return this.data.session_routes[sessionId] ?? null;
  }

  chatForCwd(cwd?: string): string | null {
    if (!cwd) return null;
    const norm = path.resolve(cwd);
    for (const [chatId, info] of Object.entries(this.data.chats)) {
      if (info.work_dir && path.resolve(info.work_dir) === norm) return chatId;
    }
    return null;
  }
}
