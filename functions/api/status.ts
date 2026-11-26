/**
 * 告诉前端「当前是否已解锁」，用于决定点击栏目时是直接跳转还是弹口令框。
 *
 * 前端读不到 HttpOnly cookie，所以只能问后端。
 * 这个接口不返回任何数据，只回一个布尔值，没有泄露风险。
 */

interface Env {
  SITE_PASSWORD?: string;
}

interface Ctx {
  request: Request;
  env: Env;
}

const COOKIE = 'bw_unlock';
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

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

export const onRequest = async (ctx: Ctx): Promise<Response> => {
  const pass = ctx.env.SITE_PASSWORD;
  const token = readCookie(ctx.request, COOKIE);
  const unlocked = Boolean(pass && token && token === (await signature(pass)));

  return new Response(JSON.stringify({ unlocked }), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
};
