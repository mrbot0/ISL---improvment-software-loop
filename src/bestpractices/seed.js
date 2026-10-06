/**
 * Seed catalog of best practices, keyed by language. Kept as data (not code) so
 * it is easy to extend. `language` uses the keys from ../languages.js, plus
 * 'general' for cross-language rules that apply to every codebase.
 *
 * category: security | performance | maintainability | reliability | style | testing
 * severity: low | medium | high | critical
 */

const P = (language, category, title, rule, severity, rationale, source) => ({ language, category, title, rule, severity, rationale, source });

export const SEED_PRACTICES = [
  /* ─────────────────────────── general ─────────────────────────────── */
  P('general', 'security', 'No hardcoded secrets', 'Never commit credentials, API keys, tokens or passwords in source; load them from environment or a secrets manager.', 'critical', 'Leaked secrets are the most common breach vector and cannot be un-published.', 'OWASP'),
  P('general', 'security', 'Validate all external input', 'Treat every input crossing a trust boundary (HTTP, files, queues, env) as hostile and validate/parameterise it.', 'high', 'Injection flaws stem from trusting unvalidated input.', 'OWASP'),
  P('general', 'reliability', 'Handle errors explicitly', 'Do not swallow errors; log with context and fail loudly or degrade deliberately. Never leave an empty catch.', 'high', 'Silent failures surface far from their cause and cost hours to debug.', null),
  P('general', 'reliability', 'Time out remote calls', 'Every call leaving the process (HTTP, DB, queue) needs an explicit timeout and a defined failure path.', 'high', 'A hung dependency without a timeout takes the whole request down with it.', null),
  P('general', 'maintainability', 'Single responsibility', 'Each function/module should do one thing; extract when a unit mixes concerns or exceeds a screen.', 'medium', 'Small, focused units are testable and safe to change.', null),
  P('general', 'maintainability', 'No dead code', 'Delete unreachable code, unused exports and commented-out blocks; version control is the history.', 'low', 'Dead code misleads readers and rots.', null),
  P('general', 'testing', 'Cover the failure paths', 'Test the branches that break in production — edge cases, errors, concurrency — not just the happy path.', 'medium', 'Happy-path-only tests pass while the real bugs ship.', null),
  P('general', 'style', 'Consistent formatting', 'Adopt one formatter/linter config and enforce it in CI so style never enters review.', 'low', 'Consistent style removes noise from diffs and reviews.', null),

  /* ─────────────────────────── javascript ──────────────────────────── */
  P('javascript', 'style', 'Use const/let, never var', 'Declare with const by default and let when reassigning; avoid var and its function-scoping surprises.', 'low', 'Block scoping prevents a class of hoisting bugs.', 'Airbnb'),
  P('javascript', 'reliability', 'Await or return promises', 'Never leave a promise floating; await it, return it, or attach a catch. Handle async errors.', 'high', 'Unhandled rejections crash Node or vanish silently.', null),
  P('javascript', 'security', 'Avoid eval and dynamic Function', 'Never pass user input to eval, new Function, or setTimeout(string).', 'critical', 'These execute arbitrary code.', 'OWASP'),
  P('javascript', 'performance', 'No await inside loops when parallel-safe', 'Use Promise.all for independent async work instead of awaiting sequentially in a loop.', 'medium', 'Sequential awaits serialise work that could run concurrently.', null),
  P('javascript', 'maintainability', 'Prefer pure functions', 'Avoid mutating shared state; return new values so behaviour is predictable and testable.', 'medium', 'Hidden mutation is a top source of bugs.', null),
  P('javascript', 'security', 'Set security headers', 'Use helmet or equivalent; set CSP, HSTS, X-Content-Type-Options on HTTP responses.', 'high', 'Missing headers expose XSS and clickjacking.', 'OWASP'),

  /* ─────────────────────────── typescript ──────────────────────────── */
  P('typescript', 'reliability', 'Enable strict mode', 'Turn on "strict": true in tsconfig; do not disable strictNullChecks.', 'high', 'Strict mode catches null/undefined bugs at compile time.', null),
  P('typescript', 'maintainability', 'Avoid any', 'Prefer unknown + narrowing over any; any disables the type system exactly where you need it.', 'medium', 'any silently propagates and defeats the compiler.', null),
  P('typescript', 'maintainability', 'Model domain with types', 'Use discriminated unions and readonly types to make illegal states unrepresentable.', 'medium', 'The type system is your cheapest test suite.', null),

  /* ───────────────────────────── python ────────────────────────────── */
  P('python', 'style', 'Follow PEP 8', 'Adhere to PEP 8 naming and layout; use a formatter (black) and linter (ruff/flake8).', 'low', 'PEP 8 is the shared baseline for Python readability.', 'PEP 8'),
  P('python', 'reliability', 'Catch specific exceptions', 'Never use bare except:; catch the narrowest exception and re-raise or handle deliberately.', 'high', 'Bare except hides bugs and swallows KeyboardInterrupt/SystemExit.', 'PEP 8'),
  P('python', 'security', 'Parameterise SQL', 'Use parameterised queries / ORM binding; never build SQL with f-strings or %.', 'critical', 'String-built SQL is the classic injection hole.', 'OWASP'),
  P('python', 'maintainability', 'Use type hints', 'Annotate public functions and run mypy/pyright to catch type errors early.', 'medium', 'Hints document intent and enable static checking.', 'PEP 484'),
  P('python', 'reliability', 'Use context managers', 'Open files, locks and connections with "with" so they are always released.', 'medium', 'Leaked resources cause flaky failures under load.', null),
  P('python', 'performance', 'Avoid mutable default args', 'Never use a list/dict as a default parameter; use None and create inside.', 'medium', 'Mutable defaults are shared across calls — a notorious bug.', null),

  /* ───────────────────────────── java ──────────────────────────────── */
  P('java', 'reliability', 'Close resources with try-with-resources', 'Use try-with-resources for anything implementing AutoCloseable.', 'high', 'Manual close is forgotten on the exception path.', 'Effective Java'),
  P('java', 'maintainability', 'Prefer immutability', 'Make fields final and objects immutable where possible; minimise mutability.', 'medium', 'Immutable objects are thread-safe and easier to reason about.', 'Effective Java'),
  P('java', 'reliability', 'Do not catch and ignore', 'Never leave an empty catch; at minimum log with context.', 'high', 'Swallowed exceptions hide defects.', 'Effective Java'),
  P('java', 'security', 'Avoid Java deserialization of untrusted data', 'Do not deserialize untrusted input with native serialization; use a safe format.', 'critical', 'Java deserialization enables remote code execution.', 'OWASP'),
  P('java', 'performance', 'Use StringBuilder in loops', 'Do not concatenate String with + inside loops; use StringBuilder.', 'low', 'String is immutable; + in a loop is O(n^2).', null),

  /* ────────────────────────────── go ───────────────────────────────── */
  P('go', 'reliability', 'Check every error', 'Never discard an error with _; handle or wrap it with context (fmt.Errorf %w).', 'high', 'Ignored errors are Go\'s most common defect.', 'Effective Go'),
  P('go', 'reliability', 'Guard goroutines with context', 'Pass context.Context to cancellable work and respect ctx.Done() to avoid leaks.', 'high', 'Unbounded goroutines leak memory and connections.', null),
  P('go', 'style', 'gofmt everything', 'Run gofmt/goimports; formatting is not a matter of taste in Go.', 'low', 'The toolchain assumes canonical formatting.', 'Effective Go'),
  P('go', 'reliability', 'defer for cleanup', 'Use defer to release locks, close files and bodies immediately after acquisition.', 'medium', 'defer runs on every return path, including panics.', null),

  /* ───────────────────────────── ruby ──────────────────────────────── */
  P('ruby', 'security', 'Avoid unsafe send/eval', 'Never pass user input to send, eval, or constantize.', 'critical', 'They execute arbitrary methods/code.', 'OWASP'),
  P('ruby', 'performance', 'Avoid N+1 queries', 'Use includes/preload for associations instead of querying per record.', 'high', 'N+1 is the top Rails performance problem.', null),
  P('ruby', 'style', 'Follow the Ruby style guide', 'Use rubocop; prefer clear, expressive idioms over cleverness.', 'low', 'Consistency aids the whole team.', null),

  /* ────────────────────────────── php ──────────────────────────────── */
  P('php', 'security', 'Use prepared statements (PDO)', 'Always use PDO/mysqli prepared statements; never interpolate input into SQL.', 'critical', 'SQL injection is rampant in legacy PHP.', 'OWASP'),
  P('php', 'security', 'Escape output', 'Escape with htmlspecialchars on output to prevent XSS.', 'high', 'Unescaped output is stored/reflected XSS.', 'OWASP'),
  P('php', 'reliability', 'Enable strict types', 'Add declare(strict_types=1) and type-hint parameters and returns.', 'medium', 'Loose typing hides coercion bugs.', null),

  /* ───────────────────────────── csharp ────────────────────────────── */
  P('csharp', 'reliability', 'Dispose with using', 'Wrap IDisposable in using/using-declarations; do not rely on GC for unmanaged resources.', 'high', 'Leaked handles and connections exhaust the pool.', null),
  P('csharp', 'reliability', 'Async all the way', 'Do not block on async with .Result/.Wait(); propagate async to avoid deadlocks.', 'high', 'Sync-over-async deadlocks in UI/ASP.NET contexts.', null),
  P('csharp', 'security', 'Parameterise SQL / use EF', 'Use parameters or EF Core; never build SQL from strings.', 'critical', 'String SQL is injectable.', 'OWASP'),

  /* ────────────────────────────── cpp ──────────────────────────────── */
  P('cpp', 'reliability', 'Prefer RAII and smart pointers', 'Manage resources with RAII; use unique_ptr/shared_ptr over new/delete.', 'high', 'Manual memory management leaks and double-frees.', 'C++ Core Guidelines'),
  P('cpp', 'security', 'Avoid unbounded buffer ops', 'Never use gets/strcpy/sprintf; use bounded, checked alternatives.', 'critical', 'Buffer overflows are exploitable memory-corruption bugs.', 'CERT'),
  P('cpp', 'maintainability', 'Follow the rule of five/zero', 'Define or default all special members together, or none (rule of zero).', 'medium', 'Partial definitions cause subtle copy/move bugs.', 'C++ Core Guidelines'),

  /* ───────────────────────────── rust ──────────────────────────────── */
  P('rust', 'reliability', 'Avoid unwrap in production paths', 'Prefer ? and Result handling over unwrap/expect on fallible operations.', 'high', 'unwrap panics on the unhappy path.', null),
  P('rust', 'security', 'Minimise and audit unsafe', 'Keep unsafe blocks tiny, documented and justified; prefer safe abstractions.', 'high', 'unsafe bypasses the borrow checker\'s guarantees.', null),

  /* ────────────────────────────── sql ──────────────────────────────── */
  P('sql', 'performance', 'Index the columns you filter/join on', 'Add indexes for WHERE/JOIN/ORDER BY predicates on large tables; verify with EXPLAIN.', 'high', 'Full scans dominate query latency at scale.', null),
  P('sql', 'performance', 'Select only needed columns', 'Avoid SELECT *; list the columns you use so the planner and I/O stay lean.', 'medium', 'SELECT * fetches and transfers dead weight.', null),
  P('sql', 'security', 'Never build SQL from strings', 'Use bind variables / parameters for all user-supplied values.', 'critical', 'Concatenated SQL is injectable.', 'OWASP'),
  P('sql', 'reliability', 'Wrap multi-statement writes in transactions', 'Group related writes in a transaction with clear commit/rollback.', 'high', 'Partial writes corrupt invariants.', null),

  /* ───────────────────────────── shell ─────────────────────────────── */
  P('shell', 'reliability', 'Set -euo pipefail', 'Start scripts with set -euo pipefail so failures stop the script.', 'high', 'Default shell ignores errors and unset vars.', null),
  P('shell', 'security', 'Quote all variable expansions', 'Always quote "$var" to avoid word-splitting and glob injection.', 'high', 'Unquoted expansions break on spaces and enable injection.', 'ShellCheck'),

  /* ═══════════════════ enterprise / proprietary ═════════════════════ */

  /* ───────────────────────────── ABAP ──────────────────────────────── */
  P('abap', 'performance', 'No SELECT inside LOOP', 'Never issue a SELECT inside a LOOP; read all needed rows once (FOR ALL ENTRIES or JOIN) then process in memory.', 'high', 'SELECT-in-LOOP is the classic ABAP performance killer on large datasets.', 'SAP'),
  P('abap', 'performance', 'Restrict SELECT with WHERE and field list', 'Always specify a field list and a selective WHERE; avoid SELECT *; and unrestricted reads.', 'high', 'Full-table reads flood the DB and the app server.', 'SAP'),
  P('abap', 'security', 'Enforce authority checks', 'Guard sensitive operations with AUTHORITY-CHECK against the correct authorization object.', 'critical', 'Missing authority checks let any user perform privileged actions.', 'SAP'),
  P('abap', 'security', 'Avoid dynamic SQL injection', 'Never build Open SQL WHERE clauses by concatenating user input; use parameters/ranges.', 'critical', 'Dynamic Open SQL from input is injectable.', 'SAP'),
  P('abap', 'maintainability', 'Prefer modern ABAP (7.4+) syntax', 'Use inline declarations, table expressions and NEW #( ) over obsolete forms; avoid OCCURS and headers.', 'medium', 'Modern syntax is safer and clearer than legacy constructs.', 'SAP'),
  P('abap', 'reliability', 'Handle SY-SUBRC after every operation', 'Check SY-SUBRC after SELECT/READ/CALL and handle the not-found/error case explicitly.', 'high', 'Ignoring SY-SUBRC processes stale or empty data silently.', 'SAP'),
  P('abap', 'maintainability', 'No hardcoded clients/values', 'Do not hardcode client numbers, dates or system-specific values; use system fields/customizing.', 'medium', 'Hardcoding breaks transports across the landscape.', 'SAP'),

  /* ───────────────────────────── Apex ──────────────────────────────── */
  P('apex', 'performance', 'Bulkify: no SOQL/DML in loops', 'Never place SOQL or DML inside a for-loop; collect into collections and query/DML once.', 'critical', 'SOQL/DML in loops hits Salesforce governor limits and fails in bulk.', 'Salesforce'),
  P('apex', 'security', 'Enforce sharing and CRUD/FLS', 'Declare "with sharing" and check CRUD/FLS (Security.stripInaccessible / WITH SECURITY_ENFORCED).', 'high', 'Apex runs in system mode; missing checks expose records.', 'Salesforce'),
  P('apex', 'reliability', 'One trigger per object', 'Use a single trigger per object delegating to a handler class; avoid logic in triggers.', 'medium', 'Multiple triggers make execution order undefined.', 'Salesforce'),
  P('apex', 'testing', 'Assert with 75%+ coverage and real data', 'Write meaningful asserts and create test data in the test (no seeAllData=true).', 'high', 'Deployments require coverage; data-dependent tests are brittle.', 'Salesforce'),

  /* ───────────────────────────── COBOL ─────────────────────────────── */
  P('cobol', 'maintainability', 'Structured programming, no fall-through', 'Use structured PERFORM; avoid GO TO and PERFORM THRU ranges that fall through.', 'high', 'Uncontrolled GO TO produces spaghetti that resists change.', null),
  P('cobol', 'reliability', 'Check file status codes', 'After every I/O verb, test the FILE STATUS and handle non-zero codes.', 'high', 'Ignoring file status processes bad/empty data silently.', null),
  P('cobol', 'reliability', 'Initialize working storage', 'Explicitly INITIALIZE or VALUE working-storage; never rely on residual memory.', 'medium', 'Uninitialised fields cause intermittent, data-dependent bugs.', null),
  P('cobol', 'maintainability', 'Avoid magic numbers and literals', 'Define literals as named constants in WORKING-STORAGE for clarity and reuse.', 'low', 'Magic literals obscure intent and are error-prone to change.', null),
];
