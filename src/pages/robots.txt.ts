import type { APIContext } from 'astro';
import { SITE } from '../site.config';

export function GET(context: APIContext) {
  const base = (context.site ?? SITE.url).href.replace(/\/$/, '');

  const body = [
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    '',
    `Sitemap: ${base}/sitemap-index.xml`,
    '',
  ].join('\n');

  return new Response(body, {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
