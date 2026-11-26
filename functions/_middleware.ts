/**
 * 给「ETF份额」栏目加一道口令门。
 *
 * 拦截范围：
 *   /columns/etf-share/*  —— 页面本身
 *   /data/etf-share/*     —— 数据文件（不拦这个等于没锁，JSON 能直接下载）
 *
 * 口令存在环境变量 SITE_PASSWORD 里，不写进代码、不进 git。
 * 校验通过后种一个 HMAC 签名的 cookie，30 天内免输；
 * cookie 里存的是签名而不是口令本身，即使被看到也推不出密码。
 *
 * 没配 SITE_PASSWORD 时**拒绝访问并提示**，而不是默默放行——
 * 否则会出现"以为锁上了其实完全公开"的情况，那种失误最难发现。
 */

/**
 * 手写上下文类型，不引 @cloudflare/workers-types。
 * 那个包的版本号和项目里的 wrangler 3.x 有 peer 冲突，装上会让部署直接挂掉。
 */
interface Ctx {
  request: Request;
  env: { SITE_PASSWORD?: string };
  next: () => Promise<Response>;
}

const COOKIE = 'bw_unlock';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 天

/** 受保护的路径前缀 */
const GUARDED = ['/columns/etf-share', '/data/etf-share'];

const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 用口令做 HMAC，得到一个固定签名当 cookie 值 */
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
  .err{min-height:20px;margin-top:10px;color:#f87171;font-size:13px}
</style>
</head>
<body>
  <form class="box" id="f">
    <h1>这个栏目是私密的</h1>
    <p>输入口令后可以查看，30 天内免输。</p>
    <input id="p" type="password" autocomplete="current-password" placeholder="口令" autofocus>
    <button id="b" type="submit">进入</button>
    <div class="err" id="e"></div>
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
      const t = await r.text();
      e.textContent = t || '口令不对';
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

  // 解锁接口自己要能访问，否则永远进不来
  if (path === '/api/unlock') return ctx.next();

  const guarded = GUARDED.some((g) => path === g || path.startsWith(g + '/'));
  if (!guarded) return ctx.next();

  const pass = ctx.env.SITE_PASSWORD;
  if (!pass) {
    return new Response('未配置 SITE_PASSWORD 环境变量，栏目已锁定但无法解锁。请在 Cloudflare Pages 设置里添加。', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const token = readCookie(ctx.request, COOKIE);
  if (token) {
    const expect = await signature(pass);
    if (token === expect) return ctx.next();
  }

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
