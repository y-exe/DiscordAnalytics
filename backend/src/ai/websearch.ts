/** DuckDuckGo Lite検索 (APIキー不要)。glm-ai-chat の src/search/ddg.js を簡略化したもの */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
  "&#39;": "'",
  "&nbsp;": " ",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&(?:amp|lt|gt|quot|#x27|#39|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

/** DDGのリダイレクトURL (//duckduckgo.com/l/?uddg=...) から実URLを取り出す */
function resolveUrl(href: string): string {
  if (href.startsWith("//")) href = `https:${href}`;
  try {
    const url = new URL(href);
    const uddg = url.searchParams.get("uddg");
    return uddg ? decodeEntities(uddg) : href;
  } catch {
    return href;
  }
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export async function webSearch(
  query: string,
  { count = 5, signal }: { count?: number; signal?: AbortSignal } = {},
): Promise<SearchResult[]> {
  const res = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
    headers: { "User-Agent": UA, "Accept-Language": "ja,en;q=0.8" },
    signal,
  });
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
  const html = await res.text();

  const links = [...html.matchAll(/<a[^>]*class=['"]result-link['"][^>]*>/g)].map((m) => {
    const href = m[0].match(/href=['"]([^'"]+)['"]/)?.[1] ?? "";
    const end = html.indexOf("</a>", m.index);
    const title = stripTags(html.slice(m.index + m[0].length, end));
    return { title, url: resolveUrl(href) };
  });

  const snippets = [
    ...html.matchAll(/<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g),
  ].map((m) => stripTags(m[1]));

  const results: SearchResult[] = [];
  for (let i = 0; i < links.length && results.length < count; i++) {
    if (!links[i].url || !links[i].title) continue;
    results.push({ ...links[i], snippet: snippets[i] ?? "" });
  }
  return results;
}
