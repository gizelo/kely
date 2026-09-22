const SOCIAL_HOSTS = new Set(["instagram.com", "www.instagram.com", "linkedin.com", "www.linkedin.com"]);
const PAGE_HINTS = /(?:^|\/)(?:about|company|product|products|platform|service|services|solutions|features|how-it-works|use-cases|usecases|compare|integrations|pricing|faq|docs|contact)(?:\/|$)/iu;
const HIGH_VALUE_PAGE_HINTS = /(?:^|\/)(?:product|products|platform|solutions|features|how-it-works|use-cases|usecases|compare|integrations)(?:\/|$)/iu;
const MEDIUM_VALUE_PAGE_HINTS = /(?:^|\/)(?:service|services|pricing|faq|docs)(?:\/|$)/iu;

export interface PublicSourceSignals {
  title: string;
  description: string;
  canonicalUrl: string | null;
  sameOriginPages: string[];
  socialProfiles: string[];
  fontFamilies: string[];
  colors: string[];
  sameOriginStylesheets: string[];
  metadataImageReferences: string[];
  visibleText: string;
}

export interface CssVisualSignals {
  fontFamilies: string[];
  colors: string[];
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
  const sameOriginPages: { url: string; order: number; priority: number }[] = [];
  const socialProfiles: string[] = [];
  const fontFamilies: string[] = [];
  const sameOriginStylesheets: string[] = [];
  const metadataImageReferences: string[] = [];

  for (const match of bounded.matchAll(/<meta\b[^>]*>/giu)) {
    const attrs = attributes(match[0]);
    const key = (attrs.get("name") ?? attrs.get("property") ?? "").toLowerCase();
    if (!description && ["description", "og:description", "twitter:description"].includes(key)) {
      description = compact(attrs.get("content") ?? "", 500);
    }
    if (["og:image", "og:image:secure_url", "twitter:image", "twitter:image:src"].includes(key)) {
      const image = safePublicLink(attrs.get("content") ?? "", pageUrl);
      if (image) metadataImageReferences.push(image.href);
    }
  }

  for (const match of bounded.matchAll(/<link\b[^>]*>/giu)) {
    const attrs = attributes(match[0]);
    const relations = (attrs.get("rel") ?? "").toLowerCase().split(/\s+/u);
    if (relations.includes("canonical")) {
      const link = safePublicLink(attrs.get("href") ?? "", pageUrl);
      if (link && link.hostname === pageUrl.hostname) canonicalUrl = link.href;
    }
    if (relations.includes("stylesheet")) {
      const stylesheet = safePublicLink(decodeEntities(attrs.get("href") ?? ""), pageUrl);
      if (stylesheet?.origin === pageUrl.origin) sameOriginStylesheets.push(stylesheet.href);
      if (stylesheet?.hostname === "fonts.googleapis.com" && stylesheet.pathname === "/css2") {
        for (const declaration of stylesheet.searchParams.getAll("family")) {
          const family = compact(declaration.split(":", 1)[0].replace(/\+/gu, " "), 100);
          if (family) fontFamilies.push(family);
        }
      }
    }
    if (relations.some((relation) => ["icon", "apple-touch-icon", "mask-icon"].includes(relation))) {
      const image = safePublicLink(decodeEntities(attrs.get("href") ?? ""), pageUrl);
      if (image) metadataImageReferences.push(image.href);
    }
  }

  let linkOrder = 0;
  for (const match of bounded.matchAll(/<a\b[^>]*>/giu)) {
    const link = safePublicLink(attributes(match[0]).get("href") ?? "", pageUrl);
    if (!link) continue;
    const host = link.hostname.toLowerCase();
    if (SOCIAL_HOSTS.has(host)) socialProfiles.push(link.href);
    else if (host === pageUrl.hostname.toLowerCase() && link.pathname !== pageUrl.pathname && PAGE_HINTS.test(link.pathname)) {
      const priority = HIGH_VALUE_PAGE_HINTS.test(link.pathname) ? 0 : MEDIUM_VALUE_PAGE_HINTS.test(link.pathname) ? 1 : 2;
      sameOriginPages.push({ url: link.href, order: linkOrder, priority });
    }
    linkOrder += 1;
  }

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
    sameOriginPages: [...new Map(sameOriginPages.sort((a, b) => a.priority - b.priority || a.order - b.order).map((item) => [item.url, item])).values()].slice(0, 4).map((item) => item.url),
    socialProfiles: unique(socialProfiles, 3),
    fontFamilies: unique(fontFamilies, 8),
    colors,
    sameOriginStylesheets: unique(sameOriginStylesheets, 2),
    metadataImageReferences: unique(metadataImageReferences, 3),
    visibleText,
  };
}

export function extractCssVisualSignals(css: string): CssVisualSignals {
  const bounded = css.slice(0, 128 * 1024);
  const fontFamilies: string[] = [];
  for (const match of bounded.matchAll(/font-family\s*:\s*([^;}{]+)/giu)) {
    const family = compact(match[1], 100).replace(/["']/gu, "");
    if (family && !/^(?:inherit|initial|unset|sans-serif|serif|monospace)$/iu.test(family)) fontFamilies.push(family);
  }
  return {
    fontFamilies: unique(fontFamilies, 8),
    colors: unique([...bounded.matchAll(/#[0-9a-f]{6}\b/giu)].map((match) => match[0].toUpperCase()), 12),
  };
}
