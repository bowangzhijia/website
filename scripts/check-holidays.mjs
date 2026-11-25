// 检查休市日历是否缺年份，缺了就开个 Issue 提醒（GitHub 会发邮件）。
//
// 为什么不让它自动改日期：国务院通知是新闻页面，格式每年可能微调，
// 解析错一个数字就会把交易日当成休市、或者反过来，直接导致数据断更。
// 提醒 + 人工确认，比"看起来自动但可能出错"可靠得多。
//
// 每年 10 月起开始盯次年，因为国务院办公厅固定在 11 月初发布次年安排。

import { readFileSync } from 'node:fs';

const beijing = new Date(Date.now() + 8 * 3600e3);
const year = beijing.getUTCFullYear();
const month = beijing.getUTCMonth() + 1;

const j = JSON.parse(readFileSync('src/data/etf-share/holidays.json', 'utf8'));
const years = j.years || {};

const missing = [];
if (!years[year]) missing.push(year);
if (month >= 10 && !years[year + 1]) missing.push(year + 1);

if (!missing.length) {
  console.log(`休市日历齐全：${Object.keys(years).join('、')}`);
  process.exit(0);
}

const title = `休市日历需要补 ${missing.join('、')} 年`;
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;

if (!repo || !token) {
  console.log(`缺 ${missing.join('、')} 年（本地运行，不发 Issue）`);
  process.exit(0);
}

const H = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json',
  'User-Agent': 'holiday-check',
};

// 已经开过就不再重复开
const listRes = await fetch(`https://api.github.com/repos/${repo}/issues?state=open&per_page=50`, {
  headers: H,
});
const open = await listRes.json();
if (Array.isArray(open) && open.some((i) => i.title === title)) {
  console.log(`已有同名 Issue，跳过：${title}`);
  process.exit(0);
}

const body = [
  '## 要做什么',
  '',
  `休市日历缺 **${missing.join('、')}** 年，需要补上。`,
  '',
  '## 怎么补',
  '',
  '1. 搜「国务院办公厅关于 ' +
    missing[missing.length - 1] +
    ' 年部分节假日安排的通知」（每年 11 月初发布）',
  '2. 把「落在工作日」的放假日期写进 `src/data/etf-share/holidays.json`',
  '3. 周末不用列——代码里有 `isWeekend` 判断；调休上班的周末股市也不开市',
  '',
  '## 不补的后果',
  '',
  '不会出错。只是长假期间每天会多跑十几次空任务（每次都 18 秒快速退出），',
  '白白消耗 Actions 时间。',
].join('\n');

const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ title, body, labels: [] }),
});
const out = await res.json();
console.log(res.status, out.html_url || out.message || '');
