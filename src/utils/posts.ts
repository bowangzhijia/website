import { getCollection, type CollectionEntry } from 'astro:content';
import { COLUMNS, SECTORS, type Column, type Sector } from '../site.config';

export type Post = CollectionEntry<'posts'>;

/** 取某个栏目下的文章，按日期倒序 */
export async function getPostsByColumn(columnId: string): Promise<Post[]> {
  const posts = await getCollection('posts', ({ data }) => data.column === columnId);
  return sortByDateDesc(posts);
}

/** 按日期倒序（新的在前） */
export function sortByDateDesc(posts: Post[]): Post[] {
  return [...posts].sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
}

export function getColumn(id: string): Column | undefined {
  return COLUMNS.find((column) => column.id === id);
}

export function getSector(id: string): Sector | undefined {
  return SECTORS.find((sector) => sector.id === id);
}

/** 把行业 id 数组转成名字数组；认不出的 id 直接丢掉，不报错 */
export function sectorNames(ids: string[]): string[] {
  return ids
    .map((id) => getSector(id)?.name)
    .filter((name): name is string => Boolean(name));
}

/** 2026年9月27日 */
export function formatDateCN(date: Date): string {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

/** 09-27，列表里用，省地方 */
export function formatDateMD(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${m}-${d}`;
}

/** 2026-09-27，给 <time datetime="..."> 用 */
export function formatDateISO(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${m}-${d}`;
}
