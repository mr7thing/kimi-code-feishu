/**
 * kimi-code-feishu (TS) 自检：不依赖真实飞书/真实 kimi 的端到端测试。
 * 运行：npm run build && node dist/selfcheck.js
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parse as parseToml } from 'smol-toml';
import { ApprovalManager } from './approvals.js';
import { Bridge, toolInputSummary } from './bridge.js';
import { loadConfig } from './config.js';
import { serveHooks } from './hookServer.js';
import * as installer from './installer.js';
import { StateStore } from './state.js';
import { parseLine } from './streamParser.js';
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
  }

  // ---------------------------------------------------------------- 2. 解析器
  {
    const ev1 = parseLine('{"type":"assistant","message":{"content":[{"type":"text","text":"你好"}]}}');
    check('解析器: assistant 文本', ev1?.kind === 'text' && (ev1.text ?? '').includes('你好'));
    const ev2 = parseLine('{"type":"tool_use","name":"Shell"}');
    check('解析器: 工具调用', ev2?.kind === 'tool_call' && ev2.tool === 'Shell');
    check('解析器: 非 JSON 行降级 raw', parseLine('not json at all')?.kind === 'raw');
    check('解析器: 空行返回 null', parseLine('') === null);
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
    check('安装器: 生成的 TOML 可解析', Array.isArray(parsed.hooks) && parsed.hooks.length === 9);
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

    // 5.3 需审批工具：发卡片 → 模拟用户在飞书点"批准"
    const approver = (async () => {
      for (let i = 0; i < 50; i++) {
        const cards = channel.cards();
        if (cards.length >= 1) {
          const actions = (cards[0].elements as Array<Record<string, unknown>>)[2].actions as Array<Record<string, unknown>>;
          await sleep(100);
          bridge.onCardAction(actions[0].value as Record<string, unknown>, 'ou_boss');
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
    fs.writeFileSync(fakeKimi, `#!/bin/sh
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"正在分析…"}]}}'
echo '{"type":"tool_use","name":"Shell"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"完成：一切正常"}]}}'
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
