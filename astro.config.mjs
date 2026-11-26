import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { SITE } from './src/site.config.ts';

export default defineConfig({
  site: SITE.url,
  output: 'static',
  trailingSlash: 'always',
  /*
   * 老的独立地址保留跳转，不做 404。
   * 这个页面和栏目页内容完全一样，留两个入口只会多一处要保护的地方；
   * 但直接删掉会让收藏过旧链接的人看到打不开——所以改成跳转，
   * 跳转页没有内容，真正的内容只有栏目页一个入口。
   */
  redirects: {
    '/etf-share': '/columns/etf-share/',
  },
  integrations: [
    sitemap({
      // 写作后台不对外，别让搜索引擎收录
      filter: (page) => !page.includes('/write/'),
    }),
  ],
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
