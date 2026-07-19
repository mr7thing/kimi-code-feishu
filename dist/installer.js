/**
 * 把 hooks 写进 Kimi CLI 的配置文件（~/.kimi/config.toml 或 ~/.kimi-code/config.toml）。
 * 注入内容用标记注释包裹，uninstall 时整块移除；写入前自动备份。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const BEGIN = '# >>> kimi-code-feishu >>>';
export const END = '# <<< kimi-code-feishu <<<';
const KIMI_CONFIG_CANDIDATES = [
    path.join(os.homedir(), '.kimi', 'config.toml'), // kimi-cli
    path.join(os.homedir(), '.kimi-code', 'config.toml'), // Kimi Code CLI
];
const PROGRESS_EVENTS = [
    'PostToolUse', 'PostToolUseFailure',
    'Stop', 'StopFailure',
    'SessionStart', 'SessionEnd',
    'SubagentStart', 'SubagentStop',
];
export function detectKimiConfig() {
    for (const p of KIMI_CONFIG_CANDIDATES) {
        if (fs.existsSync(p))
            return p;
    }
    return KIMI_CONFIG_CANDIDATES[0];
}
function hookJsPath() {
    // installer.js 与 hook.js 同目录（dist/）
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.join(here, 'hook.js');
}
function hookCommand(event, cfgPath) {
    const envParts = [];
    if (cfgPath)
        envParts.push(`KCF_CONFIG="${cfgPath}"`);
    return `${envParts.join(' ')} ${process.execPath} ${hookJsPath()} ${event}`.trim();
}
export function buildBlock(approvalTimeout = 150, cfgPath) {
    const hookTimeout = Math.min(approvalTimeout + 30, 600);
    const lines = [BEGIN, '# 由 kimi-code-feishu install 生成；uninstall 可整块移除'];
    lines.push('[[hooks]]', 'event = "PreToolUse"', `command = "${hookCommand('pre_tool_use', cfgPath)}"`, `timeout = ${hookTimeout}`, '');
    for (const ev of PROGRESS_EVENTS) {
        lines.push('[[hooks]]', `event = "${ev}"`, `command = "${hookCommand(ev.toLowerCase(), cfgPath)}"`, 'timeout = 5', '');
    }
    lines.push(END);
    return lines.join('\n') + '\n';
}
function timestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '').slice(0, 14);
}
export function install(configPath, approvalTimeout = 150, cfgPath) {
    const target = configPath ?? detectKimiConfig();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const original = fs.existsSync(target) ? fs.readFileSync(target, 'utf-8') : '';
    if (original.includes(BEGIN)) {
        throw new Error(`${target} 中已存在 kimi-code-feishu 的 hooks，请先 uninstall`);
    }
    if (original) {
        fs.copyFileSync(target, target.replace(/\.toml$/, '') + `.toml.bak-${timestamp()}`);
    }
    const sep = !original || original.endsWith('\n') ? '' : '\n';
    fs.writeFileSync(target, original + sep + '\n' + buildBlock(approvalTimeout, cfgPath), 'utf-8');
    return target;
}
export function uninstall(configPath) {
    const target = configPath ?? detectKimiConfig();
    if (!fs.existsSync(target))
        throw new Error(`配置文件不存在: ${target}`);
    const text = fs.readFileSync(target, 'utf-8');
    if (!text.includes(BEGIN))
        throw new Error(`${target} 中没有 kimi-code-feishu 的 hooks`);
    fs.copyFileSync(target, target.replace(/\.toml$/, '') + `.toml.bak-${timestamp()}`);
    const start = text.indexOf(BEGIN);
    const stop = text.indexOf(END) + END.length;
    fs.writeFileSync(target, (text.slice(0, start) + text.slice(stop)).trim() + '\n', 'utf-8');
    return target;
}
export function isInstalled(configPath) {
    const target = configPath ?? detectKimiConfig();
    return fs.existsSync(target) && fs.readFileSync(target, 'utf-8').includes(BEGIN);
}
