/**
 * kimi-code-feishu (TS) 自检：不依赖真实飞书/真实 kimi 的端到端测试。
 * 运行：npm run build && node dist/selfcheck.js
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parse as parseToml } from 'smol-toml';
import { ApprovalManager } from './approvals.js';
import { pollAppRegistration, RegistrationError, requestAppRegistration } from './appRegistration.js';
import { Bridge, toolInputSummary } from './bridge.js';
import { loadConfig, saveConfig } from './config.js';
import { ChatLogger, LoggingChannel } from './chatLogger.js';
import { Dashboard, serveDashboard } from './dashboard.js';
import { serveHooks } from './hookServer.js';
import * as installer from './installer.js';
import { StateStore } from './state.js';
import { parseLine } from './streamParser.js';
import { canInjectPts, captureTmux, listKimiSessions, sendPtsText, sendTmuxText } from './tmux.js';
import type { Channel } from './channel.js';

const execFileP = promisify(execFile);
const DIST = path.dirname(fileURLToPath(import.meta.url));
const HOOK_JS = path.join(DIST, 'hook.js');

const results: Array<[string, boolean]> = [];
function check(name: string, cond: boolean): void {
  results.push([name, cond]);
  console.log(`${cond ? '✅' : '❌'} ${name}`);
}

class FakeChannel implements Channel {
  sent: Array<{ chatId: string; kind: 'text' | 'card'; content: unknown }> = [];
  updated: string[] = [];
  private mid = 0;
  start(): void {}
  async sendText(chatId: string, text: string): Promise<string | undefined> {
    this.sent.push({ chatId, kind: 'text', content: text });
    return `mid-${++this.mid}`;
  }
  async sendCard(chatId: string, card: Record<string, unknown>): Promise<string | undefined> {
    this.sent.push({ chatId, kind: 'card', content: card });
    return `mid-${++this.mid}`;
  }
  async updateText(messageId: string): Promise<void> { this.updated.push(messageId); }
  async updateCard(messageId: string): Promise<void> { this.updated.push(messageId); }
  cards(): Array<Record<string, unknown>> {
    return this.sent.filter((s) => s.kind === 'card').map((s) => s.content as Record<string, unknown>);
  }
  texts(): string[] {
    return this.sent.filter((s) => s.kind === 'text').map((s) => s.content as string);
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function makeConfig(tmp: string, port: number): string {
  const p = path.join(tmp, 'config.toml');
  fs.writeFileSync(p, `
app_id = "cli_test"
app_secret = "secret"
allowed_user_ids = ["ou_boss"]
work_dir = "${tmp.replace(/\\/g, '\\\\')}"
bridge_port = ${port}
approval_timeout = 10
on_timeout = "deny"
fail_closed = true
kimi_bin = "kimi"
log_dir = "${tmp.replace(/\\/g, '\\\\')}/logs"
`, 'utf-8');
  return p;
}

async function runHook(cfgPath: string, event: string, payload: unknown): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_JS, event], {
      env: { ...process.env, KCF_CONFIG: cfgPath, KCF_DISABLED: undefined },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, code: code ?? -1 }));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 判断 hook stdout 是否输出了结构化 deny（与序列化空格格式无关）。 */
function isDeny(stdout: string): boolean {
  try {
    const obj = JSON.parse(stdout) as { hookSpecificOutput?: { permissionDecision?: string } };
    return obj.hookSpecificOutput?.permissionDecision === 'deny';
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  // ---------------------------------------------------------------- 1. 配置
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kcf-cfg-'));
    const cfg = loadConfig(makeConfig(tmp, 12345));
    check('配置加载: app_id', cfg.appId === 'cli_test');
    check('配置加载: approval_timeout', cfg.approvalTimeout === 10);
    check('配置加载: 默认 auto_allow_tools 非空', cfg.autoAllowTools.length > 3);

    // onboard 写入配置：renderExampleConfig 带真实值 → 合法 TOML 且可回读
    const cfgPath2 = path.join(tmp, 'onboard.toml');
    saveConfig({ appId: 'cli_onboard', appSecret: 'sec_onboard', allowedUserIds: ['ou_scan'] }, cfgPath2);
    const cfg2 = loadConfig(cfgPath2);
    check('配置写入: 真实值可解析回读', cfg2.appId === 'cli_onboard' && cfg2.allowedUserIds.includes('ou_scan'));
    let overwriteThrew = false;
    try { saveConfig({ appId: 'x', appSecret: 'y' }, cfgPath2); } catch { overwriteThrew = true; }
    check('配置写入: 拒绝覆盖已有文件', overwriteThrew);
  }

  // ---------------------------------------------------------------- 2. 解析器
  {
    const ev1 = parseLine('{"type":"assistant","message":{"content":[{"type":"text","text":"你好"}]}}');
    check('解析器: assistant 文本', ev1?.kind === 'text' && (ev1.text ?? '').includes('你好'));
    const ev2 = parseLine('{"type":"tool_use","name":"Shell"}');
    check('解析器: 工具调用', ev2?.kind === 'tool_call' && ev2.tool === 'Shell');
    check('解析器: 非 JSON 行降级 raw', parseLine('not json at all')?.kind === 'raw');
    check('解析器: 空行返回 null', parseLine('') === null);
    // 真实 stream-json 格式（OpenAI 风格 role 字段）
    const ev3 = parseLine('{"role":"assistant","content":"我先看看","tool_calls":[{"type":"function","function":{"name":"Bash"}}]}');
    check('解析器: role=assistant 带 tool_calls', ev3?.kind === 'tool_call' && ev3.tool === 'Bash' && ev3.text === '我先看看');
    const ev4 = parseLine('{"role":"tool","tool_call_id":"x","content":"file1\\nfile2"}');
    check('解析器: role=tool 工具返回', ev4?.kind === 'tool_result' && (ev4.text ?? '').includes('file1'));
  }

  // ---------------------------------------------------------------- 3. 审批管理器
  {
    const am = new ApprovalManager();
    const ap = am.create({ tool_name: 'Shell', session_id: 's1' });
    setTimeout(() => am.decide(ap.reqId, 'allow', 'ou_boss'), 100);
    const r1 = await am.wait(ap, 5000);
    check('审批: 批准路径', r1.decision === 'allow');
    const ap2 = am.create({ tool_name: 'Shell', session_id: 's1' });
    am.decide(ap2.reqId, 'allow_session', 'ou_boss');
    check('审批: 本会话允许生效', am.isSessionAllowed('s1', 'Shell'));
    const ap3 = am.create({ tool_name: 'WriteFile', session_id: 's2' });
    const r3 = await am.wait(ap3, 300);
    check('审批: 超时 decision=null', r3.decision === null);
  }

  // ---------------------------------------------------------------- 4. 安装器
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kcf-inst-'));
    const kimiCfg = path.join(tmp, 'config.toml');
    fs.writeFileSync(kimiCfg, 'default_model = "k2"\n', 'utf-8');
    installer.install(kimiCfg, 120, '/tmp/x/config.toml');
    let text = fs.readFileSync(kimiCfg, 'utf-8');
    check('安装器: 保留原配置', text.includes('default_model = "k2"'));
    check('安装器: 写入 PreToolUse', text.includes('event = "PreToolUse"'));
    check('安装器: 写入进度事件', text.includes('event = "PostToolUse"') && text.includes('event = "Stop"'));
    check('安装器: timeout=审批+30', text.includes('timeout = 150'));
    check('安装器: hook 命令指向本包 hook.js', text.includes('hook.js pre_tool_use'));
    // 回归：写出的必须是合法 TOML，且转义后命令里的 KCF_CONFIG 保持完整
    const parsed = parseToml(text) as { hooks?: Array<{ command?: string }> };
    check('安装器: 生成的 TOML 可解析', Array.isArray(parsed.hooks) && parsed.hooks.length === 11);
    check('安装器: 解析后 KCF_CONFIG 完整', (parsed.hooks?.[0]?.command ?? '').includes('KCF_CONFIG="/tmp/x/config.toml"'));
    let threw = false;
    try { installer.install(kimiCfg); } catch { threw = true; }
    check('安装器: 重复安装报错', threw);
    installer.uninstall(kimiCfg);
    text = fs.readFileSync(kimiCfg, 'utf-8');
    check('安装器: 卸载干净', !text.includes('kimi-code-feishu') && text.includes('default_model = "k2"'));
  }

  // ---------------------------------------------------------------- 5. 端到端：审批回环
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kcf-e2e-'));
    const port = await freePort();
    const cfgPath = makeConfig(tmp, port);
    const cfg = loadConfig(cfgPath);
    const state = new StateStore(path.join(tmp, 'state.json'));
    state.setWorkDir('chat-1', tmp);
    const channel = new FakeChannel();
    const bridge = new Bridge(cfg, state, channel);
    const hookServer = await serveHooks(bridge, cfg.bridgeHost, port);
    await sleep(200);

    // 5.1 危险命令：命中自动拒绝规则，不发卡片
    let r = await runHook(cfgPath, 'pre_tool_use', {
      session_id: 's1', cwd: tmp, tool_name: 'Shell', tool_input: { command: 'rm -rf /' },
    });
    check('端到端: 自动拒绝 rm -rf /', isDeny(r.stdout));
    check('端到端: 自动拒绝未发卡片', channel.cards().length === 0);

    // 5.2 只读工具：自动放行
    r = await runHook(cfgPath, 'pre_tool_use', {
      session_id: 's1', cwd: tmp, tool_name: 'ReadFile', tool_input: { file_path: '/etc/hostname' },
    });
    check('端到端: 只读工具自动放行', r.stdout.trim() === '' && r.code === 0);
    r = await runHook(cfgPath, 'pre_tool_use', {
      session_id: 's1', cwd: tmp, tool_name: 'ReadMediaFile', tool_input: { path: '/tmp/a.png' },
    });
    check('端到端: ReadMediaFile 自动放行（真实工具名）', r.stdout.trim() === '' && r.code === 0);

    // 5.2b 审批池：未进池的终端会话直接放行、不弹卡、不转发进度
    r = await runHook(cfgPath, 'pre_tool_use', {
      session_id: 's-term', cwd: tmp, tool_name: 'Shell', tool_input: { command: 'make build' },
    });
    check('审批池: 未进池终端会话放行不弹卡', r.stdout.trim() === '' && channel.cards().length === 0);
    const textsBefore = channel.texts().length;
    await runHook(cfgPath, 'posttooluse', { session_id: 's-term', cwd: tmp, tool_name: 'Shell' });
    await sleep(300);
    check('审批池: 未进池不转发进度', channel.texts().length === textsBefore);
    await runHook(cfgPath, 'permissionrequest', { session_id: 's-term', cwd: tmp, tool_name: 'Shell' });
    await sleep(300);
    check('审批池: PermissionRequest 被动通知', channel.texts().some((t) => t.includes('等待权限')));

    // 进池后恢复卡片/进度语义
    state.togglePool(tmp);

    // 5.3 需审批工具：发卡片 → 模拟用户在飞书点"批准"
    let returnedCard: Record<string, unknown> | null = null;
    const approver = (async () => {
      for (let i = 0; i < 50; i++) {
        const cards = channel.cards();
        if (cards.length >= 1) {
          const actions = (cards[0].elements as Array<Record<string, unknown>>)[2].actions as Array<Record<string, unknown>>;
          await sleep(100);
          returnedCard = bridge.onCardAction(actions[0].value as Record<string, unknown>, 'ou_boss');
          return;
        }
        await sleep(100);
      }
    })();
    r = await runHook(cfgPath, 'pre_tool_use', {
      session_id: 's1', cwd: tmp, tool_name: 'Shell', tool_input: { command: 'git push origin main' },
    });
    await approver;
    check('端到端: 飞书批准后放行', r.code === 0 && !r.stdout.includes('deny'));
    check('端到端: 发出了审批卡片', channel.cards().length >= 1);
    check('端到端: 回调内联返回结果卡片', !!returnedCard && JSON.stringify(returnedCard).includes('已批准'));
    check('端到端: 卡片声明 update_multi', JSON.stringify(channel.cards()[0]).includes('"update_multi":true'));
    await sleep(200);
    check('端到端: 卡片已更新为结果', channel.updated.length >= 1);

    // 5.4 拒绝路径
    const denier = (async () => {
      for (let i = 0; i < 50; i++) {
        const cards = channel.cards();
        if (cards.length >= 2) {
          const actions = (cards[1].elements as Array<Record<string, unknown>>)[2].actions as Array<Record<string, unknown>>;
          await sleep(100);
          bridge.onCardAction(actions[2].value as Record<string, unknown>, 'ou_boss'); // 拒绝按钮
          return;
        }
        await sleep(100);
      }
    })();
    r = await runHook(cfgPath, 'pre_tool_use', {
      session_id: 's1', cwd: tmp, tool_name: 'WriteFile', tool_input: { file_path: '/tmp/x.txt', content: 'hi' },
    });
    await denier;
    check('端到端: 飞书拒绝输出 deny JSON', isDeny(r.stdout));

    // 5.5 非白名单用户点卡片无效 → 超时 deny
    const evil = (async () => {
      for (let i = 0; i < 50; i++) {
        const cards = channel.cards();
        if (cards.length >= 3) {
          const actions = (cards[2].elements as Array<Record<string, unknown>>)[2].actions as Array<Record<string, unknown>>;
          bridge.onCardAction(actions[0].value as Record<string, unknown>, 'ou_hacker');
          return;
        }
        await sleep(100);
      }
    })();
    const t0 = Date.now();
    r = await runHook(cfgPath, 'pre_tool_use', {
      session_id: 's1', cwd: tmp, tool_name: 'Shell', tool_input: { command: 'make deploy' },
    });
    await evil;
    check('端到端: 非白名单点击被忽略且超时拒绝',
      isDeny(r.stdout) && Date.now() - t0 >= cfg.approvalTimeout * 1000 - 1000);

    // 5.6 进度事件 → 飞书进度消息
    await runHook(cfgPath, 'posttooluse', {
      session_id: 's9', cwd: tmp, tool_name: 'Shell', tool_input: { command: 'ls' }, tool_output: 'ok',
    });
    await sleep(400);
    check('端到端: 进度事件推送到飞书', channel.texts().some((t) => t.includes('执行中')));

    // 5.7 聊天命令
    await bridge.onFeishuMessage('chat-1', 'ou_stranger', '/id');
    check('命令: /id 返回 open_id', channel.texts().some((t) => t.includes('ou_stranger')));
    const n = channel.texts().length;
    await bridge.onFeishuMessage('chat-1', 'ou_hacker', '帮我删库');
    check('命令: 未授权用户被拒绝', channel.texts().slice(n).some((t) => t.includes('未授权')));
    await bridge.onFeishuMessage('chat-1', 'ou_boss', '/bind /tmp');
    check('命令: /bind 生效', state.getWorkDir('chat-1', '') === '/tmp');
    await bridge.onFeishuMessage('chat-1', 'ou_boss', '/status');
    check('命令: /status 有响应', channel.texts().some((t) => t.includes('状态')));

    // 5.7b 审批池命令
    await bridge.onFeishuMessage('chat-1', 'ou_boss', '/c');
    check('命令: /c 列出审批池', channel.texts().some((t) => t.includes('审批池')));
    await bridge.onFeishuMessage('chat-1', 'ou_boss', '/c /somewhere-else');
    check('命令: /c 路径切换进池', state.inPool('/somewhere-else'));

    // 5.8 Interrupt 事件 → 飞书通知
    await runHook(cfgPath, 'interrupt', { session_id: 's9', cwd: tmp });
    await sleep(300);
    check('端到端: Interrupt 事件通知到飞书', channel.texts().some((t) => t.includes('中断')));

    // 5.9 /dashboard 命令：假 cloudflared 开启 → 卡片带链接 → off 关闭
    const fakeCf = path.join(tmp, 'fake_cloudflared');
    fs.writeFileSync(fakeCf, '#!/bin/sh\necho "INFO https://fake-tunnel-xyz.trycloudflare.com registered"\nsleep 60\n', 'utf-8');
    fs.chmodSync(fakeCf, 0o755);
    cfg.cloudflaredBin = fakeCf;
    cfg.dashboardPublicUrl = '';
    cfg.dashboardPort = await freePort();

    await bridge.onFeishuMessage('chat-1', 'ou_boss', '/dashboard');
    check('Dashboard命令: 开启返回隧道链接',
      channel.texts().some((t) => t.includes('已开启') && t.includes('fake-tunnel-xyz.trycloudflare.com')));

    const linkApprover = (async () => {
      for (let i = 0; i < 50; i++) {
        const cards = channel.cards();
        const last = cards[cards.length - 1];
        if (last && JSON.stringify(last).includes('fake-tunnel-xyz')) {
          const actions = (last.elements as Array<Record<string, unknown>>)[2].actions as Array<Record<string, unknown>>;
          bridge.onCardAction(actions[0].value as Record<string, unknown>, 'ou_boss');
          return true;
        }
        await sleep(100);
      }
      return false;
    })();
    r = await runHook(cfgPath, 'pre_tool_use', {
      session_id: 's1', cwd: tmp, tool_name: 'Shell', tool_input: { command: 'make release' },
    });
    check('端到端: 审批卡片带 Dashboard 链接', (await linkApprover) && !isDeny(r.stdout));

    await bridge.onFeishuMessage('chat-1', 'ou_boss', '/dashboard off');
    check('Dashboard命令: off 关闭并通知', channel.texts().some((t) => t.includes('Dashboard 已关闭')));

    // 5.10 AUQ 答题卡 → send-keys 注入 tmux（需要 tmux）
    let tmuxOk = true;
    try { await execFileP('tmux', ['-V']); } catch { tmuxOk = false; }
    if (!tmuxOk) {
      console.log('⏭️  无 tmux，跳过 AUQ 注入测试');
    } else {
      const sess = 'kcf-auqchk';
      await execFileP('tmux', ['new-session', '-d', '-s', sess, '-c', tmp, 'cat']);
      try {
        await sleep(300);
        r = await runHook(cfgPath, 'pre_tool_use', {
          session_id: 's-auq', cwd: tmp, tool_name: 'AskUserQuestion',
          tool_input: { questions: [{ question: '选哪个？', options: [{ label: '甲' }, { label: '乙' }] }] },
        });
        check('答题: hook 直接放行让 TUI 出题', r.stdout.trim() === '' && r.code === 0);

        let resultCard: Record<string, unknown> | null = null;
        for (let i = 0; i < 50 && !resultCard; i++) {
          const cards = channel.cards();
          const last = cards[cards.length - 1];
          if (last && JSON.stringify(last).includes('选哪个')) {
            for (const el of last.elements as Array<Record<string, unknown>>) {
              if (el.tag !== 'action') continue;
              for (const b of el.actions as Array<Record<string, unknown>>) {
                const v = b.value as Record<string, unknown>;
                if (v?.kcf === 'auq' && v.a === 1) resultCard = bridge.onCardAction(v, 'ou_boss');
              }
            }
          }
          if (resultCard) break;
          await sleep(100);
        }
        check('答题: 点击返回结果卡片', !!resultCard && JSON.stringify(resultCard).includes('已作答'));
        await sleep(400);
        const pane = await captureTmux((await listKimiSessions()).find((s) => s.name === sess)!.target, 5);
        check('答题: send-keys 注入到 tmux 会话', pane.includes('2'));
      } finally {
        await execFileP('tmux', ['kill-session', '-t', sess]).catch(() => {});
      }
    }

    await hookServer.close();
  }

  // ---------------------------------------------------------------- 6. 桥不可达（fail_closed）
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kcf-fail-'));
    const cfgPath = makeConfig(tmp, await freePort()); // 没有服务在监听
    const r = await runHook(cfgPath, 'pre_tool_use', {
      session_id: 's', cwd: '/tmp', tool_name: 'Shell', tool_input: { command: 'ls' },
    });
    check('fail_closed: 桥不可达时拒绝', isDeny(r.stdout));
  }

  // ---------------------------------------------------------------- 7. 假 kimi 任务全流程
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kcf-task-'));
    const fakeKimi = path.join(tmp, 'fake_kimi');
    // 用真实 stream-json 格式（role 风格）输出，覆盖与线上一致的解析路径
    fs.writeFileSync(fakeKimi, `#!/bin/sh
echo '{"role":"assistant","content":"正在分析…","tool_calls":[{"type":"function","function":{"name":"Bash"}}]}'
echo '{"role":"tool","tool_call_id":"t1","content":"ok"}'
echo '{"role":"assistant","content":"完成：一切正常"}'
`, 'utf-8');
    fs.chmodSync(fakeKimi, 0o755);

    const cfgPath = makeConfig(tmp, await freePort());
    const cfg = loadConfig(cfgPath);
    cfg.kimiBin = fakeKimi;
    const state = new StateStore(path.join(tmp, 'state.json'));
    const channel = new FakeChannel();
    const bridge = new Bridge(cfg, state, channel);

    await bridge.onFeishuMessage('chat-9', 'ou_boss', '检查一下项目');
    let done = false;
    for (let i = 0; i < 60; i++) {
      if (channel.texts().some((t) => t.includes('任务完成') && t.includes('一切正常'))) { done = true; break; }
      await sleep(200);
    }
    check('任务: 流式执行并回报结果', done);
    check('任务: 会话标记已置位', state.hasSession('chat-9'));
    check('任务: 有执行中消息', channel.texts().some((t) => t.includes('执行中') || t.includes('已开工')));
    check('任务: 进度消息被更新（工具行）', channel.updated.length >= 1);
    check('任务: 工具返回不混入最终结果', !channel.texts().some((t) => t.includes('任务完成') && t.includes('ok')));
  }

  // ---------------------------------------------------------------- 8. 扫码注册流程（mock accounts 服务）
  {
    let beginCount = 0;
    let pollCount = 0;
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const form = new URLSearchParams(body);
        const action = form.get('action');
        let out: Record<string, unknown>;
        if (action === 'begin') {
          beginCount++;
          out = { device_code: beginCount === 1 ? 'dc-ok' : 'dc-deny', user_code: 'ABCD-EFGH', expire_in: 30, interval: 1 };
        } else if (action === 'poll') {
          if (form.get('device_code') === 'dc-deny') {
            out = { error: 'access_denied' };
          } else {
            pollCount++;
            out = pollCount < 3
              ? { error: 'authorization_pending' }
              : { client_id: 'cli_scan', client_secret: 'sec_scan', user_info: { open_id: 'ou_scan', tenant_brand: 'feishu' } };
          }
        } else {
          out = { error: 'bad_action' };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      });
    });
    const port = await freePort();
    await new Promise<void>((r) => srv.listen(port, '127.0.0.1', () => r()));
    const eps = { accountsBase: `http://127.0.0.1:${port}`, openBase: 'https://open.feishu.cn' };

    const begin = await requestAppRegistration(eps);
    check('注册: begin 返回 device_code 与验证链接',
      begin.deviceCode === 'dc-ok' && begin.verificationUrl.includes('user_code=ABCD-EFGH'));
    const reg = await pollAppRegistration(begin, eps);
    check('注册: 轮询成功拿到凭证与 open_id', reg.clientId === 'cli_scan' && reg.openId === 'ou_scan');

    const begin2 = await requestAppRegistration(eps);
    let denied = false;
    try {
      await pollAppRegistration(begin2, eps);
    } catch (err) {
      denied = err instanceof RegistrationError && err.code === 'access_denied';
    }
    check('注册: access_denied 正确抛出', denied);
    await new Promise<void>((r) => srv.close(() => r()));
  }

  // ---------------------------------------------------------------- 9. Dashboard
  {
    const dash = new Dashboard();
    const port = await freePort();
    const srv = await serveDashboard(dash, '127.0.0.1', port, 'tok123', { idlePageMs: 600_000, idleNopageMs: 600_000, onClose: () => {} });
    const base = `http://127.0.0.1:${port}`;

    const r1 = await fetch(`${base}/events`);
    check('Dashboard: 无 token 拒绝访问', r1.status === 401);

    const r2 = await fetch(`${base}/?token=tok123`);
    const html = await r2.text();
    check('Dashboard: 带 token 返回 HTML 页面', r2.status === 200 && html.includes('<html'));

    dash.publish('chat-dash', 'stdout', 'hello-dashboard-xyz');
    const ac = new AbortController();
    const r3 = await fetch(`${base}/events?token=tok123`, { signal: ac.signal });
    const reader = r3.body!.getReader();
    const { value } = await reader.read();
    check('Dashboard: SSE 回放到已发布事件', new TextDecoder().decode(value).includes('hello-dashboard-xyz'));

    const hb = await fetch(`${base}/heartbeat?token=tok123`, { method: 'POST' });
    check('Dashboard: 心跳保活 204', hb.status === 204);

    // /close 关闭：SSE 连接被断开（流结束或连接被重置都算断开），服务不可达
    await fetch(`${base}/close?token=tok123`, { method: 'POST' });
    let sseClosed = false;
    try {
      sseClosed = (await reader.read()).done === true;
    } catch {
      sseClosed = true; // 服务器销毁连接（ECONNRESET/terminated）正是我们要的行为
    }
    check('Dashboard: 关闭时断开 SSE 连接', sseClosed);
    let unreachable = false;
    try { await fetch(`${base}/?token=tok123`); } catch { unreachable = true; }
    check('Dashboard: 关闭后服务不可达', unreachable);
    ac.abort();

    // 无页面闲置自动关闭
    const dash2 = new Dashboard();
    const port2 = await freePort();
    let closedReason = '';
    await serveDashboard(dash2, '127.0.0.1', port2, 't', { idlePageMs: 5000, idleNopageMs: 800, onClose: (r) => { closedReason = r; } });
    await sleep(2500);
    let down = false;
    try { await fetch(`http://127.0.0.1:${port2}/health`); } catch { down = true; }
    check('Dashboard: 无人观看闲置自动关闭', down && closedReason.includes('无人观看'));
  }

  // ---------------------------------------------------------------- 10. tmux 集成
  {
    let hasTmux = true;
    try { await execFileP('tmux', ['-V']); } catch { hasTmux = false; }
    if (!hasTmux) {
      console.log('⏭️  未安装 tmux，跳过 tmux 集成测试');
    } else {
      const sess = 'kcf-selfcheck';
      await execFileP('tmux', ['new-session', '-d', '-s', sess, 'cat']);
      try {
        await sleep(300);
        const sessions = await listKimiSessions();
        const found = sessions.find((s) => s.name === sess);
        check('tmux: 发现 kcf-* 会话', !!found);
        const target = found!.target;

        await sendTmuxText(target, 'hello-kcf');
        await sleep(300);
        check('tmux: 注入并抓到画面', (await captureTmux(target, 5)).includes('hello-kcf'));

        // 桥命令 /a /t /s（用真实 tmux 会话端到端）
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kcf-tmux-'));
        const cfg = loadConfig(makeConfig(tmp, await freePort()));
        const state = new StateStore(path.join(tmp, 'state.json'));
        const channel = new FakeChannel();
        const bridge = new Bridge(cfg, state, channel);

        await bridge.onFeishuMessage('chat-t', 'ou_boss', '/a');
        check('命令: /a 列出会话', channel.texts().some((t) => t.includes(sess)));

        const idx = (await listKimiSessions()).findIndex((s) => s.name === sess) + 1;
        await bridge.onFeishuMessage('chat-t', 'ou_boss', `/a ${idx}`);
        check('命令: /a 序号绑定会话', state.getAttach('chat-t') === `tmux|${target}`);

        await bridge.onFeishuMessage('chat-t', 'ou_boss', '/t world-inject');
        await sleep(300);
        check('命令: /t 注入生效', (await captureTmux(target, 5)).includes('world-inject'));

        await bridge.onFeishuMessage('chat-t', 'ou_boss', '/s');
        check('命令: /s 返回画面', channel.texts().some((t) => t.includes('当前画面')));

        // pts（非 tmux）绑定：可注入则真注入，否则给提示
        state.setAttach('chat-t', 'pts|/dev/pts/99');
        await bridge.onFeishuMessage('chat-t', 'ou_boss', '/t hello');
        check('命令: pts 会话 /t 有明确反馈', channel.texts().some((t) => t.includes('无法注入') || t.includes('注入失败')));

        // pts 真注入（需要 legacy_tiocsti=1 + 免密 sudo；不满足则跳过）
        if (await canInjectPts()) {
          // 用 python pty.fork 起一个带伪终端的 cat：stdout 首行是它的 tty，后续是终端回显
          const victim = spawn('python3', ['-c', `import os, pty, time, sys, select
pid, master = pty.fork()
if pid == 0:
    os.execvp('cat', ['cat'])
print(os.readlink('/proc/%d/fd/0' % pid), flush=True)
end = time.time() + 30
while time.time() < end:
    r, _, _ = select.select([master], [], [], 1)
    if r:
        sys.stdout.buffer.write(os.read(master, 4096)); sys.stdout.buffer.flush()
`], { stdio: ['ignore', 'pipe', 'ignore'] });
          let buf = '';
          victim.stdout!.on('data', (d: Buffer) => { buf += d.toString(); });
          try {
            let ok = false;
            for (let i = 0; i < 30; i++) {
              const nl = buf.indexOf('\n');
              if (nl > 0 && buf.slice(0, nl).startsWith('/dev/pts/')) {
                if (buf.includes('pts-inject-ok')) { ok = true; break; }
                await sendPtsText(buf.slice(0, nl).trim(), 'pts-inject-ok').catch(() => {});
              }
              await sleep(300);
            }
            check('pts: TIOCSTI 注入文本到达目标终端', ok);
          } finally {
            victim.kill();
          }
        } else {
          console.log('⏭️  pts 注入不可用（tiocsti/sudo），跳过');
        }
      } finally {
        await execFileP('tmux', ['kill-session', '-t', sess]).catch(() => {});
      }
    }
  }

  // ---------------------------------------------------------------- 11. 对话日志
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kcf-log-'));
    const logger = new ChatLogger(tmp);
    const day = new Date().toISOString().slice(0, 10);
    const logFile = path.join(tmp, `${day}.jsonl`);

    logger.log('chat-1', 'in', 'text', 'ou_x: 你好');
    const e = JSON.parse(fs.readFileSync(logFile, 'utf-8').trim().split('\n')[0]);
    check('日志: 写入 JSONL 条目', e.chat === 'chat-1' && e.dir === 'in' && e.text.includes('你好'));

    const fake = new FakeChannel();
    const lc = new LoggingChannel(fake, logger);
    await lc.sendText('chat-1', '回复内容-xyz');
    check('日志: 出站消息透传且记录',
      fake.texts().includes('回复内容-xyz') && fs.readFileSync(logFile, 'utf-8').includes('回复内容-xyz'));

    fs.writeFileSync(path.join(tmp, '2020-01-01.jsonl'), '{}\n');
    check('日志: clean 清理过期文件', logger.clean(30) === 1 && !fs.existsSync(path.join(tmp, '2020-01-01.jsonl')));

    // e2e：桥入站消息落盘 + 进 dashboard feed
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kcf-loge2e-'));
    const cfg = loadConfig(makeConfig(tmp2, await freePort()));
    cfg.logDir = path.join(tmp2, 'logs');
    const state = new StateStore(path.join(tmp2, 'state.json'));
    const channel = new FakeChannel();
    const bridge = new Bridge(cfg, state, channel);
    bridge.channel = new LoggingChannel(channel, bridge.logger);
    await bridge.onFeishuMessage('chat-9', 'ou_boss', '/id');
    const logFile2 = path.join(tmp2, 'logs', `${day}.jsonl`);
    check('日志: 桥入站消息落盘', fs.existsSync(logFile2) && fs.readFileSync(logFile2, 'utf-8').includes('/id'));
    const feed = bridge.dashboardBus.snapshot();
    check('日志: 入站消息进 dashboard feed', feed.some((e) => e.kind === 'in' && e.text.includes('👤') && e.text.includes('/id')));
    check('日志: 出站回复进 dashboard feed', feed.some((e) => e.kind === 'out' && e.text.includes('🤖')));
  }

  // ---------------------------------------------------------------- 汇总
  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n${'='.repeat(50)}\n共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  if (failed.length) {
    console.log('失败项:');
    for (const [name] of failed) console.log(`  - ${name}`);
    process.exit(1);
  }
  console.log('全部通过 🎉');
  process.exit(0);
}

main().catch((err) => {
  console.error('自检异常:', err);
  process.exit(1);
});
