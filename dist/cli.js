#!/usr/bin/env node
/**
 * kimi-code-feishu 命令行入口。
 *
 *   kimi-code-feishu init        生成示例配置 ~/.kimi-code-feishu/config.toml
 *   kimi-code-feishu install     把 hooks 写入 Kimi CLI 配置
 *   kimi-code-feishu uninstall   移除 hooks
 *   kimi-code-feishu run         启动桥服务（hook server + 飞书长连接）
 *   kimi-code-feishu doctor      环境自检
 */
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { Bridge } from './bridge.js';
import { loadConfig, saveExampleConfig } from './config.js';
import { FeishuChannel } from './feishuChannel.js';
import { serveHooks } from './hookServer.js';
import * as installer from './installer.js';
import { StateStore } from './state.js';
function argValue(args, flag) {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
}
function cmdInit(args) {
    const p = saveExampleConfig(argValue(args, '--kcf-config'));
    console.log(`配置文件已生成：${p}\n请编辑填入 app_id / app_secret / allowed_user_ids 后再运行。`);
    return 0;
}
function cmdInstall(args) {
    const target = installer.install(argValue(args, '--kimi-config'), Number(argValue(args, '--approval-timeout') ?? 150), argValue(args, '--kcf-config'));
    console.log(`✅ hooks 已写入 ${target}`);
    console.log('提示：重启正在运行的 kimi 会话后生效；可用 /hooks 命令在 CLI 内查看。');
    return 0;
}
function cmdUninstall(args) {
    const target = installer.uninstall(argValue(args, '--kimi-config'));
    console.log(`✅ 已从 ${target} 移除 kimi-code-feishu hooks`);
    return 0;
}
function which(bin) {
    try {
        execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' });
        return true;
    }
    catch {
        return false;
    }
}
async function portFree(host, port) {
    return new Promise((resolve) => {
        const s = net.connect(port, host);
        s.once('connect', () => { s.destroy(); resolve(false); });
        s.once('error', () => resolve(true));
    });
}
async function cmdDoctor(args) {
    const cfg = loadConfig(argValue(args, '--kcf-config'));
    let ok = true;
    const mark = (cond, label) => {
        console.log(`${cond === null ? '⚠️ ' : cond ? '✅' : '❌'} ${label}`);
        if (cond === false)
            ok = false;
    };
    mark(which(cfg.kimiBin), `kimi 可执行文件: ${cfg.kimiBin}`);
    mark(!!cfg.appId, `飞书 app_id: ${cfg.appId ? '已配置' : '未配置'}`);
    mark(!!cfg.appSecret, `飞书 app_secret: ${cfg.appSecret ? '已配置' : '未配置'}`);
    mark(cfg.allowedUserIds.length > 0 ? true : null, `allowed_user_ids: ${cfg.allowedUserIds.length ? cfg.allowedUserIds.length + ' 人' : '为空（先给机器人发 /id 获取）'}`);
    mark(installer.isInstalled(argValue(args, '--kimi-config')) ? true : null, `Kimi CLI hooks: ${installer.isInstalled(argValue(args, '--kimi-config')) ? '已安装' : '未安装（运行 install 命令）'}`);
    try {
        await import('@larksuiteoapi/node-sdk');
        mark(true, '@larksuiteoapi/node-sdk 已安装');
    }
    catch {
        mark(false, '@larksuiteoapi/node-sdk 未安装：npm i @larksuiteoapi/node-sdk');
    }
    mark(await portFree(cfg.bridgeHost, cfg.bridgePort), `端口 ${cfg.bridgePort}`);
    return ok ? 0 : 1;
}
async function cmdRun(args) {
    const cfg = loadConfig(argValue(args, '--kcf-config'));
    if (!cfg.appId || !cfg.appSecret) {
        console.log('请先在配置文件中填写 app_id / app_secret（kimi-code-feishu init 生成模板）');
        return 1;
    }
    const state = new StateStore();
    const bridge = new Bridge(cfg, state);
    const channel = new FeishuChannel(cfg.appId, cfg.appSecret, (chatId, openId, text) => void bridge.onFeishuMessage(chatId, openId, text), (value, operator) => bridge.onCardAction(value, operator));
    bridge.channel = channel;
    const hookServer = await serveHooks(bridge, cfg.bridgeHost, cfg.bridgePort);
    await channel.start();
    console.log('kimi-code-feishu 已启动，按 Ctrl+C 退出');
    await new Promise((resolve) => {
        process.on('SIGINT', () => resolve());
        process.on('SIGTERM', () => resolve());
    });
    console.log('正在退出…');
    bridge.runner.stopAll();
    await channel.close();
    await hookServer.close();
    return 0;
}
async function main() {
    const args = process.argv.slice(2);
    const command = args[0];
    const rest = args.slice(1);
    switch (command) {
        case 'init': return cmdInit(rest);
        case 'install': return cmdInstall(rest);
        case 'uninstall': return cmdUninstall(rest);
        case 'doctor': return cmdDoctor(rest);
        case 'run': return cmdRun(rest);
        default:
            console.log(`用法: kimi-code-feishu <init|install|uninstall|run|doctor> [选项]
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
