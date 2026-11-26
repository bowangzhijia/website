/**
 * 告诉前端「当前是否已解锁」，用于决定点击栏目时是直接跳转还是弹口令框。
 *
 * 前端读不到 HttpOnly cookie，所以只能问后端。
 * 这个接口不返回任何数据，只回一个布尔值，没有泄露风险。
 */

import { isUnlocked, type Env } from '../_lib/auth';

interface Ctx {
  request: Request;
  env: Env;
}

export const onRequest = async (ctx: Ctx): Promise<Response> => {
  const unlocked = await isUnlocked(ctx.request, ctx.env);

  return new Response(JSON.stringify({ unlocked }), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
};
