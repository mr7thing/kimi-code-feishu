/**
 * cloudflared quick tunnel 托管：/dashboard 开启时拉起，关闭时杀掉。
 * 每次拿到新的 trycloudflare 随机域名——旧链接随隧道死亡自毁。
 */
import { spawn, type ChildProcess } from 'node:child_process';

export interface TunnelHandle {
  url: string;
  proc: ChildProcess;
}

/**
 * 拉起 quick tunnel 并解析 trycloudflare 域名（从 stdout/stderr，最多等 timeoutMs）。
 * 未安装 / 超时 / 进程退出 → 返回 null（调用方回退局域网链接）。
 */
export function startCloudflaredTunnel(bin: string, localPort: number, timeoutMs = 15_000): Promise<TunnelHandle | null> {
  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${localPort}`, '--no-autoupdate'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve(null);
      return;
    }
    let done = false;
    const timer = setTimeout(() => finish(null), timeoutMs);
    function finish(h: TunnelHandle | null): void {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!h) proc.kill('SIGTERM');
      resolve(h);
    }
    const onData = (d: Buffer) => {
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(d.toString());
      if (m) finish({ url: m[0], proc });
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.on('error', () => finish(null));
    proc.on('exit', () => finish(null));
  });
}
