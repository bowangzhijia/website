/**
 * /api/unsubscribe?token=xxxx
 *
 *   POST → 执行退订。Gmail / Outlook 的一键退订（RFC 8058）就是往这里 POST
 *   GET  → 不执行退订，只跳转到确认页面。
 *          因为邮箱客户端会预抓取链接，GET 直接退订会误伤订阅者。
 *
 * 绑定：[[d1_databases]] binding = "SUBSCRIBERS_DB"
 */

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });

function getToken(request) {
  const url = new URL(request.url);
  const q = url.searchParams.get('token');
  if (q) return q.trim().toLowerCase();
  return '';
}

async function doUnsubscribe(env, token) {
  if (!env.SUBSCRIBERS_DB) {
    return { ok: false, error: 'NOT_CONFIGURED' };
  }
  if (!/^[0-9a-f]{16,64}$/.test(token)) {
    return { ok: false, error: 'INVALID_TOKEN' };
  }

  const row = await env.SUBSCRIBERS_DB.prepare(
    'SELECT id, unsubscribed_at FROM subscribers WHERE token = ?1'
  )
    .bind(token)
    .first();

  if (!row) {
    return { ok: false, error: 'NOT_FOUND' };
  }

  if (!row.unsubscribed_at) {
    await env.SUBSCRIBERS_DB.prepare(
      'UPDATE subscribers SET unsubscribed_at = ?1 WHERE id = ?2'
    )
      .bind(new Date().toISOString(), row.id)
      .run();
  }

  // 已经退订过也返回成功，避免重复点击报错
  return { ok: true };
}

export async function onRequestPost({ request, env }) {
  const result = await doUnsubscribe(env, getToken(request));
  return json(result, result.ok ? 200 : 400);
}

export async function onRequestGet({ request }) {
  // 不直接退订，转到确认页让用户点一下
  const token = getToken(request);
  const target = new URL('/unsubscribe/', request.url);
  if (token) target.searchParams.set('token', token);
  return Response.redirect(target.toString(), 302);
}
