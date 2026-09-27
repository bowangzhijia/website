import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { SITE } from './src/site.config.ts';

export default defineConfig({
  site: SITE.url,
  output: 'static',
  trailingSlash: 'always',
  integrations: [sitemap()],
  /*
   * 链接预取：页面加载后，把视口里出现的站内链接提前下载好。
   * 点栏目的时候页面已经在本地了，不用再等网络往返——
   * 这是「点一下要等两秒」最有效的解法。
   */
  prefetch: {
    prefetchAll: true,
    defaultStrategy: 'viewport',
  },
  markdown: {
    shikiConfig: { theme: 'github-dark' },
  },
  // 允许通过 Cloudflare 临时隧道（*.trycloudflare.com）访问本地开发/预览服务器，
  // 用于在手机上真机预览。仅影响本地 dev / preview，不影响正式部署。
  vite: {
    server: { allowedHosts: ['.trycloudflare.com'] },
    preview: { allowedHosts: ['.trycloudflare.com'] },
  },
});
