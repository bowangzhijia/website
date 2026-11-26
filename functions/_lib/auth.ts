/**
 * 口令门的共用逻辑。
 *
 * cookie 里存「签发时间 + HMAC 签名」，不是单纯一个签名。
 *
 * 为什么要带时间戳：如果只存签名，有效期是在「种 cookie 那一刻」写进浏览器的，
 * 之后把 SITE_UNLOCK_HOURS 从 30 天改成 7 天，已经登录的设备仍然能用满 30 天——
 * 改动看起来没生效，很容易误判成设置写错了。
 * 带上签发时间后，每次请求都由服务端按**当前**配置判断是否过期，
 * 改完立刻对所有人（包括已登录的）生效。
 */

export interface Env {
  SITE_PASSWORD?: string;
  /** 免输口令的小时数，默认 720（30 天） */
  SITE_UNLOCK_HOURS?: string;
}

export const COOKIE = 'bw_unlock';

const enc = new TextEncoder();
const DEFAULT_HOURS = 720;

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 对「口令 + 签发时间」做 HMAC，时间被改就签不出来 */
export async function sign(password: string, issuedAt: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`bw-unlock-v2|${issuedAt}`));
  return hex(sig);
}

/** 免输时长（小时），读环境变量，没配或非法就用默认 30 天 */
export function unlockHours(env: Env): number {
  const h = Number(env.SITE_UNLOCK_HOURS);
  return Number.isFinite(h) && h > 0 ? h : DEFAULT_HOURS;
}

export function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

/**
 * 当前请求是否已解锁。
 * 同时校验签名和「签发时间距今是否超过允许时长」，
 * 所以调小时长之后，超期的旧 cookie 立刻失效。
 */
export async function isUnlocked(req: Request, env: Env): Promise<boolean> {
  const pass = env.SITE_PASSWORD;
  if (!pass) return false;

  const token = readCookie(req, COOKIE);
  if (!token) return false;

  const dot = token.indexOf('.');
  if (dot <= 0) return false;

  const issuedAt = Number(token.slice(0, dot));
  const sig = token.slice(dot + 1);
  if (!Number.isFinite(issuedAt) || !sig) return false;

  const expect = await sign(pass, issuedAt);
  if (sig !== expect) return false;

  const ageHours = (Date.now() / 1000 - issuedAt) / 3600;
  // 时间在未来超过 1 小时视为异常（时钟被改过之类）
  if (ageHours < -1) return false;

  return ageHours <= unlockHours(env);
}

/** 构造 Set-Cookie 值 */
export async function buildCookie(password: string, hours: number): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = `${issuedAt}.${await sign(password, issuedAt)}`;
  return `${COOKIE}=${token}; Path=/; Max-Age=${hours * 3600}; HttpOnly; Secure; SameSite=Lax`;
}

/** 清空 cookie */
export function clearCookie(): string {
  return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}
