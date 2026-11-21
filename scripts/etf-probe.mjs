// 一次性验证第三轮：交易所被墙后，改测集思录 / 东财在 Actions 上能不能拿到份额。
//
// 本地已验证集思录匿名可取，字段有：
//   amount 份额(万份) / amount_incr 份额增减 / amount_increase_rt 变化率
//   amount_dt 份额更新时间 / fund_nav 净值 / increase_rt 涨跌幅 / index_nm 跟踪指数
//
// 这轮只回答一件事：Actions 的 IP 能不能访问。

import { writeFileSync } from 'node:fs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const out = [];
const log = (s = '') => out.push(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(label, url, headers = {}, json = true) {
  log('');
  log(`--- ${label}`);
  log(`URL: ${url}`);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*', ...headers },
      signal: AbortSignal.timeout(30000),
    });
    const buf = Buffer.from(await r.arrayBuffer());
    const text = buf.toString('utf8');
    log(`status=${r.status} bytes=${buf.length} type=${r.headers.get('content-type') || '-'}`);

    if (json) {
      try {
        return { status: r.status, j: JSON.parse(text), text };
      } catch {
        log(`非 JSON，前 500 字符:`);
        log(text.slice(0, 500));
        return { status: r.status, j: null, text };
      }
    }
    return { status: r.status, j: null, text };
  } catch (e) {
    log(`失败: ${e?.message} / cause=${e?.cause?.code || e?.cause?.message || '?'}`);
    return { status: 0, j: null, text: '' };
  }
}

log('=== 第三轮：集思录 / 东财 在 Actions 的可用性 ===');
log(`北京时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
log(`出口 IP: ${process.env.PROBE_IP || '(未取)'}`);

// ---------- 集思录 ----------
// 只打一次，集思录对连发请求会弹验证码
const js = await probe(
  '集思录 ETF 列表（走一次拿全量）',
  'https://www.jisilu.cn/data/etf/etf_list/?___jsl=LST___&rp=3000&page=1',
  { Referer: 'https://www.jisilu.cn/data/etf/' }
);

if (js.j?.rows) {
  const rows = js.j.rows;
  log(`rows 条数: ${rows.length}`);
  const c = rows[0]?.cell || {};
  log(`首行关键字段:`);
  for (const k of [
    'fund_id', 'fund_nm', 'amount', 'amount_incr', 'amount_increase_rt',
    'amount_dt', 'fund_nav', 'nav_dt', 'increase_rt', 'index_nm', 'price',
  ]) {
    log(`  ${k} = ${JSON.stringify(c[k])}`);
  }
  const withShare = rows.filter((x) => x.cell?.amount > 0).length;
  const withIncr = rows.filter((x) => x.cell?.amount_incr !== null && x.cell?.amount_incr !== undefined).length;
  log(`有份额的: ${withShare} / 有份额增减的: ${withIncr} / 总数: ${rows.length}`);
  const dts = [...new Set(rows.map((x) => String(x.cell?.amount_dt || '').slice(0, 10)))].slice(0, 5);
  log(`amount_dt 日期分布: ${JSON.stringify(dts)}`);
  log(`6 位代码的条数(场内): ${rows.filter((x) => /^\d{6}$/.test(x.cell?.fund_id || '')).length}`);
} else {
  log(`没拿到 rows。text 前 300: ${js.text.slice(0, 300)}`);
}

await sleep(2000);

// ---------- 东财（备选）----------
const em = await probe(
  '东财 stock/get 510300（f84 总份额 股）',
  'https://push2.eastmoney.com/api/qt/stock/get?secid=1.510300&invt=2&fltt=2&fields=f57,f58,f43,f84,f85,f116,f117',
  { Referer: 'https://quote.eastmoney.com/' }
);
if (em.j?.data) log(`data: ${JSON.stringify(em.j.data)}`);

log('');
log('=== 结束 ===');
log('判读：集思录 rows 上千条、amount 有值、amount_dt 是最近的交易日，就算通了。');

writeFileSync('etf-probe.txt', out.join('\n') + '\n', 'utf8');
console.log(out.join('\n'));
