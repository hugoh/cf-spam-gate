const HREF_RE = /href\s*=\s*["']([^"']+)["']/gi;
const BARE_URL_RE = /https?:\/\/[^\s"'<>]+/gi;

export function extractLinks(
  html: string | undefined,
  text: string | undefined,
): string[] {
  const links = new Set<string>();

  for (const match of html?.matchAll(HREF_RE) ?? []) {
    if (match[1].startsWith("http")) links.add(match[1]);
  }

  for (const match of text?.matchAll(BARE_URL_RE) ?? []) {
    links.add(match[0]);
  }

  return [...links];
}
