# 给编码助手的工作约定

> 人类读者可以跳过这份，项目说明见 `README.md`。
> 本地还有更详细的工作笔记（`.codebuddy/`，不进仓库）。

## 项目

- **Astro 静态站 + Cloudflare Pages**，后端接口在 `functions/`
- 线上：https://bowangzhijia.com/ ｜ 仓库：`github.com/bowangzhijia/website`（公开）
- 配置总入口：`src/site.config.ts`（栏目、行业标签、平台账号、邮箱）
- 文章：`src/content/posts/*.md`，**文件名会变成网址的一部分**

## 铁律

1. **改完必须 `commit` + `push`，并把提交号告诉用户。**
   仓库配了 `deploy.yml`，任何 push 都会自动重建部署；
   用 `wrangler` 手动部署的改动，下一次别人推代码就会被覆盖掉。

2. **先验证，再实现。**
   涉及外部数据源的自动化功能，先在 GitHub Actions 里实测能不能拿到数据，
   再写页面和业务逻辑。不要基于"应该能行"动手。

3. **不要动 `.codebuddy/` 目录。**

4. **写样式注意作用域。**
   Astro 的 `<style>` 会给元素加作用域标记，JS `createElement` 出来的元素拿不到样式。
   这类样式必须写进 `<style is:global>`，并用父类名限制范围。

5. **诊断文件别用 `.log`**。`.gitignore` 里有 `*.log`，提交不上去，改用 `.txt`。

6. **敏感信息不要写进仓库。** 本仓库是公开的，密码/密钥一律走 GitHub Secrets
   或环境变量，不要出现在任何被跟踪的文件里。

## 用户偏好

- 要短、要直接。不要 emoji，不要"受多重因素影响"这类空话。
- 回答问题先说结论，再讲理由。
- 花钱、对外发布内容、删东西之前，先问一句。

## 关键文件

| 文件 | 作用 |
|---|---|
| `src/site.config.ts` | 栏目、行业、平台账号、邮箱、订阅配置 |
| `src/components/TabBar.astro` | 手机端底部标签栏（≤760px 显示） |
| `src/scripts/auth.js` | 后台门禁校验，用 `?raw` 内联进 HTML |
| `src/components/ArticleEditor.astro` | 文章页就地编辑面板 |
| `src/scripts/inline-edit.js` | 就地编辑逻辑，仅本机有令牌时启用 |
| `src/pages/write.astro` | 写作台（发布 / 列表 / 编辑 / 删除） |
| `scripts/hot-news.mjs` | 每日热点速览生成器（定时已暂停） |
| `scripts/x-quotes.mjs` | 抓 X 推文（栏目已撤下，代码保留） |
| `.github/workflows/*.yml` | 自动部署、热点生成、推文抓取 |
