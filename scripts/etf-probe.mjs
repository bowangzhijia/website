// 一次性验证第二轮的：交易所 WAF 会不会因为连发请求直接掐连接。
//
// 第一轮结果：上交所第一条 200（927 条），紧接着第二条 fetch failed，
// 深交所也 failed。判断是限速/连接重置，不是不可达。
// 这轮加请求间隔 + 重试，并把底层错误打出来。
//
// 结论确认后本文件和 etf-probe.yml 一起删掉。

import { writeFileSync } from 'node:fs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const SSE_H = { 'User-Agent': UA, Referer: 'https://www.sse.com.cn/', Origin: 'https://www.sse.com.cn' };
const SZSE_H = { 'User-Agent': UA, Referer: 'https://www.szse.cn/', Origin: 'https://www.szse.cn' };

const out = [];
const log = (s = '') => out.push(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(label, url, headers, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
      const text = await r.text();
      let j = null;
      try {
        j = JSON.parse(text);
      } catch {
        log(`${label} 第${i}次: status=${r.status} 非 JSON，前 200 字符: ${text.slice(0, 200)}`);
        return null;
      }
      log(`${label} 第${i}次: status=${r.status} OK`);
      return j;
    } catch (e) {
      const cause = e?.cause?.code || e?.cause?.message || e?.name || '?';
      log(`${label} 第${i}次失败: ${e?.message} / cause=${cause}`);
      if (i < tries) await sleep(1500 * i);
    }
  }
  return null;
}

log('=== 第二轮：间隔 + 重试 ===');
log(`北京时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
log(`出口 IP: ${process.env.PROBE_IP || '(未取)'}`);
log('');

const sseUrl = (d) =>
  'https://query.sse.com.cn/commonQuery.do?sqlId=COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L' +
  `&STAT_DATE=${d}&pageHelp.pageSize=10000&pageHelp.pageNo=1&pageHelp.beginPage=1&pageHelp.cacheSize=1&pageHelp.endPage=1`;

// 连取 3 个交易日，验证「历史可回溯」在 Actions 里也成立
for (const d of ['2026-11-20', '2026-11-19', '2026-11-18']) {
  log(`--- 上交所 ${d}`);
  const j = await getJson('SSE', sseUrl(d), SSE_H);
  const rows = j?.result || [];
  log(`  条数=${rows.length}`);
  const big = rows.find((x) => x.SEC_CODE === '510300');
  if (big) log(`  510300 份额=${big.TOT_VOL} 万份`);
  await sleep(3000);
  log('');
}

log('--- 深交所 CATALOGID=1945');
const szseUrl =
  'https://www.szse.cn/api/report/ShowReport/data?SHOWTYPE=JSON&CATALOGID=1945&TABKEY=tab1&PAGENO=1&random=0.3';
const j = await getJson('SZSE', szseUrl, SZSE_H);
if (j?.[0]) {
  const t = j[0];
  log(`  报表=${t.metadata.name} 日期=${t.metadata.subname} 总数=${t.metadata.recordcount} 页数=${t.metadata.pagecount}`);
  log(`  首行=${JSON.stringify(t.data[0])}`);
}

log('');
log('=== 结束 ===');

writeFileSync('etf-probe.txt', out.join('\n') + '\n', 'utf8');
console.log(out.join('\n'));
