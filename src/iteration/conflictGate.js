/**
 * MARCATORI DI CONFLITTO IN UNA MODIFICA.
 *
 * `<<<<<<<`, `=======`, `>>>>>>>` a inizio riga non sono codice: sono ciò che git lascia quando due
 * versioni non si fondono e nessuno ha finito il lavoro. Un file così non è "quasi giusto", è
 * sintatticamente invalido — due versioni dello stesso modulo incollate una sull'altra.
 *
 * Non è ipotetico. Su un repository governato da ISL un file di test è rimasto in HEAD con i
 * marcatori dentro dalla iterazione #230 in poi: 575 righe che erano due suite complete concatenate,
 * `node --check` in errore alla prima riga, e nessuno se n'è accorto perché il file non veniva
 * eseguito. Il gate di parsing non lo vedeva perché guarda i file toccati dal diff; i test non lo
 * vedevano perché il file rotto era lui stesso un test.
 *
 * Il controllo costa una scansione delle righe aggiunte e non ha falsi positivi degni di nota: le
 * uniche righe che iniziano con sette `<` di fila e un nome sono quelle. Per sicurezza si applica
 * solo alle righe AGGIUNTE dal diff — un file che li conteneva già non è colpa di questa modifica,
 * e bloccarla non lo riparerebbe.
 */

const MARKER = /^[+](<{7}|={7}|>{7})(\s|$)/;

/**
 * @param {string} diff  diff unificato
 * @returns {{veto: boolean, findings: Array<{file: string, line: string}>, summary: string}}
 */
export function checkConflictMarkers(diff) {
  const findings = [];
  let file = null;
  for (const line of String(diff || '').split('\n')) {
    if (line.startsWith('+++ b/')) { file = line.slice(6).trim(); continue; }
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    if (MARKER.test(line)) findings.push({ file: file || '(sconosciuto)', line: line.slice(1, 40) });
  }
  if (!findings.length) return { veto: false, findings, summary: 'nessun marcatore di conflitto' };
  const files = [...new Set(findings.map((f) => f.file))];
  return {
    veto: true,
    findings,
    summary: `marcatori di conflitto non risolti in ${files.length} file: ${files.slice(0, 3).join(', ')}`,
  };
}
