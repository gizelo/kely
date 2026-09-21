const SOCIAL_HOSTS = new Set(["instagram.com", "www.instagram.com", "linkedin.com", "www.linkedin.com"]);
const PAGE_HINTS = /(?:^|\/)(?:about|company|product|products|service|services|solutions|features|pricing|contact)(?:\/|$)/iu;

export interface PublicSourceSignals {
  title: string;
  description: string;
  canonicalUrl: string | null;
  sameOriginPages: string[];
  socialProfiles: string[];
  fontFamilies: string[];
  colors: string[];
  visibleText: string;
}

function decodeEntities(value: string) {
  return value
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">");
}

function compact(value: string, maximum: number) {
  return decodeEntities(value).replace(/\s+/gu, " ").trim().slice(0, maximum);
}

function attributes(tag: string) {
  const result = new Map<string, string>();
  for (const match of tag.matchAll(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) {
    result.set(match[1].toLowerCase(), match[2] ?? match[3] ?? "");
  }
  return result;
}

function safePublicLink(value: string, base: URL) {
  try {
    const url = new URL(value, base);
    url.hash = "";
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
    return url;
  } catch {
    return null;
  }
}

function unique(values: string[], limit: number) {
  return [...new Set(values)].slice(0, limit);
}

export function extractPublicSourceSignals(html: string, pageUrl: URL): PublicSourceSignals {
  const bounded = html.slice(0, 512 * 1024);
  const title = compact(bounded.match(/<title\b[^>]*>([\s\S]*?)<\/title>/iu)?.[1] ?? "", 200);
  let description = "";
  let canonicalUrl: string | null = null;
  const sameOriginPages: string[] = [];
  const socialProfiles: string[] = [];

  for (const match of bounded.matchAll(/<meta\b[^>]*>/giu)) {
    const attrs = attributes(match[0]);
    const key = (attrs.get("name") ?? attrs.get("property") ?? "").toLowerCase();
    if (!description && ["description", "og:description", "twitter:description"].includes(key)) {
      description = compact(attrs.get("content") ?? "", 500);
    }
  }

  for (const match of bounded.matchAll(/<link\b[^>]*>/giu)) {
    const attrs = attributes(match[0]);
    if ((attrs.get("rel") ?? "").toLowerCase().split(/\s+/u).includes("canonical")) {
      const link = safePublicLink(attrs.get("href") ?? "", pageUrl);
      if (link && link.hostname === pageUrl.hostname) canonicalUrl = link.href;
    }
  }

  for (const match of bounded.matchAll(/<a\b[^>]*>/giu)) {
    const link = safePublicLink(attributes(match[0]).get("href") ?? "", pageUrl);
    if (!link) continue;
    const host = link.hostname.toLowerCase();
    if (SOCIAL_HOSTS.has(host)) socialProfiles.push(link.href);
    else if (host === pageUrl.hostname.toLowerCase() && link.pathname !== pageUrl.pathname && PAGE_HINTS.test(link.pathname)) sameOriginPages.push(link.href);
  }

  const fontFamilies: string[] = [];
  for (const match of bounded.matchAll(/font-family\s*:\s*([^;}{]+)/giu)) {
    const family = compact(match[1], 100).replace(/["']/gu, "");
    if (family && !/^(?:inherit|initial|unset|sans-serif|serif|monospace)$/iu.test(family)) fontFamilies.push(family);
  }

  const colors = unique([...bounded.matchAll(/#[0-9a-f]{6}\b/giu)].map((match) => match[0].toUpperCase()), 12);
  const withoutExecutable = bounded
    .replace(/<(?:script|style|template|noscript|svg)\b[\s\S]*?<\/(?:script|style|template|noscript|svg)>/giu, " ")
    .replace(/<!--([\s\S]*?)-->/gu, " ");
  const visibleText = compact(withoutExecutable.replace(/<[^>]+>/gu, " "), 12_000);

  return {
    title,
    description,
    canonicalUrl,
    sameOriginPages: unique(sameOriginPages, 4),
    socialProfiles: unique(socialProfiles, 3),
    fontFamilies: unique(fontFamilies, 8),
    colors,
    visibleText,
  };
}
