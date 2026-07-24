/**
 * 终端会话发现与注入：tmux 里的 kimi 会话可远程控制，普通 pts 终端在
 * 内核允许时（legacy_tiocsti=1 + 免密 sudo）也可注入按键。
 *
 * pts 注入原理：TIOCSTI ioctl 把字节塞进终端输入队列（等同敲键盘）。
 * 新内核默认禁用该 ioctl（dev.tty.legacy_tiocsti=0）且要求 root 或
 * 控制会话，所以走 sudo 助手进程；不可用时降级为「仅发现」。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface TermSession {
  /** 注入目标：tmux 窗格 id（%N）或 pts 路径（/dev/pts/N） */
  target: string;
  kind: 'tmux' | 'pts';
  name: string;
  cwd: string;
  pid?: number;
  /** 可注入（tmux，或 pts 且 TIOCSTI 可用）才允许 /t /答题卡 */
  injectable: boolean;
}

/** pts 注入能力：需要内核 legacy_tiocsti=1 + 免密 sudo（TIOCSTI 要 root 或控制会话）。 */
let ptsCapable: boolean | null = null;
export async function canInjectPts(): Promise<boolean> {
  if (ptsCapable !== null) return ptsCapable;
  try {
    const { stdout } = await run('sysctl', ['-n', 'dev.tty.legacy_tiocsti']);
    if (stdout.trim() !== '1') throw new Error('tiocsti off');
    await run('sudo', ['-n', 'python3', '-c', 'import fcntl, termios']);
    ptsCapable = true;
  } catch {
    ptsCapable = false;
  }
  return ptsCapable;
}

/** TIOCSTI 注入助手（root 运行）：把 payload 逐字符塞进终端输入队列。 */
const PTS_INJECT_PY = `import sys, fcntl, termios
tty, payload = sys.argv[1], sys.argv[2].encode()
with open(tty, 'wb', buffering=0) as f:
    for i in range(len(payload)):
        fcntl.ioctl(f, termios.TIOCSTI, payload[i:i+1])
`;

/** 向 pts 注入文本 + 回车（需要 canInjectPts）。多行文本拍平为一行。 */
export async function sendPtsText(tty: string, text: string): Promise<void> {
  const flat = text.replace(/\s*\n+\s*/g, ' ').trim();
  await run('sudo', ['-n', 'python3', '-c', PTS_INJECT_PY, tty, flat + '\n']);
}

/** 向 pts 注入文本 + Ctrl+S（立即插入正在执行的轮次）。 */
export async function sendPtsCtrlS(tty: string, text: string): Promise<void> {
  const flat = text.replace(/\s*\n+\s*/g, ' ').trim();
  await run('sudo', ['-n', 'python3', '-c', PTS_INJECT_PY, tty, flat + '\x13']);
}

/** 向 pts 注入按键序列：'Enter'→换行，'Escape'→ESC，其余取首字符。 */
export async function sendPtsKeys(tty: string, keys: string[]): Promise<void> {
  const payload = keys
    .map((k) => (k === 'Enter' ? '\n' : k === 'Escape' ? '\x1b' : k[0] ?? ''))
    .join('');
  if (payload) await run('sudo', ['-n', 'python3', '-c', PTS_INJECT_PY, tty, payload]);
}

interface ProcInfo {
  pid: number;
  ppid: number;
  tty: string;
  comm: string;
  args: string;
}

function isKimiProc(p: ProcInfo): boolean {
  // kimi TUI 进程 comm 就是 'kimi'；桥自身（node）和 hook 子进程（sh/node）不匹配
  return p.comm === 'kimi';
}

async function processTable(): Promise<ProcInfo[]> {
  const { stdout } = await run('ps', ['-eo', 'pid=,ppid=,tty=,comm=,args=']);
  const out: ProcInfo[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    if (m) out.push({ pid: +m[1], ppid: +m[2], tty: m[3], comm: m[4], args: m[5] });
  }
  return out;
}

function findKimiDescendant(procs: ProcInfo[], rootPid: number, depth = 0): ProcInfo | undefined {
  if (depth > 8) return undefined;
  // pane 根进程本身就是 kimi（tmux 用 sh -c 启动，单命令会被 exec 掉）
  const root = procs.find((p) => p.pid === rootPid);
  if (root && isKimiProc(root)) return root;
  for (const p of procs) {
    if (p.ppid !== rootPid) continue;
    if (isKimiProc(p)) return p;
    const d = findKimiDescendant(procs, p.pid, depth + 1);
    if (d) return d;
  }
  return undefined;
}

function cwdOf(pid?: number): string {
  if (!pid) return '';
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return '';
  }
}

/** 列出所有活着的 kimi 终端会话：tmux（可注入）+ 普通 pts 终端（仅发现）。 */
export async function listKimiSessions(): Promise<TermSession[]> {
  const out: TermSession[] = [];
  let procs: ProcInfo[] = [];
  try {
    procs = await processTable();
  } catch {
    /* ps 失败时退化为只列 tmux */
  }

  // 1) tmux 窗格：进程树里含 kimi 进程（kcf-* 命名保底也收）
  try {
    const { stdout } = await run('tmux', [
      'list-panes', '-a', '-F', '#{session_name}\t#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}',
    ]);
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      const [name, paneId, panePidStr, command, paneCwd] = line.split('\t');
      const kimiProc = findKimiDescendant(procs, Number(panePidStr));
      if (kimiProc || name.startsWith('kcf-')) {
        out.push({
          target: paneId,
          kind: 'tmux',
          name,
          cwd: cwdOf(kimiProc?.pid) || paneCwd,
          pid: kimiProc?.pid,
          injectable: true,
        });
      }
    }
  } catch {
    /* 无 tmux 服务 */
  }

  // 2) 普通终端的 kimi 进程（tty 是 pts 且不在 tmux 里）：TIOCSTI 可用则可注入，否则仅发现
  const ptsOk = await canInjectPts();
  for (const p of procs) {
    if (!isKimiProc(p) || !p.tty.startsWith('pts/')) continue;
    if (out.some((s) => s.pid === p.pid)) continue;
    out.push({
      target: `/dev/${p.tty}`,
      kind: 'pts',
      name: `kimi@${p.tty}`,
      cwd: cwdOf(p.pid),
      pid: p.pid,
      injectable: ptsOk,
    });
  }
  return out;
}

/** 注入文本 + 回车（text 为空则只发回车）。多行文本拍平为一行，避免逐行提交。 */
export async function sendTmuxText(target: string, text: string): Promise<void> {
  const flat = text.replace(/\s*\n+\s*/g, ' ').trim();
  if (flat) await run('tmux', ['send-keys', '-t', target, '-l', '--', flat]);
  await run('tmux', ['send-keys', '-t', target, 'Enter']);
}

/** 注入文本 + Ctrl+S（等价终端里输入后按 Ctrl+S：立即插入正在执行的轮次）。 */
export async function sendTmuxCtrlS(target: string, text: string): Promise<void> {
  const flat = text.replace(/\s*\n+\s*/g, ' ').trim();
  if (flat) await run('tmux', ['send-keys', '-t', target, '-l', '--', flat]);
  await run('tmux', ['send-keys', '-t', target, 'C-s']);
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
