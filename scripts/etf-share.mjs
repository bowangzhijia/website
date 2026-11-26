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
const COLUMN = 'etf-share';

/** 回溯时最多往前找几天 */
/**
 * 往前找几个自然日。
 *
 * 定 15 是为了覆盖最长假期：春节连休可能 9~10 天，加上前后周末，
 * 8 天会够不着节前最后一个交易日，任务直接报错、数据断更。
 */
const LOOKBACK_DAYS = 15;

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
        // 东财的名称带基金公司（「通信ETF国泰」），交易所只给简称（「通信ETF」），
        // 按「通信ETF国泰」搜本来是搜不到的，所以顺手把名称也带回来
        quotes.set(String(d.f12), {
          close,
          chgPct: Number.isFinite(chg) ? chg : null,
          name: String(d.f14 || '').trim(),
        });
      }
    }
    await sleep(120);
  }

  // 东财被掐的时候经常一批都拿不到，价格缺了净流入就全算不出来，用腾讯补
  if (quotes.size < items.length * 0.5) {
    console.warn(`   东财报价只拿到 ${quotes.size}/${items.length}，改用腾讯兜底`);
    const tx = await fetchTencentQuotes(items);
    for (const [k, v] of tx) quotes.set(k, v);
    console.log(`   腾讯补到 ${quotes.size}/${items.length}`);
  }
  return quotes;
}

/**
 * 腾讯批量报价，东财被掐时的兜底。
 *
 * 返回 GBK 编码的文本，格式 `v_sh510300="1~名称~代码~现价~昨收~..."`，
 * 按 ~ 切开后：3 是收盘价、32 是涨跌幅。
 */
async function fetchTencentQuotes(items) {
  const quotes = new Map();
  const CHUNK = 60;
  const dec = new TextDecoder('gbk');
  for (let i = 0; i < items.length; i += CHUNK) {
    const batch = items.slice(i, i + CHUNK);
    const q = batch.map((x) => `${x.market === 'sh' ? 'sh' : 'sz'}${x.code}`).join(',');
    const url = `https://qt.gtimg.cn/q=${q}`;
    try {
      const r = await fetch(url, { headers: H_TX });
      const text = dec.decode(await r.arrayBuffer());
      for (const line of text.split(';')) {
        const m = /v_(?:sh|sz)(\d{6})="([^"]*)"/.exec(line);
        if (!m) continue;
        const f = m[2].split('~');
        const close = Number(f[3]);
        const chg = Number(f[32]);
        if (Number.isFinite(close) && close > 0) {
          quotes.set(m[1], { close, chgPct: Number.isFinite(chg) ? chg : null });
        }
      }
    } catch {
      // 这一批失败就算了，能补多少补多少
    }
    await sleep(150);
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

/**
 * 只在内容真的变了才写盘。
 *
 * 为什么需要：外部定时器可能每 30 分钟触发一次，如果每次都把 generatedAt /
 * updated 这类时间戳刷新一遍，git 就会认为有改动 → 提交 → 构建 → 部署。
 * Cloudflare Pages 免费版每月只有 500 次构建；按每小时两次算，一个月 1400 多次，
 * 两天就把额度烧光，真需要部署时反而失败。
 *
 * 忽略时间戳后，只有份额数据实质变化才会触发部署。
 */
function writeIfChanged(path, obj, ignoreKeys = []) {
  const strip = (o) => JSON.stringify(o, (k, v) => (ignoreKeys.includes(k) ? undefined : v));
  if (existsSync(path)) {
    try {
      const old = JSON.parse(readFileSync(path, 'utf8'));
      if (strip(old) === strip(obj)) return false;
    } catch {
      // 旧文件坏了就当变了，正常重写
    }
  }
  writeFileSync(path, JSON.stringify(obj), 'utf8');
  return true;
}

function saveSnapshot(snap) {
  const dir = join(DATA_DIR, 'daily');
  mkdirSync(dir, { recursive: true });
  writeIfChanged(snapshotPath(snap.date), snap, ['generatedAt']);
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
  const shCount = snap.items.filter((x) => x.market === 'sh').length;
  const szCount = snap.items.filter((x) => x.market === 'sz').length;
  console.log(`   合并后 ${snap.items.length} 只（沪 ${shCount} / 深 ${szCount}）`);
  if (snap.warnings.length) console.log(`   ⚠ ${snap.warnings.join('；')}`);

  /*
   * 完整性闸门：沪深任何一边明显缺失就不写盘。
   *
   * 踩过的坑：沪市当天数据还没发布（返回 0 条）时，深市备源仍能拉到 580 只，
   * 合并后照样写盘，等于把「只有深市」的半截快照当成全市场数据，
   * 下一次算份额变化会凭空造出巨额差异。宁可今天没数据，也不要脏数据。
   */
  const MIN_PER_MARKET = 400;
  if (shCount < MIN_PER_MARKET || szCount < MIN_PER_MARKET) {
    console.warn(`   数据不完整（沪 ${shCount} / 深 ${szCount}，各需 ≥ ${MIN_PER_MARKET}），本次不写盘`);
    return null;
  }

  // 补价格。拿不到不致命——榜单退化成只按份额变化率排，不显示金额
  const quotes = await fetchEmQuotes(snap.items);
  let priced = 0;
  for (const it of snap.items) {
    const q = quotes.get(it.code);
    if (q) {
      it.close = q.close;
      it.chgPct = q.chgPct;
      // 东财名称更完整（带基金公司），只在更长时替换，避免被错的简称覆盖
      if (q.name && q.name.length > it.name.length) it.name = q.name;
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
 * 规模门槛（亿元）。低于这个数的不进榜单和文章。
 *
 * 依据：1699 只里有 822 只规模不到 2 亿，加起来只占全市场规模 1.4%、
 * 占资金流向 0.5%，纯噪音。10 亿这条线砍掉 71% 的只数，只损失 1.9% 的流向。
 *
 * 这个门槛每天按最新规模重算，所以规模涨过 10 亿会自动进来，
 * 缩到 10 亿以下会自动退出——不需要人工维护名单。
 * 数据本身是 T+1 日频（份额要等交易所次日披露），不存在盘中实时。
 */
const MIN_SCALE = 10;

/** 亿元规模 */
const scaleOf = (share, close) => (share * (close || 0)) / 1e8;

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
    // 份额没变的也要留：搜索框要能查到任意一只，不然抽查某只查不到会以为数据缺了
    const sc = scaleOf(it.share, it.close);
    const prevSc = scaleOf(p.share, p.close ?? it.close);

    rows.push({
      ...it,
      prevShare: p.share,
      delta,
      deltaPct: (delta / p.share) * 100,
      // 有价格才能折成金额，没有就记 null
      amount: it.close ? delta * it.close : null,
      sc, // 当前规模(亿元)
      // 昨天在门槛外、今天进来的，标出来——规模突然做大本身也是信号
      newIn: sc >= MIN_SCALE && prevSc < MIN_SCALE ? 1 : 0,
    });
  }
  return { prev: prevDate, rows };
}

/**
 * 今天是否已经成功复核过。
 *
 * --refresh 的设计是「重抓一遍核对交易所有没有修正」，但早上 7/8/9 点连着触发
 * 就会把同一份数据抓三四遍。深市要翻 55 页，密集请求很容易被限速
 * （实测 7 点那次 fetch failed 就是这么来的）。
 *
 * 同一交易日成功复核过一次就够了：实测复核时数据几乎从不修正
 * （11-23 那次 936 只逐只比对，全部一致）。
 */
function refreshedToday(today) {
  const p = join(DATA_DIR, 'last-refresh.json');
  if (!existsSync(p)) return false;
  try {
    // 去掉可能的 BOM：某些手动编辑/Windows 工具会把 \uFEFF 带到文件头
    const raw = readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw).runDate === today;
  } catch {
    return false;
  }
}

function markRefreshed(today) {
  writeIfChanged(join(DATA_DIR, 'last-refresh.json'), { runDate: today });
}

/** 宽基篮子配置（人工维护，交易所接口不给跟踪标的） */
function loadBaskets() {
  const p = join(DATA_DIR, 'baskets.json');
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, 'utf8')).baskets || [];
  } catch {
    return [];
  }
}

/**
 * 按指数归集。同一个指数下挂十几只 ETF，是同一份敞口——
 * 汇金买 510300 还是 510310 没有区别，分散在单只榜里根本看不出资金规模。
 */
function computeBaskets(date, rows) {
  const snap = loadSnapshot(date);
  const byCode = new Map((snap?.items || []).map((x) => [x.code, x]));
  const changeByCode = new Map(rows.map((r) => [r.code, r]));

  return loadBaskets().map((b) => {
    let delta = 0;
    let amount = 0;
    let scale = 0;
    const members = [];
    for (const code of b.codes) {
      const it = byCode.get(code);
      if (!it) continue; // 已退市或还没上市，跳过
      const ch = changeByCode.get(code);
      const mScale = (it.share * (it.close || 0)) / 1e8;
      scale += mScale * 1e8;
      if (ch) {
        delta += ch.delta;
        amount += ch.amount || 0;
      }
      // 成分逐只留痕，页面点开能看到是哪几只，方便自己核对
      members.push({
        c: code,
        n: it.name,
        s: mScale, // 规模(亿元)
        d: ch ? ch.delta / 1e8 : 0, // 份额变化(亿份)
        amt: ch && ch.amount != null ? ch.amount / 1e8 : 0, // 净流入(亿元)
      });
    }
    members.sort((x, y) => y.amt - x.amt || y.s - x.s);
    return { id: b.id, name: b.name, desc: b.desc || '', n: members.length, delta, amount, scale, members };
  }).filter((b) => b.n > 0);
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

/** 名称截断，表格别被撑爆。名称现在是「沪深300ETF华泰柏瑞」这种长名，放宽到 14 字 */
const shortName = (n) => (n.length > 14 ? n.slice(0, 14) + '…' : n);

function yamlStr(text) {
  return '"' + String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function table(rows, withAmount) {
  const head = withAmount
    ? '| 代码 | 名称 | 估算净流入(亿元) | 规模(亿元) | 份额变化(亿份) | 变化率 | 涨跌幅 |'
    : '| 代码 | 名称 | 规模(亿元) | 份额变化(亿份) | 变化率 | 涨跌幅 |';
  const sep = withAmount ? '|---|---|---:|---:|---:|---:|---:|' : '|---|---|---:|---:|---:|---:|';
  const body = rows.map((r) => {
    const cells = [r.code, shortName(r.name) + (r.newIn ? '（新）' : '')];
    // 金额紧跟名称：它既是排序依据，也是读者最先想看的
    if (withAmount) cells.push(money(r.amount));
    cells.push(r.sc != null ? r.sc.toFixed(1) : '—');
    cells.push(`${r.delta > 0 ? '+' : ''}${yi(r.delta)}`);
    cells.push(pct(r.deltaPct), r.chgPct == null ? '—' : pct(r.chgPct));
    return '| ' + cells.join(' | ') + ' |';
  });
  return [head, sep, ...body].join('\n');
}

function buildArticle(date, { prev, rows }, dates) {
  const [, month, day] = date.split('-');
  const title = `${Number(month)}月${Number(day)}日 · ETF 份额异动`;
  const hasPrice = rows.some((r) => r.amount != null);

  // 榜单只收规模 ≥10 亿的。小 ETF 几百万份的申赎就能做出 50% 变化率，
  // 混进来会把真信号挤掉。门槛每天按最新规模重算，涨过就自动进、缩下去就自动出。
  const pool = rows.filter((r) => r.sc >= MIN_SCALE);

  /**
   * 按金额排，不按份数。
   * 不同 ETF 单价能差十倍（黄金 7 块、半导体 1 块），按份数排会系统性偏袒低价品种：
   * 恒生互联 +32.5 亿份只有 9 亿，中证500ETF +14.6 亿份却有 88 亿。
   * 拿不到价格的排到最后，不参与金额比较。
   */
  const byAmountDesc = (a, b) => (b.amount ?? -Infinity) - (a.amount ?? -Infinity);
  const byAmountAsc = (a, b) => (a.amount ?? Infinity) - (b.amount ?? Infinity);

  const inflow = pool.filter((r) => r.delta > 0).sort(byAmountDesc);
  const outflow = pool.filter((r) => r.delta < 0).sort(byAmountAsc);

  const upButRedeem = pool
    .filter((r) => r.chgPct != null && r.chgPct > 0 && r.delta < 0 && bigEnough(r))
    .sort((a, b) => (a.amount ?? a.delta) - (b.amount ?? b.delta));
  const downButBuy = pool
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

  const changed = rows.filter((r) => r.delta !== 0);
  lines.push('## 一句话');
  lines.push('');
  lines.push(
    `全市场 ${rows.length} 只 ETF 里 ${changed.length} 只有份额变动` +
      (hasPrice ? `，合计净流入 **${money(totalAmount)} 亿元**` : '') +
      `。规模 10 亿以上的 ${pool.length} 只里，**${inflow.length} 只净申购**、**${outflow.length} 只净赎回**。`
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

  // 宽基篮子：同一指数下的 ETF 加总
  const baskets = computeBaskets(date, rows);
  if (baskets.length) {
    lines.push('## 宽基篮子');
    lines.push('');
    lines.push(
      '一个指数挂十几只 ETF，是同一份敞口。汇金买 510300 还是 510310 没有区别，' +
        '分散在单只榜里根本看不出进了多少钱，加总才准。'
    );
    lines.push('');
    lines.push(`| 指数 | 只数 | ${hasPrice ? '净流入(亿元)' : '份额变化(亿份)'} | 篮子规模(亿元) |`);
    lines.push('|---|---:|---:|---:|');
    for (const b of baskets) {
      const v = hasPrice ? b.amount : b.delta;
      lines.push(`| ${b.name} | ${b.n} | ${v ? (v > 0 ? '+' : '') + (hasPrice ? money(v) : yi(v)) : '—'} | ${money(b.scale)} |`);
    }
    lines.push('');

    // 篮子之外的全部算「其它」，不再用名称猜宽基（「300」里有纳斯达克、「50」里有中概互联）
    const inBasket = new Set(loadBaskets().flatMap((b) => b.codes));
    const other = pool.filter((r) => !inBasket.has(r.code));
    if (other.length) {
      const otherAmount = other.reduce((s, r) => s + (r.amount || 0), 0);
      const inAmount = baskets.reduce((s, b) => s + b.amount, 0);
      lines.push(
        `篮子之外的 ${other.length} 只（行业主题、跨境、债券、商品）合计 ` +
          `${hasPrice ? (otherAmount > 0 ? '+' : '') + money(otherAmount) + ' 亿元' : yi(other.reduce((s, r) => s + r.delta, 0)) + ' 亿份'}，` +
          `宽基篮子合计 ${(inAmount > 0 ? '+' : '') + money(inAmount)} 亿元。`
      );
      lines.push('');
    }
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
  const inBasketCodes = new Set(loadBaskets().flatMap((b) => b.codes));

  const out = {
    date,
    prevDate: prev,
    generatedAt: new Date().toISOString(),
    total: snap?.items.length || 0,
    changed: rows.filter((r) => r.delta !== 0).length,
    inflowCount: rows.filter((r) => r.delta > 0).length,
    outflowCount: rows.filter((r) => r.delta < 0).length,
    netAmount: Math.round(rows.reduce((s, r) => s + (r.amount || 0), 0) / 1e6) / 100,
    hasPrice: rows.some((r) => r.amount != null),
    baskets: computeBaskets(date, rows).map((b) => ({
      id: b.id,
      name: b.name,
      desc: b.desc,
      n: b.n,
      d: Math.round(b.delta / 1e6) / 100,
      amt: Math.round(b.amount / 1e6) / 100,
      s: Math.round(b.scale / 1e6) / 100,
      members: b.members.map((m) => ({
        c: m.c,
        n: m.n,
        s: Math.round(m.s * 100) / 100,
        d: Math.round(m.d * 100) / 100,
        amt: Math.round(m.amt * 100) / 100,
      })),
    })),
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
        sc: Math.round(r.sc * 100) / 100, // 规模(亿元)
        b: inBasketCodes.has(r.code) ? 1 : 0,
        ni: r.newIn || 0, // 今天刚够 10 亿门槛
        st: consecutiveDays(r.code, dates, r.delta > 0 ? 1 : -1),
      }))
      .sort((a, b) => b.d - a.d),
  };

  writeIfChanged(join(DATA_DIR, 'latest.json'), out, ['generatedAt']);
  console.log(`   ✔ 已更新 latest.json（${out.rows.length} 行）`);
}

function generateArticle(date) {
  const dates = listSnapshots();
  const changes = computeChanges(date);

  if (!changes.prev) {
    console.log(`   没有前一交易日的快照，本次不出文章（先补历史：--days=N）`);
    return null;
  }
  if (!changes.rows.some((r) => r.delta !== 0)) {
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
  console.log(`     ${title}｜${changes.rows.filter((r) => r.delta !== 0).length} 只有变动`);
  return file;
}

// ============================================================
//  历史走势（指数 K 线 + 篮子逐日净流入）
// ============================================================

/**
 * 要画的指数。secid 规则：沪市 1.xxxxxx，深市 0.xxxxxx。
 * 这几个正好和 baskets.json 里的篮子一一对应。
 */
const INDICES = [
  { code: '000300', name: '沪深300', secid: '1.000300', basket: 'hs300' },
  { code: '000001', name: '上证指数', secid: '1.000001', basket: null },
  { code: '000016', name: '上证50', secid: '1.000016', basket: 'sz50' },
  { code: '000905', name: '中证500', secid: '1.000905', basket: 'zz500' },
  { code: '000852', name: '中证1000', secid: '1.000852', basket: 'zz1000' },
  { code: '000688', name: '科创50', secid: '1.000688', basket: 'kc50' },
  { code: '399006', name: '创业板指', secid: '0.399006', basket: 'cyb' },
];

/**
 * 日 K（前复权）。days 传 'all' 就是全部历史。
 *
 * 一次要 30 多年（8000 多根）东财会直接掐连接（UND_ERR_SOCKET），
 * 所以按十年一段拉，再拼起来。
 */
async function fetchIndexKline(secid, days = 90) {
  const today = beijingToday().replace(/-/g, '');
  const parse = (body) =>
    (body?.data?.klines || []).map((line) => {
      const [d, o, c, h, l, , a] = line.split(',');
      return { d, o: +o, c: +c, h: +h, l: +l, a: Number(a) || 0 }; // a = 成交额(元)
    });

  const segs =
    days === 'all'
      ? [
          ['19910101', '20001231'],
          ['20010101', '20101231'],
          ['20110101', '20201231'],
          ['20210101', today],
        ]
      : [[shiftDate(beijingToday(), -Number(days) * 2).replace(/-/g, ''), today]];

  const out = [];
  for (const [beg, end] of segs) {
    const url =
      'https://push2his.eastmoney.com/api/qt/stock/kline/get' +
      `?secid=${secid}&klt=101&fqt=1&beg=${beg}&end=${end}` +
      '&fields1=f1,f2,f3,f4,f5&fields2=f51,f52,f53,f54,f55,f56,f57';
    const j = await fetchJson(url, H_EM, `K线 ${secid} ${beg}`, 3);
    out.push(...parse(j));
    if (segs.length > 1) await sleep(250);
  }
  return out;
}

const H_TX = { 'User-Agent': UA };

/** 按年把区间切成若干段 */
function splitYears(from, to, step = 3) {
  const segs = [];
  const endY = Number(to.slice(0, 4));
  let y = Number(from.slice(0, 4));
  while (y <= endY) {
    segs.push([`${y}-01-01`, `${Math.min(y + step - 1, endY)}-12-31`]);
    y += step;
  }
  return segs;
}

/**
 * 单只 ETF 的历史收盘价，用腾讯行情。
 *
 * 为什么不用东财：push2his 对同一 IP 连续请求会直接掐连接（UND_ERR_SOCKET），
 * 补历史时要抓几十只 ETF 的价格，用东财必然半路挂掉，价格拿不到净流入就全是 0。
 * 腾讯单次上限约 800 条，三年一段正好。
 */
async function fetchTencentClose(code, from, to) {
  const sym = `${code.startsWith('15') ? 'sz' : 'sh'}${code}`;
  const out = new Map();
  for (const [b, e] of splitYears(from, to)) {
    const url =
      'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get' +
      `?param=${sym},day,${b},${e},900,qfq`;
    const j = await fetchJson(url, H_TX, `腾讯K线 ${code} ${b}`, 2);
    const d = j?.data?.[sym];
    const k = d?.qfqday || d?.day || [];
    for (const row of k) {
      const close = Number(row[2]); // [日期, 开, 收, 高, 低, 量]
      if (row[0] && Number.isFinite(close) && close > 0) out.set(row[0], close);
    }
    await sleep(120);
  }
  return out;
}

/**
 * 新浪日 K，一次最多 1023 条（约四年）。
 * 腾讯被 WAF 拦的时候用它兜底——补历史时两只价格源来回打，很容易撞限流。
 */
async function fetchSinaClose(code, from, to) {
  const sym = `${code.startsWith('15') ? 'sz' : 'sh'}${code}`;
  const url =
    'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData' +
    `?symbol=${sym}&scale=240&ma=no&datalen=4000`; // 4000 够拿到 ETF 成立日
  const rows = await fetchJson(url, { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' }, `新浪K线 ${code}`, 2);
  const out = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const close = Number(r.close);
    if (r.day >= from && r.day <= to && Number.isFinite(close) && close > 0) out.set(r.day, close);
  }
  return out;
}

/**
 * 找出「份额折算/拆分」的日子。
 *
 * ETF 做份额折算时，份额一夜之间减半、价格同时翻倍（比如 510310 在 2024-09-20
 * 份额 -48.84%，09-23 价格从 1.599 跳到 3.213）。如果直接按「份额变化 × 价格」
 * 算净流入，会得出一千多亿的假赎回，把整张图毁掉。
 *
 * 判据：单日价格涨跌超过 40% 就是异常（正常 ETF 一天不可能），
 * 把跳变日连同前 3 个交易日一起标成「折算窗口」，窗口内的份额变化不计入。
 */
/**
 * 找出「份额折算/拆分」的日子。
 *
 * 判据的核心是**守恒**：拆分时份额增多、价格等比例下跌，两者相加约等于零。
 * 只按「价格跳变超过 40%」抓会漏掉小幅拆分——159919 在 2019-01-11 按 1:1.11
 * 拆分，份额 +11.07%、价格 -10.1%，看着都不夸张，但确实是拆分不是申购。
 *
 * 真实申购的特征是价格几乎不动、只有份额涨，不会满足「份额涨多少价格跌多少」。
 */
function splitWindow(pxMap, sharesOfCode, dates) {
  const bad = new Set();

  // 先列出所有价格跳变点（只在有报价的日期之间比较，跳过停牌和周末）
  const pxDates = dates.filter((d) => pxMap.get(d));
  const jumps = [];
  for (let j = 1; j < pxDates.length; j++) {
    const p0 = pxMap.get(pxDates[j - 1]);
    const p1 = pxMap.get(pxDates[j]);
    const r = p1 / p0;
    if (Math.abs(r - 1) > 0.04) jumps.push({ d: pxDates[j], r });
  }
  if (!jumps.length) return bad;

  for (let i = 1; i < dates.length; i++) {
    const s0 = sharesOfCode.get(dates[i - 1]);
    const s1 = sharesOfCode.get(dates[i]);
    if (!s0 || !s1) continue;

    const sRatio = s1 / s0;
    // 份额一天变动不到 8% 的，基本不可能是折算，直接放过
    if (Math.abs(sRatio - 1) < 0.08) continue;

    /*
     * 折算的判据是「份额比值 × 价格比值 ≈ 1」——拆分后份额变多少，
     * 价格就反向变多少，市值守恒。真实申购会让市值实实在在变大，乘出来明显偏离 1。
     *
     * 两个坑：
     *   1. 份额变化日和价格跳变日可能差 1~3 个交易日（510310 是 09-20 减半、
     *      09-23 才跳价），必须跨日找匹配，不能只跟同一天比。
     *   2. 用变化率相加在幅度大时会失真（份额减半是 -48.8%，价格翻倍是 +101%，
     *      加起来对不上），用比值相乘才守恒。
     */
    const end = dates[Math.min(dates.length - 1, i + 3)];
    let hit = false;
    for (const jp of jumps) {
      if (jp.d < dates[i] || jp.d > end) continue;
      if (Math.abs(sRatio * jp.r - 1) < 0.05) {
        hit = true;
        break;
      }
    }
    if (hit) bad.add(dates[i]);
  }
  return bad;
}

/**
 * 收盘价：新浪优先，拿不到才用腾讯。
 *
 * 顺序不能反。腾讯那个接口返回的是**前复权**价，折算过的 ETF 历史价格被
 * 悄悄除过权，价格序列是连续的，根本看不出哪天做过份额折算；而且用复权价
 * 去乘「未复权的份额变化」，折算前的金额会系统性偏小。
 * 新浪返回的是不复权价，折算那天价格会跳变，正好拿来识别折算。
 */
async function fetchEtfClose(code, from, to) {
  const sina = await fetchSinaClose(code, from, to);
  if (sina.size > 0) return sina;
  console.warn(`   新浪拿不到 ${code} 的价格，换腾讯（价格是复权的，折算日可能不准）`);
  return fetchTencentClose(code, from, to);
}

/**
 * 深市单只 ETF 的历史逐日份额。
 *
 * fund_jjgm 传代码 + 日期区间能一次拿多天，但区间超过约 170 自然日就返回空，
 * 所以要分成 5 个月一个窗口。返回 Map<日期, 份额(份)>。
 */
async function fetchSzseHistory(code, start, end) {
  const out = new Map();
  let s = new Date(start + 'T00:00:00Z');
  const finish = new Date(end + 'T00:00:00Z').getTime();

  while (s.getTime() <= finish) {
    const winEnd = new Date(Math.min(s.getTime() + 150 * 86400e3, finish));
    const ds = s.toISOString().slice(0, 10);
    const de = winEnd.toISOString().slice(0, 10);

    for (let p = 1; p <= 12; p++) {
      const url =
        'https://fund.szse.cn/api/report/ShowReport/data?SHOWTYPE=JSON&CATALOGID=fund_jjgm' +
        `&TABKEY=tab1&txtDm=${code}&txtStart=${ds}&txtEnd=${de}&PAGENO=${p}`;
      const j = await fetchJson(url, H_SZSE_FUND, `深市历史 ${code} ${ds}`, 2);
      const blk = j?.[0];
      if (!blk) break;
      for (const r of blk.data || []) {
        const share = toShares(r.current_size);
        if (r.size_date && share) out.set(r.size_date, share);
      }
      if (p >= Number(blk.metadata?.pagecount || 1)) break;
      await sleep(120);
    }
    s = new Date(winEnd.getTime() + 86400e3);
    await sleep(150);
  }
  return out;
}

/** 篮子逐日净流入 = Σ(份额变化 × 当日价)，单位亿元 */
function flowOfDay(set, cur, prev) {
  if (!prev || !cur) return 0;
  const pm = new Map(prev.items.map((x) => [x.code, x]));
  let amt = 0;
  for (const it of cur.items) {
    if (!set.has(it.code)) continue;
    const p = pm.get(it.code);
    if (!p || !p.share) continue;
    amt += (it.share - p.share) * (it.close || p.close || 0);
  }
  return Math.round(amt / 1e6) / 100;
}

/** 从已有快照算（日常用，快） */
function flowsFromSnapshots() {
  const dates = listSnapshots();
  const flows = {};
  for (const b of loadBaskets()) {
    const set = new Set(b.codes);
    const flow = [];
    for (let i = 0; i < dates.length; i++) {
      flow.push(flowOfDay(set, loadSnapshot(dates[i]), i > 0 ? loadSnapshot(dates[i - 1]) : null));
    }
    flows[b.id] = flow;
  }
  return { dates, flows };
}

/**
 * 直接从交易所抓长期历史（一次性，慢）。
 *
 * 沪市接口只能按日期查全市场，所以是「一天一次请求」；
 * 深市能按代码 + 区间查，所以按代码翻窗口就行。
 * 只抓篮子里那几个代码，不抓全市场。
 */
async function flowsFromExchange(bars, fromDate, toDate) {
  // 交易日历优先用已存的 K 线日期——东财偶尔会掐连接，没必要每次都去问
  const histPath = join(DATA_DIR, 'history.json');
  const cached = existsSync(histPath) ? JSON.parse(readFileSync(histPath, 'utf8')) : null;
  let allDates = cached?.dates || [];
  if (allDates.length < 100) {
    const cal = await fetchIndexKline('1.000001', 'all');
    allDates = cal.map((x) => x.d);
  }
  if (!allDates.length) throw new Error('拿不到交易日历');

  // 支持两种模式：最近 N 个交易日，或指定区间（便于分段补历史，避免一次跑太久）
  let dates;
  if (fromDate) {
    dates = allDates.filter((d) => d >= fromDate && (!toDate || d <= toDate));
  } else {
    dates = allDates.slice(-bars);
  }
  if (dates.length < 2) throw new Error(`区间内交易日太少：${dates.length}`);

  const from = dates[0];
  const to = dates[dates.length - 1];
  console.log(`   抓 ${from} ~ ${to}，共 ${dates.length} 个交易日`);

  const baskets = loadBaskets();
  const inBasket = new Set(baskets.flatMap((b) => b.codes));
  const szCodes = [...inBasket].filter((c) => c.startsWith('15'));

  // code -> Map(date -> share)
  const shares = new Map();
  const put = (code, d, share) => {
    if (!shares.has(code)) shares.set(code, new Map());
    shares.get(code).set(d, share);
  };

  console.log('   沪市逐日抓取（只能按日期查）…');
  for (let i = 0; i < dates.length; i++) {
    const map = await fetchSse(dates[i]);
    for (const [code, v] of map) if (inBasket.has(code)) put(code, dates[i], v.share);
    if ((i + 1) % 40 === 0) console.log(`     沪市 ${i + 1}/${dates.length}`);
    await sleep(200);
  }

  console.log(`   深市按代码抓取（${szCodes.length} 只）…`);
  let szHit = 0;
  for (const code of szCodes) {
    const m = await fetchSzseHistory(code, from, to);
    if (m.size) szHit++;
    for (const [d, s] of m) put(code, d, s);
    await sleep(150);
  }

  // 深市全挂的时候，沪市数据照抓，算出来的 flow 会系统性偏小。
  // 宁可不更新，也不要拿「只有沪市」的数据去覆盖历史。
  if (szHit === 0) throw new Error('深市份额一只都没抓到，中止（避免写入残缺历史）');

  console.log('   抓成分 ETF 的历史价格（腾讯）…');
  const px = new Map();
  for (const code of inBasket) {
    px.set(code, await fetchEtfClose(code, from, to));
    await sleep(80);
  }

  // 每只 ETF 的折算窗口
  const badByCode = new Map();
  for (const code of inBasket) {
    badByCode.set(code, splitWindow(px.get(code) || new Map(), shares.get(code) || new Map(), dates));
  }
  const splitCodes = [...badByCode].filter(([, s]) => s.size > 0).map(([c]) => c);
  if (splitCodes.length) console.log(`   ⚠ 检测到份额折算：${splitCodes.join(', ')}`);

  const flows = {};
  let skipped = 0;
  for (const b of baskets) {
    const flow = [];
    // 从第 2 天开始：第一天没有前值，算不出变化
    for (let i = 1; i < dates.length; i++) {
      let amt = 0;
      for (const code of b.codes) {
        const sm = shares.get(code);
        if (!sm) continue;
        // 折算窗口内的份额变化不是申赎，跳过
        if (badByCode.get(code)?.has(dates[i])) {
          skipped++;
          continue;
        }
        const cur = sm.get(dates[i]);
        const prev = sm.get(dates[i - 1]);
        if (!cur || !prev) continue;
        const pm = px.get(code);
        amt += (cur - prev) * (pm?.get(dates[i]) || pm?.get(dates[i - 1]) || 0);
      }
      flow.push(Math.round(amt / 1e6) / 100);
    }
    flows[b.id] = flow;
  }
  if (skipped) console.log(`   因折算跳过 ${skipped} 条记录`);
  // 时间轴也跟着去掉第一天，免得合并时把旧数据覆盖成 0
  return { dates: dates.slice(1), flows };
}

/**
 * 生成 history.json：指数 K 线 + 每个篮子的逐日净流入。
 *
 * deepBars > 1 时走交易所直接抓长期；否则从快照算。
 * 两种模式结果会合并，避免日常运行把长期历史覆盖成最近 30 天。
 */
async function buildHistory(deepBars = 0, fromDate = null, toDate = null, skipKline = false) {
  const histPath = join(DATA_DIR, 'history.json');
  const old = existsSync(histPath) ? JSON.parse(readFileSync(histPath, 'utf8')) : null;

  const got =
    deepBars > 1 || fromDate ? await flowsFromExchange(deepBars, fromDate, toDate) : flowsFromSnapshots();
  let dates = got.dates;
  let flows = got.flows;

  if (!dates.length) {
    console.log('   没有历史数据，跳过');
    return;
  }

  // 合并旧数据：以并集为时间轴，新数据覆盖同一天
  // 注意 old.dates 可能是「上证全历史」，真正的份额日期在 old.flowDates 里
  const oldFlowDates = old?.flowDates || (old?.dates ? old.dates.slice(old.flowStart || 0) : []);
  if (oldFlowDates.length && old?.baskets?.length) {
    const mergedDates = [...new Set([...oldFlowDates, ...dates])].sort();
    const mergedFlows = {};
    for (const b of loadBaskets()) {
      const oldB = old.baskets.find((x) => x.id === b.id);
      const m = new Map();
      if (oldB) oldFlowDates.forEach((d, i) => m.set(d, oldB.flow[i]));
      dates.forEach((d, i) => m.set(d, (flows[b.id] || [])[i] ?? 0));
      mergedFlows[b.id] = mergedDates.map((d) => m.get(d) ?? 0);
    }
    dates = mergedDates;
    flows = mergedFlows;
  }

  // K 线只用上证指数，拉成立以来全部（1990 至今 8000 多根）
  // 东财偶尔掐连接，抓不到就沿用上次存的，别让整次任务失败
  const sh = skipKline ? [] : await fetchIndexKline('1.000001', 'all');
  let klineDates;
  let klineArr;
  if (sh.length) {
    klineDates = sh.map((x) => x.d);
    klineArr = sh.map((x) => [x.o, x.c, x.h, x.l]);
  } else if (old?.kline?.length && old?.dates?.length) {
    console.warn('   K 线没抓到，沿用上次的');
    klineDates = old.dates;
    klineArr = old.kline;
  } else {
    klineDates = [];
    klineArr = [];
  }

  /*
   * 裁掉末尾「有日期但没有数据」的那几天。
   *
   * 踩过的坑：某次采集失败但留下了空壳快照，合并后 flowDates 会多出这一天，
   * 所有篮子都算成 0。前端看到「份额有记录到这天」，就会把今天显示成
   * 「份额没有变动」——其实是还没公布。全市场六个篮子同时恰好为 0 的概率
   * 基本为零，所以末尾连续全 0 的直接裁掉是安全的。
   */
  while (dates.length > 1) {
    const last = dates.length - 1;
    if (Object.values(flows).some((f) => (f[last] || 0) !== 0)) break;
    dates.pop();
    for (const k of Object.keys(flows)) flows[k].pop();
  }

  // 份额数据落在全历史时间轴的哪个位置（前面那段柱子是空的）
  let flowStart = klineDates.findIndex((d) => d >= dates[0]);
  if (flowStart < 0) flowStart = 0;

  // 六大宽基合计
  const aggregate = dates.map((_, i) =>
    Math.round(Object.values(flows).reduce((s, f) => s + (f[i] || 0), 0) * 100) / 100
  );

  const out = {
    updated: new Date().toISOString(),
    dates: klineDates,
    flowDates: dates,
    flowStart,
    kline: klineArr,
    // 篮子 flow 只存有份额的那一段，页面上按 flowStart 铺到全历史
    baskets: loadBaskets().map((b) => {
      const flow = flows[b.id] || [];
      // 新加的篮子不会回溯到 2016 年，记下它从哪天开始有数据，前端据此提示
      const first = flow.findIndex((v) => v !== 0);
      return { id: b.id, name: b.name, flow, start: first >= 0 ? dates[first] : dates[0] };
    }),
    aggregate,
  };
  const changed = writeIfChanged(histPath, out, ['updated']);

  // 再往 public 放一份给页面异步加载：11 年的 K 线直接内嵌进 HTML 有 500KB，
  // 首屏会被拖慢，拆成独立文件让浏览器缓存更划算
  const pubDir = join(ROOT, 'public', 'data', 'etf-share');
  mkdirSync(pubDir, { recursive: true });
  writeIfChanged(join(pubDir, 'history.json'), out, ['updated']);

  if (!changed) console.log('   历史数据没有实质变化，跳过写盘（避免触发无意义的部署）');

  const sizeKb = Math.round(JSON.stringify(out).length / 1024);
  console.log(`   ✔ 已更新 history.json（K 线 ${klineDates.length} 根，资金流 ${dates.length} 天，${sizeKb}KB）`);
}

// ============================================================
//  入口
// ============================================================

function parseArgs() {
  const out = { date: null, days: 1, article: true, force: false, deep: 0, refresh: false };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--date=')) out.date = a.slice(7);
    else if (a.startsWith('--days=')) out.days = Number(a.slice(7)) || 1;
    else if (a.startsWith('--deep=')) out.deep = Number(a.slice(7)) || 0;
    else if (a.startsWith('--from=')) out.from = a.slice(7);
    else if (a.startsWith('--to=')) out.to = a.slice(5);
    else if (a === '--no-article') out.article = false;
    else if (a === '--force') out.force = true;
    else if (a === '--no-kline') out.nokline = true;
    else if (a === '--refresh') out.refresh = true;
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

  // 只重建历史图表数据，不碰当日快照和文章
  // 只重建历史图表数据，不碰当日快照和文章
  if (args.deep > 1 || args.from) {
    await buildHistory(args.deep, args.from || null, args.to || null, args.nokline);
    return;
  }

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
    await buildHistory();
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
    await buildHistory();
    return;
  }

  // 今天已经成功复核过就不再重抓：早上连着触发三四次，每次都翻 55 页深市，
  // 纯浪费还可能触发限速。
  if (args.refresh && refreshedToday(today)) {
    console.log(`${today} 已经成功复核过，本次跳过`);
    return;
  }

  /*
   * 晚间首跑只看今天，不往前找。
   *
   * 原因：长假期间（国庆、春节）每天都在触发，如果每次都往前抓节前那一天，
   * 一抓就是 40 秒抓取 + 30 秒重建，8 天假期白跑几十次。而且抓到的数据完全没变，
   * 写盘那步会直接跳过，纯浪费时间。
   * 今天没数据就直接退出，等下一轮；真要补昨天的，交给 --refresh（次日早上那几次）。
   */
  if (!args.refresh) {
    const snap = await collectDay(today);
    if (!snap) {
      console.log(`${today} 还没有数据（未发布或非交易日），等下一轮`);
      return;
    }
    if (args.article) generateArticle(today);
    await buildHistory();
    return;
  }

  for (let i = 0; i <= LOOKBACK_DAYS; i++) {
    const d = shiftDate(today, -i);
    if (isWeekend(d)) continue;
    // 这一天的文章已经有了，说明当天已经成功跑过一次，后面几个时段不用再抓。
    // --refresh 是例外：晚间先出结果，次日早上再抓一遍核对，交易所若有修正就覆盖。
    if (args.article && articleDone(d) && !args.force && !args.refresh) {
      console.log(`${d} 的文章已存在，本次跳过`);
      await buildHistory();
      return;
    }
    const snap = await collectDay(d);
    if (snap) {
      if (args.article) generateArticle(d);
      await buildHistory();
      // 复核成功后打个标记，同一天后面的几次触发直接跳过
      if (args.refresh) markRefreshed(today);
      return;
    }
    await sleep(1000);
  }
  /*
   * 这一轮没抓到，但不算失败。
   *
   * 数据源的可用性本来就是抽签：沪市、深市的接口时不时 fetch failed，
   * 完整性闸门会拦住半截数据（这是对的），结果就是「这一轮什么都没抓到」。
   * 定时器一小时触发一次，下一轮自然重试，不需要人干预。
   *
   * 标成 failure 的坏处：Actions 页面一片红，真出问题时反而看不出来。
   */
  console.warn('⚠  这一轮没抓到数据（接口抽签失败或数据未发布），下一轮会重试');
}

main().catch((err) => {
  console.error('✖  出错：', err);
  process.exitCode = 1;
});
