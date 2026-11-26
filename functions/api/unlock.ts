/**
 * 验证口令并种 cookie。
 *
 * 只接受 POST，口令从请求体里来，不放 URL（URL 会进日志和浏览器历史）。
 * 校验通过后种一个 HMAC 签名 cookie，值不是口令本身，看到也推不出密码。
 */

interface Env {
  SITE_PASSWORD?: string;
}

/** 手写上下文类型，不引 @cloudflare/workers-types（会和 wrangler 3.x 的 peer 依赖打架） */
interface Ctx {
  request: Request;
  env: Env;
}

const COOKIE = 'bw_unlock';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 天

const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function signature(password: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode('bw-unlock-v1'));
  return hex(sig);
}

export const onRequestPost = async (ctx: Ctx): Promise<Response> => {
  const pass = ctx.env.SITE_PASSWORD;
  if (!pass) {
    return new Response('未配置 SITE_PASSWORD', { status: 503 });
  }

  let given = '';
  try {
    const body = await ctx.request.json<{ password?: string }>();
    given = String(body.password ?? '');
  } catch {
    return new Response('请求格式不对', { status: 400 });
  }

  if (!given || given !== pass) {
    // 稍微延迟一下，削弱暴力尝试
    await new Promise((r) => setTimeout(r, 400));
    return new Response('口令不对', { status: 401 });
  }

  const token = await signature(pass);
  const cookie = `${COOKIE}=${token}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;

  return new Response(null, {
    status: 204,
    headers: { 'Set-Cookie': cookie, 'Cache-Control': 'no-store' },
  });
};

/** 退出：清掉 cookie */
export const onRequestDelete = async (): Promise<Response> =>
  new Response(null, {
    status: 204,
    headers: { 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` },
  });
