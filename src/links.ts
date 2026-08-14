import { parseHTML } from "linkedom";

const BARE_URL_RE = /https?:\/\/[^\s"'<>]+/gi;

export interface ExtractedLink {
  url: string;
  anchorText?: string;
}

export function extractLinks(
  html: string | undefined,
  text: string | undefined,
): ExtractedLink[] {
  const links = new Map<string, ExtractedLink>();

  if (html) {
    const { document } = parseHTML(html);
    for (const anchor of document.querySelectorAll("a[href]")) {
      const url = anchor.getAttribute("href") ?? "";
      if (!url.startsWith("http")) continue;
      if (!links.has(url))
        links.set(url, {
          url,
          anchorText: anchor.textContent?.trim() || undefined,
        });
    }
  }

  for (const match of text?.matchAll(BARE_URL_RE) ?? []) {
    const url = match[0];
    if (!links.has(url)) links.set(url, { url });
  }

  return [...links.values()];
}
