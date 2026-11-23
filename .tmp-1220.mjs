// 临时：查 2021-12-20 沪深300 篮子明细
import { readFileSync } from 'node:fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36';
const sse = async (d) => {
  const u =
    'https://query.sse.com.cn/commonQuery.do?sqlId=COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L' +
    `&STAT_DATE=${d}&pageHelp.pageSize=10000&pageHelp.pageNo=1&pageHelp.beginPage=1&pageHelp.cacheSize=1&pageHelp.endPage=1`;
  const r = await fetch(u, { headers: { 'User-Agent': UA, Referer: 'https://www.sse.com.cn/' } });
  const j = await r.json();
  const m = new Map();
  for (const x of j.result || []) m.set(x.SEC_CODE, Number(String(x.TOT_VOL).replace(/,/g, '')));
  return m;
};
const szse = async (code, d) => {
  const u =
    'https://fund.szse.cn/api/report/ShowReport/data?SHOWTYPE=JSON&CATALOGID=fund_jjgm' +
    `&TABKEY=tab1&txtDm=${code}&txtStart=${d}&txtEnd=${d}&PAGENO=1`;
  const r = await fetch(u, { headers: { 'User-Agent': UA, Referer: 'https://fund.szse.cn/' } });
  const j = await r.json();
  const row = j[0]?.data?.[0];
  return row ? Number(String(row.current_size).replace(/,/g, '')) : null;
};
const px = async (code) => {
  const sym = `${code.startsWith('15') ? 'sz' : 'sh'}${code}`;
  const r = await fetch(
    'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData' +
      `?symbol=${sym}&scale=240&ma=no&datalen=4000`,
    { headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' } }
  );
  const j = await r.json();
  const m = new Map();
  for (const x of Array.isArray(j) ? j : []) m.set(x.day, { c: Number(x.close), v: Number(x.volume) });
  return m;
};

const baskets = JSON.parse(readFileSync('src/data/etf-share/baskets.json', 'utf8')).baskets;
const hs = baskets.find((b) => b.id === 'hs300').codes;
const A = '2021-12-17';
const B = '2021-12-20';
const a = await sse(A);
const b = await sse(B);

console.log('代码    份额变化(万份)  净流入(亿)  当日成交额(亿)');
let total = 0;
for (const code of hs) {
  let x = a.get(code);
  let y = b.get(code);
  if (code.startsWith('15')) {
    x = await szse(code, A);
    y = await szse(code, B);
    await new Promise((r) => setTimeout(r, 100));
  }
  if (x == null || y == null) continue;
  const d = y - x;
  if (Math.abs(d) < 1000) continue;
  const m = await px(code);
  const v = m.get(B);
  const price = v?.c || m.get(A)?.c || 0;
  const amt = (d * 1e4 * price) / 1e8;
  const turn = v ? (v.v * price) / 1e8 : null;
  total += amt;
  console.log(`${code}  ${d.toLocaleString().padStart(12)}  ${amt.toFixed(2).padStart(8)}  ${turn == null ? '—' : turn.toFixed(2)}`);
  await new Promise((r) => setTimeout(r, 120));
}
console.log('合计', total.toFixed(2), '亿元');
