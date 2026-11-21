// 一次性验证：GitHub Actions 的海外 IP 能不能拿到交易所 ETF 份额。
//
// 本地（住宅 IP）已验证数据源正确，这里只回答一个问题：
// Actions 能不能访问？不能的话整个方案要重来。
//
// 结果写进 etf-probe.txt，由 workflow 提交回仓库。
// 结论确认后本文件和 etf-probe.yml 一起删掉。

import { writeFileSync } from 'node:fs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const SSE_H = { 'User-Agent': UA, Referer: 'https://www.sse.com.cn/', Origin: 'https://www.sse.com.cn' };
const SZSE_H = { 'User-Agent': UA, Referer: 'https://www.szse.cn/', Origin: 'https://www.szse.cn' };

const out = [];
const log = (s = '') => out.push(s);

log('=== Actions 能否访问交易所 ETF 份额接口 ===');
log(`北京时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
log(`出口 IP: ${process.env.PROBE_IP || '(未取)'}`);
log('');

// ---------- 上交所 ----------
const sseUrl = (d) =>
  'https://query.sse.com.cn/commonQuery.do?sqlId=COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L' +
  `&STAT_DATE=${d}&pageHelp.pageSize=10000&pageHelp.pageNo=1&pageHelp.beginPage=1&pageHelp.cacheSize=1&pageHelp.endPage=1`;

for (const d of ['2026-11-20', '2026-11-19', '2026-11-14']) {
  log(`--- 上交所 STAT_DATE=${d}`);
  try {
    const r = await fetch(sseUrl(d), { headers: SSE_H, signal: AbortSignal.timeout(25000) });
    const j = await r.json();
    const rows = j.result || [];
    log(`status=${r.status} 条数=${rows.length}`);
    if (rows.length) {
      log(`样例: ${JSON.stringify(rows[0])}`);
      const types = {};
      for (const x of rows) types[x.ETF_TYPE] = (types[x.ETF_TYPE] || 0) + 1;
      log(`ETF_TYPE 分布: ${JSON.stringify(types)}`);
      const noShare = rows.filter((x) => !x.TOT_VOL || Number(x.TOT_VOL) <= 0).length;
      log(`TOT_VOL 为空/0 的条数: ${noShare}`);
      // 挑一只大 ETF 看看数对不对（510300 华泰柏瑞沪深300）
      const big = rows.find((x) => x.SEC_CODE === '510300');
      log(`510300: ${big ? JSON.stringify(big) : '不在列表里'}`);
    }
  } catch (e) {
    log(`失败: ${e?.name} ${e?.message}`);
  }
  log('');
}

// ---------- 深交所 ----------
log('--- 深交所 CATALOGID=1945（ETF列表，只能取最新一期）');
try {
  const u =
    'https://www.szse.cn/api/report/ShowReport/data?SHOWTYPE=JSON&CATALOGID=1945' +
    '&TABKEY=tab1&PAGENO=1&random=0.3';
  const r = await fetch(u, { headers: SZSE_H, signal: AbortSignal.timeout(25000) });
  const j = await r.json();
  const t = j[0];
  log(`status=${r.status}`);
  log(`报表: ${t.metadata.name} / 日期: ${t.metadata.subname} / 总数: ${t.metadata.recordcount} / 页数: ${t.metadata.pagecount}`);
  log(`列: ${JSON.stringify(t.metadata.cols)}`);
  log(`首行: ${JSON.stringify(t.data[0])}`);
} catch (e) {
  log(`失败: ${e?.name} ${e?.message}`);
}

log('');
log('=== 结束 ===');
log('判读：上交所 11-20 / 11-19 有几百条、11-14 为 0 条，深交所有 700+ 条，就算通了。');

writeFileSync('etf-probe.txt', out.join('\n') + '\n', 'utf8');
console.log(out.join('\n'));
