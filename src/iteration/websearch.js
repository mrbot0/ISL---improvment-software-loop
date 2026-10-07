/**
 * Ricerca web senza dipendenze e senza chiavi, raschiando l'endpoint HTML di DuckDuckGo.
 *
 * Best-effort per scelta: se la rete cade o il markup cambia restituisce [] e il ricercatore
 * prosegue con il solo catalogo del codice. Non solleva mai.
 *
 * DUE COSE CHE MANCAVANO, ed erano il motivo per cui le proposte da ricerca restavano generiche.
 *
 * 1. L'URL VENIVA BUTTATO VIA. L'href e' nell'HTML — verificato — ma l'espressione regolare
 *    catturava solo il testo del link. Senza URL il ricercatore non puo' seguire un risultato, non
 *    puo' leggere la pagina e non puo' citare una fonte. Intanto il suo schema di output gli chiede
 *    `competitorEvidence`: "quale prodotto fa questa cosa e cosa fa esattamente". Gli si chiedeva
 *    una precisione che questo livello non poteva fornirgli, e a un modello a cui si chiede un
 *    dettaglio che non ha resta solo inventarlo.
 *
 * 2. SI LEGGEVANO SOLO I FRAMMENTI. Misurati su una ricerca reale: 145-290 caratteri. Sono
 *    didascalie, non contenuto. `readPage` scarica la pagina vera per i risultati che meritano,
 *    cosi' il secondo giro di ricerca mantiene la promessa che gia' fa nel suo commento — leggere
 *    la cosa di cui l'elenco parla, invece dell'elenco.
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

/**
 * DuckDuckGo avvolge i link in un proprio reindirizzamento: `//duckduckgo.com/l/?uddg=<url>`.
 * Passarlo cosi' com'e' a `readPage` scaricherebbe la pagina di rimbalzo invece dell'articolo.
 */
function unwrap(href) {
  if (!href) return null;
  try {
    const u = href.startsWith('//') ? `https:${href}` : href;
    const parsed = new URL(u);
    const target = parsed.searchParams.get('uddg');
    if (target) return decodeURIComponent(target);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

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
    // L'href viene ora catturato insieme al titolo. L'ordine degli attributi non e' garantito,
    // quindi si cerca href ovunque dentro il tag invece di pretenderlo in una posizione fissa.
    const re = /<a([^>]+class="result__a"[^>]*)>(.*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>(.*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) && results.length < max) {
      const href = /href="([^"]+)"/.exec(m[1])?.[1] || null;
      const title = decode(m[2]);
      const snippet = decode(m[3]);
      if (title) results.push({ title, snippet, url: unwrap(href) });
    }
    // Ripiego: solo frammenti, se il pattern combinato non aggancia.
    if (!results.length) {
      const sr = /class="result__snippet"[^>]*>(.*?)<\/a>/g;
      while ((m = sr.exec(html)) && results.length < max) {
        const snippet = decode(m[1]);
        if (snippet) results.push({ title: '', snippet, url: null });
      }
    }
    return results;
  } catch {
    return [];
  }
}

/** Markup che non e' testo leggibile: va tolto PRIMA di spogliare i tag, o il suo contenuto resta. */
const NON_TESTO = /<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi;

/**
 * Scarica una pagina e ne estrae il testo.
 *
 * Deliberatamente grezzo e limitato: serve a dare al modello il contenuto reale invece di un
 * frammento di centosessanta caratteri, non a costruire un lettore di articoli. Il tetto sui
 * caratteri non e' un dettaglio di prestazioni — e' cio' che impedisce a una pagina lunga di
 * occupare da sola tutto lo spazio del prompt e scacciare gli altri risultati.
 *
 * Non solleva mai: una fonte irraggiungibile e' un risultato in meno, non un'iterazione fallita.
 */
export async function readPage(url, { maxChars = 4000, timeoutMs = 10000 } = {}) {
  if (!url || !/^https?:\/\//i.test(url)) return '';
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
    if (!res.ok) return '';
    // Solo HTML: un PDF o un'immagine letti come testo producono rumore che sembra contenuto.
    const type = res.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml/i.test(type)) return '';

    const html = await res.text();
    const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html;
    return body
      .replace(NON_TESTO, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;|&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxChars);
  } catch {
    return '';
  }
}
