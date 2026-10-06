/**
 * The canonical language registry. Everything that reasons about code — the
 * composition scanner, the best-practices knowledge base, the compliance checker,
 * and the improvement agents' scopes — resolves languages through here, so ISL
 * recognises the same broad set everywhere, including proprietary languages like
 * ABAP, Apex and COBOL that a JS-centric tool would never see.
 */

// language key → { name, accent, exts:[...], family }
export const LANGUAGES = {
  javascript: { name: 'JavaScript', accent: 'amber', family: 'web', exts: ['.js', '.mjs', '.cjs', '.jsx'] },
  typescript: { name: 'TypeScript', accent: 'sky', family: 'web', exts: ['.ts', '.tsx'] },
  python: { name: 'Python', accent: 'emerald', family: 'general', exts: ['.py', '.pyi', '.pyw'] },
  java: { name: 'Java', accent: 'rose', family: 'jvm', exts: ['.java'] },
  kotlin: { name: 'Kotlin', accent: 'violet', family: 'jvm', exts: ['.kt', '.kts'] },
  scala: { name: 'Scala', accent: 'rose', family: 'jvm', exts: ['.scala', '.sc'] },
  groovy: { name: 'Groovy', accent: 'sky', family: 'jvm', exts: ['.groovy', '.gradle'] },
  csharp: { name: 'C#', accent: 'violet', family: 'dotnet', exts: ['.cs'] },
  fsharp: { name: 'F#', accent: 'violet', family: 'dotnet', exts: ['.fs', '.fsx'] },
  vbnet: { name: 'Visual Basic', accent: 'sky', family: 'dotnet', exts: ['.vb'] },
  go: { name: 'Go', accent: 'teal', family: 'general', exts: ['.go'] },
  rust: { name: 'Rust', accent: 'amber', family: 'systems', exts: ['.rs'] },
  ruby: { name: 'Ruby', accent: 'rose', family: 'general', exts: ['.rb', '.rake', '.erb'] },
  php: { name: 'PHP', accent: 'violet', family: 'web', exts: ['.php', '.phtml'] },
  c: { name: 'C', accent: 'slate', family: 'systems', exts: ['.c', '.h'] },
  cpp: { name: 'C++', accent: 'slate', family: 'systems', exts: ['.cpp', '.cc', '.cxx', '.hpp', '.hh'] },
  objc: { name: 'Objective-C', accent: 'slate', family: 'apple', exts: ['.mm'] },
  swift: { name: 'Swift', accent: 'rose', family: 'apple', exts: ['.swift'] },
  dart: { name: 'Dart', accent: 'sky', family: 'general', exts: ['.dart'] },
  elixir: { name: 'Elixir', accent: 'violet', family: 'beam', exts: ['.ex', '.exs'] },
  erlang: { name: 'Erlang', accent: 'rose', family: 'beam', exts: ['.erl', '.hrl'] },
  haskell: { name: 'Haskell', accent: 'violet', family: 'functional', exts: ['.hs', '.lhs'] },
  clojure: { name: 'Clojure', accent: 'emerald', family: 'jvm', exts: ['.clj', '.cljs', '.cljc', '.edn'] },
  perl: { name: 'Perl', accent: 'sky', family: 'general', exts: ['.pl', '.pm', '.t'] },
  lua: { name: 'Lua', accent: 'sky', family: 'general', exts: ['.lua'] },
  r: { name: 'R', accent: 'sky', family: 'data', exts: ['.r', '.rmd'] },
  julia: { name: 'Julia', accent: 'violet', family: 'data', exts: ['.jl'] },
  matlab: { name: 'MATLAB', accent: 'amber', family: 'data', exts: ['.mlx'] },
  sql: { name: 'SQL', accent: 'sky', family: 'data', exts: ['.sql', '.ddl', '.dml'] },
  plsql: { name: 'PL/SQL', accent: 'sky', family: 'data', exts: ['.pls', '.plsql', '.pks', '.pkb'] },
  tsql: { name: 'T-SQL', accent: 'sky', family: 'data', exts: ['.tsql'] },
  prisma: { name: 'Prisma', accent: 'teal', family: 'data', exts: ['.prisma'] },
  graphql: { name: 'GraphQL', accent: 'rose', family: 'web', exts: ['.graphql', '.gql'] },
  vue: { name: 'Vue', accent: 'emerald', family: 'web', exts: ['.vue'] },
  svelte: { name: 'Svelte', accent: 'rose', family: 'web', exts: ['.svelte'] },
  solidity: { name: 'Solidity', accent: 'slate', family: 'blockchain', exts: ['.sol'] },
  shell: { name: 'Shell', accent: 'slate', family: 'ops', exts: ['.sh', '.bash', '.zsh'] },
  powershell: { name: 'PowerShell', accent: 'sky', family: 'ops', exts: ['.ps1', '.psm1'] },
  terraform: { name: 'Terraform', accent: 'violet', family: 'ops', exts: ['.tf', '.tfvars'] },
  dockerfile: { name: 'Docker', accent: 'sky', family: 'ops', exts: ['.dockerfile'] },
  nim: { name: 'Nim', accent: 'amber', family: 'systems', exts: ['.nim'] },
  zig: { name: 'Zig', accent: 'amber', family: 'systems', exts: ['.zig'] },
  crystal: { name: 'Crystal', accent: 'slate', family: 'general', exts: ['.cr'] },

  // ── Enterprise / proprietary languages ──────────────────────────────────
  abap: { name: 'ABAP', accent: 'amber', family: 'enterprise', exts: ['.abap'] },
  apex: { name: 'Apex (Salesforce)', accent: 'sky', family: 'enterprise', exts: ['.cls', '.trigger', '.apex'] },
  cobol: { name: 'COBOL', accent: 'slate', family: 'enterprise', exts: ['.cob', '.cbl', '.cpy', '.ccp'] },
  rpg: { name: 'RPG (IBM i)', accent: 'slate', family: 'enterprise', exts: ['.rpgle', '.rpg', '.sqlrpgle'] },
  pli: { name: 'PL/I', accent: 'slate', family: 'enterprise', exts: ['.pli', '.pl1'] },
  fortran: { name: 'Fortran', accent: 'violet', family: 'enterprise', exts: ['.f', '.f90', '.f95', '.for'] },
  vba: { name: 'VBA', accent: 'emerald', family: 'enterprise', exts: ['.bas', '.cls_vba'] },
  sas: { name: 'SAS', accent: 'sky', family: 'enterprise', exts: ['.sas'] },
  progress: { name: 'Progress OpenEdge (ABL)', accent: 'rose', family: 'enterprise', exts: ['.p', '.w', '.cls_abl'] },
  plsqlforms: { name: 'Oracle Forms', accent: 'sky', family: 'enterprise', exts: ['.fmb'] },

  // ── Markup / config (tracked, but not counted as "code %") ───────────────
  html: { name: 'HTML', accent: 'amber', family: 'markup', exts: ['.html', '.htm'] },
  css: { name: 'CSS', accent: 'sky', family: 'markup', exts: ['.css'] },
  scss: { name: 'SCSS', accent: 'sky', family: 'markup', exts: ['.scss', '.sass'] },
  less: { name: 'Less', accent: 'sky', family: 'markup', exts: ['.less'] },
  json: { name: 'JSON', accent: 'slate', family: 'config', exts: ['.json', '.jsonc'] },
  yaml: { name: 'YAML', accent: 'slate', family: 'config', exts: ['.yml', '.yaml'] },
  toml: { name: 'TOML', accent: 'slate', family: 'config', exts: ['.toml'] },
  xml: { name: 'XML', accent: 'slate', family: 'config', exts: ['.xml', '.xsd', '.xsl'] },
  markdown: { name: 'Markdown', accent: 'slate', family: 'docs', exts: ['.md', '.mdx', '.markdown'] },
};

/** Families that are markup/config/docs, excluded from the "% of code" metric. */
export const NON_CODE_FAMILIES = new Set(['markup', 'config', 'docs']);

// Build the reverse lookup once.
const EXT_TO_LANG = {};
for (const [key, def] of Object.entries(LANGUAGES)) {
  for (const ext of def.exts) EXT_TO_LANG[ext] = key;
}
// A couple of ambiguous extensions resolved by convention.
EXT_TO_LANG['.m'] = 'objc'; // Objective-C wins over MATLAB by prevalence in repos

/** Resolve a filename (or extension) to a language key, or null. */
export function languageOf(fileName) {
  const lower = String(fileName || '').toLowerCase();
  if (lower === 'dockerfile' || lower.endsWith('.dockerfile') || lower.startsWith('dockerfile.')) return 'dockerfile';
  if (lower === 'makefile') return 'shell';
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return null;
  return EXT_TO_LANG[lower.slice(dot)] || null;
}

export const languageName = (key) => LANGUAGES[key]?.name || key;
export const languageAccent = (key) => LANGUAGES[key]?.accent || 'slate';
export const isCodeLanguage = (key) => LANGUAGES[key] && !NON_CODE_FAMILIES.has(LANGUAGES[key].family);

/** All code file extensions (excludes markup/config/docs) — used for agent scopes. */
export const CODE_EXTENSIONS = Object.entries(LANGUAGES)
  .filter(([, d]) => !NON_CODE_FAMILIES.has(d.family))
  .flatMap(([, d]) => d.exts);

/** Glob for all code files under a directory, across every known language. */
export const codeGlobsUnder = (dir) => CODE_EXTENSIONS.map((e) => `${dir}/**/*${e}`);
