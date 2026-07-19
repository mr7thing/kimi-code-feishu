/**
 * 本地 HTTP 服务：接收 Kimi CLI hook 发来的事件。
 * 只监听 127.0.0.1，不暴露到公网。
 */
import http from 'node:http';
import type { Bridge } from './bridge.js';

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', () => resolve(''));
  });
}

function writeJson(res: http.ServerResponse, obj: unknown, status = 200): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

export interface HookServer {
  server: http.Server;
  close: () => Promise<void>;
}

export function serveHooks(bridge: Bridge, host: string, port: number): Promise<HookServer> {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        writeJson(res, { ok: true });
        return;
      }
      if (req.method === 'POST') {
        const raw = await readBody(req);
        let body: Record<string, unknown> = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          body = {};
        }
        if (req.url === '/hook/pre_tool_use') {
          writeJson(res, await bridge.handlePreToolUse(body));
          return;
        }
        if (req.url === '/hook/event') {
          // 观察型事件：立即响应，异步处理，不阻塞 hook 进程
          void bridge.handleHookEvent(String(body.event ?? ''), (body.payload ?? {}) as Record<string, unknown>);
          writeJson(res, { ok: true });
          return;
        }
      }
      writeJson(res, { error: 'not found' }, 404);
    } catch (err) {
      console.error('[hook-server] error:', err);
      // fail-open：桥内部异常不应阻断 CLI
      writeJson(res, { decision: 'allow', reason: 'bridge internal error' });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      console.log(`[hook-server] listening on http://${host}:${port}`);
      resolve({
        server,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}
