/**
 * 给「ETF份额」栏目加一道口令门。
 *
 * 拦截范围：
 *   /columns/etf-share/*  —— 页面本身
 *   /data/etf-share/*     —— 数据文件（不拦这个等于没锁，JSON 能直接下载）
 *
 * 判定逻辑在 _lib/auth.ts：cookie 带签发时间，每次请求按当前配置算是否过期，
 * 所以调 SITE_UNLOCK_HOURS 之后，超期的旧 cookie 会立刻失效。
 *
 * 没配 SITE_PASSWORD 时**拒绝访问并提示**，而不是默默放行——
 * 否则会出现"以为锁上了其实完全公开"的情况，那种失误最难发现。
 */

import { isUnlocked, type Env } from './_lib/auth';

interface Ctx {
  request: Request;
  env: Env;
  next: () => Promise<Response>;
}

/** 受保护的路径前缀 */
const GUARDED = ['/columns/etf-share', '/data/etf-share'];

/** 口令输入页：自包含，不依赖站点样式，加载快也不怕样式被改 */
function unlockPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>需要口令</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;
       background:#0b0f14;color:#e6edf3;font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
  .box{width:min(92vw,340px);padding:28px 24px;border:1px solid #22303c;border-radius:14px;background:#111820}
  h1{margin:0 0 6px;font-size:18px}
  p{margin:0 0 18px;color:#8b9aa8;font-size:13px}
  input{width:100%;padding:11px 13px;border:1px solid #22303c;border-radius:9px;
        background:#0b0f14;color:#e6edf3;font-size:15px;outline:none}
  input:focus{border-color:#3b82f6}
  button{width:100%;margin-top:12px;padding:11px;border:0;border-radius:9px;
         background:#2563eb;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
  button:disabled{opacity:.6;cursor:default}
  .back{background:transparent;border:1px solid #22303c;color:#8b9aa8;font-weight:400;font-size:13px;padding:9px}
  .back:hover{color:#e6edf3;border-color:#3b4a57}
  .err{min-height:20px;margin-top:10px;color:#f87171;font-size:13px}
</style>
</head>
<body>
  <form class="box" id="f">
    <h1>这个栏目是私密的</h1>
    <p>输入口令后可以查看。</p>
    <input id="p" type="password" autocomplete="current-password" placeholder="口令" autofocus>
    <button id="b" type="submit">进入</button>
    <div class="err" id="e"></div>
    <button class="back" type="button" onclick="location.href='/'">返回首页</button>
  </form>
<script>
  const f = document.getElementById('f'), p = document.getElementById('p'),
        b = document.getElementById('b'), e = document.getElementById('e');
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const v = p.value.trim();
    if (!v) return;
    b.disabled = true; e.textContent = '';
    try {
      const r = await fetch('/api/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: v }),
      });
      if (r.ok) { location.reload(); return; }
      e.textContent = '口令不对';
    } catch {
      e.textContent = '网络出错，稍后再试';
    }
    b.disabled = false;
    p.select();
  });
</script>
</body>
</html>`;
}

export const onRequest = async (ctx: Ctx): Promise<Response> => {
  const url = new URL(ctx.request.url);
  const path = url.pathname;

  // 解锁和状态查询接口自己要能访问，否则永远进不来
  if (path === '/api/unlock' || path === '/api/status') return ctx.next();

  const guarded = GUARDED.some((g) => path === g || path.startsWith(g + '/'));
  if (!guarded) return ctx.next();

  if (!ctx.env.SITE_PASSWORD) {
    return new Response(
      '未配置 SITE_PASSWORD 环境变量，栏目已锁定但无法解锁。请在 Cloudflare Pages 设置里添加。',
      { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } }
    );
  }

  if (await isUnlocked(ctx.request, ctx.env)) return ctx.next();

  // 数据文件被前端 fetch，返回 HTML 会让 JSON 解析炸掉，所以这里给 401
  if (path.startsWith('/data/')) {
    return new Response(JSON.stringify({ error: 'locked' }), {
      status: 401,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  return new Response(unlockPage(), {
    status: 401,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
};
