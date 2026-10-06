/**
 * Scope analysis without a parser dependency: what a JavaScript file BINDS, and what it USES.
 *
 * Lives in src/ because the pipeline's scope gate runs on every iteration; tools/staticCheck.mjs
 * re-exports it so the standalone scans and the test guard read the same implementation. One copy,
 * because four copies of a diff parser is the last thing this codebase needed.
 *
 * Every rule here was tuned against real source until it reported nothing on a clean tree — the
 * first version produced thirty findings and all of them were noise.
 */
/**
 * Remove everything that is not executable code: comments, strings, and template literals.
 *
 * A single pass rather than a set of regexes, because regexes cannot do this. The first attempt
 * used them and reported thirty findings, all noise: SQL inside a multi-line template produced
 * `COALESCE()` and `IN()`, prose in a doc comment produced `submit_plan()` and `public()`. A guard
 * whose output is mostly wrong is one nobody reads.
 *
 * Template literals are handled with a depth counter so `${ … `nested` … }` is followed correctly,
 * and the interpolations themselves are KEPT — they are live code and can contain a real call.
 */
export function stripNonCode(src) {
  const s = String(src);
  let out = '';
  let i = 0;
  const tpl = []; // depth of `${` nesting per open template literal

  while (i < s.length) {
    const c = s[i];
    const next = s[i + 1];

    if (c === '/' && next === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    /*
     * Una stringa, oppure un apostrofo in mezzo alla prosa.
     *
     * Il testo dentro JSX non è una stringa: `<p>se perdi l'accesso</p>` contiene una virgoletta
     * singola che non apre niente. Trattarla come apertura di stringa faceva divorare tutto fino
     * alla virgoletta successiva — su un file reale cinque righe di codice, e da lì in poi la
     * parità restava invertita per il resto del file: l'analizzatore diventava cieco proprio dove
     * doveva guardare. Su un progetto scritto in italiano o francese è ovunque.
     *
     * Il criterio è nella specifica del linguaggio, non è un'euristica: una stringa JavaScript non
     * può attraversare un a capo. Se la chiusura non arriva entro fine riga, quella virgoletta non
     * apriva una stringa — è un carattere qualunque, e il resto della riga è codice da leggere.
     * (L'unica eccezione, la continuazione con backslash a fine riga, è gestita sotto.)
     */
    if (c === "'" || c === '"') {
      /*
       * Prima prova: una stringa può iniziare solo dove ci si aspetta un VALORE. È la stessa regola
       * che distingue una regex da una divisione, poche righe più sotto, e vale per lo stesso
       * motivo. In `dall'inserzionista` la virgoletta segue una lettera, e in JavaScript nessuna
       * stringa può seguire direttamente un identificatore — quindi non apre niente, è prosa.
       *
       * Serve perché la sola regola dell'a capo non basta: su `Prezzo richiesto dall'inserzionista:
       * <b>{prezzo} / giorno</b>` i due apostrofi si chiudono sulla stessa riga, e la falsa stringa
       * si porta via la graffa aperta. Il conteggio delle parentesi chiudeva allora il corpo della
       * funzione centinaia di caratteri prima della fine, e tutto ciò che veniva dopo risultava
       * fuori dal componente: nove segnalazioni su una sola pagina, tutte inesistenti.
       */
      const before = out.replace(/\s+$/, '');
      const prev = before.slice(-1);
      // Dopo una parola chiave la stringa è legittima anche se il carattere precedente è una
      // lettera: `from 'x'`, `return 'x'`, `case 'x'`. Senza questa eccezione la regola sopra
      // scartava ogni specificatore di import, e `import App from './App.jsx'` faceva risultare
      // App non importato — segnalato dalla scansione sull'albero sano nel giro di un minuto.
      const keyword = /\b(from|return|case|typeof|in|of|new|delete|void|do|else|yield|await|import|export|default|throw|instanceof|as)$/.test(before);
      if (!keyword && /[\w$)\]]/.test(prev)) { out += ' '; i++; continue; }
      const quote = c;
      let j = i + 1;
      let closed = false;
      while (j < s.length) {
        if (s[j] === '\\') {
          // Backslash a fine riga: continuazione, la stringa prosegue davvero sulla riga dopo.
          j += s[j + 1] === '\n' ? 2 : 2;
          continue;
        }
        if (s[j] === '\n') break;
        if (s[j] === quote) { closed = true; break; }
        j++;
      }
      if (!closed) { out += ' '; i++; continue; }
      i = j + 1;
      out += '""';
      continue;
    }
    if (c === '`') {
      i++;
      tpl.push(0);
      while (i < s.length && tpl.length) {
        if (s[i] === '\\') { i += 2; continue; }
        if (s[i] === '`') { i++; tpl.pop(); continue; }
        if (s[i] === '$' && s[i + 1] === '{') {
          // An interpolation is code — emit it so a call inside it is still seen.
          i += 2;
          let depth = 1;
          const start = i;
          while (i < s.length && depth) {
            if (s[i] === '{') depth++;
            else if (s[i] === '}') depth--;
            if (depth) i++;
          }
          out += ` ${stripNonCode(s.slice(start, i))} `;
          i++;
          continue;
        }
        i++;
      }
      out += '""';
      continue;
    }
    /*
     * A regex literal. Distinguished from division by what precedes it: a regex can only start
     * where a value is expected. Without this, an alternation like /(public|private)\s*\(/ reads
     * as a call to public().
     */
    /*
     * A JSX closing tag is not a regex.  puts a  immediately before the slash, and
     *  is a position where a regex may legally start — so treating it as one swallowed
     * everything up to the next slash, taking whole component definitions with it and then
     * reporting those components as undefined. On the target application it produced three findings
     * naming components defined a few lines below their own use.
     */
    /*
     * IL TEST VA ANCORATO ALL ULTIMO CARATTERE, non "uno qualsiasi degli ultimi otto".
     *
     * Senza ancora, in <Users size={11} /> la finestra conteneva = e { e lo slash del tag
     * autochiudente passava per inizio di regex. La finta regex correva fino alla barra
     * successiva — dentro un template literal — portandosi via il backtick di APERTURA; quello
     * di chiusura ne apriva allora uno nuovo che divorava settantasette righe fino al backtick
     * dopo. I due componenti definiti in quel tratto sparivano e venivano segnalati come non
     * definiti. Ancorato, size={11} finisce con } e lo slash resta quello che e: un tag JSX.
     */
    const prevChar = out[out.length - 1];
    if (c === '/' && prevChar !== '<' && /(?:[([{,;:=!&|?+\-*%~^<>]|^\s*|\b(?:return|typeof|case|in|of|new|delete|void|do|else|yield|await))$/.test(out.replace(/\s+$/, '').slice(-8) || '')) {
      i++;
      let inClass = false;
      while (i < s.length) {
        if (s[i] === '\\') { i += 2; continue; }
        if (s[i] === '[') inClass = true;
        else if (s[i] === ']') inClass = false;
        else if (s[i] === '/' && !inClass) break;
        else if (s[i] === '\n') break; // a newline means this was division after all
        i++;
      }
      i++;
      while (i < s.length && /[gimsuyd]/.test(s[i])) i++;
      out += ' 0 ';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Names this module can legitimately use. Deliberately over-permissive: it hunts for the name that is nowhere. */
export function boundNames(code) {
  const n = new Set();
  const add = (s) => { for (const m of String(s).matchAll(/[A-Za-z_$][\w$]*/g)) n.add(m[0]); };
  for (const m of code.matchAll(/^\s*import\s+([\s\S]*?)\s+from\s+/gm)) add(m[1]);
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) n.add(m[1]);
  /*
   * Destructuring, both shapes. The array form was missing, and it is the single most common
   * binding in a React codebase: `const [value, setValue] = useState()`. Without it a scan of the
   * target application reported 406 findings, almost all of them state setters that were perfectly
   * well defined — noise that buried the two real ones.
   */
  for (const m of code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}/g)) add(m[1]);
  for (const m of code.matchAll(/(?:const|let|var)\s*\[([^\]]*)\]/g)) add(m[1]);
  for (const m of code.matchAll(/\b(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) n.add(m[1]);
  // parameters of any function-ish form, plus catch bindings
  for (const m of code.matchAll(/(?:function\s*[\w$]*\s*|\bcatch\s*)\(([^)]*)\)/g)) add(m[1]);
  for (const m of code.matchAll(/\(([^)]*)\)\s*=>/g)) add(m[1]);
  for (const m of code.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) n.add(m[1]);
  /*
   * Object-literal and class methods: `foo(a, b) {`. Both the NAME and its PARAMETERS are bound —
   * binding only the name left every method parameter looking undefined, which is what produced the
   * last three findings of the first clean run: `handler` in `on(event, handler)`, `fn`, `b`.
   */
  for (const m of code.matchAll(/(?:^|[\s,{;])(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g)) {
    n.add(m[1]);
    add(m[2]);
  }
  return n;
}

/**
 * Identifiers in call position, excluding property calls (`a.b()`) and declarations.
 *
 * Names shorter than three characters are ignored. A missing import is always a named helper —
 * `changedPathsFrom`, `useResource`, `TabbedView` — never `b`. Short names in call position that
 * resolve to nothing are, in practice, the residue of a regex alternation the stripper did not
 * recognise (`/(refactor|split)/` reads as `b(`). Dropping them removes that class entirely at
 * no measurable cost to what the check is for; keeping them meant one permanent false positive,
 * and a guard with a known false positive is a guard people learn to ignore.
 */
export function calledNames(code, { minLength = 1 } = {}) {
  const out = new Set();
  // No whitespace between the name and the parenthesis. A call is written `foo(`; JSX prose is
  // `Scadenza (MM/AA)`, and JSX text is not a string literal so the stripper cannot remove it.
  // Requiring them adjacent drops that entire class of false positive.
  /*
   * `word(s)` is English pluralisation in prose — "3 file(s) changed", "2 line(s) added" — not a
   * call. In JSX that text is not a string literal, so the stripper cannot remove it, and it has no
   * space before the parenthesis, so the adjacency rule above does not catch it either. It was the
   * last source of false positives on healthy code: 17 files out of 220, every one of them this.
   */
  for (const m of code.matchAll(/(^|[^.\w$?])([a-zA-Z_$][\w$]*)\((s\))?/gm)) {
    if (m[3]) continue;
    if (m[2].length >= minLength) out.add(m[2]);
  }
  return out;
}

/*
 * L'elenco dei nomi globali sta in scopeGate.js, che e l'unico a usarlo. Qui ne esisteva una
 * seconda copia, dichiarata e mai letta: due liste dello stesso genere divergono al primo nome
 * aggiunto a una sola delle due, ed e successo — DOMException finiva in quella che nessuno
 * consultava, quindi il gate continuava a segnalarlo.
 */

/** Class members declared more than once in the same class body. */
export function duplicateClassMembers(code) {
  const dupes = [];
  for (const cls of code.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)[^{]*\{/g)) {
    const start = cls.index + cls[0].length;
    let depth = 1;
    let i = start;
    while (i < code.length && depth > 0) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}') depth--;
      i++;
    }
    const body = code.slice(start, i - 1);
    // Only members at depth 1 of the class body.
    const seen = new Map();
    let d = 0;
    for (const line of body.split('\n')) {
      const m = d === 0 && /^\s*(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(line);
      if (m && !/^\s*(?:if|for|while|switch|catch|return)\b/.test(line)) {
        const name = m[1];
        if (seen.has(name)) dupes.push({ cls: cls[1], name, first: seen.get(name), second: line.trim().slice(0, 60) });
        else seen.set(name, line.trim().slice(0, 60));
      }
      d += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      if (d < 0) d = 0;
    }
  }
  return dupes;
}

