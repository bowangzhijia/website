import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { SITE } from './src/site.config.ts';

export default defineConfig({
  site: SITE.url,
  output: 'static',
  trailingSlash: 'always',
  integrations: [sitemap()],
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
