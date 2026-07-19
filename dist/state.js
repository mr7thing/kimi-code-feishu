/**
 * 轻量持久化状态：聊天绑定、会话标记、session/cwd → chat 路由。JSON 文件。
 * Node 单线程事件循环，无需锁。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG_DIR } from './config.js';
export class StateStore {
    file;
    data;
    constructor(file) {
        this.file = file ?? path.join(DEFAULT_CONFIG_DIR, 'state.json');
        this.data = { chats: {}, session_routes: {}, default_notify_chat: null };
        if (fs.existsSync(this.file)) {
            try {
                Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf-8')));
            }
            catch {
                /* 状态文件损坏就从零开始 */
            }
        }
    }
    save() {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = this.file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1), 'utf-8');
        fs.renameSync(tmp, this.file);
    }
    // ---- 聊天绑定 ----
    getWorkDir(chatId, fallback) {
        return this.data.chats[chatId]?.work_dir ?? fallback;
    }
    setWorkDir(chatId, workDir) {
        (this.data.chats[chatId] ??= {}).work_dir = workDir;
        this.save();
    }
    hasSession(chatId) {
        return !!this.data.chats[chatId]?.has_session;
    }
    setHasSession(chatId, value) {
        (this.data.chats[chatId] ??= {}).has_session = value;
        this.save();
    }
    touchChat(chatId) {
        this.data.default_notify_chat = chatId;
        this.save();
    }
    defaultNotifyChat() {
        return this.data.default_notify_chat;
    }
    // ---- session_id / cwd → chat 路由 ----
    bindSession(sessionId, chatId) {
        this.data.session_routes[sessionId] = chatId;
        this.save();
    }
    chatForSession(sessionId) {
        if (!sessionId)
            return null;
        return this.data.session_routes[sessionId] ?? null;
    }
    chatForCwd(cwd) {
        if (!cwd)
            return null;
        const norm = path.resolve(cwd);
        for (const [chatId, info] of Object.entries(this.data.chats)) {
            if (info.work_dir && path.resolve(info.work_dir) === norm)
                return chatId;
        }
        return null;
    }
}
