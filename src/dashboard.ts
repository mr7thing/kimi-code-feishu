/**
 * Dashboard：按需开启的本地 WebUI，实时展示各聊天任务的 kimi 终端输出。
 *
 * 安全模型（桥启动时**不**开启）：
 * - 飞书发 /dashboard 才临时拉起 HTTP 服务，每次开启生成新 token、新隧道域名
 * - 页面只读，唯一操作是「关闭 Dashboard」按钮（POST /close）
 * - 双阈值闲置自动关闭：没有打开的页面 → idleNopageMs 关；
 *   有页面在看（可见时每 30s 心跳）→ 心跳停 idlePageMs 关
 *
 * 数据流：KimiRunner/Bridge → Dashboard.publish → SSE 广播给浏览器。
 * 无新依赖：原生 http + SSE（单向日志流，不需要 WebSocket）。
 */
import http from 'node:http';

export type DashKind = 'stdout' | 'stderr' | 'lifecycle' | 'progress';

export interface DashEvent {
  ts: number;
  chatId: string;
  kind: DashKind;
  text: string;
}

const MAX_BUFFER = 500;
const PING_INTERVAL = 25_000;
const IDLE_CHECK_INTERVAL = 30_000;

export class Dashboard {
  private buffer: DashEvent[] = [];
  private clients = new Set<http.ServerResponse>();

  publish(chatId: string, kind: DashKind, text: string): void {
    const ev: DashEvent = { ts: Date.now(), chatId, kind, text };
    this.buffer.push(ev);
    if (this.buffer.length > MAX_BUFFER) this.buffer.shift();
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of this.clients) res.write(line);
  }

  /** SSE 客户端接入：先回放缓冲（后打开的页面也有上下文），再登记为实时订阅者。 */
  subscribe(res: http.ServerResponse): void {
    for (const ev of this.buffer) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    this.clients.add(res);
  }

  unsubscribe(res: http.ServerResponse): void {
    this.clients.delete(res);
  }
}

export interface DashboardServer {
  token: string;
  /** 主动关闭（等价于闲置/页面关闭，会触发 onClose 回调）。 */
  close: (reason?: string) => Promise<void>;
}

export interface ServeDashboardOptions {
  /** 有页面在看时，心跳停多久后关闭（毫秒）。 */
  idlePageMs: number;
  /** 没有打开的页面时，多久后关闭（毫秒）。 */
  idleNopageMs: number;
  /** 任何路径的关闭都会回调（闲置、页面关闭、主动 close）。 */
  onClose: (reason: string) => void;
}

export function serveDashboard(
  dash: Dashboard,
  host: string,
  port: number,
  token: string,
  opts: ServeDashboardOptions,
): Promise<DashboardServer> {
  let lastSignal = Date.now(); // 心跳/打开页面/SSE 接入都刷新
  const sseClients = new Set<http.ServerResponse>();
  let closed = false;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const authed = url.searchParams.get('token') === token;

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (!authed) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('401 Unauthorized：请使用 /dashboard 命令获取带 token 的链接');
      return;
    }

    if (req.method === 'POST' && url.pathname === '/heartbeat') {
      lastSignal = Date.now();
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/close') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('已关闭');
      void shutdown('用户在页面上手动关闭');
      return;
    }

    lastSignal = Date.now(); // 打开页面/接入 SSE 也算活动

    if (url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      dash.subscribe(res);
      sseClients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), PING_INTERVAL);
      req.on('close', () => {
        clearInterval(ping);
        sseClients.delete(res);
        dash.unsubscribe(res);
      });
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(DASHBOARD_HTML);
  });

  async function shutdown(reason: string): Promise<void> {
    if (closed) return;
    closed = true;
    clearInterval(idleCheck);
    // server.close() 不会断开已建立的 SSE 长连接，必须显式销毁，否则永远关不掉
    for (const res of sseClients) res.destroy();
    sseClients.clear();
    await new Promise<void>((r) => server.close(() => r()));
    opts.onClose(reason);
  }

  // 双阈值闲置关闭：有页面在看 → 心跳停 idlePageMs 关；没有页面 → idleNopageMs 关
  const minIdle = Math.min(opts.idlePageMs, opts.idleNopageMs);
  const idleCheck = setInterval(() => {
    const limit = sseClients.size > 0 ? opts.idlePageMs : opts.idleNopageMs;
    if (Date.now() - lastSignal > limit) {
      void shutdown(sseClients.size > 0
        ? `页面停看超过 ${Math.round(opts.idlePageMs / 60000)} 分钟自动关闭`
        : `无人观看超过 ${Math.round(opts.idleNopageMs / 60000)} 分钟自动关闭`);
    }
  }, Math.min(IDLE_CHECK_INTERVAL, Math.max(250, minIdle / 4)));
  idleCheck.unref();

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      console.log(`[dashboard] listening on http://${host}:${port}`);
      resolve({ token, close: (reason = '主动关闭') => shutdown(reason) });
    });
  });
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>kimi-code-feishu Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { background: #1e1e1e; color: #d4d4d4; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  header { position: sticky; top: 0; display: flex; gap: 12px; align-items: center; padding: 8px 12px;
           background: #252526; border-bottom: 1px solid #333; flex-wrap: wrap; }
  header b { color: #fff; }
  header select, header label { font: inherit; color: #d4d4d4; background: #3c3c3c; border: 1px solid #555; border-radius: 4px; padding: 2px 6px; }
  header label { border: none; background: none; cursor: pointer; }
  #dot { width: 8px; height: 8px; border-radius: 50%; background: #f14c4c; display: inline-block; }
  #dot.on { background: #23d18b; }
  #closeBtn { margin-left: auto; font: inherit; color: #fff; background: #c72e2e; border: none; border-radius: 4px; padding: 3px 10px; cursor: pointer; }
  #closeBtn:hover { background: #e04040; }
  #log { padding: 8px 12px 40px; white-space: pre-wrap; word-break: break-all; }
  .line { display: flex; gap: 8px; }
  .time { color: #666; flex-shrink: 0; }
  .chat { color: #c586c0; flex-shrink: 0; max-width: 180px; overflow: hidden; text-overflow: ellipsis; }
  .stdout .text { color: #d4d4d4; }
  .stderr .text { color: #f14c4c; }
  .lifecycle .text { color: #808080; }
  .progress .text { color: #6bcbff; }
  .hide { display: none; }
</style>
</head>
<body>
<header>
  <span id="dot"></span><b>kimi-code-feishu</b>
  <select id="filter"><option value="">全部聊天</option></select>
  <label><input type="checkbox" id="scroll" checked> 自动滚动</label>
  <button id="closeBtn">关闭 Dashboard</button>
</header>
<div id="log"></div>
<script>
const token = new URLSearchParams(location.search).get('token') || '';
const log = document.getElementById('log');
const filter = document.getElementById('filter');
const scrollBox = document.getElementById('scroll');
const dot = document.getElementById('dot');
const closeBtn = document.getElementById('closeBtn');
const knownChats = new Set();

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function addChat(chatId) {
  if (!chatId || knownChats.has(chatId)) return;
  knownChats.add(chatId);
  const opt = document.createElement('option');
  opt.value = chatId;
  opt.textContent = chatId;
  filter.appendChild(opt);
}

function applyFilter() {
  const want = filter.value;
  for (const el of log.children) {
    el.classList.toggle('hide', !!want && el.dataset.chat !== want);
  }
}
filter.onchange = applyFilter;

function append(ev) {
  addChat(ev.chatId);
  const line = document.createElement('div');
  line.className = 'line ' + ev.kind;
  line.dataset.chat = ev.chatId || '';
  const t = document.createElement('span'); t.className = 'time'; t.textContent = fmtTime(ev.ts);
  const c = document.createElement('span'); c.className = 'chat'; c.textContent = ev.chatId || '-';
  const x = document.createElement('span'); x.className = 'text'; x.textContent = ev.text;
  line.append(t, c, x);
  if (filter.value && ev.chatId !== filter.value) line.classList.add('hide');
  log.appendChild(line);
  if (scrollBox.checked) window.scrollTo(0, document.body.scrollHeight);
}

const es = new EventSource('/events?token=' + encodeURIComponent(token));
es.onopen = () => dot.classList.add('on');
es.onerror = () => dot.classList.remove('on');
es.onmessage = (m) => { try { append(JSON.parse(m.data)); } catch {} };

// 心跳保活：页面可见时每 30s 一次；无心跳超过闲置阈值服务端自动关闭
setInterval(() => {
  if (document.visibilityState === 'visible') {
    fetch('/heartbeat?token=' + encodeURIComponent(token), { method: 'POST' }).catch(() => {});
  }
}, 30000);

closeBtn.onclick = async () => {
  if (!confirm('关闭 Dashboard？之后可在飞书发 /dashboard 重新开启')) return;
  closeBtn.disabled = true;
  try { await fetch('/close?token=' + encodeURIComponent(token), { method: 'POST' }); } catch {}
  es.close();
  document.body.innerHTML = '<p style="padding:40px;text-align:center;color:#888">Dashboard 已关闭，可以关掉这个页面了</p>';
};
</script>
</body>
</html>
`;
