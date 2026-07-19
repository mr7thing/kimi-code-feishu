/**
 * 扫码创建飞书应用：飞书官方账号体系的 Device-Flow 应用注册协议。
 *
 * 协议参考飞书官方开源 CLI（github.com/larksuite/cli，MIT）：
 *   internal/auth/app_registration.go
 *
 * 流程：begin 拿 device_code/user_code → 用户用飞书 App 扫码（官方 H5 确认页）
 * → 飞书服务端自动创建 PersonalAgent 模板应用（预置机器人能力与消息权限）
 * → poll 轮询拿回 client_id/client_secret 和创建者 open_id。
 * 全程匿名调用，无需任何已有凭证，也不需要公网回调。
 */

export type LarkBrand = 'feishu' | 'lark';

const ACCOUNTS_BASE: Record<LarkBrand, string> = {
  feishu: 'https://accounts.feishu.cn',
  lark: 'https://accounts.larksuite.com',
};
const OPEN_BASE: Record<LarkBrand, string> = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
};

const REGISTRATION_PATH = '/oauth/v1/app/registration';
const DEFAULT_POLL_INTERVAL = 5; // 秒
const DEFAULT_EXPIRE_IN = 600; // 秒
const MAX_POLL_INTERVAL = 60; // 秒
const BEGIN_TIMEOUT_MS = 30_000;

export interface RegistrationEndpoints {
  accountsBase: string;
  openBase: string;
}

export interface AppRegistrationBegin {
  deviceCode: string;
  userCode: string;
  /** 扫码/浏览器打开的确认页地址 */
  verificationUrl: string;
  expiresIn: number;
  interval: number;
}

export interface AppRegistrationResult {
  clientId: string;
  clientSecret: string;
  openId?: string;
  tenantBrand?: string;
}

export type RegistrationErrorCode = 'access_denied' | 'expired' | 'failed';

export class RegistrationError extends Error {
  constructor(
    public code: RegistrationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RegistrationError';
  }
}

function endpointsFor(brand: LarkBrand): RegistrationEndpoints {
  return { accountsBase: ACCOUNTS_BASE[brand], openBase: OPEN_BASE[brand] };
}

async function postForm(url: string, form: Record<string, string>, timeoutMs = BEGIN_TIMEOUT_MS): Promise<Record<string, unknown>> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await resp.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new RegistrationError('failed', `注册接口返回非 JSON（HTTP ${resp.status}）`);
  }
  return data;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** 构造扫码确认页 URL（tracking 参数仅统计用途，可自定义）。 */
export function buildVerificationUrl(openBase: string, userCode: string, tracking = 'kimi-code-feishu'): string {
  return `${openBase}/page/cli?user_code=${encodeURIComponent(userCode)}&from=${encodeURIComponent(tracking)}`;
}

/**
 * 发起应用注册。协议固定从 feishu 域名引导，跨品牌租户在 poll 阶段切换。
 * endpoints 可注入（测试用），默认官方 feishu。
 */
export async function requestAppRegistration(endpoints?: RegistrationEndpoints): Promise<AppRegistrationBegin> {
  const ep = endpoints ?? endpointsFor('feishu');
  const data = await postForm(`${ep.accountsBase}${REGISTRATION_PATH}`, {
    action: 'begin',
    archetype: 'PersonalAgent',
    auth_method: 'client_secret',
    request_user_info: 'open_id tenant_brand',
  });

  if (data.error) {
    const msg = str(data.error_description) || str(data.error) || '未知错误';
    throw new RegistrationError('failed', `发起注册失败：${msg}`);
  }
  const deviceCode = str(data.device_code);
  if (!deviceCode) throw new RegistrationError('failed', '发起注册失败：响应缺少 device_code');

  const userCode = str(data.user_code);
  const expiresIn = num(data.expire_in) || num(data.expires_in) || DEFAULT_EXPIRE_IN;
  const interval = num(data.interval) > 0 ? num(data.interval) : DEFAULT_POLL_INTERVAL;

  return {
    deviceCode,
    userCode,
    verificationUrl: buildVerificationUrl(ep.openBase, userCode),
    expiresIn,
    interval,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 轮询注册结果直到用户确认/拒绝/过期。
 * 忠实移植官方 CLI 行为：首次 poll 立即执行；跨品牌租户（lark）最多切换一次域名；
 * slow_down 时 interval +5s（封顶 60s）；整体受 expire_in 截止约束。
 */
export async function pollAppRegistration(
  begin: AppRegistrationBegin,
  endpoints?: RegistrationEndpoints,
): Promise<AppRegistrationResult> {
  let ep = endpoints ?? endpointsFor('feishu');
  const deadline = Date.now() + begin.expiresIn * 1000;
  let interval = begin.interval;
  let switched = false;
  let waitBeforePoll = false;

  for (;;) {
    if (waitBeforePoll) await sleep(interval * 1000);
    waitBeforePoll = true;
    if (Date.now() >= deadline) throw new RegistrationError('expired', '扫码超时，请重新发起');

    let data: Record<string, unknown>;
    try {
      data = await postForm(`${ep.accountsBase}${REGISTRATION_PATH}`, {
        action: 'poll',
        device_code: begin.deviceCode,
      });
    } catch (err) {
      if (err instanceof RegistrationError) throw err;
      interval = Math.min(interval + 1, MAX_POLL_INTERVAL);
      continue;
    }

    // 跨品牌租户报告：立即切换一次轮询域名（与官方 SDK/CLI 行为一致）
    const userInfo = (data.user_info ?? {}) as Record<string, unknown>;
    if (!switched && !endpoints) {
      const tb = str(userInfo.tenant_brand);
      if (tb === 'lark' && ep.accountsBase !== ACCOUNTS_BASE.lark) {
        ep = endpointsFor('lark');
        switched = true;
        waitBeforePoll = false;
        continue;
      }
    }

    const errStr = str(data.error);
    if (!errStr) {
      const clientId = str(data.client_id);
      const clientSecret = str(data.client_secret);
      if (clientId && clientSecret) {
        const tenantBrand = str(userInfo.tenant_brand);
        return { clientId, clientSecret, openId: str(userInfo.open_id) || undefined, tenantBrand: tenantBrand || undefined };
      }
      continue; // 无错误但凭证不完整：继续轮询
    }

    if (errStr === 'authorization_pending') continue;
    if (errStr === 'slow_down') {
      interval = Math.min(interval + 5, MAX_POLL_INTERVAL);
      continue;
    }
    if (errStr === 'access_denied') throw new RegistrationError('access_denied', '用户拒绝了创建');
    if (errStr === 'expired_token' || errStr === 'invalid_grant') {
      throw new RegistrationError('expired', '授权码已过期，请重新发起');
    }
    throw new RegistrationError('failed', `注册失败：${str(data.error_description) || errStr}`);
  }
}
