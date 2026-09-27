/**
 * POST /api/subscribe
 * 订阅接口：把粉丝邮箱存进你自己的 D1 数据库，并给出双方反馈。
 *
 * 流程：
 *   1. 先落库（名单最重要，不能因为发信失败而丢）
 *   2. 给粉丝发确认邮件，附带退订链接和一键退订头
 *   3. 给站长发通知邮件
 *
 * 绑定要求：[[d1_databases]] binding = "SUBSCRIBERS_DB"
 *
 * 环境变量：
 *   RESEND_API_KEY   发信密钥
 *   MAIL_FROM        发件人，如 "波王之家 <noreply@yourdomain.com>"
 *   CONTACT_TO       站长邮箱，接收新订阅通知
 *   SUBSCRIBE_NOTIFY 设为 "off" 可关闭新订阅通知
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

/**
 * 清理 MAIL_FROM 里可能混入的零宽字符（BOM、零宽空格等）。
 * 这些字符不可见，但会让邮件客户端解析不出「发件人昵称」，
 * 退回显示地址的本地部分（例如把「波王之家」显示成 hello）。
 * 从 Word / 微信 / 网页复制配置时很容易带进来。
 */
const cleanFrom = (value) =>
  String(value ?? '')
    .replace(/[\uFEFF\u200B\u200C\u200D\u2060]/g, '')
    .trim();

/** 实际发送，失败时记录原因 */
async function send(env, kind, payload) {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ from: cleanFrom(env.MAIL_FROM), ...payload }),
    });
    if (!res.ok) {
      await logFailure(
        env,
        kind,
        `Resend 拒绝(${res.status}) → ${(await res.text()).slice(0, 400)}`
      );
      return false;
    }
    return true;
  } catch (error) {
    await logFailure(env, kind, `请求 Resend 异常 → ${error}`);
    return false;
  }
}

export async function onRequestPost({ request, env }) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: 'INVALID_JSON' }, 400);
  }

  const email = String(payload?.email ?? '')
    .trim()
    .toLowerCase();
  const source = payload?.source ? String(payload.source).slice(0, 200) : null;

  if (!EMAIL_RE.test(email) || email.length > 254) {
    return json({ ok: false, error: 'INVALID_EMAIL' }, 400);
  }

  if (!env.SUBSCRIBERS_DB) {
    return json({ ok: false, error: 'NOT_CONFIGURED' }, 503);
  }

  const origin = new URL(request.url).origin;
  let token = crypto.randomUUID().replace(/-/g, '');
  let total = null;

  // 1. 落库。重复订阅也算成功，不暴露「这个邮箱已存在」；
  //    重新订阅会清掉退订标记，token 沿用原来的。
  try {
    await env.SUBSCRIBERS_DB.prepare(
      `INSERT INTO subscribers (email, token, source, created_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(email) DO UPDATE SET
         unsubscribed_at = NULL,
         source = excluded.source`
    )
      .bind(email, token, source, new Date().toISOString())
      .run();

    const row = await env.SUBSCRIBERS_DB.prepare(
      'SELECT token FROM subscribers WHERE email = ?1'
    )
      .bind(email)
      .first();

    if (row?.token) token = row.token;

    const counted = await env.SUBSCRIBERS_DB.prepare(
      'SELECT COUNT(*) AS n FROM subscribers WHERE unsubscribed_at IS NULL'
    ).first();
    total = counted?.n ?? null;
  } catch (error) {
    console.error('D1 insert failed:', error);
    return json({ ok: false, error: 'DB_ERROR' }, 500);
  }

  if (env.RESEND_API_KEY && env.MAIL_FROM) {
    const pageUrl = `${origin}/unsubscribe/?token=${token}`;
    const apiUrl = `${origin}/api/unsubscribe?token=${token}`;

    // 2. 给粉丝的确认邮件：正文带退订链接，同时带标准一键退订头，
    //    Gmail / Outlook 会在邮件顶部显示原生「退订」按钮。
    await send(env, 'welcome', {
      to: email,
      subject: '订阅成功',
      // 粉丝直接点「回复」就能写信给站长（走 CONTACT_TO 这个邮箱）
      reply_to: env.CONTACT_TO || undefined,
      text: [
        '你好，',
        '',
        '订阅已确认。以后有新内容或重要观点，我会发到这个邮箱。',
        '',
        '有问题直接回复这封邮件即可。',
        '',
        '不想继续收到的话，点这里退订：',
        pageUrl,
      ].join('\n'),
      headers: {
        'List-Unsubscribe': `<${apiUrl}>, <${pageUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });

    // 3. 给站长的通知
    if (env.CONTACT_TO && env.SUBSCRIBE_NOTIFY !== 'off') {
      await send(env, 'notify', {
        to: env.CONTACT_TO,
        // 直接点「回复」就能回给这位订阅者，而不是发到收不了信的 noreply@
        reply_to: email,
        subject: `【波王之家】新订阅 ${email}`,
        text: [
          `新订阅者：${email}`,
          source ? `来源页面：${source}` : '',
          `时间：${new Date().toISOString()}`,
          total !== null ? `当前有效名单人数：${total}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      });
    }
  }

  return json({ ok: true });
}

export async function onRequestGet() {
  return json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
}
