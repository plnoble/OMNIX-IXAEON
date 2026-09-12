import { createHash } from 'node:crypto';

export interface ParsedEntry {
  title: string;
  url: string;
  excerpt: string;
  claimedPublishedAt: string | null;
  fingerprint: string;
}

export function fingerprintText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  return createHash('sha256').update(normalized).digest('hex');
}

/** RSS/Atom 粗解析：不执行脚本，只取标题、链接、摘要、日期。 */
export function parseFeed(xml: string, sourceUrl: string): ParsedEntry[] {
  const items = [...xml.matchAll(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi)].slice(0, 10);
  return items
    .map((m) => {
      const block = m[0]!;
      const title = decode(tag(block, 'title') ?? '未命名条目');
      const link =
        attr(block, 'link', 'href') ??
        tag(block, 'link') ??
        tag(block, 'guid') ??
        tag(block, 'id') ??
        sourceUrl;
      const excerpt = stripTags(
        tag(block, 'description') ?? tag(block, 'summary') ?? tag(block, 'content') ?? title,
      ).slice(0, 800);
      const published = parseDate(
        tag(block, 'pubDate') ?? tag(block, 'published') ?? tag(block, 'updated'),
      );
      return {
        title: title.slice(0, 300) || '未命名条目',
        url: link.trim(),
        excerpt,
        claimedPublishedAt: published,
        fingerprint: fingerprintText(`${title}\n${excerpt}`),
      };
    })
    .filter((e) => e.url.length > 0);
}

/** HTML 发布页：标题 + 去标签正文指纹。排版空白变化不改变指纹。 */
export function parsePage(html: string, url: string): ParsedEntry {
  const title = decode(
    tag(html, 'title') ?? attr(html, 'meta', 'content', /property=["']og:title["']/i) ?? url,
  ).slice(0, 300);
  const body = stripTags(html).slice(0, 100_000);
  const excerpt = body.slice(0, 800);
  const published = parseDate(
    attr(html, 'meta', 'content', /property=["']article:published_time["']/i) ??
      attr(html, 'time', 'datetime'),
  );
  return {
    title: title || url,
    url,
    excerpt,
    claimedPublishedAt: published,
    // 指纹用受限正文，不跟展示摘要绑死；长导航前缀后的版本变化必须能检出。
    fingerprint: fingerprintText(`${title}\n${body}`),
  };
}

function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1]!.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : null;
}

function attr(xml: string, name: string, attrName: string, extra?: RegExp): string | null {
  const re = extra
    ? new RegExp(`<${name}\\b[^>]*${extra.source}[^>]*${attrName}=["']([^"']+)["']`, 'i')
    : new RegExp(`<${name}\\b[^>]*${attrName}=["']([^"']+)["']`, 'i');
  const m = xml.match(re);
  if (m) return m[1]!;
  const alt = extra
    ? new RegExp(`<${name}\\b[^>]*${attrName}=["']([^"']+)["'][^>]*${extra.source}`, 'i')
    : null;
  if (alt) {
    const m2 = xml.match(alt);
    if (m2) return m2[1]!;
  }
  return null;
}

function stripTags(html: string): string {
  return decode(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function parseDate(raw: string | null): string | null {
  if (!raw) return null;
  const t = Date.parse(raw.trim());
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}
