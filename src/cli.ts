#!/usr/bin/env node
/**
 * kimi-code-feishu 命令行入口。
 *
 *   kimi-code-feishu onboard    扫码创建飞书应用并写入配置（推荐）
 *   kimi-code-feishu init        生成示例配置 ~/.kimi-code-feishu/config.toml（手动填写）
 *   kimi-code-feishu install     把 hooks 写入 Kimi CLI 配置
 *   kimi-code-feishu uninstall   移除 hooks
 *   kimi-code-feishu run         启动桥服务（hook server + 飞书长连接）
 *   kimi-code-feishu tmux        在 tmux 里启动 kimi 会话（飞书 /a 可绑定注入）
 *   kimi-code-feishu doctor      环境自检
 */
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import * as readline from 'node:readline/promises';
import QRCode from 'qrcode';
import { pollAppRegistration, RegistrationError, requestAppRegistration } from './appRegistration.js';
import { Bridge } from './bridge.js';
import { ChatLogger, LoggingChannel } from './chatLogger.js';
import { loadConfig, saveConfig, saveExampleConfig } from './config.js';
import { FeishuChannel } from './feishuChannel.js';
import { serveHooks } from './hookServer.js';
import * as installer from './installer.js';
import { StateStore } from './state.js';

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function cmdInit(args: string[]): number {
  const p = saveExampleConfig(argValue(args, '--kcf-config'));
  console.log(`配置文件已生成：${p}\n请编辑填入 app_id / app_secret / allowed_user_ids 后再运行。`);
  return 0;
}

/** 扫码创建飞书应用：飞书官方 Device-Flow 应用注册，凭证自动写入配置。 */
async function onboardScan(cfgPath?: string): Promise<number> {
  console.log('正在向飞书发起应用注册…');
  const begin = await requestAppRegistration();
  console.log('\n请用「飞书」手机 App 扫描下方二维码，并在确认页点击确认：\n');
  console.log(await QRCode.toString(begin.verificationUrl, { type: 'terminal', small: true }));
  console.log(`扫不出来也可以手动打开链接：\n${begin.verificationUrl}\n`);
  console.log(`等待确认中（${Math.round(begin.expiresIn / 60)} 分钟内有效）…`);

  let result;
  try {
    result = await pollAppRegistration(begin);
  } catch (err) {
    if (err instanceof RegistrationError) {
      console.log(`❌ ${err.message}`);
      return 1;
    }
    throw err;
  }

  if (result.tenantBrand && result.tenantBrand !== 'feishu') {
    console.log(`⚠️  当前租户是 Lark（国际版），本桥目前只支持飞书（feishu）域名，请用飞书账号扫码。`);
    return 1;
  }

  const p = writeOnboardConfig(cfgPath, result.clientId, result.clientSecret, result.openId);
  console.log(`\n✅ 应用创建成功，配置已写入：${p}`);
  console.log(`   app_id = ${result.clientId}`);
  if (result.openId) console.log(`   你的 open_id 已加入 allowed_user_ids：${result.openId}`);
  else console.log('   未拿到 open_id，请私聊机器人发 /id 后自行填入 allowed_user_ids');
  // 注册协议（PersonalAgent 模板）不支持自定义应用名，但确认页可直接改
  console.log(`   提示：应用名可在手机确认页直接修改；事后改名请前往开发者后台`);
  console.log(`   https://open.feishu.cn/app/${result.clientId}/baseinfo （事后改名需创建新版本并发布后生效）`);
  return 0;
}

/** 手动输入已有应用的凭证。 */
async function onboardManual(cfgPath: string | undefined, ask: (q: string) => Promise<string>): Promise<number> {
  const appId = await ask('App ID（cli_ 开头）：');
  const appSecret = await ask('App Secret：');
  const openId = await ask('你的 open_id（可留空，稍后私聊机器人发 /id 获取）：');
  if (!appId || !appSecret) {
    console.log('❌ App ID 和 App Secret 不能为空');
    return 1;
  }
  const p = writeOnboardConfig(cfgPath, appId, appSecret, openId || undefined);
  console.log(`\n✅ 配置已写入：${p}`);
  if (!openId) console.log('   启动桥后私聊机器人发 /id，把返回的 ou_xxx 填入 allowed_user_ids 并重启桥');
  return 0;
}

function writeOnboardConfig(cfgPath: string | undefined, appId: string, appSecret: string, openId?: string): string {
  return saveConfig(
    { appId, appSecret, allowedUserIds: openId ? [openId] : [], workDir: process.env.HOME },
    cfgPath,
  );
}

/**
 * 逐行提问。用 readline 的异步迭代器而非 rl.question：
 * 管道输入时所有行瞬间到达，question 模式会丢弃两次提问之间到达的行。
 */
function makeAsk(): (q: string) => Promise<string> {
  const rl = readline.createInterface({ input: process.stdin });
  const it = rl[Symbol.asyncIterator]();
  return async (q: string) => {
    process.stdout.write(q);
    const { value, done } = await it.next();
    if (done) rl.close();
    return (value ?? '').trim();
  };
}

async function cmdOnboard(args: string[]): Promise<number> {
  const cfgPath = argValue(args, '--kcf-config');
  console.log('飞书应用接入方式：');
  console.log('  1) 扫码创建新应用（推荐）');
  console.log('  2) 手动输入已有应用的 App ID / App Secret');
  const ask = makeAsk();
  const choice = await ask('请选择 [1/2]（默认 1）：');
  const code = choice === '2' ? await onboardManual(cfgPath, ask) : await onboardScan(cfgPath);
  if (code === 0) console.log('\n下一步：kimi-code-feishu run 启动桥，然后私聊机器人测试；install 可注入 hooks。');
  return code;
}

function cmdInstall(args: string[]): number {
  const target = installer.install(
    argValue(args, '--kimi-config'),
    Number(argValue(args, '--approval-timeout') ?? 150),
    argValue(args, '--kcf-config'),
  );
  console.log(`✅ hooks 已写入 ${target}`);
  console.log('提示：重启正在运行的 kimi 会话后生效；可用 /hooks 命令在 CLI 内查看。');
  return 0;
}

function cmdUninstall(args: string[]): number {
  const target = installer.uninstall(argValue(args, '--kimi-config'));
  console.log(`✅ 已从 ${target} 移除 kimi-code-feishu hooks`);
  return 0;
}

/** 在 tmux 里启动一个规范命名的 kimi 会话（kcf-*），桥才能发现和注入。 */
function cmdTmux(args: string[]): number {
  if (!which('tmux')) {
    console.log('未安装 tmux：sudo apt install tmux');
    return 1;
  }
  const name = `kcf-${argValue(args, '--name') ?? crypto.randomBytes(3).toString('hex')}`;
  console.log(`启动 tmux 会话 ${name}（Ctrl+B D 脱离后可在飞书 /a 找到）`);
  const r = spawnSync('tmux', ['new-session', '-A', '-s', name, '-c', process.cwd(), 'kimi'], { stdio: 'inherit' });
  return r.status ?? 1;
}

function which(bin: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function portFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, host);
    s.once('connect', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(true));
  });
}

async function cmdDoctor(args: string[]): Promise<number> {
  const cfg = loadConfig(argValue(args, '--kcf-config'));
  let ok = true;
  const mark = (cond: boolean | null, label: string) => {
    console.log(`${cond === null ? '⚠️ ' : cond ? '✅' : '❌'} ${label}`);
    if (cond === false) ok = false;
  };

  mark(which(cfg.kimiBin), `kimi 可执行文件: ${cfg.kimiBin}`);
  mark(!!cfg.appId, `飞书 app_id: ${cfg.appId ? '已配置' : '未配置'}`);
  mark(!!cfg.appSecret, `飞书 app_secret: ${cfg.appSecret ? '已配置' : '未配置'}`);
  mark(cfg.allowedUserIds.length > 0 ? true : null,
    `allowed_user_ids: ${cfg.allowedUserIds.length ? cfg.allowedUserIds.length + ' 人' : '为空（先给机器人发 /id 获取）'}`);
  mark(installer.isInstalled(argValue(args, '--kimi-config')) ? true : null,
    `Kimi CLI hooks: ${installer.isInstalled(argValue(args, '--kimi-config')) ? '已安装' : '未安装（运行 install 命令）'}`);
  try {
    await import('@larksuiteoapi/node-sdk');
    mark(true, '@larksuiteoapi/node-sdk 已安装');
  } catch {
    mark(false, '@larksuiteoapi/node-sdk 未安装：npm i @larksuiteoapi/node-sdk');
  }
  mark(await portFree(cfg.bridgeHost, cfg.bridgePort), `端口 ${cfg.bridgePort}`);
  return ok ? 0 : 1;
}

async function cmdRun(args: string[]): Promise<number> {
  const cfg = loadConfig(argValue(args, '--kcf-config'));
  if (!cfg.appId || !cfg.appSecret) {
    console.log('请先在配置文件中填写 app_id / app_secret（kimi-code-feishu init 生成模板）');
    return 1;
  }

  const state = new StateStore();
  const bridge = new Bridge(cfg, state);
  const rawChannel = new FeishuChannel(
    cfg.appId, cfg.appSecret,
    (chatId, openId, text) => void bridge.onFeishuMessage(chatId, openId, text),
    (value, operator) => bridge.onCardAction(value, operator),
  );
  // 对话日志：出站消息经 LoggingChannel 落盘，入站由 bridge 记录
  const logger = new ChatLogger(cfg.logDir || undefined);
  const channel = cfg.logEnabled ? new LoggingChannel(rawChannel, logger) : rawChannel;
  bridge.channel = channel;
  if (cfg.logEnabled) {
    const removed = logger.clean(cfg.logRetentionDays);
    if (removed) console.log(`[log] 已清理 ${removed} 个过期日志文件`);
  }

  const hookServer = await serveHooks(bridge, cfg.bridgeHost, cfg.bridgePort);
  await channel.start();

  // 上线通知：发到最近活跃的聊天，出门在外能确认桥在线
  const notifyChat = state.defaultNotifyChat();
  if (notifyChat) {
    void channel.sendText(notifyChat, '✅ 桥已上线（发 /dashboard 可随时开启实时输出）');
  }

  console.log('kimi-code-feishu 已启动，按 Ctrl+C 退出');

  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => resolve());
    process.on('SIGTERM', () => resolve());
  });
  console.log('正在退出…');
  bridge.runner.stopAll();
  await channel.close();
  await hookServer.close();
  return 0;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const command = args[0];
  const rest = args.slice(1);
  switch (command) {
    case 'init': return cmdInit(rest);
    case 'onboard': return cmdOnboard(rest);
    case 'install': return cmdInstall(rest);
    case 'uninstall': return cmdUninstall(rest);
    case 'tmux': return cmdTmux(rest);
    case 'doctor': return cmdDoctor(rest);
    case 'run': return cmdRun(rest);
    default:
      console.log(`用法: kimi-code-feishu <onboard|init|install|uninstall|run|doctor|tmux> [选项]
  onboard                扫码创建飞书应用并自动写入配置（推荐）
  tmux                   在 tmux 里启动 kimi 会话（kcf-* 命名，飞书 /a 可绑定）
  --kcf-config <path>      桥配置文件路径（默认 ~/.kimi-code-feishu/config.toml）
  --kimi-config <path>     Kimi CLI 配置文件路径（install/uninstall，默认自动探测）
  --approval-timeout <秒>  审批等待秒数（install，默认 150）`);
      return command ? 1 : 0;
  }
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
