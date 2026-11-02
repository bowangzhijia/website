#!/usr/bin/env node
/**
 * ============================================================
 *  波王 · 大佬发言
 * ============================================================
 *
 * 每天由 GitHub Actions 定时跑一次：
 *   抓马斯克 / 特朗普 / 奥特曼 在 X 上的新推文
 *   → 只留没发过的 → 翻成中文 → 中英对照生成当天文章 → 提交上线
 *
 * 三条设计原则：
 *   1. **只翻原话，不加评论、不改语气。** 译文下面永远跟着英文原文，
 *      读者能自己对——翻错了一眼就看得出来，不会被当成事实传开。
 *   2. **只发新的。** 已发过的推文 id 记在文章的 HTML 注释里，
 *      下次读出来跳过，永不重复。
 *   3. **宁缺毋滥。** 今天没人说话就不出文章；某人没发就那一节不出现。
 *
 * ⚠️ 2026-11 实测结论 —— 这个免费接口**只对住宅 IP 友好**：
 *   · 家庭 / 办公网络直连：正常（4 个账号全部 200，能拿到完整时间线）
 *   · GitHub Actions 机房 IP（实测 172.203.196.224）：**第一个请求就 429**
 *   · 公共 CORS 代理（codetabs / allorigins / cors.lol）：同样 429 或 522
 *
 *   结论：**它撑不起「每天自动跑」**，只能在自己电脑上手动跑。
 *   要自动化，必须换成付费接口（X 官方按量付费，或 twitterapi.io 之类）。
 *   换的时候只改 fetchTimeline() 一个函数，其余代码不用动。
 *
 * 数据来源：X 的 syndication 接口（网页嵌入推文用的），免费、无需密钥。
 * 限制：约 30 次 / 15 分钟（住宅 IP 下）。
 *
 * 本地手动跑：
 *   node scripts/x-quotes.mjs            # 生成今天
 *   node scripts/x-quotes.mjs 2026-11-03 # 生成指定日期
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const POSTS_DIR = join(ROOT, 'src', 'content', 'posts');

/** 发到哪个栏目 */
const COLUMN = 'daren';

/** 文件名后缀。栏目里的文章日期会撞车（热点也是按天），靠它区分 */
const SUFFIX = 'daren';

/**
 * 盯谁。
 * handle 是 X 的用户名（网址里 x.com/ 后面那段）。
 * 顺序 = 文章里的小节顺序。
 */
const PEOPLE = [
  { handle: 'elonmusk', name: '马斯克', en: 'Elon Musk' },
  { handle: 'realDonaldTrump', name: '特朗普', en: 'Donald Trump' },
  { handle: 'sama', name: '山姆·奥特曼', en: 'Sam Altman' },
];

/** 每人每天最多露几条：多了就成流水账 */
const MAX_PER_PERSON = 5;

/** 只收最近多少小时内的推文（每天跑一次，留点余量防止漏） */
const RECENT_HOURS = 36;

/** 短于这个长度就不算「发言」（纯表情、纯链接会被滤掉） */
const MIN_LEN = 10;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/**
 * 行业关键词表（只用于给每条推文打标签）。
 *
 * ⚠️ 这里的 id 必须和 src/site.config.ts 里 SECTORS 的 id 一致。
 * 脚本是 .mjs，没法直接 import TypeScript，所以只能同步维护一份。
 */
const SECTOR_WORDS = [
  ['ai', ['AI', 'artificial intelligence', 'AGI', 'Grok', 'OpenAI', 'Anthropic', 'compute']],
  ['llm', ['GPT', 'ChatGPT', 'LLM', 'model', 'DeepSeek', 'Gemini', 'Claude', '大模型']],
  ['semiconductor', ['chip', 'semiconductor', 'Nvidia', 'GPU', 'TSMC', 'wafer', '芯片', '半导体']],
  ['robot', ['robot', 'Optimus', 'humanoid', '机器人', '人形']],
  ['ev', ['Tesla', 'EV', 'electric vehicle', 'battery', '特斯拉', '电动车', '锂电']],
  ['solar', ['solar', '光伏', '太阳能']],
  ['finance', ['tariff', 'Fed', 'rate', 'inflation', 'dollar', 'stock', 'market', '关税', '美联储', '利率', '通胀']],
  ['oil', ['oil', 'OPEC', '原油', '石油']],
  ['defense', ['defense', 'military', '军工', '国防']],
  ['medical', ['drug', 'FDA', 'vaccine', '医药', '疫苗']],
  ['media', ['media', 'game', 'gamepass', 'X', 'Twitter', '传媒', '游戏']],
];

/** ---------- 工具 ---------- */

/** 北京时间（GitHub 的机器是 UTC，这里手动 +8） */
function todayBeijing() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 把 UTC 时间按北京时间显示成「11-03 08:20」 */
function beijingStamp(date) {
  const d = new Date(date.getTime() + 8 * 3600 * 1000);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

/** 还原推文里的 HTML 实体 */
function unescapeHtml(text) {
  return String(text)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/**
 * 把正文里的 Markdown 特殊字符转义掉。
 * 不转的话，推文里的 * 或 _ 会把句子变成斜体，[ 会被当成链接。
 */
function escapeMd(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/([`*_[\]<>])/g, '\\$1');
}

/** 推文里带 markdown 引号时，避免破坏 > 引用块 */
function normalizeText(text) {
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/https:\/\/t\.co\/\w+/g, '') // t.co 短链去掉，原帖链接单独给
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 命中哪个行业；都没命中返回 null */
function pickSector(text) {
  const lower = text.toLowerCase();
  for (const [id, words] of SECTOR_WORDS) {
    if (words.some((w) => lower.includes(w.toLowerCase()))) return id;
  }
  return null;
}

/** ---------- 抓取 ---------- */

/**
 * 从 syndication 接口拿一个人的时间线 HTML，解析出推文数组。
 *
 * 返回的是网页，推文数据塞在 <script id="__NEXT_DATA__"> 的 JSON 里。
 * 这里不假设具体路径，而是递归搜索所有带 full_text 的对象——
 * X 改一层嵌套也不会让脚本立刻报废。
 */
async function fetchTimeline(person) {
  const url = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${person.handle}`;

  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html' },
    signal: AbortSignal.timeout(25000),
  });

  if (res.status === 429) {
    const reset = Number(res.headers.get('x-rate-limit-reset') || 0) * 1000;
    const when = reset ? new Date(reset).toISOString() : '未知';
    throw new Error(`被限流（重置于 ${when}）`);
  }
  if (!res.ok) throw new Error('HTTP ' + res.status);

  const html = await res.text();
  const matched = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
  );
  if (!matched) throw new Error('页面结构变了，找不到 __NEXT_DATA__');

  const data = JSON.parse(matched[1]);
  return extractTweets(data);
}

/** 递归找出所有带 full_text 的对象 */
function extractTweets(node, out = []) {
  if (!node || typeof node !== 'object') return out;

  if (typeof node.full_text === 'string') {
    const id = String(node.id_str || node.id || '');
    const createdAt = node.created_at ? new Date(node.created_at) : null;
    if (id && createdAt && !Number.isNaN(createdAt.getTime())) {
      out.push({ id, text: unescapeHtml(node.full_text), createdAt });
    }
  }

  for (const key of Object.keys(node)) {
    const value = node[key];
    if (value && typeof value === 'object') extractTweets(value, out);
  }
  return out;
}

/** ---------- 过滤 ---------- */

/** 已经发过的推文 id：扫所有历史文章里的 <!-- tw:xxx --> 注释 */
function readPublishedIds() {
  const ids = new Set();
  if (!existsSync(POSTS_DIR)) return ids;

  for (const file of readdirSync(POSTS_DIR)) {
    if (!file.endsWith(`-${SUFFIX}.md`)) continue;
    const text = readFileSync(join(POSTS_DIR, file), 'utf8');
    for (const m of text.matchAll(/<!--\s*tw:(\d+)\s*-->/g)) ids.add(m[1]);
  }
  return ids;
}

/** 从抓到的原始推文里，挑出今天该发的 */
function select(tweets, publishedIds, now) {
  const cutoff = now.getTime() - RECENT_HOURS * 3600 * 1000;
  const seen = new Set();
  const kept = [];

  // 新的在前
  const sorted = [...tweets].sort((a, b) => b.createdAt - a.createdAt);

  for (const tweet of sorted) {
    if (seen.has(tweet.id) || publishedIds.has(tweet.id)) continue;
    if (tweet.createdAt.getTime() < cutoff) continue;

    const text = normalizeText(tweet.text);

    // 转推不是他本人说的话
    if (/^RT @/.test(text)) continue;
    if (text.length < MIN_LEN) continue;
    // 纯链接（去掉 t.co 后什么都不剩）
    if (/^https?:\/\/\S+$/.test(text)) continue;

    seen.add(tweet.id);
    kept.push({ ...tweet, text });
    if (kept.length >= MAX_PER_PERSON) break;
  }

  return kept;
}

/** ---------- 翻译 ---------- */

/**
 * 免费翻译（Google 的公开端点，无需密钥）。
 *
 * 老实说：这是机器翻译，推文里的梗、反讽、双关它翻不好。
 * 所以每一条的中文下面都会附英文原文——翻错了读者能自己对。
 * 以后配了大模型的密钥，把这个函数换成调模型即可，其它地方不用动。
 */
async function translate(text) {
  // 已经是中文就不用翻了
  if (!/[a-zA-Z]{3}/.test(text)) return text;

  const input = text.length > 1800 ? text.slice(0, 1800) : text;
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=' +
    encodeURIComponent(input);

  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    const out = (json?.[0] ?? []).map((seg) => seg?.[0] ?? '').join('').trim();
    return out || null;
  } catch (err) {
    console.warn(`   翻译失败（${err.message}），这条只放原文`);
    return null;
  }
}

/** 两条之间歇一下，别把免费接口打急了 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** ---------- 生成文章 ---------- */

function yamlStr(text) {
  return '"' + String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function buildBody(sections) {
  const lines = [];

  for (const { person, tweets } of sections) {
    if (!tweets.length) continue;

    lines.push(`## ${person.name}`);
    lines.push('');
    lines.push(
      `<sub>@${person.handle} · ${person.en}</sub>`
    );
    lines.push('');

    for (const tweet of tweets) {
      // 中文译文放引用块里，和下面的英文原文在视觉上分开
      if (tweet.zh) {
        for (const line of tweet.zh.split('\n')) {
          lines.push(`> ${escapeMd(line)}`);
        }
      } else {
        // 翻译失败时，别让引用块空着
        for (const line of tweet.text.split('\n')) {
          lines.push(`> ${escapeMd(line)}`);
        }
      }
      lines.push('');

      // 英文原文：让读者能校对翻译
      if (tweet.zh) {
        for (const line of tweet.text.split('\n')) {
          lines.push(escapeMd(line));
        }
        lines.push('');
      }

      lines.push(
        `[原帖](https://x.com/${person.handle}/status/${tweet.id}) · ${beijingStamp(tweet.createdAt)}`
      );
      lines.push('');
      lines.push(`<!-- tw:${tweet.id} -->`);
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');
  lines.push('以上为公开发言的中英对照，只做翻译，不加评论。');
  lines.push('');
  lines.push('个人观点，不构成投资建议。');
  lines.push('');

  return lines.join('\n');
}

function buildMarkdown(date, sections, sectors) {
  const [, month, day] = date.split('-');
  const names = sections.map((s) => s.person.name);
  const count = sections.reduce((sum, s) => sum + s.tweets.length, 0);

  const title = `${Number(month)}月${Number(day)}日 · 大佬说了什么`;
  const summary = `${names.join('、')} 今天在 X 上的 ${count} 条发言，中英对照`;

  const fm = [
    '---',
    `title: ${yamlStr(title)}`,
    `summary: ${yamlStr(summary)}`,
    `date: ${date}`,
    `column: ${COLUMN}`,
    `sectors: [${sectors.join(', ')}]`,
    '---',
    '',
  ];

  return fm.join('\n') + '\n' + buildBody(sections);
}

/** ---------- 主流程 ---------- */

async function main() {
  const date = process.argv[2] || todayBeijing();
  const file = join(POSTS_DIR, `${date}-${SUFFIX}.md`);

  if (existsSync(file)) {
    console.log(`⏭  ${date}-${SUFFIX}.md 已经存在，跳过`);
    return;
  }

  const publishedIds = readPublishedIds();
  console.log(`历史已发推文 ${publishedIds.size} 条`);

  const now = new Date();
  const sections = [];
  let failed = 0;

  for (const person of PEOPLE) {
    console.log(`抓取 ${person.name}（@${person.handle}）…`);
    try {
      const raw = await fetchTimeline(person);
      const fresh = select(raw, publishedIds, now);
      console.log(`   抓到 ${raw.length} 条，新的 ${fresh.length} 条`);

      const tweets = [];
      for (const tweet of fresh) {
        const zh = await translate(tweet.text);
        tweets.push({ ...tweet, zh });
        if (zh) await sleep(300);
      }
      sections.push({ person, tweets });
    } catch (err) {
      // 一个人挂了不影响别人——接口限流、账号改名都很常见
      console.warn(`   ${person.name} 抓取失败（${err.message}），跳过`);
      failed += 1;
      sections.push({ person, tweets: [] });
    }
  }

  const total = sections.reduce((sum, s) => sum + s.tweets.length, 0);

  if (total === 0) {
    if (failed === PEOPLE.length) {
      console.error('✖  三个人全都没抓到，接口可能出问题了，这次不生成');
      process.exitCode = 1;
    } else {
      console.log('✖  今天没有新的发言，不生成文章');
    }
    return;
  }

  // 取所有推文命中的行业，去重后按固定顺序排（避免每次构建顺序乱跳）
  const hit = new Set();
  for (const { tweets } of sections) {
    for (const tweet of tweets) {
      const sector = pickSector(tweet.text);
      if (sector) hit.add(sector);
    }
  }
  const sectors = SECTOR_WORDS.map(([id]) => id).filter((id) => hit.has(id));

  writeFileSync(file, buildMarkdown(date, sections, sectors), 'utf8');

  console.log(`✔  已生成 ${date}-${SUFFIX}.md，共 ${total} 条`);
  for (const { person, tweets } of sections) {
    if (tweets.length) console.log(`     ${person.name}：${tweets.length} 条`);
  }
}

/**
 * 只有「直接运行」时才跑主流程。
 * 被别的脚本 import 时（比如自检）只提供函数，不产生副作用。
 */
const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((err) => {
    console.error('✖  出错：', err);
    process.exitCode = 1;
  });
}

/** 给自检用 */
export {
  extractTweets,
  select,
  normalizeText,
  pickSector,
  buildMarkdown,
  beijingStamp,
  escapeMd,
  unescapeHtml,
  PEOPLE,
};
