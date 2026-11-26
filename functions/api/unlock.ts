/**
 * 验证口令并种 cookie。
 *
 * 只接受 POST，口令从请求体里来，不放 URL（URL 会进日志和浏览器历史）。
 * cookie 里存「签发时间 + HMAC 签名」，服务端每次按当前配置判断是否过期，
 * 所以调 SITE_UNLOCK_HOURS 之后能立刻对所有设备生效。
 */

import { buildCookie, clearCookie, unlockHours, type Env } from '../_lib/auth';

interface Ctx {
  request: Request;
  env: Env;
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

  const cookie = await buildCookie(pass, unlockHours(ctx.env));

  return new Response(null, {
    status: 204,
    headers: { 'Set-Cookie': cookie, 'Cache-Control': 'no-store' },
  });
};

/** 退出：清掉 cookie */
export const onRequestDelete = async (): Promise<Response> =>
  new Response(null, {
    status: 204,
    headers: { 'Set-Cookie': clearCookie() },
  });
