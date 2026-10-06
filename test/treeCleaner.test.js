import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { analyseTree, applyCleanup } from '../src/workbench/treeCleaner.js';

/**
 * Un agente che pulisce va verificato su ciò che NON tocca, non su ciò che tocca.
 * Il danno che può fare è irreversibile e silenzioso: cancella, l'albero diventa pulito, e nessuno
 * si accorge di cosa mancava finché non serve.
 */

function repoFinto() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isl-tree-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 't@t.t');
  g('config', 'user.name', 'test');
  fs.writeFileSync(path.join(dir, 'sorgente.js'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(dir, 'cancellato.js'), 'export const b = 2;\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  return { dir, g };
}

test('non propone MAI di eliminare modifiche vere a un sorgente', () => {
  const { dir } = repoFinto();
  fs.writeFileSync(path.join(dir, 'sorgente.js'), 'export const a = 999; // lavoro non salvato\n');
  const r = analyseTree(dir);
  const item = r.items.find((i) => i.path === 'sorgente.js');
  assert.equal(item.categoria, 'lavoro');
  assert.equal(item.azione, 'salva', 'l\'azione proposta non deve essere distruttiva');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rifiuta di agire se fra i percorsi scelti c\'è del lavoro', () => {
  // La protezione non sta solo nell'etichetta: anche se il chiamante chiede esplicitamente di
  // toccare quel file, l'agente si ferma. È l'unico modo perché l'etichetta significhi qualcosa.
  const { dir } = repoFinto();
  fs.writeFileSync(path.join(dir, 'sorgente.js'), 'export const a = 999;\n');
  const r = applyCleanup(['sorgente.js'], { root: dir });
  assert.equal(r.ok, false);
  assert.match(r.error, /modifiche vere/);
  assert.equal(fs.readFileSync(path.join(dir, 'sorgente.js'), 'utf8').includes('999'), true, 'il file è stato toccato');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('un file in stage conta come lavoro, non come rumore di formattazione', () => {
  /*
   * Il difetto che rendeva l'agente pericoloso. `git diff` senza argomenti ignora l'indice, quindi
   * per un file già messo in stage restituiva vuoto — che qui significava "nessuna differenza di
   * contenuto", cioè eliminabile. Con quella lettura la risoluzione di un conflitto di merge, appena
   * stagiata, veniva proposta per il ripristino.
   */
  const { dir, g } = repoFinto();
  fs.writeFileSync(path.join(dir, 'sorgente.js'), 'export const a = 42; // risolto a mano\n');
  g('add', 'sorgente.js');
  const item = analyseTree(dir).items.find((i) => i.path === 'sorgente.js');
  assert.equal(item.categoria, 'lavoro');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('riconosce gli scarti di strumenti e li elimina lasciando una copia', () => {
  const { dir } = repoFinto();
  fs.writeFileSync(path.join(dir, 'nul'), 'output di un bundler mal configurato');
  const r = analyseTree(dir);
  assert.equal(r.items.find((i) => i.path === 'nul').categoria, 'artefatto');

  const done = applyCleanup(['nul'], { root: dir });
  assert.equal(done.ok, true);
  assert.equal(fs.existsSync(path.join(dir, 'nul')), false, 'doveva essere rimosso');
  assert.ok(done.recupero.backup, 'deve esistere una copia di recupero');
  assert.equal(fs.existsSync(path.join(dir, done.recupero.backup, 'nul')), true, 'la copia deve contenere il file');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('una cartella con un progetto dentro viene ignorata, mai cancellata', () => {
  const { dir } = repoFinto();
  fs.mkdirSync(path.join(dir, 'annidato', 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'annidato', 'package.json'), '{}');
  fs.writeFileSync(path.join(dir, 'annidato', 'importante.js'), 'non perdere questo');

  const item = analyseTree(dir).items.find((i) => i.path.startsWith('annidato'));
  assert.equal(item.categoria, 'ingombro');
  assert.equal(item.azione, 'ignora');

  applyCleanup([item.path], { root: dir });
  assert.equal(fs.existsSync(path.join(dir, 'annidato', 'importante.js')), true, 'la cartella non va toccata');
  assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /annidato/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('un file tracciato e cancellato viene RIPRISTINATO, non confermato', () => {
  const { dir } = repoFinto();
  fs.rmSync(path.join(dir, 'cancellato.js'));
  const item = analyseTree(dir).items.find((i) => i.path === 'cancellato.js');
  assert.equal(item.categoria, 'ripristino');

  applyCleanup(['cancellato.js'], { root: dir });
  assert.equal(fs.existsSync(path.join(dir, 'cancellato.js')), true, 'doveva tornare al suo posto');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('il primo file dell\'elenco ha il nome giusto', () => {
  // `git status --porcelain` è posizionale e la prima riga inizia con uno spazio: un trim
  // complessivo sull'output sfalsava di un carattere il percorso del PRIMO file soltanto,
  // e un'azione su un percorso storpiato colpisce qualcosa di diverso da quello mostrato.
  const { dir } = repoFinto();
  fs.writeFileSync(path.join(dir, 'sorgente.js'), 'cambiato\n');
  const r = analyseTree(dir);
  for (const i of r.items) assert.ok(fs.existsSync(path.join(dir, i.path)) || i.categoria === 'ripristino', `percorso storpiato: ${i.path}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('un albero pulito lo dice, senza inventare voci', () => {
  const { dir } = repoFinto();
  const r = analyseTree(dir);
  assert.equal(r.clean, true);
  assert.equal(r.items.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
