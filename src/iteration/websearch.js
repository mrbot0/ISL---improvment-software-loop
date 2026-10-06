/**
 * Zero-dependency, zero-key web search by scraping DuckDuckGo's HTML endpoint.
 * Best-effort: if the network is down or the markup shifts, it returns [] and
 * the researcher falls back to the code catalog alone. Never throws.
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

const decode = (s) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();

export async function webSearch(query, { max = 5, timeoutMs = 8000 } = {}) {
  try {
    const res = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
      body: new URLSearchParams({ q: query }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return [];
    const html = await res.text();

    const results = [];
    const re = /<a[^>]+class="result__a"[^>]*>(.*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>(.*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) && results.length < max) {
      const title = decode(m[1]);
      const snippet = decode(m[2]);
      if (title) results.push({ title, snippet });
    }
    // Fallback: snippets only, if the combined pattern misses.
    if (!results.length) {
      const sr = /class="result__snippet"[^>]*>(.*?)<\/a>/g;
      while ((m = sr.exec(html)) && results.length < max) {
        const snippet = decode(m[1]);
        if (snippet) results.push({ title: '', snippet });
      }
    }
    return results;
  } catch {
    return [];
  }
}
