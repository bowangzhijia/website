/**
 * 代理 GitHub Actions 的运行记录。
 *
 * 为什么不让前端直接调 api.github.com：
 *   1. 请求 URL 里带着仓库名，打开开发者工具的网络面板就能看到，等于公开了仓库地址
 *   2. 匿名调用有 60 次/小时/IP 的限制，人多就会挂
 * 走自己的域名后仓库名只存在于服务端代码里，对外完全不可见。
 *
 * 加了 60 秒缓存：状态条不需要秒级实时，也能保护住 GitHub 的限额。
 */

interface Env {
  SITE_PASSWORD?: string;
}

interface Ctx {
  env: Env;
}

const REPO = 'bowangzhijia/website';
const WORKFLOW = 'etf-share.yml';
const CACHE_SECONDS = 60;

export const onRequestGet = async (): Promise<Response> => {
  const empty = { runs: [] as unknown[] };

  try {
    const r = await fetch(
      `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=5`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'bw-runstatus-proxy',
        },
      }
    );

    if (!r.ok) {
      // 上游挂了也返回 200 + 空数组，前端展示"状态不可用"总比报错好
      return new Response(JSON.stringify(empty), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        },
      });
    }

    const j = await r.json<{ workflow_runs?: any[] }>();

    // 只挑前端要用的字段，顺便把 html_url 去掉（那个链接会暴露仓库）
    const runs = (j.workflow_runs || []).map((x) => ({
      created_at: x.created_at,
      event: x.event,
      status: x.status,
      conclusion: x.conclusion,
    }));

    return new Response(JSON.stringify({ runs }), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': `public, max-age=${CACHE_SECONDS}`,
      },
    });
  } catch {
    return new Response(JSON.stringify(empty), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
};
