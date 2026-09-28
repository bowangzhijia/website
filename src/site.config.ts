/**
 * ============================================================
 *  站点总配置 —— 日常只需要改这一个文件
 *  TODO 标记的地方请替换成你自己的真实信息
 * ============================================================
 */

export const SITE = {
  /** 站点名（品牌名） */
  name: '波王之家',
  /** 一句话定位，用于搜索结果与分享 */
  tagline: 'ETF基金波段王 · 波王茶话会 · 给波王留言',
  /** 站点简介 */
  description: 'ETF 波段交易与闲聊杂谈。',
  /** 正式域名 */
  url: 'https://bowangzhijia.com',
  /**
   * 社交分享缩略图。
   * TODO: 正式上线前换成 1200x630 的 PNG（微信、微博、X 都不支持 SVG），
   *       可参照 public/og.svg 的版式导出后放进 public/，再改这里。
   */
  ogImage: '/og.svg',
  author: '波王之家',
  /**
   * 对外展示的联系邮箱。
   * 先在 Cloudflare 的 Email Routing 里配好转发规则，否则粉丝发来的邮件会被丢弃。
   * 改这里之后，站上的显示、复制按钮、名片文件会一起变。
   */
  email: 'bowang@bowangzhijia.com',
  /** TODO: 域名若在国内备案，填备案号；没有就留空 */
  icp: '',
  /** 开始做内容的年份 */
  since: '2020',
} as const;

/** 风险提示，显示在首页与各栏目页底部 */
export const RISK_NOTE = '个人观点，不构成投资建议。';

/** 内容型栏目页顶部的欢迎语（可被单个栏目的 welcome 覆盖） */
export const WELCOME = {
  title: '欢迎回到波王之家',
  body: '大家好，我是波王，为了防止失联，请务必记住我的个人站点，可以留下您的邮箱，有更新会随时通知大家哈',
} as const;

/**
 * ============================================================
 *  栏目 —— 导航、首页入口、页面都由它自动生成
 * ============================================================
 */
export type Column = {
  /** 栏目 id：网址是 /columns/<id>/ */
  id: string;
  name: string;
  tagline: string;
  /** 用于搜索结果摘要 */
  desc: string;
  /** 栏目主色 */
  color: [string, string];
  /** platforms（默认）展示平台账号；message 展示留言表单；feed 展示文章列表 */
  kind?: 'platforms' | 'message' | 'feed';
  /** 该栏目页的欢迎语，不填用默认的 WELCOME */
  welcome?: { title: string; body: string };
};

export const COLUMNS: Column[] = [
  {
    id: 'redian',
    name: '波王热点',
    tagline: '每日市场热点',
    desc: '每日热点与市场消息面整理。',
    color: ['#e0533d', '#ff8a70'],
    kind: 'feed',
  },
  {
    id: 'etf-boduan-wang',
    name: 'ETF基金波段王',
    tagline: 'ETF 波段交易',
    desc: 'ETF 波段交易。',
    color: ['#f0a92b', '#ffd479'],
  },
  {
    id: 'chahuahui',
    name: '波王茶话会',
    tagline: '投资之外的闲聊',
    desc: '投资之外的闲聊。',
    color: ['#4a9eff', '#8cc4ff'],
  },
  {
    id: 'message',
    name: '给波王留言',
    tagline: '有问题或建议写在这里',
    desc: '留言会直接发到我的邮箱。',
    kind: 'message',
    color: ['#64748b', '#94a3b8'],
    welcome: {
      title: '有问题或建议？',
      body: '写在下面，内容会直接发到我的邮箱，我不会公开你的邮箱地址。',
    },
  },
];

/**
 * ============================================================
 *  行业标签 —— 「波王热点」栏目页的筛选按钮由它自动生成
 *  增删行业只改这个数组，文章里用 id 引用
 * ============================================================
 */
export type Sector = {
  /** 行业 id：写在文章 frontmatter 的 sectors 里 */
  id: string;
  name: string;
};

export const SECTORS: Sector[] = [
  { id: 'ai', name: 'AI' },
  { id: 'llm', name: '大模型' },
  { id: 'semiconductor', name: '半导体' },
  { id: 'robot', name: '机器人' },
  { id: 'media', name: '游戏传媒' },
  { id: 'travel', name: '旅游' },
  { id: 'medical', name: '医疗' },
  { id: 'solar', name: '光伏' },
  { id: 'ev', name: '新能源车' },
  { id: 'agriculture', name: '农业' },
  { id: 'oil', name: '石油' },
  { id: 'consumer', name: '消费' },
  { id: 'metal', name: '有色金属' },
  { id: 'defense', name: '军工' },
  { id: 'finance', name: '金融' },
];

/**
 * 平台账号 —— 每个平台归属到一个栏目，在该栏目页内展示
 * color 用平台官方的品牌色，决定徽章（那个小方块）的配色
 */
export type Platform = {
  name: string;
  /** 徽章上的短文字 */
  badge: string;
  /** 账号名 / ID */
  handle: string;
  /** 所属栏目 id */
  column: string;
  url: string;
  /** 徽章底色（渐变的两端） */
  color: [string, string];
  /**
   * 徽章上的文字颜色。
   * 不填就是白色——白底徽章必须填这个，否则白字白底看不见。
   */
  fg?: string;
};

export const PLATFORMS: Platform[] = [
  // ---------- ETF基金波段王 ----------
  {
    name: '哔哩哔哩',
    badge: 'B站',
    handle: '@ETF基金波段王',
    column: 'etf-boduan-wang',
    url: 'https://b23.tv/F4FN7pf',
    color: ['#FB7299', '#FF9CB8'],
  },

  {
    name: '抖音',
    badge: '抖音',
    handle: '@ETF基金波段王',
    column: 'etf-boduan-wang',
    url: 'https://v.douyin.com/fDGEoMOjYrM/',
    color: ['#000000', '#3A3A44'],
  },
  {
    name: '雪球',
    badge: '雪球',
    handle: '@ETF基金波段王',
    column: 'etf-boduan-wang',
    url: 'https://xueqiu.com/u/1311183441',
    // 白色底纹：徽章用浅灰渐变打底，配雪球蓝的字，不然白底白字看不见
    color: ['#FFFFFF', '#E8EDF5'],
    fg: '#0B69C7',
  },
  {
    name: '知乎',
    badge: '知乎',
    handle: '@ETF基金波段王',
    column: 'etf-boduan-wang',
    url: 'https://www.zhihu.com/people/jason-shao-43',
    color: ['#0084FF', '#4FB0FF'],
  },

  // ---------- 波王茶话会 ----------
  {
    name: '哔哩哔哩',
    badge: 'B站',
    handle: '@波王茶话会',
    column: 'chahuahui',
    url: 'https://b23.tv/EoyvtdP',
    color: ['#FB7299', '#FF9CB8'],
  },
  {
    name: '抖音',
    badge: '抖音',
    handle: '@波王茶话会',
    column: 'chahuahui',
    url: 'https://v.douyin.com/H5KD5wxe1zw/',
    color: ['#000000', '#3A3A44'],
  },
];

/** 邮箱订阅 */
export const SUBSCRIBE = {
  endpoint: '/api/subscribe',
  button: '免费订阅',
  placeholder: '你的邮箱地址',
  success: '订阅成功。',
  fallback: '暂时无法订阅，请稍后再试。',
} as const;

/**
 * 留言板 —— 用户填写自己的邮箱和内容，后端转发到站长的邮箱。
 * 站长的邮箱只存在于服务端环境变量 CONTACT_TO 里，前端不会出现。
 */
export const MESSAGE = {
  endpoint: '/api/message',
  button: '发送留言',
  emailPlaceholder: '你的邮箱（方便我回复）',
  messagePlaceholder: '想说的话…',
  success: '已发送，感谢。',
  fallback: '发送失败，请稍后再试。',
  /** 留言长度上限，与后端保持一致 */
  maxLength: 2000,
} as const;

/** 会员方案（暂未开放入口，仅页面展示） */
export const TIERS = [
  {
    id: 'free',
    name: '免费订阅',
    price: '¥0',
    period: '永久',
    highlight: false,
    features: ['公开内容', '邮件通知'],
    cta: '订阅',
    ctaHref: '#subscribe',
  },
  {
    id: 'pro',
    name: '波段会员',
    price: '待定',
    period: '每月',
    highlight: true,
    features: ['每周持仓与调仓记录', '轮动观察清单', '专属答疑'],
    cta: '预约通知',
    ctaHref: '#subscribe',
  },
  {
    id: 'lifetime',
    name: '终身会员',
    price: '待定',
    period: '一次性',
    highlight: false,
    features: ['包含波段会员全部内容', '历史归档', '一对一沟通（每年一次）'],
    cta: '预约通知',
    ctaHref: '#subscribe',
  },
] as const;
