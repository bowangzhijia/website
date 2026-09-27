/**
 * POST /api/message
 * 留言接口：访客填写自己的邮箱与内容，服务端转发到站长的邮箱。
 *
 * 站长的邮箱只存在于服务端环境变量 CONTACT_TO，前端拿不到、也不会出现在页面源码里。
 *
 * 环境变量：
 *   RESEND_API_KEY  必填
 *   CONTACT_TO      必填，站长收信的邮箱
 *   MAIL_FROM       必填，发件人
 *   SUBSCRIBERS_DB  可选，绑定了 D1 就会存一份留言，并记录发信失败原因
 */

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_MESSAGE = 2000;
const MAX_EMAIL = 254;

/**
 * 清理 MAIL_FROM 里可能混入的零宽字符（BOM、零宽空格等）。
 * 这些字符不可见，但会让邮件客户端解析不出「发件人昵称」，
 * 退回显示地址的本地部分。从 Word / 微信 / 网页复制配置时很容易带进来。
 */
const cleanFrom = (value) =>
  String(value ?? '')
    .replace(/[\uFEFF\u200B\u200C\u200D\u2060]/g, '')
    .trim();

/** 记录失败原因，便于排查 */
async function logFailure(env, kind, detail) {
  console.error(kind, detail);
  if (!env.SUBSCRIBERS_DB) return;
  try {
    await env.SUBSCRIBERS_DB.prepare(
      'INSERT INTO send_logs (kind, detail, created_at) VALUES (?1, ?2, ?3)'
    )
      .bind(kind, String(detail).slice(0, 900), new Date().toISOString())
      .run();
  } catch (error) {
    console.error('logFailure failed:', error);
  }
}

/** 不泄露真实值，只记录形状，用来判断环境变量是不是填错了 */
function configShape(env) {
  const from = String(env.MAIL_FROM ?? '');
  const key = String(env.RESEND_API_KEY ?? '');
  const to = String(env.CONTACT_TO ?? '');
  return [
    `MAIL_FROM len=${from.length} value=${from || '(空)'}`,
    `KEY len=${key.length} prefix=${key.slice(0, 3) || '(空)'}`,
    `TO=${to || '(空)'}`,
  ].join(' | ');
}

export async function onRequestPost({ request, env }) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: 'INVALID_JSON' }, 400);
  }

  const email = String(payload?.email ?? '').trim().toLowerCase();
  const message = String(payload?.message ?? '').trim();
  const source = payload?.source ? String(payload.source).slice(0, 200) : null;

  if (!EMAIL_RE.test(email) || email.length > MAX_EMAIL) {
    return json({ ok: false, error: 'INVALID_EMAIL' }, 400);
  }
  if (message.length < 2 || message.length > MAX_MESSAGE) {
    return json({ ok: false, error: 'INVALID_MESSAGE' }, 400);
  }

  // 先落库，避免邮件发送失败导致留言丢失
  if (env.SUBSCRIBERS_DB) {
    try {
      await env.SUBSCRIBERS_DB.prepare(
        `INSERT INTO messages (email, message, source, created_at)
         VALUES (?1, ?2, ?3, ?4)`
      )
        .bind(email, message, source, new Date().toISOString())
        .run();
    } catch (error) {
      console.error('D1 insert failed:', error);
    }
  }

  if (!env.RESEND_API_KEY || !env.CONTACT_TO || !env.MAIL_FROM) {
    await logFailure(env, 'message', `缺少环境变量 → ${configShape(env)}`);
    return json({ ok: false, error: 'NOT_CONFIGURED' }, 503);
  }

  let res;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: cleanFrom(env.MAIL_FROM),
        to: env.CONTACT_TO,
        // 直接回复这封邮件就能回给留言者
        reply_to: email,
        subject: `【波王之家留言】${message.slice(0, 30)}`,
        text: [
          `来自：${email}`,
          source ? `页面：${source}` : '',
          `时间：${new Date().toISOString()}`,
          '',
          '--- 留言内容 ---',
          message,
        ]
          .filter(Boolean)
          .join('\n'),
      }),
    });
  } catch (error) {
    await logFailure(env, 'message', `请求 Resend 异常 → ${error} | ${configShape(env)}`);
    return json({ ok: false, error: 'MAIL_FAILED' }, 502);
  }

  if (!res.ok) {
    const body = await res.text();
    await logFailure(
      env,
      'message',
      `Resend 拒绝(${res.status}) → ${body.slice(0, 400)} | ${configShape(env)}`
    );
    return json({ ok: false, error: 'MAIL_FAILED' }, 502);
  }

  return json({ ok: true });
}

export async function onRequestGet() {
  return json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
}
