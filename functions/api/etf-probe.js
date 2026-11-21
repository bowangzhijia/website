/**
 * GET /api/etf-probe
 *
 * 第二轮：深交所已通（772 条带份额），上交所 403。
 * 这里测上交所的几种变体，以及东财在 Cloudflare 出口上通不通，
 * 目的是给沪市份额找一条可用来源。
 *
 * 验证完删掉本文件。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

async function hit(url, headers) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*,application/json', ...headers },
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {}
    return {
      status: res.status,
      ms: Date.now() - t0,
      bytes: text.length,
      ok: !!parsed,
      body: parsed ? summarize(parsed) : text.slice(0, 160).replace(/\s+/g, ' '),
    };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, error: `${e?.name}: ${e?.message}` };
  }
}

function summarize(j) {
  if (Array.isArray(j)) return { arrayLen: j.length, first: j[0] ? Object.keys(j[0]).slice(0, 12) : null };
  if (j?.data?.diff) return { total: j.data.total, first: j.data.diff[0] };
  if (j?.data) return { data: j.data };
  if (j?.result) return { rows: Array.isArray(j.result) ? j.result.length : -1, first: j.result[0] };
  return { keys: Object.keys(j).slice(0, 12) };
}

export async function onRequestGet() {
  const d = '2026-11-20';
  const sseQ =
    'sqlId=COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L' +
    `&STAT_DATE=${d}&pageHelp.pageSize=10000&pageHelp.pageNo=1&pageHelp.beginPage=1&pageHelp.cacheSize=1&pageHelp.endPage=1`;

  const report = {};

  // 上交所：HTTP 变体 / 不同 Referer / 另一路径
  report.sse_http = await hit(`http://query.sse.com.cn/commonQuery.do?${sseQ}`, {
    Referer: 'http://www.sse.com.cn/',
  });
  report.sse_https_noref = await hit(`https://query.sse.com.cn/commonQuery.do?${sseQ}`, {});
  report.sse_soa = await hit(`https://query.sse.com.cn/commonSoaQuery.do?${sseQ}`, {
    Referer: 'https://www.sse.com.cn/',
  });
  report.sse_static = await hit('https://www.sse.com.cn/market/funddata/volumn/etfvolumn/', {
    Referer: 'https://www.sse.com.cn/',
  });

  // 东财：单只 + 批量
  report.em_single = await hit(
    'https://push2.eastmoney.com/api/qt/stock/get?secid=1.510300&invt=2&fltt=2&fields=f57,f58,f43,f84,f85,f116',
    { Referer: 'https://quote.eastmoney.com/' }
  );
  report.em_ulist = await hit(
    'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f12,f14,f2,f3,f84&secids=1.510300,1.510500,1.588000,0.159915',
    { Referer: 'https://quote.eastmoney.com/' }
  );

  return json(report);
}
