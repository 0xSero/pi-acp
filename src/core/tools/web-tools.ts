type FetchResult = { text: string; truncated: boolean };

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_CHARS = 20000;

export async function fetchUrl(url: string, maxChars = DEFAULT_MAX_CHARS): Promise<FetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    const truncated = text.length > maxChars;
    return { text: truncated ? `${text.slice(0, maxChars)}…` : text, truncated };
  } finally {
    clearTimeout(timeout);
  }
}

export async function searchWeb(query: string): Promise<string> {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const { text } = await fetchUrl(url, 40000);
  const results: Array<{ title: string; href: string }> = [];
  const regex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/g;
  let match: RegExpExecArray | null = null;
  while ((match = regex.exec(text)) && results.length < 5) {
    results.push({ href: match[1], title: decodeHtml(stripTags(match[2])) });
  }
  if (results.length === 0) {
    return "No results found.";
  }
  return results.map((result, index) => `${index + 1}. ${result.title}\n${result.href}`).join("\n\n");
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, "").trim();
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}
