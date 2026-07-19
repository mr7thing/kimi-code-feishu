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
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';
import type { Config } from './config.js';
import type { DashKind } from './dashboard.js';
import type { StateStore } from './state.js';
import { parseLine, type StreamEvent } from './streamParser.js';

export interface ChatTask {
  chatId: string;
  prompt: string;
  proc: ChildProcess;
  startedAt: number;
  textParts: string[];
  toolLines: string[];
  rawTail: string[];
}

export interface RunnerCallbacks {
  onTaskStream(chatId: string, event: StreamEvent): void;
  onTaskDone(chatId: string, task: ChatTask, exitCode: number | null, stderrTail: string): void;
}

/** 原始输出监听（dashboard 用）：每一行 stdout、stderr 块、生命周期事件，原文转发。 */
export type OutputListener = (chatId: string, kind: DashKind, text: string) => void;

const trunc = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + '…');

/** stream-json 行 → dashboard 上的一行紧凑可读摘要。 */
export function compactStreamLine(raw: string, ev: StreamEvent | null): string {
  if (!ev) return trunc(raw, 200); // 未识别的协议行
  if (ev.kind === 'tool_call') return `🔧 ${ev.tool}${ev.text ? '｜' + trunc(ev.text.replace(/\s+/g, ' '), 120) : ''}`;
  if (ev.kind === 'tool_result') return `📎 ${trunc((ev.text ?? '').replace(/\s+/g, ' '), 200)}`;
  if (ev.kind === 'done') return '✅ 流结束';
  return trunc(ev.text ?? raw, 400);
}

export class KimiRunner {
  private active = new Map<string, ChatTask>();

  constructor(
    private cfg: Config,
    private state: StateStore,
    private cb: RunnerCallbacks,
    private onOutput?: OutputListener,
  ) {}

  isBusy(chatId: string): boolean {
    return this.active.has(chatId);
  }

  /** 启动一个 headless 任务；该聊天已有任务在跑时返回 false。kimi 不存在时抛错。 */
  submit(chatId: string, prompt: string): boolean {
    if (this.active.has(chatId)) return false;

    const workDir = this.state.getWorkDir(chatId, this.cfg.workDir);
    fs.mkdirSync(workDir, { recursive: true });

    const args: string[] = [];
    if (this.state.hasSession(chatId)) args.push('-c'); // 续接当前目录最近一次会话
    args.push('-p', prompt, '--output-format', 'stream-json', ...this.cfg.kimiExtraArgs);

    let proc: ChildProcess;
    try {
      proc = spawn(this.cfg.kimiBin, args, {
        cwd: workDir,
        detached: process.platform !== 'win32', // 独立进程组，便于整组终止
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw err;
      throw err;
    }

    const task: ChatTask = {
      chatId, prompt, proc,
      startedAt: Date.now(),
      textParts: [], toolLines: [], rawTail: [],
    };
    this.active.set(chatId, task);
    this.state.setHasSession(chatId, true);
    this.onOutput?.(chatId, 'lifecycle', `▶ 任务启动：${prompt.slice(0, 200)}`);

    let stderrTail = '';
    proc.stderr?.on('data', (d: Buffer) => {
      const text = d.toString('utf-8');
      stderrTail = (stderrTail + text).slice(-2000);
      this.onOutput?.(chatId, 'stderr', trunc(text.replace(/\n+$/, ''), 300));
    });

    const rl = readline.createInterface({ input: proc.stdout! });
    rl.on('line', (line) => {
      const ev = parseLine(line);
      this.onOutput?.(chatId, 'stdout', compactStreamLine(line, ev));
      if (!ev) return;
      if (ev.kind === 'text') task.textParts.push(ev.text ?? '');
      else if (ev.kind === 'tool_call' || ev.kind === 'tool_result') task.toolLines.push(`${ev.kind}:${ev.tool}`);
      else if (ev.kind === 'raw') {
        task.rawTail.push(ev.text ?? '');
        if (task.rawTail.length > 30) task.rawTail.shift();
      }
      try {
        this.cb.onTaskStream(chatId, ev);
      } catch (err) {
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
      this.onOutput?.(chatId, 'lifecycle', `✖ 进程错误：${String(err)}`);
      this.cb.onTaskDone(chatId, task, 127, String(err));
    });

    proc.on('close', (code) => {
      clearTimeout(watchdog);
      this.active.delete(chatId);
      this.onOutput?.(chatId, 'lifecycle', `■ 任务结束，exit=${code ?? 'null'}`);
      try {
        this.cb.onTaskDone(chatId, task, code, stderrTail);
      } catch (err) {
        console.error('[runner] done callback failed:', err);
      }
    });

    return true;
  }

  stop(chatId: string): boolean {
    const task = this.active.get(chatId);
    if (!task) return false;
    this.kill(task);
    return true;
  }

  stopAll(): void {
    for (const task of this.active.values()) this.kill(task);
  }

  private kill(task: ChatTask): void {
    const pid = task.proc.pid;
    this.onOutput?.(task.chatId, 'lifecycle', '⏹ 已发送终止信号');
    try {
      if (process.platform !== 'win32' && pid) {
        process.kill(-pid, 'SIGTERM'); // 杀整个进程组
      } else {
        task.proc.kill('SIGTERM');
      }
    } catch {
      /* 进程可能已退出 */
    }
    setTimeout(() => {
      try {
        if (process.platform !== 'win32' && pid) process.kill(-pid, 'SIGKILL');
        else task.proc.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }, 5000).unref();
  }
}
