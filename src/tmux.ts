/**
 * tmux 集成：终端交互会话的发现、输入注入（send-keys）、画面抓取（capture-pane）。
 *
 * 桥通过它把飞书变成 tmux 里 kimi 会话的远程键盘：
 * - 会话发现：列出所有 kcf-* 命名会话及含 kimi 进程的窗格
 * - 输入注入：send-keys 字面文本 + Enter，等价于在终端敲键盘
 * - 画面抓取：capture-pane 纯文本快照，/s 命令发到飞书
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface TmuxSession {
  /** tmux 窗格目标（%N），send-keys/capture-pane 直接用 */
  target: string;
  name: string;
  cwd: string;
  command: string;
}

/** 列出 tmux 里的 kimi 会话（kcf-* 命名 或 窗格前台命令含 kimi）。tmux 未装/无服务返回空。 */
export async function listKimiSessions(): Promise<TmuxSession[]> {
  try {
    const { stdout } = await run('tmux', [
      'list-panes', '-a', '-F', '#{session_name}\t#{pane_id}\t#{pane_current_command}\t#{pane_current_path}',
    ]);
    const out: TmuxSession[] = [];
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      const [name, paneId, command, cwd] = line.split('\t');
      if (name.startsWith('kcf-') || /kimi/i.test(command ?? '')) {
        out.push({ target: paneId, name, cwd, command });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** 注入文本 + 回车（text 为空则只发回车）。多行文本拍平为一行，避免逐行提交。 */
export async function sendTmuxText(target: string, text: string): Promise<void> {
  const flat = text.replace(/\s*\n+\s*/g, ' ').trim();
  if (flat) await run('tmux', ['send-keys', '-t', target, '-l', '--', flat]);
  await run('tmux', ['send-keys', '-t', target, 'Enter']);
}

/** 原始按键注入（数字键/方向键/Escape 等，每个元素一次 send-keys 动作）。 */
export async function sendTmuxKeys(target: string, keys: string[]): Promise<void> {
  for (const k of keys) await run('tmux', ['send-keys', '-t', target, k]);
}

/** 抓取窗格最近 lines 行画面（纯文本）。 */
export async function captureTmux(target: string, lines = 30): Promise<string> {
  const { stdout } = await run('tmux', ['capture-pane', '-p', '-t', target, '-S', `-${lines}`]);
  return stdout;
}
