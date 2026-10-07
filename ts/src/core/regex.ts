// Python-regex compatibility shim: leading inline flags (?i)(?s)(?m) -> JS flags.
// RegExp.test == Python re.search semantics (unanchored).
export function compileRegex(pattern: string, extraFlags = ""): RegExp {
  let p = pattern;
  let flags = extraFlags;
  const m = /^\(\?([aimsx]+)\)/.exec(p);
  if (m) {
    p = p.slice(m[0].length);
    for (const f of m[1] ?? "") if ("ims".includes(f) && !flags.includes(f)) flags += f;
  }
  return new RegExp(p, flags);
}
