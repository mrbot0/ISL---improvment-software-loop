/**
 * Minimal glob → RegExp compiler. Supports `**`, `*`, `?` and `{a,b}`.
 * Deliberately dependency-free: it only has to be correct for the patterns
 * we let agents configure as scopes, and being able to audit it matters more
 * than covering every edge of the POSIX spec.
 */
const cache = new Map();

function compile(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` may match zero directories, so make the slash optional.
        if (glob[i + 2] === '/') {
          re += '(?:.*\\/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) re += '\\{';
      else {
        re += `(?:${glob
          .slice(i + 1, end)
          .split(',')
          .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('|')})`;
        i = end;
      }
    } else if ('.+^$()|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

/** @param {string} p POSIX-style, repo-relative path (no leading `./`). */
export function matches(p, glob) {
  let re = cache.get(glob);
  if (!re) cache.set(glob, (re = compile(glob)));
  return re.test(p);
}

export const matchesAny = (p, globs = []) => globs.some((g) => matches(p, g));
