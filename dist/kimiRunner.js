/**
 * Kimi headless 运行器：每个飞书聊天一个工作目录、同时最多一个任务。
 *
 * 调用方式：
 *   kimi -p "<prompt>" --output-format stream-json            # 新会话
 *   kimi -c -p "<prompt>" --output-format stream-json         # 续接该目录最近会话
 *
 * 非交互模式固定 auto 权限（自动批准），因此审批闸门完全由
 * PreToolUse hook（飞书卡片）承担。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';
import { parseLine } from './streamParser.js';
export class KimiRunner {
    cfg;
    state;
    cb;
    active = new Map();
    constructor(cfg, state, cb) {
        this.cfg = cfg;
        this.state = state;
        this.cb = cb;
    }
    isBusy(chatId) {
        return this.active.has(chatId);
    }
    /** 启动一个 headless 任务；该聊天已有任务在跑时返回 false。kimi 不存在时抛错。 */
    submit(chatId, prompt) {
        if (this.active.has(chatId))
            return false;
        const workDir = this.state.getWorkDir(chatId, this.cfg.workDir);
        fs.mkdirSync(workDir, { recursive: true });
        const args = [];
        if (this.state.hasSession(chatId))
            args.push('-c'); // 续接当前目录最近一次会话
        args.push('-p', prompt, '--output-format', 'stream-json', ...this.cfg.kimiExtraArgs);
        let proc;
        try {
            proc = spawn(this.cfg.kimiBin, args, {
                cwd: workDir,
                detached: process.platform !== 'win32', // 独立进程组，便于整组终止
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        }
        catch (err) {
            if (err.code === 'ENOENT')
                throw err;
            throw err;
        }
        const task = {
            chatId, prompt, proc,
            startedAt: Date.now(),
            textParts: [], toolLines: [], rawTail: [],
        };
        this.active.set(chatId, task);
        this.state.setHasSession(chatId, true);
        let stderrTail = '';
        proc.stderr?.on('data', (d) => {
            stderrTail = (stderrTail + d.toString('utf-8')).slice(-2000);
        });
        const rl = readline.createInterface({ input: proc.stdout });
        rl.on('line', (line) => {
            const ev = parseLine(line);
            if (!ev)
                return;
            if (ev.kind === 'text')
                task.textParts.push(ev.text ?? '');
            else if (ev.kind === 'tool_call' || ev.kind === 'tool_result')
                task.toolLines.push(`${ev.kind}:${ev.tool}`);
            else if (ev.kind === 'raw') {
                task.rawTail.push(ev.text ?? '');
                if (task.rawTail.length > 30)
                    task.rawTail.shift();
            }
            try {
                this.cb.onTaskStream(chatId, ev);
            }
            catch (err) {
                console.error('[runner] stream callback failed:', err);
            }
        });
        // 看门狗：超长任务强制终止
        const watchdog = setTimeout(() => {
            task.rawTail.push(`[kimi-code-feishu] 任务超过 ${this.cfg.taskTimeout}s，已强制终止`);
            this.kill(task);
        }, this.cfg.taskTimeout * 1000);
        proc.on('error', (err) => {
            // spawn 失败（如 ENOENT）
            clearTimeout(watchdog);
            this.active.delete(chatId);
            this.cb.onTaskDone(chatId, task, 127, String(err));
        });
        proc.on('close', (code) => {
            clearTimeout(watchdog);
            this.active.delete(chatId);
            try {
                this.cb.onTaskDone(chatId, task, code, stderrTail);
            }
            catch (err) {
                console.error('[runner] done callback failed:', err);
            }
        });
        return true;
    }
    stop(chatId) {
        const task = this.active.get(chatId);
        if (!task)
            return false;
        this.kill(task);
        return true;
    }
    stopAll() {
        for (const task of this.active.values())
            this.kill(task);
    }
    kill(task) {
        const pid = task.proc.pid;
        try {
            if (process.platform !== 'win32' && pid) {
                process.kill(-pid, 'SIGTERM'); // 杀整个进程组
            }
            else {
                task.proc.kill('SIGTERM');
            }
        }
        catch {
            /* 进程可能已退出 */
        }
        setTimeout(() => {
            try {
                if (process.platform !== 'win32' && pid)
                    process.kill(-pid, 'SIGKILL');
                else
                    task.proc.kill('SIGKILL');
            }
            catch {
                /* 已退出 */
            }
        }, 5000).unref();
    }
}
