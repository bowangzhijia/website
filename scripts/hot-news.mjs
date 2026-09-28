#!/usr/bin/env node
/**
 * ============================================================
 *  波王热点 · 每日热点速览生成器
 * ============================================================
 *
 * 每天由 GitHub Actions 定时跑一次：
 *   抓几个公开财经快讯源 → 去重 → 按行业分组 → 写成当天的文章
 *   → 提交 → 触发构建上线
 *
 * 三条设计原则：
 *   1. 只取「标题 + 来源链接」，**不搬运正文**——观点留给你自己写。
 *      一来避免版权问题，二来保住你「波段王」的人设。
 *   2. 只读公开接口，不爬网页。反爬风险低，也不容易被封。
 *   3. 当天已经有文章就跳过，**绝不覆盖你自己写的东西**。
 *
 * 本地手动跑（可指定日期）：
 *   node scripts/hot-news.mjs            # 生成今天
 *   node scripts/hot-news.mjs 2026-09-28 # 生成指定日期
 */

import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const POSTS_DIR = join(ROOT, 'src', 'content', 'posts');

/** 发到哪个栏目 */
const COLUMN = 'redian';

/** 每天最多露出几个行业、每个行业最多几条、总共最多几条——太多就成流水账了 */
const MAX_GROUPS = 8;
const MAX_PER_SECTOR = 5;
const MAX_TOTAL = 24;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/**
 * 行业关键词表。
 *
 * ⚠️ id 必须和 src/site.config.ts 里 SECTORS 的 id 一致，改了那边记得同步。
 * 数组顺序 = 优先级：一条新闻命中多个行业时，归到最靠前的那个。
 */
const SECTORS = [
  { id: 'ai', name: 'AI', words: ['AI', '人工智能', '算力', '英伟达', 'OpenAI', 'Anthropic', '智算中心'] },
  { id: 'llm', name: '大模型', words: ['大模型', 'ChatGPT', 'GPT', 'DeepSeek', '通义', '文心', '豆包', 'Kimi', '千问'] },
  {
    id: 'semiconductor',
    name: '半导体',
    words: ['半导体', '芯片', '晶圆', '光刻', '存储芯片', 'DRAM', '台积电', '中芯', '封测', '先进封装'],
  },
  { id: 'robot', name: '机器人', words: ['机器人', '人形', '减速器', '伺服', '具身智能'] },
  { id: 'metal', name: '有色金属', words: ['有色', '铜价', '铝价', '锂价', '稀土', '黄金', '白银', '钨价', '镍价'] },
  { id: 'solar', name: '光伏', words: ['光伏', '硅料', '硅片', '逆变器', '太阳能'] },
  {
    id: 'ev',
    name: '新能源车',
    words: ['新能源车', '电动车', '锂电', '动力电池', '充电桩', '比亚迪', '特斯拉', '固态电池'],
  },
  { id: 'defense', name: '军工', words: ['军工', '国防', '航空发动机', '导弹', '造船'] },
  { id: 'medical', name: '医疗', words: ['医药', '医疗', '创新药', '疫苗', 'CXO', '集采', '生物科技', '医保'] },
  {
    id: 'finance',
    name: '金融',
    words: [
      '银行', '券商', '保险', '利率', '央行', 'LPR', '降准', '降息', '汇率', '美债',
      '美联储', '证监会', 'IPO', '私募', '公募', '融资余额',
    ],
  },
  { id: 'consumer', name: '消费', words: ['消费', '白酒', '零售', '食品饮料', '家电', '免税'] },
  { id: 'oil', name: '石油', words: ['石油', '原油', '油价', 'OPEC', '天然气', '炼化'] },
  { id: 'media', name: '游戏传媒', words: ['游戏', '传媒', '影视', '版号', '短剧'] },
  { id: 'travel', name: '旅游', words: ['旅游', '文旅', '酒店', '航空', '景区', '免签', '出境游'] },
  { id: 'agriculture', name: '农业', words: ['农业', '养殖', '猪价', '种业', '化肥', '粮食'] },
];

/** 明显没信息量的噪音，直接丢掉 */
const NOISE = [
  /于\d+月\d+日斥资[\d.,]+万港元回购/, // 港股每日回购公告，一天几十条，几乎没信息量
  /回购[\d.]+万股/,
  /涉资约[\d.]+万港元/,
  /根据股份计划合共发行/, // 港股期权行权的例行公告
];

/** 单条最长多少字：华尔街见闻给的是整段话，得压成一句话 */
const MAX_ITEM_LEN = 68;

/** ---------- 数据源 ---------- */

const SOURCES = [
  {
    name: '华尔街见闻',
    async fetch() {
      const json = await getJson(
        'https://api-one.wallstcn.com/apiv1/content/lives?channel=global-channel&limit=40'
      );
      return (json?.data?.items ?? []).map((it) => ({
        title: clean(it.content_text || it.title || ''),
        url: it.uri || '',
        source: '华尔街见闻',
      }));
    },
  },
  {
    name: '东方财富',
    async fetch() {
      const json = await getJson(
        'https://np-listapi.eastmoney.com/comm/web/getFastNewsList' +
          '?client=web&biz=web_news_col&fastColumn=102&sortEnd=&pageSize=40&req_trace=1'
      );
      return (json?.data?.fastNewsList ?? []).map((it) => ({
        title: clean(it.title || ''),
        url: '',
        source: '东方财富',
      }));
    },
  },
  {
    name: '新浪财经',
    async fetch() {
      const json = await getJson(
        'https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2517&num=40&page=1'
      );
      return (json?.result?.data ?? []).map((it) => ({
        title: clean(it.title || ''),
        url: it.url || '',
        source: '新浪财经',
      }));
    },
  },
];

/** ---------- 工具 ---------- */

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json, text/plain, */*' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

/** 去掉 HTML 标签、把连续空白压成一个空格，并压成一句话 */
function clean(text) {
  let out = String(text ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // 华尔街见闻是整段快讯，只留第一句，太长再截断
  const end = out.search(/[。！？]/);
  if (end > 8) out = out.slice(0, end);
  if (out.length > MAX_ITEM_LEN) out = out.slice(0, MAX_ITEM_LEN - 1) + '…';

  return out;
}

/** 去掉标点做比较用 */
function normalize(text) {
  return text.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
}

/**
 * 两个标题是不是在说同一件事。
 * 跑一个最长公共子串 —— 中文标题里连续 7 个字一模一样，
 * 基本可以断定是同一件事被两个源各报了一遍。
 * （阈值 7 是实测定出来的：调高到 8 会漏掉「沙特…输油管道…恢复石油出口」
 *   这种换了个说法的重复报道）
 */
function sameStory(a, b) {
  if (a.slice(0, 12) === b.slice(0, 12)) return true;
  if (a.length < 8 || b.length < 8) return false;
  // 长度差太多就不用比了，省时间
  if (Math.min(a.length, b.length) / Math.max(a.length, b.length) < 0.45) return false;

  let best = 0;
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
    if (best >= 7) return true;
  }
  return false;
}

/** 北京时间（GitHub 的机器是 UTC，这里手动 +8） */
function todayBeijing() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 命中哪个行业；都没命中就返回 null（归到「其他」） */
function pickSector(title) {
  for (const sector of SECTORS) {
    if (sector.words.some((word) => title.includes(word))) return sector;
  }
  return null;
}

/** ---------- 主流程 ---------- */

async function collect() {
  const batches = await Promise.all(
    SOURCES.map(async (src) => {
      try {
        const items = await src.fetch();
        console.log(`   ${src.name}: 拿到 ${items.length} 条`);
        return items;
      } catch (err) {
        // 单个源失败不影响整体——这些接口随时可能改，必须容错
        console.warn(`   ${src.name}: 抓取失败（${err.message}），跳过`);
        return [];
      }
    })
  );
  return batches.flat();
}

function screen(items) {
  const kept = [];

  for (const item of items) {
    const title = item.title;
    // 太短的没信息量；噪音直接丢
    if (title.length < 10) continue;
    if (NOISE.some((re) => re.test(title))) continue;

    // 同一件事常被好几个源同时发，比一比就知道是不是老面孔
    const key = normalize(title);
    if (kept.some((seen) => sameStory(key, seen.key))) continue;

    kept.push({ ...item, title, key, sector: pickSector(title) });
  }

  return kept;
}

function group(items) {
  const buckets = new Map();
  for (const item of items) {
    const key = item.sector ? item.sector.id : '__other__';
    if (!buckets.has(key)) {
      buckets.set(key, { sector: item.sector, items: [] });
    }
    buckets.get(key).items.push(item);
  }

  let groups = [...buckets.values()];

  // 先按条数排：今天哪个方向消息多，哪个排前面；「其他」永远垫底
  groups.sort((a, b) => {
    if (a.sector && !b.sector) return -1;
    if (!a.sector && b.sector) return 1;
    return b.items.length - a.items.length;
  });

  // 只留最活跃的几个方向，避免十几个小节各一条、看着像凑数
  groups = groups.slice(0, MAX_GROUPS);

  return trimGroups(groups, MAX_TOTAL);
}

/**
 * 轮流从各行业取，而不是把前面的行业先喂饱。
 * 否则一个刷屏的方向（比如今天的石油）会把别的方向全挤掉。
 */
function trimGroups(groups, maxTotal) {
  const picked = groups.map((g) => ({ sector: g.sector, items: [] }));
  let total = 0;
  let round = 0;

  while (total < maxTotal) {
    let added = false;
    for (let i = 0; i < groups.length && total < maxTotal; i++) {
      const source = groups[i].items;
      if (round < source.length && picked[i].items.length < MAX_PER_SECTOR) {
        picked[i].items.push(source[round]);
        total++;
        added = true;
      }
    }
    if (!added) break;
    round++;
  }

  return { groups: picked.filter((g) => g.items.length > 0), total };
}

function buildBody(groups, total) {
  const lines = [];

  for (const { sector, items } of groups) {
    if (!items.length) continue;
    lines.push(`## ${sector ? sector.name : '其他'}`);
    lines.push('');
    for (const item of items) {
      const from = item.url ? `[${item.source}](${item.url})` : item.source;
      lines.push(`- ${item.title}　—— ${from}`);
    }
    lines.push('');
  }

  if (!lines.length) return '';

  lines.push('---');
  lines.push('');
  lines.push(
    `以上 ${total} 条由公开财经快讯自动整理，只取标题、来源已标注，正文看法我来补。`
  );
  lines.push('');
  lines.push('个人观点，不构成投资建议。');
  lines.push('');

  return lines.join('\n');
}

function yamlStr(text) {
  return '"' + String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function buildMarkdown(date, groups, total) {
  const [, month, day] = date.split('-');
  const title = `${Number(month)}月${Number(day)}日 · 今日热点速览`;
  const summary = `今天值得看的 ${total} 条财经快讯，按行业分好了`;

  const sectorIds = groups
    .filter((g) => g.sector && g.items.length)
    .map((g) => g.sector.id);

  const fm = [
    '---',
    `title: ${yamlStr(title)}`,
    `summary: ${yamlStr(summary)}`,
    `date: ${date}`,
    `column: ${COLUMN}`,
    `sectors: [${sectorIds.join(', ')}]`,
    '---',
    '',
  ];

  return fm.join('\n') + '\n' + buildBody(groups, total);
}

async function main() {
  const date = process.argv[2] || todayBeijing();
  const file = join(POSTS_DIR, `${date}.md`);

  if (existsSync(file)) {
    console.log(`⏭  ${date}.md 已经存在，跳过——不会覆盖你自己写的内容`);
    return;
  }

  console.log(`抓取热点了（${date}）…`);
  const raw = await collect();
  console.log(`   合计 ${raw.length} 条`);

  const items = screen(raw);
  console.log(`   过滤去重后 ${items.length} 条`);

  const { groups, total } = group(items);

  if (total === 0) {
    // 一个源都没抓到：不要生成一篇空文章
    console.error('✖  一条都没抓到，所有数据源可能都挂了，这次不生成');
    process.exitCode = 1;
    return;
  }

  writeFileSync(file, buildMarkdown(date, groups, total), 'utf8');
  console.log(`✔  已生成 ${date}.md，共 ${total} 条，分 ${groups.length} 组`);
  for (const g of groups) {
    console.log(`     ${g.sector ? g.sector.name : '其他'}：${g.items.length} 条`);
  }
}

main().catch((err) => {
  console.error('✖  出错：', err);
  process.exitCode = 1;
});
