/**
 * GET /api/etf-probe
 *
 * 一次性验证：Cloudflare 的出口 IP 能不能访问交易所的 ETF 份额接口。
 *
 * 背景：GitHub Actions 的 IP 访问上交所直接 403、深交所超时，
 * 而 Cloudflare 走自己的网络，可能没被拦。验证通过就把这里改造成正式抓取接口。
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
      headers: { 'User-Agent': UA, Accept: '*/*', ...headers },
      signal: AbortSignal.timeout(20000),
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
      isJson: !!parsed,
      head: parsed ? undefined : text.slice(0, 300),
      parsed,
    };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, error: `${e?.name}: ${e?.message}` };
  }
}

export async function onRequestGet() {
  const d = '2026-11-20';
  const report = {};

  // 上交所
  const sse = await hit(
    'https://query.sse.com.cn/commonQuery.do?sqlId=COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L' +
      `&STAT_DATE=${d}&pageHelp.pageSize=10000&pageHelp.pageNo=1&pageHelp.beginPage=1&pageHelp.cacheSize=1&pageHelp.endPage=1`,
    { Referer: 'https://www.sse.com.cn/', Origin: 'https://www.sse.com.cn' }
  );
  report.sse = {
    status: sse.status,
    ms: sse.ms,
    bytes: sse.bytes,
    isJson: sse.isJson,
    error: sse.error,
    head: sse.head,
    rows: sse.parsed?.result?.length,
    sample: sse.parsed?.result?.[0],
  };

  // 深交所
  const szse = await hit(
    'https://www.szse.cn/api/report/ShowReport/data?SHOWTYPE=JSON&CATALOGID=1945&TABKEY=tab1&PAGENO=1&random=0.3',
    { Referer: 'https://www.szse.cn/', Origin: 'https://www.szse.cn' }
  );
  const t = Array.isArray(szse.parsed) ? szse.parsed[0] : null;
  report.szse = {
    status: szse.status,
    ms: szse.ms,
    bytes: szse.bytes,
    isJson: szse.isJson,
    error: szse.error,
    head: szse.head,
    reportName: t?.metadata?.name,
    date: t?.metadata?.subname,
    recordcount: t?.metadata?.recordcount,
    sample: t?.data?.[0],
  };

  // 出口 IP
  const ip = await hit('https://api.ipify.org', {});
  report.egressIp = ip.parsed ? undefined : ip.head;

  return json(report);
}
