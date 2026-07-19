/**
 * Kimi CLI hook 入口：node hook.js <event>
 *
 * CLI 触发 hook 时通过 stdin 传入 JSON 上下文：
 *   {"session_id": "...", "cwd": "...", "hook_event_name": "PreToolUse",
 *    "tool_name": "Shell", "tool_input": {...}}
 *
 * 返回值约定（官方文档）：
 * - 退出码 0：放行；stdout 非空会附加到上下文
 * - 退出码 2：阻断；stderr 反馈给 LLM
 * - stdout 输出 {"hookSpecificOutput": {"permissionDecision": "deny", ...}} 也可阻断
 *
 * pre_tool_use → 请求桥做飞书审批并等待结果；其余事件 → 转发给桥做进度推送。
 * 桥不可达时按配置 fail_closed / fail_open 处理。
 */
import { loadConfig, bridgeBaseUrl } from './config.js';
async function readStdin() {
    const chunks = [];
    for await (const chunk of process.stdin)
        chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf-8');
}
function denyJson(reason) {
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
        },
    }));
}
async function post(url, body, timeoutMs) {
    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
    });
    return (await resp.json());
}
async function main() {
    const event = process.argv[2] ?? '';
    const raw = await readStdin();
    let payload = {};
    try {
        payload = raw.trim() ? JSON.parse(raw) : {};
    }
    catch {
        payload = { _raw: raw.slice(0, 2000) };
    }
    if (process.env.KCF_DISABLED)
        return 0; // 紧急旁路：让 CLI 回到原生行为
    const cfg = loadConfig();
    if (event === 'pre_tool_use') {
        let resp;
        try {
            resp = await post(`${bridgeBaseUrl(cfg)}/hook/pre_tool_use`, payload, (cfg.approvalTimeout + 20) * 1000);
        }
        catch {
            if (cfg.failClosed) {
                denyJson('飞书审批桥未运行或不可达，按 fail_closed 策略拒绝。启动桥：kimi-code-feishu run');
            }
            return 0; // fail-open：什么都不输出直接放行
        }
        const decision = String(resp.decision ?? 'allow');
        if (decision === 'deny' || decision === 'timeout_deny') {
            denyJson(String(resp.reason ?? '用户在飞书上拒绝了该操作'));
        }
        return 0;
    }
    // 观察型事件：转发给桥做进度推送，失败静默
    if (event) {
        try {
            await post(`${bridgeBaseUrl(cfg)}/hook/event`, { event, payload }, 3000);
        }
        catch {
            /* 静默 */
        }
    }
    return 0;
}
main()
    .then((code) => process.exit(code))
    .catch(() => process.exit(0)); // hook 绝不让 CLI 卡住：异常 = fail-open
