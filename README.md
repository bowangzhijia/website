# 波王之家 · 独立站

个人独立站。**没有文章系统**，整站由三个栏目组成，首页和各栏目页都是单屏设计。

| 栏目 | 网址 | 作用 |
| --- | --- | --- |
| ETF基金波段王 | `/columns/etf-boduan-wang/` | 欢迎语 + 邮箱订阅 + 平台账号 |
| 波王茶话会 | `/columns/chahuahui/` | 同上 |
| 给波王留言 | `/columns/message/` | 访客留言表（内容转发到站长邮箱） |

技术栈：Astro（纯静态）+ Cloudflare Pages + Cloudflare Functions + D1。

---

## 一、五分钟跑起来

```bash
npm install
npm run dev          # 本地开发，默认 http://localhost:4321
npm run build        # 构建到 dist/
npm run preview      # 预览构建结果
```

> `npm run dev` / `npm run preview` 不启动 Cloudflare Functions，
> 所以订阅和留言提交会显示失败提示。这是正常的，
> 用下面的 `wrangler pages dev` 才能连上后端联调。

### 手机真机预览

**同一 Wi-Fi**：`npm run dev -- --host`，终端会打印 Network 地址，手机直接打开。
连不上基本都是 Windows 防火墙拦了 Node 的入站连接（网络位置是「公用网络」时）。

**公网临时链接**：`npx cloudflared tunnel --url http://localhost:4321`，
会输出一个 `https://xxx.trycloudflare.com` 地址，关掉命令即失效。
`astro.config.mjs` 里已放行 `*.trycloudflare.com`，否则会返回 403。

---

## 二、上线前必须改的东西

打开 **`src/site.config.ts`**，全站配置都在这里：

| 位置 | 要改什么 |
| --- | --- |
| `SITE.url` | 你的正式域名（影响 sitemap、robots、分享链接） |
| `SITE.ogImage` | 社交分享图，见下方说明 |
| `SITE.icp` | 域名在国内备案才需要填，没有留空 |
| `PLATFORMS[].url` | **除哔哩哔哩外全是占位地址，必须逐个替换** |
| `COLUMNS` | 栏目列表，见下一节 |
| `WELCOME` | 内容栏目页的欢迎语 |
| `RISK_NOTE` | 底部风险提示，默认「个人观点，不构成投资建议。」 |

> **注意**：站长邮箱不在代码里。它只存在于服务端环境变量 `CONTACT_TO`，
> 前端和页面源码中都不会出现。

### 关于分享图

`public/og.svg` 是版式模板。**微信、微博、X 都不支持 SVG 作为分享缩略图**，
上线前请用它导出一张 1200×630 的 PNG 放进 `public/`，再把 `SITE.ogImage` 改成 `/og.png`。

---

## 三、站点结构

导航、首页入口卡片、栏目页**全部由 `COLUMNS` 自动生成**，不需要改任何代码。

```ts
{
  id: 'your-column-id',        // 网址是 /columns/your-column-id/
  name: '你的栏目名',
  tagline: '一句话定位',
  desc: '用于搜索结果摘要',
  color: ['#3b82f6', '#93c5fd'],
  kind: 'platforms',           // 默认；填 'message' 则该栏目显示留言表单
  welcome: {                   // 可选，不填用全局的 WELCOME
    title: '标题',
    body: '正文',
  },
}
```

平台归属：`PLATFORMS` 每项的 `column` 字段决定它显示在哪个栏目页。

### 单屏是怎么做到的

`body` 是 flex 纵向布局 + `min-height: 100dvh`，页脚自动贴底；
`main` 占满剩余高度，页面内容用 `margin-block: auto` 垂直居中，所以正常情况下不出现滚动条。

> 用 `margin-block: auto` 而不是 `align-items: center` 是有意的：
> 后者在内容超出容器时会把顶部裁掉且滚动不到，前者会自动退化为 0，内容始终可见。
> 矮屏或手机上确实装不下时，页面会正常滚动，不会丢内容。

---

## 四、部署到 Cloudflare Pages

### 1. 推到 Git 仓库

```bash
git init
git add -A
git commit -m "init"
git remote add origin <你的仓库地址>
git push -u origin main
```

### 2. 在 Cloudflare Pages 创建项目

- Framework preset：**Astro**
- Build command：`npm run build`
- Build output directory：`dist`

> 仓库里有 `wrangler.toml`（含 `pages_build_output_dir = "dist"`），Cloudflare 会自动读取。

### 3. 绑定域名

在 Pages 项目的 **Custom domains** 里添加域名，证书自动。
**绑好后回到 `src/site.config.ts` 把 `SITE.url` 改成这个域名，再推一次。**

---

## 五、后端配置：把粉丝邮箱收进自己手里

整站的目标只有一个：**攒下粉丝邮箱**。等哪天平台出问题，一封邮件就能把所有人叫回来。

完整链路：

```
粉丝填邮箱
   ↓
POST /api/subscribe
   ↓
① 先存进你的 D1 数据库          ← 最重要，绝不能因为发信失败而丢
② 粉丝收到「订阅成功」确认邮件   ← 顺便暴露填错的地址
③ 你收到「新订阅 xxx@qq.com」通知邮件（含当前名单总人数）
```

留言走同一条链路，只是把「欢迎邮件」换成「留言正文通知你」。

### 1. 创建数据库

```bash
npx wrangler d1 create etf-subscribers
```

把返回的 `database_id` 填进 `wrangler.toml`。然后建表：

```bash
npx wrangler d1 execute etf-subscribers --remote --file=db/schema.sql
```

> 如果数据库是**早先版本**建的（没有 `token` 字段），补跑一次迁移：
>
> ```bash
> npx wrangler d1 execute etf-subscribers --remote --file=db/migrations/001-add-unsubscribe.sql
> ```

没有 D1 时，订阅接口返回 503、留言接口仍会尝试发邮件，页面会显示失败提示。

### 2. 邮件环境变量

留言要真正送达邮箱，必须配这三项（[Resend](https://resend.com) 免费额度 3000 封/月）：

```bash
npx wrangler pages secret put RESEND_API_KEY   # Resend 密钥
npx wrangler pages secret put CONTACT_TO       # 站长收信邮箱（前端不可见）
npx wrangler pages secret put MAIL_FROM        # 发件人，如 "波王之家 <noreply@yourdomain.com>"
```

**`CONTACT_TO` 是本站唯一存放你邮箱的地方，它不会出现在任何前端代码里。**

留言邮件带 `reply_to`，你直接在邮件里点「回复」就能回给留言者。

### 3. 可选

```bash
npx wrangler pages secret put FORWARD_WEBHOOK_URL  # 订阅成功后转发到该 webhook
```

### 4. 你会收到什么

配好之后，粉丝一订阅，你的邮箱立刻收到：

```
主题：【波王之家】新订阅 fan@qq.com

新订阅者：fan@qq.com
来源页面：/columns/etf-boduan-wang/
时间：2026-09-26T07:12:33.000Z
当前名单总人数：37
```

不想收这个通知（比如粉丝多了嫌吵）：

```bash
npx wrangler pages secret put SUBSCRIBE_NOTIFY   # 填 off
```

### 5. 把名单拿出来

**方式一：Cloudflare 后台（推荐，能直接下载 CSV）**

Cloudflare 控制台 → Workers & Pages → D1 → `etf-subscribers` → Console，执行：

```sql
SELECT email, created_at FROM subscribers ORDER BY created_at DESC;
```

结果区右上角可以直接 Download CSV。

**方式二：命令行**

```bash
npx wrangler d1 execute etf-subscribers --remote \
  --command "SELECT email, created_at FROM subscribers ORDER BY created_at DESC"
```

留言同理，把表名换成 `messages`，字段换成 `email, message, created_at`。

> **定期备份**：建议每月导出一次 CSV，本地和网盘各存一份。
> 名单存在 Cloudflare 上很安全，但多一份备份没坏处。

### 6. 以后怎么给名单群发

**不要自己写群发脚本。** 自己发很容易进垃圾箱、也没有退订管理，反而会把域名信誉搞坏。

正确做法是**把名单导进专业的邮件列表服务**，让它们负责发送：

| 工具 | 免费额度 | 说明 |
| --- | --- | --- |
| **Buttondown** | 100 订阅者内免费 | 最轻量，个人站长常用 |
| **Substack** | 完全免费 | 顺便还能当博客用 |
| **Mailchimp** | 500 人 / 1000 封每月 | 功能全，界面重 |
| **Resend Broadcasts** | 3000 封每月 | 你已经在用它发通知，可以直接接着用 |

流程都一样：导出 CSV → 导入工具 → 写一封信 → 群发。

**真正要演练一次的动作**（极重要）：

> 假设明天 B 站把你封了。你打开邮件列表工具，写一封「我搬到新地址了，点这里」，
> 一键群发。五分钟内，所有粉丝都能收到。
>
> 这个流程建议提前走一遍，别等真的出事才第一次用。

### 7. 退订

每封发给粉丝的邮件都自带**两种**退订方式：

1. **邮件顶部的一键退订按钮** —— Gmail / Outlook 原生显示，靠 `List-Unsubscribe`
   和 `List-Unsubscribe-Post` 两个邮件头，点一下就退，不用跳页面
2. **正文里的退订链接** —— 跳到 `/unsubscribe/?token=xxx`，点「确认退订」

有人退订后，记录**不会删除**，只打上 `unsubscribed_at` 时间戳。好处是：

- 名单历史完整，能看出退订趋势
- 他不会再收到任何邮件
- 万一他自己重新订阅，会自动恢复，token 也不变

> **设计细节**：退订页故意做成「要点一下确认」，而不是打开链接就退订。
> 因为邮箱客户端会预抓取邮件里的所有链接，GET 直接退订会造成大批误伤。

**查有效名单**（排除已退订，群发前用这个）：

```bash
npx wrangler d1 execute etf-subscribers --remote \
  --command "SELECT email FROM subscribers WHERE unsubscribed_at IS NULL"
```

**查谁退订了**：

```bash
npx wrangler d1 execute etf-subscribers --remote \
  --command "SELECT email, unsubscribed_at FROM subscribers WHERE unsubscribed_at IS NOT NULL ORDER BY unsubscribed_at DESC"
```

---

## 六、目录结构

```
src/
├── site.config.ts        ← 全站配置：站点信息、栏目、平台、文案
├── layouts/BaseLayout.astro
├── components/
│   ├── Header.astro      ← 导航（首页 + 三个栏目 + 主题切换）
│   ├── Footer.astro      ← 只有一行版权
│   ├── SubscribeForm.astro
│   ├── MessageForm.astro
│   └── PlatformLinks.astro
├── pages/
│   ├── index.astro            ← 首页（站名 + 订阅 + 栏目入口）
│   ├── columns/[id]/index.astro ← 栏目页
│   ├── member.astro           ← 会员方案（暂未开放，无入口）
│   ├── unsubscribe.astro      ← 退订确认页
│   ├── robots.txt.ts
│   └── 404.astro
└── styles/global.css     ← 设计系统（双主题）
functions/api/
├── subscribe.js          ← 订阅接口（确认邮件 + 通知站长）
├── message.js            ← 留言接口（转发到 CONTACT_TO）
└── unsubscribe.js        ← 退订接口（POST 退订 / GET 跳转确认页）
db/
├── schema.sql            ← 全新建库用
└── migrations/           ← 已有数据库的增量改动
wrangler.toml
```

---

## 七、深浅色主题

默认浅色，切换按钮在页头最右侧。

- 选择存在 `localStorage` 的 `etf-theme`，首屏绘制前同步读取，**不会闪烁**
- 深色靠 `<html data-theme="dark">` 生效，没有该属性就是浅色
- 想改默认色：`src/layouts/BaseLayout.astro` 里 `<head>` 顶部脚本加 `|| 'dark'`
- 想改配色：只需改 `src/styles/global.css` 顶部的 `:root`（浅色）和
  `html[data-theme='dark']`（深色）两块，不用动任何组件

---

## 八、防封清单

- [ ] 所有平台简介里都放上本站地址
- [ ] 每个视频结尾口播一次「留邮箱」
- [ ] 订阅名单定期导出备份（本地 + 网盘各一份）
- [ ] 视频同时上传一份到 YouTube
- [ ] 保留原始素材的本地/网盘备份
- [ ] 准备一个备用域名，主站万一被墙可快速切换

---

## 九、常见问题

**Q：本地提交订阅或留言报错？**
A：正常。`npm run dev` 没有 Functions，用 `npx wrangler pages dev dist` 才能联调。

**Q：改了 `site.config.ts` 但页面没变？**
A：重启 dev server。配置在构建时读取。

**Q：会员页怎么没有入口？**
A：还没开放，所以没放进导航和页脚。文件在 `/member/`，开放时加个链接即可。

**Q：想加文章功能？**
A：当前刻意没有。如果之后要加，用 Astro 的 content collections 配合
`src/pages/columns/[id]/[slug].astro` 就可以，注意别破坏单屏布局。
