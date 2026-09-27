import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

/**
 * ============================================================
 *  内容集合：站上所有文章 / 日报
 * ============================================================
 *  文件放在 src/content/posts/ 下，用 Markdown 写。
 *  文件名（不含扩展名）会成为网址的一部分：
 *
 *    src/content/posts/2026-09-27.md
 *      →  /columns/redian/2026-09-27/
 *
 *  字段说明见下面的注释；不确定的一律可以不写，会用默认值。
 */
const posts = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/posts' }),
  schema: z.object({
    /** 标题 */
    title: z.string(),
    /** 一句话摘要，显示在列表里（不写就只显示标题和日期） */
    summary: z.string().default(''),
    /** 发布日期，格式 2026-09-27 */
    date: z.coerce.date(),
    /** 所属栏目 id，对应 site.config.ts 的 COLUMNS */
    column: z.string().default('redian'),
    /** 涉及的行业 id，对应 site.config.ts 的 SECTORS，可写多个 */
    sectors: z.array(z.string()).default([]),
    /**
     * 音频文件地址（可选）。
     * 填了就在文章页顶部显示播放器，例如 '/audio/2026-09-27.mp3'
     * 或 R2 的完整地址。不填则只显示文字稿。
     */
    audio: z.string().optional(),
  }),
});

export const collections = { posts };
