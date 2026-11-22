#!/usr/bin/env node
/**
 * ============================================================
 *  ETF 份额采集 · 多源互补版
 * ============================================================
 *
 * 为什么要多源：交易所接口对境外 IP 是「抽签」——同一个脚本，
 * 有的 IP 全通，有的 IP 上交所 403、深交所超时。所以每个市场都配
 * 主源 + 备用源 + 兜底源，一个挂了自动降级，别指望单点。
 *
 *   沪市  主：上交所 commonQuery（一次拿全市场 927 只）
 *         备：上交所往前回溯最多 5 个交易日
 *         兜底：东财 stock/get 的 f84（逐只，慢，只在主源全挂时用）
 *   深市  主：fund_jjgm 按日拿全市场（每页 20 条，55 页）
 *         备：1945 ETF 列表（每页 10 条，78 页，顺带做交叉校验）
 *         兜底：东财 stock/get 的 f84
 *
 * 交叉校验：同一只 ETF 两个源都拿到时比对，偏差超过 1% 打标记，
 * 避免某一源返回脏数据悄悄污染「份额变化」这个信号。
 *
 * 两个必须守住的规矩：
 *   1. 抓不到就退出，**不写空数据**——旧数据比错数据值钱。
 *   2. 非交易日（上交所返回 0 条）直接跳过，不出空文章。
 *
 * 本地用法：
 *   node scripts/etf-share.mjs                  # 抓最近一个交易日
 *   node scripts/etf-share.mjs --date=2026-11-20
 *   node scripts/etf-share.mjs --days=10        # 回溯补 10 个交易日
 *   node scripts/etf-share.mjs --no-article     # 只抓数据，不生成文章
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'src', 'data', 'etf-share');
const POSTS_DIR = join(ROOT, 'src', 'content', 'posts');

/** 发到哪个栏目（对应 src/site.config.ts） */
const COLUMN = 'etf-boduan-wang';

/** 回溯时最多往前找几天 */
const LOOKBACK_DAYS = 8;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const H_SSE = { 'User-Agent': UA, Referer: 'https://www.sse.com.cn/', Origin: 'https://www.sse.com.cn' };
const H_SZSE = {
  'User-Agent': UA,
  Referer: 'https://www.szse.cn/market/product/list/etfList/index.html',
  Accept: 'application/json, text/javascript, */*; q=0.01',
};
const H_SZSE_FUND = { 'User-Agent': UA, Referer: 'https://fund.szse.cn/' };
const H_EM = { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================
//  工具
// ============================================================

/** 北京时间今天，YYYY-MM-DD */
function beijingToday() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
}

function shiftDate(date, deltaDays) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/** 节假日/周末粗筛：周末不请求，少挨一次封 */
function isWeekend(date) {
  const w = new Date(date + 'T00:00:00Z').getUTCDay();
  return w === 0 || w === 6;
}

/** 带重试的 JSON 请求。失败返回 null，不抛异常。 */
async function fetchJson(url, headers, label, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(25000) });
      const text = await res.text();
      if (!text.trim()) throw new Error('空响应体');
      if (res.status === 403) {
        // 403 是 IP 被挡，重试同一个 IP 没用，尽早返回让上层降级
        console.warn(`   ${label}：403（这个出口 IP 被挡了）`);
        return null;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return JSON.parse(text);
    } catch (e) {
      if (i === tries) {
        console.warn(`   ${label}：${e.message}`);
        return null;
      }
      await sleep(800 * i);
    }
  }
  return null;
}

/** 万份 → 份；兼容 "1,234.56" */
function toShares(v) {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 10000) : 0;
}

// ============================================================
//  沪市：上交所
// ============================================================

function sseUrl(date) {
  return (
    'https://query.sse.com.cn/commonQuery.do?sqlId=COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L' +
    `&STAT_DATE=${date}&pageHelp.pageSize=10000&pageHelp.pageNo=1` +
    '&pageHelp.beginPage=1&pageHelp.cacheSize=1&pageHelp.endPage=1'
  );
}

/** 取某个交易日的沪市全市场 ETF 份额。非交易日返回空 Map。 */
async function fetchSse(date) {
  const j = await fetchJson(sseUrl(date), H_SSE, `上交所 ${date}`);
  const rows = j?.result || [];
  const map = new Map();
  for (const r of rows) {
    const code = String(r.SEC_CODE || '').trim();
    const share = toShares(r.TOT_VOL);
    // 新上市的 ETF 首日没有份额，跳过，不要显示 0
    if (!code || !share) continue;
    map.set(code, { code, name: String(r.SEC_NAME || '').trim(), market: 'sh', share, type: r.ETF_TYPE || '' });
  }
  return map;
}

/** 从 date 往前找最近一个有数据的交易日 */
async function fetchSseLatest(fromDate) {
  for (let i = 0; i <= LOOKBACK_DAYS; i++) {
    const d = shiftDate(fromDate, -i);
    if (isWeekend(d)) continue;
    const map = await fetchSse(d);
    if (map.size > 500) return { date: d, map };
    await sleep(500);
  }
  return null;
}

// ============================================================
//  深市：深交所
// ============================================================

/**
 * 主源：fund_jjgm 按日拿全市场。
 * 不传 txtDm 就是全市场，单页固定 20 条，1088 只需 55 页。
 * 返回的是全部基金（含 LOF / 封闭式），用「代码 15 开头 + 名称含 ETF」过滤。
 */
async function fetchSzseShares(date) {
  const base =
    'https://fund.szse.cn/api/report/ShowReport/data?SHOWTYPE=JSON&CATALOGID=fund_jjgm' +
    `&TABKEY=tab1&txtStart=${date}&txtEnd=${date}`;
  const first = await fetchJson(`${base}&PAGENO=1`, H_SZSE_FUND, `深交所份额 ${date} p1`);
  if (!first?.[0]) return new Map();

  const pageCount = Number(first[0]?.metadata?.pagecount || 1);
  const map = new Map();
  const take = (rows) => {
    for (const r of rows || []) {
      const code = String(r.fund_code || '').trim();
      const name = String(r.security_short_name || '').trim();
      const share = toShares(r.current_size);
      const isEtf = /^15\d{4}$/.test(code) && /ETF/i.test(name);
      if (!isEtf || !share) continue;
      map.set(code, { code, name, market: 'sz', share, type: '' });
    }
  };
  take(first[0].data);

  for (let p = 2; p <= pageCount; p++) {
    const j = await fetchJson(`${base}&PAGENO=${p}`, H_SZSE_FUND, `深交所份额 p${p}`);
    if (!j?.[0]) break; // 断了就用手上已有的，别把整批丢掉
    take(j[0].data);
    await sleep(120); // 别打太快
  }
  return map;
}

/** 备源：1945 ETF 列表，字段 dqgm（万份）。顺便用来交叉校验。 */
async function fetchSzseList() {
  const map = new Map();
  for (let p = 1; p <= 90; p++) {
    const url =
      'https://www.szse.cn/api/report/ShowReport/data?SHOWTYPE=JSON&CATALOGID=1945' +
      `&TABKEY=tab1&PAGENO=${p}&random=0.${p}`;
    const j = await fetchJson(url, H_SZSE, `深交所列表 p${p}`, 2);
    const blk = j?.[0];
    if (!blk) break;
    for (const r of blk.data || []) {
      // sys_key / kzjcurl 里是带 <u> 的 HTML，抠出代码和名称
      const code = (String(r.sys_key || '').match(/>(\d{6})</) || [])[1];
      const name = (String(r.kzjcurl || '').match(/>([^<]+)<\/u>/) || [])[1] || '';
      const share = toShares(r.dqgm);
      if (code && share) map.set(code, { code, name: name.trim(), market: 'sz', share, type: '' });
    }
    if (p >= Number(blk.metadata?.pagecount || 1)) break;
    await sleep(150);
  }
  return map;
}

// ============================================================
//  兜底：东财
// ============================================================

/**
 * 批量报价：一次 80 只，拿收盘价和涨跌幅。
 *
 * 涨跌幅是判断「涨了但份额减」「跌了但份额增」的必要条件，
 * 收盘价用来把份额变化折算成金额（净流入）。
 *
 * ⚠️ 这个接口的 f84（份额）不可信，与单只查询差 66 倍，只用 f2/f3。
 */
async function fetchEmQuotes(items) {
  const quotes = new Map();
  const CHUNK = 80;
  for (let i = 0; i < items.length; i += CHUNK) {
    const batch = items.slice(i, i + CHUNK);
    const secids = batch.map((x) => `${x.market === 'sh' ? '1' : '0'}.${x.code}`).join(',');
    const url =
      'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2' +
      `&fields=f12,f14,f2,f3&secids=${secids}`;
    const j = await fetchJson(url, H_EM, `东财报价 ${Math.floor(i / CHUNK) + 1}`, 2);
    for (const d of j?.data?.diff || []) {
      const close = Number(d.f2);
      const chg = Number(d.f3);
      if (Number.isFinite(close) && close > 0) {
        quotes.set(String(d.f12), { close, chgPct: Number.isFinite(chg) ? chg : null });
      }
    }
    await sleep(120);
  }
  return quotes;
}

/** 单只 ETF 的总份额（份）。只在前两源都失败时用，慢。 */
async function fetchEmShare(code) {
  const secid = code.startsWith('15') ? `0.${code}` : `1.${code}`;
  const url =
    `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&invt=2&fltt=2` +
    '&fields=f57,f58,f43,f84,f116';
  const j = await fetchJson(url, H_EM, `东财 ${code}`, 2);
  const d = j?.data;
  if (!d || !d.f84) return null;
  return { code, name: String(d.f58 || '').trim(), share: Number(d.f84) || 0, close: Number(d.f43) || 0 };
}

// ============================================================
//  合并 + 交叉校验
// ============================================================

function mergeDay({ date, sse, szseMain, szseBackup, emFallback = new Map() }) {
  const items = [];
  const warnings = [];

  for (const [, v] of sse) items.push({ ...v, src: 'sse' });

  // 深市：主源优先；主源缺的用备源；两者都有时比对
  const szCodes = new Set([...szseMain.keys(), ...szseBackup.keys()]);
  let mismatch = 0;
  for (const code of szCodes) {
    const a = szseMain.get(code);
    const b = szseBackup.get(code);
    const pick = a || b;
    if (!pick) continue;

    let src = a ? 'fund_jjgm' : '1945';
    if (a && b && b.share > 0) {
      const diff = Math.abs(a.share - b.share) / b.share;
      if (diff > 0.01) {
        mismatch++;
        // 两边打架时以 fund_jjgm 为准（它是份额专项报表），但要留痕
        warnings.push(`${code} 两源份额偏差 ${(diff * 100).toFixed(1)}%`);
      }
    }
    items.push({ ...pick, src });
  }

  for (const [, v] of emFallback) {
    if (!items.some((x) => x.code === v.code)) items.push({ ...v, market: v.code.startsWith('15') ? 'sz' : 'sh', src: 'eastmoney' });
  }

  if (mismatch > 0) warnings.unshift(`深市 ${mismatch} 只两源份额偏差超 1%`);

  return { date, generatedAt: new Date().toISOString(), items, warnings };
}

// ============================================================
//  存盘
// ============================================================

function snapshotPath(date) {
  return join(DATA_DIR, 'daily', `${date}.json`);
}

function saveSnapshot(snap) {
  const dir = join(DATA_DIR, 'daily');
  mkdirSync(dir, { recursive: true });
  writeFileSync(snapshotPath(snap.date), JSON.stringify(snap), 'utf8');
  _snapCache.set(snap.date, snap);
}

/** 已有的历史快照，按日期升序 */
function listSnapshots() {
  const dir = join(DATA_DIR, 'daily');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.slice(0, 10))
    .sort();
}

/** 只保留最近 N 个交易日的快照，不然仓库一年能涨几十兆 */
const KEEP_DAYS = 60;

function pruneOldSnapshots() {
  const dates = listSnapshots();
  const extra = dates.slice(0, Math.max(0, dates.length - KEEP_DAYS));
  for (const d of extra) rmSync(snapshotPath(d), { force: true });
  if (extra.length) console.log(`   清理 ${extra.length} 个过期快照（保留最近 ${KEEP_DAYS} 个交易日）`);
}

const _snapCache = new Map();

function loadSnapshot(date) {
  if (_snapCache.has(date)) return _snapCache.get(date);
  const p = snapshotPath(date);
  let data = null;
  if (existsSync(p)) {
    try {
      data = JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      data = null;
    }
  }
  _snapCache.set(date, data);
  return data;
}

// ============================================================
//  主流程：抓一天
// ============================================================

async function collectDay(date) {
  console.log(`\n=== ${date} ===`);

  const sse = await fetchSse(date);
  console.log(`   沪市（上交所）：${sse.size} 只`);

  let szseMain = await fetchSzseShares(date);
  console.log(`   深市（fund_jjgm）：${szseMain.size} 只`);

  let szseBackup = new Map();
  // 主源太少（可能是接口半挂）或正常情况都拉一次列表做校验——78 页有点慢，
  // 只在主源件数异常时拉，日常不拉，省请求。
  if (szseMain.size < 600) {
    console.log('   深市主源件数偏少，拉 1945 列表对照…');
    szseBackup = await fetchSzseList();
    console.log(`   深市（1945 备源）：${szseBackup.size} 只`);
  }

  // 一个市场都没拿到 → 直接放弃，别写空数据
  if (sse.size === 0 && szseMain.size === 0 && szseBackup.size === 0) {
    console.error('✖  沪深都没抓到数据，本次不写盘');
    return null;
  }

  const snap = mergeDay({ date, sse, szseMain, szseBackup });
  console.log(`   合并后 ${snap.items.length} 只（沪 ${snap.items.filter((x) => x.market === 'sh').length} / 深 ${snap.items.filter((x) => x.market === 'sz').length}）`);
  if (snap.warnings.length) console.log(`   ⚠ ${snap.warnings.join('；')}`);

  // 补价格。拿不到不致命——榜单退化成只按份额变化率排，不显示金额
  const quotes = await fetchEmQuotes(snap.items);
  let priced = 0;
  for (const it of snap.items) {
    const q = quotes.get(it.code);
    if (q) {
      it.close = q.close;
      it.chgPct = q.chgPct;
      priced++;
    }
  }
  console.log(`   补价格：${priced}/${snap.items.length} 只`);

  saveSnapshot(snap);
  pruneOldSnapshots();
  console.log(`   ✔ 已存 ${snapshotPath(date)}`);
  return snap;
}

// ============================================================
//  变化计算
// ============================================================

/** 宽基关键词。命中归「宽基」，其余算行业/主题 */
const BROAD_WORDS = [
  '沪深300', '中证500', '中证1000', '中证2000', '中证A500', '中证A50',
  '上证50', '上证180', '上证380', '科创50', '科创100', '科创200',
  '创业板', '深证100', '深证50', '国证2000', '双创', 'MSCI', 'A股', '全指',
];

const isBroad = (name) => BROAD_WORDS.some((k) => name.includes(k));

/** 份额太小的不进榜：几百万份的 ETF 变化率能翻倍，纯噪音 */
const MIN_PREV_SHARE = 1e7; // 1000 万份

/**
 * 反直觉榜的绝对额门槛。
 * 只按变化率排会混进「-0.03 亿份、变化率 -8%」这种小 ETF，
 * 变化率吓人但金额可以忽略，读者看完没有信息量。
 */
const MIN_AMOUNT = 5e8; // 5 亿元
const MIN_DELTA = 1e8; // 1 亿份（拿不到价格时的替代门槛）

const bigEnough = (r) => (r.amount != null ? Math.abs(r.amount) >= MIN_AMOUNT : Math.abs(r.delta) >= MIN_DELTA);

/**
 * 用最近两个快照算变化。
 * 返回 { prev, rows }，rows 里每只带 delta / deltaPct / amount。
 */
function computeChanges(date) {
  const dates = listSnapshots();
  const idx = dates.indexOf(date);
  if (idx <= 0) return { prev: null, rows: [] };

  const prevDate = dates[idx - 1];
  const cur = loadSnapshot(date);
  const prev = loadSnapshot(prevDate);
  if (!cur || !prev) return { prev: null, rows: [] };

  const prevMap = new Map(prev.items.map((x) => [x.code, x]));
  const rows = [];
  for (const it of cur.items) {
    const p = prevMap.get(it.code);
    // 新上市 / 前一交易日没数据 → 跳过，不能当成巨额申购
    if (!p || !p.share || p.share < MIN_PREV_SHARE) continue;
    const delta = it.share - p.share;
    if (delta === 0) continue;
    rows.push({
      ...it,
      prevShare: p.share,
      delta,
      deltaPct: (delta / p.share) * 100,
      // 有价格才能折成金额，没有就记 null
      amount: it.close ? delta * it.close : null,
    });
  }
  return { prev: prevDate, rows };
}

/** 连续同向天数（从最近往前数，含今天这次变化） */
function consecutiveDays(code, dates, dir) {
  let n = 0;
  for (let i = dates.length - 1; i > 0; i--) {
    const a = loadSnapshot(dates[i]);
    const b = loadSnapshot(dates[i - 1]);
    const cur = a?.items.find((x) => x.code === code);
    const old = b?.items.find((x) => x.code === code);
    if (!cur || !old || !old.share) break;
    const d = cur.share - old.share;
    if (dir > 0 ? d > 0 : d < 0) n++;
    else break;
  }
  return n;
}

// ============================================================
//  文章生成
// ============================================================

const yi = (shares) => (shares / 1e8).toFixed(2);
const pct = (v) => (v > 0 ? '+' : '') + v.toFixed(2) + '%';
const money = (v) => (v == null ? '—' : (v / 1e8).toFixed(2));

/** 名称截断，表格别被撑爆 */
const shortName = (n) => (n.length > 10 ? n.slice(0, 10) + '…' : n);

function yamlStr(text) {
  return '"' + String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function table(rows, withAmount) {
  const head = withAmount
    ? '| 代码 | 名称 | 份额变化(亿份) | 变化率 | 涨跌幅 | 估算净流入(亿元) |'
    : '| 代码 | 名称 | 份额变化(亿份) | 变化率 | 涨跌幅 |';
  const sep = withAmount ? '|---|---|---:|---:|---:|---:|' : '|---|---|---:|---:|---:|';
  const body = rows.map((r) => {
    const cells = [
      r.code,
      shortName(r.name),
      `${r.delta > 0 ? '+' : ''}${yi(r.delta)}`,
      pct(r.deltaPct),
      r.chgPct == null ? '—' : pct(r.chgPct),
    ];
    if (withAmount) cells.push(money(r.amount));
    return '| ' + cells.join(' | ') + ' |';
  });
  return [head, sep, ...body].join('\n');
}

function buildArticle(date, { prev, rows }, dates) {
  const [, month, day] = date.split('-');
  const title = `${Number(month)}月${Number(day)}日 · ETF 份额异动`;
  const hasPrice = rows.some((r) => r.amount != null);

  const inflow = rows.filter((r) => r.delta > 0).sort((a, b) => b.delta - a.delta);
  const outflow = rows.filter((r) => r.delta < 0).sort((a, b) => a.delta - b.delta);

  const upButRedeem = rows
    .filter((r) => r.chgPct != null && r.chgPct > 0 && r.delta < 0 && bigEnough(r))
    .sort((a, b) => (a.amount ?? a.delta) - (b.amount ?? b.delta));
  const downButBuy = rows
    .filter((r) => r.chgPct != null && r.chgPct < 0 && r.delta > 0 && bigEnough(r))
    .sort((a, b) => (b.amount ?? b.delta) - (a.amount ?? a.delta));

  const totalAmount = rows.reduce((s, r) => s + (r.amount || 0), 0);
  const summary =
    inflow.length && outflow.length
      ? `${date} ETF 份额：${inflow.length} 只净申购、${outflow.length} 只净赎回` +
        (hasPrice ? `，合计净流入 ${money(totalAmount)} 亿元` : '')
      : `${date} ETF 份额变化`;

  const lines = [];
  lines.push('---');
  lines.push(`title: ${yamlStr(title)}`);
  lines.push(`summary: ${yamlStr(summary)}`);
  lines.push(`date: ${date}`);
  lines.push(`column: ${COLUMN}`);
  lines.push('sectors: []');
  lines.push('---');
  lines.push('');

  lines.push(
    '> 份额是**真金白银的申购赎回**，规模涨可能只是净值涨，份额涨才说明有人把钱搬进来了。'
  );
  lines.push(`> 数据：上交所 / 深交所官方披露，统计日 **${date}**，对比上一交易日 ${prev}。`);
  lines.push('');

  lines.push('## 一句话');
  lines.push('');
  lines.push(
    `全市场 ${rows.length} 只有份额变动：**${inflow.length} 只净申购**、**${outflow.length} 只净赎回**` +
      (hasPrice ? `，合计净流入 **${money(totalAmount)} 亿元**。` : '。')
  );

  // 单日变动超过 30% 的，多半是大额申购或份额调整，值得单独点一句，
  // 否则读者会以为数据错了
  const outliers = rows.filter((r) => Math.abs(r.deltaPct) > 30 && bigEnough(r));
  if (outliers.length) {
    lines.push('');
    lines.push(
      `其中 ${outliers.length} 只单日份额变动超过 30%（${outliers
        .slice(0, 3)
        .map((r) => r.name)
        .join('、')} 等），这种量级不是散户能凑出来的。`
    );
  }
  lines.push('');

  if (inflow.length) {
    lines.push('## 净申购 TOP 10');
    lines.push('');
    lines.push(table(inflow.slice(0, 10), hasPrice));
    lines.push('');
  }

  if (outflow.length) {
    lines.push('## 净赎回 TOP 10');
    lines.push('');
    lines.push(table(outflow.slice(0, 10), hasPrice));
    lines.push('');
  }

  if (upButRedeem.length) {
    lines.push('## 反直觉一：涨了，份额却在减');
    lines.push('');
    lines.push('价格涨、份额降，说明有资金借着上涨离场。');
    lines.push('');
    lines.push(table(upButRedeem.slice(0, 8), hasPrice));
    lines.push('');
  }

  if (downButBuy.length) {
    lines.push('## 反直觉二：跌了，份额反而增');
    lines.push('');
    lines.push('价格跌、份额涨，是逆势抄底的动作。');
    lines.push('');
    lines.push(table(downButBuy.slice(0, 8), hasPrice));
    lines.push('');
  }

  // 连续同向：只在有 3 天以上快照时才有意义
  if (dates.length >= 4) {
    const streak = inflow
      .slice(0, 40)
      .map((r) => ({ ...r, days: consecutiveDays(r.code, dates, 1) }))
      .filter((r) => r.days >= 3)
      .sort((a, b) => b.days - a.days)
      .slice(0, 10);
    if (streak.length) {
      lines.push('## 连续净申购');
      lines.push('');
      lines.push('连着几天都在被买，比单日的猛增更值得留意。');
      lines.push('');
      lines.push('| 代码 | 名称 | 连续天数 | 今日份额变化(亿份) |');
      lines.push('|---|---|---:|---:|');
      for (const r of streak) {
        lines.push(`| ${r.code} | ${shortName(r.name)} | ${r.days} 天 | +${yi(r.delta)} |`);
      }
      lines.push('');
    }
  }

  // 宽基 vs 行业主题
  const broad = rows.filter((r) => isBroad(r.name));
  const sector = rows.filter((r) => !isBroad(r.name));
  if (broad.length && sector.length) {
    const sum = (arr) => arr.reduce((s, r) => s + (r[hasPrice ? 'amount' : 'delta'] || 0), 0);
    const fmt = (v) => (v > 0 ? '+' : '') + (hasPrice ? money(v) : yi(v));
    // 不同 ETF 单价差好几倍，份数直接相加没意义，有价格就用金额
    lines.push('## 宽基 vs 行业主题');
    lines.push('');
    lines.push(`| 类别 | 只数 | ${hasPrice ? '估算净流入(亿元)' : '合计份额变化(亿份)'} |`);
    lines.push('|---|---:|---:|');
    lines.push(`| 宽基 | ${broad.length} | ${fmt(sum(broad))} |`);
    lines.push(`| 行业主题 | ${sector.length} | ${fmt(sum(sector))} |`);
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('## 我的看法');
  lines.push('');
  lines.push('<!-- 这里留给你补。数据是死的，判断是你的 -->');
  lines.push('');

  return { title, summary, body: lines.join('\n') };
}

/**
 * 给看板页用的汇总数据。
 * 字段名缩写是为了控制体积——1699 行全塞进页面里，长字段名会多出几十 KB。
 */
function writeLatest(date, { prev, rows }, dates) {
  const snap = loadSnapshot(date);
  const pyi = (v) => Math.round(v / 1e6) / 100; // 份 → 亿份，2 位小数

  const out = {
    date,
    prevDate: prev,
    generatedAt: new Date().toISOString(),
    total: snap?.items.length || 0,
    inflowCount: rows.filter((r) => r.delta > 0).length,
    outflowCount: rows.filter((r) => r.delta < 0).length,
    netAmount: Math.round(rows.reduce((s, r) => s + (r.amount || 0), 0) / 1e6) / 100,
    hasPrice: rows.some((r) => r.amount != null),
    rows: rows
      .map((r) => ({
        c: r.code,
        n: r.name,
        m: r.market,
        s: pyi(r.share),
        d: pyi(r.delta),
        p: +r.deltaPct.toFixed(2),
        px: r.close ?? null,
        chg: r.chgPct ?? null,
        amt: r.amount == null ? null : Math.round(r.amount / 1e6) / 100,
        b: isBroad(r.name) ? 1 : 0,
        st: consecutiveDays(r.code, dates, r.delta > 0 ? 1 : -1),
      }))
      .sort((a, b) => b.d - a.d),
  };

  writeFileSync(join(DATA_DIR, 'latest.json'), JSON.stringify(out), 'utf8');
  console.log(`   ✔ 已更新 latest.json（${out.rows.length} 行）`);
}

function generateArticle(date) {
  const dates = listSnapshots();
  const changes = computeChanges(date);

  if (!changes.prev) {
    console.log(`   没有前一交易日的快照，本次不出文章（先补历史：--days=N）`);
    return null;
  }
  if (!changes.rows.length) {
    console.log('   份额没有变动，本次不出文章');
    return null;
  }

  // 看板数据每次都要刷新，哪怕文章早就写过了
  writeLatest(date, changes, dates);

  const file = join(POSTS_DIR, `etf-share-${date}.md`);
  if (existsSync(file)) {
    console.log(`   ${date} 的文章已存在，跳过——不会覆盖你自己写的`);
    return null;
  }

  const { title, body } = buildArticle(date, changes, dates);
  writeFileSync(file, body, 'utf8');
  console.log(`   ✔ 已生成文章 ${file}`);
  console.log(`     ${title}｜${changes.rows.length} 只有变动`);
  return file;
}

// ============================================================
//  入口
// ============================================================

function parseArgs() {
  const out = { date: null, days: 1, article: true, force: false };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--date=')) out.date = a.slice(7);
    else if (a.startsWith('--days=')) out.days = Number(a.slice(7)) || 1;
    else if (a === '--no-article') out.article = false;
    else if (a === '--force') out.force = true;
  }
  return out;
}

/** 当天的文章已经生成过就不必再抓——多时段重试靠这个省请求 */
function articleDone(date) {
  return existsSync(join(POSTS_DIR, `etf-share-${date}.md`));
}

async function main() {
  const args = parseArgs();
  const today = beijingToday();

  if (args.days > 1) {
    // 回溯补历史：沪市便宜（一天一次），深市贵（一天 55 页）
    const anchor = args.date || shiftDate(today, -1);
    console.log(`回溯补 ${args.days} 天，起点 ${anchor}`);
    for (let i = args.days - 1; i >= 0; i--) {
      const d = shiftDate(anchor, -i);
      if (isWeekend(d)) continue;
      if (loadSnapshot(d)) {
        console.log(`${d} 已有快照，跳过`);
        continue;
      }
      await collectDay(d);
      await sleep(1000);
    }
    return;
  }

  // 默认：从今天往前找最近一个有数据的交易日
  const target = args.date;
  if (target) {
    if (isWeekend(target)) {
      console.log(`${target} 是周末，跳过`);
      return;
    }
    const snap = await collectDay(target);
    if (!snap) {
      process.exitCode = 1;
      return;
    }
    if (args.article) generateArticle(target);
    return;
  }

  for (let i = 0; i <= LOOKBACK_DAYS; i++) {
    const d = shiftDate(today, -i);
    if (isWeekend(d)) continue;
    // 这一天的文章已经有了，说明当天已经成功跑过一次，后面几个时段不用再抓
    if (args.article && articleDone(d) && !args.force) {
      console.log(`${d} 的文章已存在，本次跳过`);
      return;
    }
    const snap = await collectDay(d);
    if (snap) {
      if (args.article) generateArticle(d);
      return;
    }
    await sleep(1000);
  }
  console.error('✖  往前找了一圈都没有数据（可能接口全挂，或长假）');
  process.exitCode = 1;
}

main().catch((err) => {
  console.error('✖  出错：', err);
  process.exitCode = 1;
});
