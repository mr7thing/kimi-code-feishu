/**
 * 配置加载：~/.kimi-code-feishu/config.toml + KCF_* 环境变量覆盖。
 * 与 Python 版配置格式完全兼容，两个实现可共用同一份配置。
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';

export const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.kimi-code-feishu');
export const DEFAULT_CONFIG_PATH = path.join(DEFAULT_CONFIG_DIR, 'config.toml');

/** 包安装路径（dist 的上一级）：飞书会话的默认工作目录与 session 存放地。 */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 只读类工具默认自动放行（不推审批卡片），避免刷屏。 */
export const DEFAULT_AUTO_ALLOW_TOOLS = [
  // 真实 Kimi Code CLI 只读工具
  'Read', 'Grep', 'Glob', 'ReadMediaFile', 'TodoList', 'TaskList', 'TaskOutput',
  'WebSearch', 'FetchURL', 'CronList', 'GetGoal',
  // 兼容旧命名（Python 版协议）
  'ReadFile', 'ListDir', 'SearchFile', 'Think', 'TaskGet', 'TodoWrite',
];

/** 命中这些正则的工具参数，不问直接拒绝（在审批卡片之前生效）。 */
export const DEFAULT_AUTO_DENY_PATTERNS = [
  String.raw`rm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+/(?:\s|$)`, // rm -rf /
  String.raw`mkfs\.`,                                          // 格式化磁盘
  String.raw`:\(\)\{ :\|:& \};:`,                              // fork 炸弹
];

export interface Config {
  appId: string;
  appSecret: string;
  /** 允许操作机器人的飞书用户 open_id 列表（必填，安全措施） */
  allowedUserIds: string[];
  /** 默认工作目录（可在飞书里用 /bind 按聊天覆盖） */
  workDir: string;
  bridgeHost: string;
  bridgePort: number;
  /** 等待点击卡片的秒数（需小于 hook 的 timeout） */
  approvalTimeout: number;
  /** 超时未点卡片时的默认动作 */
  onTimeout: 'deny' | 'allow';
  /** 桥不可达时 hook 是否默认拒绝 */
  failClosed: boolean;
  autoAllowTools: string[];
  autoDenyPatterns: string[];
  kimiBin: string;
  kimiExtraArgs: string[];
  /** 单个 headless 任务最长运行秒数 */
  taskTimeout: number;
  progressEnabled: boolean;
  /** 终端里手动跑的 kimi 会话也推送进度/审批 */
  forwardTerminalSessions: boolean;
  /** 本地 Web Dashboard（实时终端输出），按需开启（飞书 /dashboard 命令） */
  dashboardEnabled: boolean;
  dashboardHost: string;
  dashboardPort: number;
  /** dashboard 的公网地址（固定域名/named tunnel 时填写）；空 = 每次开启时临时拉起 cloudflared quick tunnel */
  dashboardPublicUrl: string;
  /** 有页面在看时，心跳停多少秒后自动关闭 dashboard */
  dashboardIdleTimeoutPage: number;
  /** 没有打开的页面时，多少秒后自动关闭 dashboard */
  dashboardIdleTimeoutNopage: number;
  /** cloudflared 可执行文件（quick tunnel 用） */
  cloudflaredBin: string;
  /** kimi 会话转录目录（wire.jsonl 所在）；空 = ~/.kimi-code/sessions */
  kimiSessionsDir: string;
  /** 飞书对话日志落盘（logs/YYYY-MM-DD.jsonl） */
  logEnabled: boolean;
  /** 日志目录；空 = ~/.kimi-code-feishu/logs */
  logDir: string;
  /** 日志保留天数，启动时清理更早的 */
  logRetentionDays: number;
}

export function defaultConfig(): Config {
  return {
    appId: '',
    appSecret: '',
    allowedUserIds: [],
    workDir: PACKAGE_ROOT,
    bridgeHost: '127.0.0.1',
    bridgePort: 17771,
    approvalTimeout: 150,
    onTimeout: 'deny',
    failClosed: true,
    autoAllowTools: [...DEFAULT_AUTO_ALLOW_TOOLS],
    autoDenyPatterns: [...DEFAULT_AUTO_DENY_PATTERNS],
    kimiBin: 'kimi',
    kimiExtraArgs: [],
    taskTimeout: 7200,
    progressEnabled: true,
    forwardTerminalSessions: true,
    dashboardEnabled: true,
    dashboardHost: '127.0.0.1',
    dashboardPort: 17772,
    dashboardPublicUrl: '',
    dashboardIdleTimeoutPage: 600,
    dashboardIdleTimeoutNopage: 180,
    cloudflaredBin: 'cloudflared',
    kimiSessionsDir: '',
    logEnabled: true,
    logDir: '',
    logRetentionDays: 30,
  };
}

export function bridgeBaseUrl(cfg: Config): string {
  return `http://${cfg.bridgeHost}:${cfg.bridgePort}`;
}

export function configPathFromEnv(): string {
  return process.env.KCF_CONFIG ?? DEFAULT_CONFIG_PATH;
}

export interface ExampleConfigValues {
  appId?: string;
  appSecret?: string;
  allowedUserIds?: string[];
  workDir?: string;
}

export function renderExampleConfig(v: ExampleConfigValues = {}): string {
  return `# kimi-code-feishu 配置
# 飞书开放平台 → 企业自建应用 → 凭证与基础信息
app_id = "${v.appId ?? 'cli_xxxxxxxx'}"
app_secret = "${v.appSecret ?? 'xxxxxxxx'}"

# 允许操控机器人的飞书用户 open_id（给机器人私聊发 /id 可获取自己的）
allowed_user_ids = [${(v.allowedUserIds?.length ? v.allowedUserIds : ['ou_xxxxxxxx']).map((s) => `"${s}"`).join(', ')}]

# 默认工作目录（飞书里可用 /bind 按会话覆盖）
work_dir = "${v.workDir ?? PACKAGE_ROOT}"

[bridge]
bridge_host = "127.0.0.1"
bridge_port = 17771

[approval]
approval_timeout = 150     # 等你点卡片的秒数（必须小于 hook 的 timeout）
on_timeout = "deny"        # 超时未处理：deny 拒绝 / allow 放行
fail_closed = true         # 桥不在线时默认拒绝（安全优先；想要 fail-open 改为 false）

[kimi]
kimi_bin = "kimi"
kimi_extra_args = []       # 额外追加给 kimi 的参数
task_timeout = 7200

[progress]
progress_enabled = true
forward_terminal_sessions = true   # 终端里手动启动的 kimi 会话也推送到飞书

[dashboard]
dashboard_enabled = true           # 本地 WebUI 实时展示 kimi 终端输出（飞书发 /dashboard 按需开启）
dashboard_host = "127.0.0.1"       # dashboard 只绑本机；公网靠 cloudflared 隧道，每次开启新建
dashboard_port = 17772
dashboard_public_url = ""          # 固定域名（named tunnel）才填；留空则每次开启临时拉 quick tunnel
dashboard_idle_timeout_page = 600  # 有页面在看时，心跳停多少秒自动关闭
dashboard_idle_timeout_nopage = 180 # 没有打开的页面时，多少秒自动关闭
cloudflared_bin = "cloudflared"    # quick tunnel 可执行文件

[log]
log_enabled = true                 # 飞书完整对话日志落盘
log_dir = ""                       # 空 = ~/.kimi-code-feishu/logs
log_retention_days = 30            # 启动时清理更早的日志
`;
}

/** snake_case 配置文件键 → camelCase Config 字段 */
const KEY_MAP: Record<string, keyof Config> = {
  app_id: 'appId',
  app_secret: 'appSecret',
  allowed_user_ids: 'allowedUserIds',
  work_dir: 'workDir',
  bridge_host: 'bridgeHost',
  bridge_port: 'bridgePort',
  approval_timeout: 'approvalTimeout',
  on_timeout: 'onTimeout',
  fail_closed: 'failClosed',
  auto_allow_tools: 'autoAllowTools',
  auto_deny_patterns: 'autoDenyPatterns',
  kimi_bin: 'kimiBin',
  kimi_extra_args: 'kimiExtraArgs',
  task_timeout: 'taskTimeout',
  progress_enabled: 'progressEnabled',
  forward_terminal_sessions: 'forwardTerminalSessions',
  dashboard_enabled: 'dashboardEnabled',
  dashboard_host: 'dashboardHost',
  dashboard_port: 'dashboardPort',
  dashboard_public_url: 'dashboardPublicUrl',
  dashboard_idle_timeout_page: 'dashboardIdleTimeoutPage',
  dashboard_idle_timeout_nopage: 'dashboardIdleTimeoutNopage',
  cloudflared_bin: 'cloudflaredBin',
  kimi_sessions_dir: 'kimiSessionsDir',
  log_enabled: 'logEnabled',
  log_dir: 'logDir',
  log_retention_days: 'logRetentionDays',
};

export function loadConfig(configPath?: string): Config {
  const cfg = defaultConfig();
  const p = configPath ?? configPathFromEnv();

  let data: Record<string, unknown> = {};
  if (fs.existsSync(p)) {
    data = parseToml(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
  }
  // 顶层 + 一节分节（[bridge] [approval] [kimi] [progress]）拍平
  const flat: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(flat, v);
    } else {
      flat[k] = v;
    }
  }
  for (const [k, v] of Object.entries(flat)) {
    const field = KEY_MAP[k];
    if (field !== undefined && v !== undefined) {
      (cfg as unknown as Record<string, unknown>)[field] = v;
    }
  }

  // 环境变量覆盖（密钥优先走环境变量）
  if (process.env.KCF_APP_ID) cfg.appId = process.env.KCF_APP_ID;
  if (process.env.KCF_APP_SECRET) cfg.appSecret = process.env.KCF_APP_SECRET;
  if (process.env.KCF_ALLOWED_USER_IDS) {
    cfg.allowedUserIds = process.env.KCF_ALLOWED_USER_IDS.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (process.env.KCF_WORK_DIR) cfg.workDir = process.env.KCF_WORK_DIR;
  if (process.env.KCF_BRIDGE_PORT) cfg.bridgePort = Number(process.env.KCF_BRIDGE_PORT);
  if (process.env.KCF_KIMI_BIN) cfg.kimiBin = process.env.KCF_KIMI_BIN;
  if (process.env.KCF_DASHBOARD_PUBLIC_URL) cfg.dashboardPublicUrl = process.env.KCF_DASHBOARD_PUBLIC_URL;

  return cfg;
}

export function saveExampleConfig(configPath?: string): string {
  const p = configPath ?? configPathFromEnv();
  if (fs.existsSync(p)) return p;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, renderExampleConfig(), { encoding: 'utf-8', mode: 0o600 });
  return p;
}

/** 写入带真实值的配置；文件已存在时抛错，避免覆盖已有配置。 */
export function saveConfig(values: ExampleConfigValues, configPath?: string): string {
  const p = configPath ?? configPathFromEnv();
  if (fs.existsSync(p)) throw new Error(`配置文件已存在：${p}（如需重建请先备份后删除）`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, renderExampleConfig(values), { encoding: 'utf-8', mode: 0o600 });
  return p;
}
