const ANCHOR_RE = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>(.*?)<\/a>/gis;
const BARE_URL_RE = /https?:\/\/[^\s"'<>]+/gi;

export interface ExtractedLink {
  url: string;
  anchorText?: string;
}

function anchorTextOf(innerHtml: string): string | undefined {
  const text = innerHtml.replace(/<[^>]+>/g, "").trim();
  return text || undefined;
}

export function extractLinks(
  html: string | undefined,
  text: string | undefined,
): ExtractedLink[] {
  const links = new Map<string, ExtractedLink>();

  for (const match of html?.matchAll(ANCHOR_RE) ?? []) {
    const url = match[1];
    if (!url.startsWith("http")) continue;
    if (!links.has(url))
      links.set(url, { url, anchorText: anchorTextOf(match[2]) });
  }

  for (const match of text?.matchAll(BARE_URL_RE) ?? []) {
    const url = match[0];
    if (!links.has(url)) links.set(url, { url });
  }

  return [...links.values()];
}
