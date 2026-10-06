import fs from 'node:fs';
import { BaseManager } from '../managers/baseManager.js';
import { emit } from '../bus.js';
import { log } from '../logger.js';
import { llmJson } from '../iteration/llm.js';
import { notify } from '../db_iteration.js';
import { LANGUAGES, languageName } from '../languages.js';
import { getCodeStats, refreshCodeStats, sampleFilesByLanguage } from '../context/codeScan.js';
import { practicesForLanguages } from './bestPracticesDb.js';
import {
  addComplianceFinding,
  clearOpenComplianceFindings,
  listComplianceFindings,
  recordComplianceRun,
  lastComplianceRun,
  complianceByLanguage,
  countOpenViolations,
} from './complianceDb.js';

const SEVERITY_WEIGHT = { critical: 12, high: 7, medium: 3, low: 1 };
const MAX_LANGUAGES = 8;
const FILES_PER_LANG = 3;
const MAX_FILE_CHARS = 8000;

const CHECK_SYSTEM = `You are a code-compliance auditor. You are given the BEST-PRACTICE RULES for a specific
programming language and one source file in that language. Report ONLY concrete, real violations of
those rules that you can see in the file. Return ONLY JSON:
{"violations":[{"title":"short name of the rule broken","message":"what is wrong and where, specifically","category":"security|performance|maintainability|reliability|style|testing","severity":"low|medium|high|critical","line":<number or null>}]}
Be precise and conservative — cite the actual problem in the code. If the file respects the rules, return {"violations":[]}. Max 8 violations.`;

/**
 * Check the active project's code against the best-practices knowledge base.
 * Works for EVERY language — including proprietary ones like ABAP, Apex and
 * COBOL — because the check is performed by the LLM against the rule set for
 * that language, not by a language-specific parser.
 */
export async function runComplianceCheck({ signal, languages = null } = {}) {
  let stats = getCodeStats();
  if (!stats) stats = refreshCodeStats();

  const codeLangs = (stats.byLanguage || [])
    .filter((l) => l.pct != null) // real code, not markup/config
    .slice(0, MAX_LANGUAGES)
    .map((l) => l.key);
  const targetLangs = languages ? languages.filter((k) => codeLangs.includes(k)) : codeLangs;

  if (!targetLangs.length) {
    emit('compliance.checked', { languages: 0, violations: 0, score: null });
    return { languages: [], filesChecked: 0, violations: 0, score: null };
  }

  const samples = sampleFilesByLanguage({ languages: targetLangs, perLanguage: FILES_PER_LANG });
  clearOpenComplianceFindings();

  let filesChecked = 0;
  let violations = 0;
  const perLang = {};

  for (const lang of targetLangs) {
    const files = samples[lang] || [];
    if (!files.length) continue;
    const rules = practicesForLanguages([lang]);
    const ruleText = rules.map((r) => `- [${r.severity}/${r.category}] ${r.title}: ${r.rule}`).join('\n');

    for (const f of files) {
      let content;
      try {
        content = fs.readFileSync(f.absPath, 'utf8').slice(0, MAX_FILE_CHARS);
      } catch {
        continue;
      }
      filesChecked++;
      try {
        const r = await llmJson({
          system: CHECK_SYSTEM,
          user: `LANGUAGE: ${languageName(lang)}\n\nBEST-PRACTICE RULES:\n${ruleText}\n\nFILE: ${f.relPath}\n\`\`\`\n${content}\n\`\`\``,
          temperature: 0.2,
          signal,
        });
        const vs = Array.isArray(r.data?.violations) ? r.data.violations.slice(0, 8) : [];
        for (const v of vs) {
          addComplianceFinding({
            language: lang,
            relPath: f.relPath,
            line: Number.isFinite(v.line) ? v.line : null,
            category: v.category || 'maintainability',
            severity: ['low', 'medium', 'high', 'critical'].includes(v.severity) ? v.severity : 'medium',
            title: v.title,
            message: v.message,
            practice: v.title,
          });
          violations++;
          perLang[lang] = (perLang[lang] || 0) + 1;
        }
      } catch (err) {
        log.warn('compliance', `check failed for ${f.relPath}: ${err.message}`);
      }
    }
  }

  // Score: start at 100, subtract severity-weighted violations, floor at 0.
  const penalty = listComplianceFindings({ onlyOpen: true, limit: 1000 }).reduce((a, v) => a + (SEVERITY_WEIGHT[v.severity] || 3), 0);
  const score = Math.max(0, 100 - penalty);
  recordComplianceRun({ languages: targetLangs, filesChecked, violations, score });
  emit('compliance.checked', { languages: targetLangs.length, filesChecked, violations, score });
  notify({
    kind: 'system',
    severity: violations ? 'warn' : 'info',
    title: violations ? `Compliance: ${violations} best-practice violation(s) found` : 'Compliance check passed',
    body: `Checked ${filesChecked} file(s) across ${targetLangs.map(languageName).join(', ')}. Score ${score}/100.`,
    link: '#compliance',
  });
  log.info('compliance', `checked ${filesChecked} file(s) across ${targetLangs.length} language(s) — ${violations} violation(s), score ${score}`);
  return { languages: targetLangs, filesChecked, violations, score, perLang };
}

export function complianceReport() {
  return {
    lastRun: lastComplianceRun(),
    byLanguage: complianceByLanguage(),
    findings: listComplianceFindings({ onlyOpen: true, limit: 300 }),
    openViolations: countOpenViolations(),
  };
}

/* ---------------------------- manager (brief) ----------------------------- */

export class ComplianceManager extends BaseManager {
  constructor() {
    super('Compliance', { icon: '📋', accent: 'teal', role: 'Best-practice compliance across all languages' });
    for (const ev of ['compliance.checked', 'context.built']) this.on(ev, () => this.analyze());
  }

  analyze() {
    let run;
    let byLang;
    let open;
    let stats;
    try {
      run = lastComplianceRun();
      byLang = complianceByLanguage();
      open = countOpenViolations();
      stats = getCodeStats();
    } catch {
      this.setBrief({ status: 'idle', headline: 'No project database open.', stats: {} });
      return;
    }
    const langCount = (stats?.byLanguage || []).filter((l) => l.pct != null).length;
    const s = {
      score: run?.score ?? null,
      openViolations: open,
      languagesInProject: langCount,
      languagesChecked: run?.languages?.length ?? 0,
      worstLanguage: byLang[0] ? { language: byLang[0].language, violations: byLang[0].violations } : null,
      lastRunAt: run?.ts ?? null,
    };

    let status = 'idle';
    let headline;
    const recommendations = [];
    if (!run) {
      status = 'watching';
      headline = `${langCount} language(s) detected — run a compliance check to measure adherence to best practices.`;
      recommendations.push('Open the Compliance tab and run a check to audit the code against best practices per language.');
    } else if (open === 0) {
      status = 'idle';
      headline = `Compliant: no open best-practice violations (score ${run.score}/100).`;
    } else {
      status = run.score < 60 ? 'alert' : 'watching';
      headline = `${open} best-practice violation(s) open · score ${run.score}/100${s.worstLanguage ? ` · weakest: ${languageName(s.worstLanguage.language)}` : ''}.`;
      if (s.worstLanguage) recommendations.push(`${languageName(s.worstLanguage.language)} has the most violations — prioritise it.`);
    }
    this.setBrief({ status, headline, stats: s, recommendations });
  }
}
