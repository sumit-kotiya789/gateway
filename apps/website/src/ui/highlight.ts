// Tiny syntax highlighter for the code samples on this site (no dependency, no HTML strings: returns tokens that
// React renders as spans). Good enough for short, well-formed snippets; not a parser.

export type Lang = 'bash' | 'js' | 'json' | 'python' | 'go' | 'php' | 'http' | 'html' | 'text';

/** Token kinds: '' plain, c comment, s string, n number, k keyword, f function, p key/property, a member, y type, v variable/flag, m method. */
export interface Token { k: string; v: string }

const KEYWORDS: Partial<Record<Lang, ReadonlySet<string>>> = {
  js: new Set(['import', 'from', 'export', 'const', 'let', 'var', 'function', 'return', 'if', 'else', 'await', 'async', 'new', 'throw', 'try', 'catch', 'for', 'of', 'in', 'typeof', 'true', 'false', 'null', 'undefined', 'class', 'extends', 'interface', 'type', 'default']),
  html: new Set(['const', 'function', 'return', 'if', 'true', 'false', 'null', 'new', 'await', 'async']),
  python: new Set(['def', 'return', 'import', 'from', 'if', 'else', 'elif', 'not', 'and', 'or', 'in', 'for', 'True', 'False', 'None', 'lambda', 'with', 'as', 'bytes', 'str', 'int', 'bool']),
  go: new Set(['func', 'return', 'if', 'for', 'range', 'var', 'switch', 'case', 'continue', 'package', 'import', 'nil', 'true', 'false', 'string', 'bool', 'byte', 'int64', 'err', 'ok']),
  php: new Set(['function', 'return', 'if', 'foreach', 'as', 'true', 'false', 'null', 'string', 'int', 'bool', 'array', 'abs', 'time']),
  json: new Set(['true', 'false', 'null']),
  bash: new Set(['curl', 'export', 'npm', 'pnpm', 'docker']),
};

const S = {
  lineComment: /\/\/[^\n]*/.source,
  blockComment: /\/\*[\s\S]*?\*\//.source,
  hashComment: /#[^\n]*/.source,
  htmlComment: /<!--[\s\S]*?-->/.source,
  string: /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/.source,
  number: /\b\d[\d_]*(?:\.\d+)?\b/.source,
  flag: /(?<=\s)--?[A-Za-z][\w-]*/.source,
  variable: /\$[A-Za-z_][\w]*/.source,
  tag: /<\/?[A-Za-z][\w-]*|\/?>/.source,
  word: /[A-Za-z_$][\w$]*/.source,
};

function ruleFor(lang: Lang): RegExp {
  const parts: string[] = [];
  const comment: string[] = [];
  if (lang === 'python' || lang === 'bash') comment.push(S.hashComment);
  if (lang === 'js' || lang === 'go' || lang === 'php' || lang === 'html') comment.push(S.lineComment, S.blockComment);
  if (lang === 'html') comment.unshift(S.htmlComment);
  if (comment.length > 0) parts.push(`(?<c>${comment.join('|')})`);
  parts.push(`(?<s>${S.string})`);
  if (lang === 'html') parts.push(`(?<t>${S.tag})`);
  if (lang === 'bash') parts.push(`(?<v>${S.flag}|${S.variable})`);
  if (lang === 'php') parts.push(`(?<v>${S.variable})`);
  parts.push(`(?<n>${S.number})`);
  parts.push(`(?<w>${S.word})`);
  return new RegExp(parts.join('|'), 'g');
}

const RULES = new Map<Lang, RegExp>();

export function highlight(code: string, lang: Lang): Token[] {
  if (lang === 'text') return [{ k: '', v: code }];
  if (lang === 'http') return highlightHttp(code);
  let rule = RULES.get(lang);
  if (!rule) {
    rule = ruleFor(lang);
    RULES.set(lang, rule);
  }
  const kw = KEYWORDS[lang];
  const out: Token[] = [];
  const push = (k: string, v: string) => {
    if (!v) return;
    const last = out[out.length - 1];
    if (last && last.k === k) last.v += v;
    else out.push({ k, v });
  };
  let i = 0;
  for (const m of code.matchAll(rule)) {
    const at = m.index;
    push('', code.slice(i, at));
    const v = m[0];
    const g = m.groups ?? {};
    const after = code.slice(at + v.length);
    const before = code.slice(0, at);
    if (g.c !== undefined) push('c', v);
    else if (g.s !== undefined) push(lang === 'json' && /^\s*:/.test(after) ? 'p' : 's', v);
    else if (g.t !== undefined) push('k', v);
    else if (g.v !== undefined) push('v', v);
    else if (g.n !== undefined) push('n', v);
    else if (kw?.has(v)) push('k', v);
    else if (/^\s*\(/.test(after)) push('f', v);
    else if (before.endsWith('.')) push('a', v);
    else if (lang === 'html' && /^=/.test(after)) push('p', v);
    else if (/^[A-Z][a-z]/.test(v)) push('y', v);
    else if (lang === 'js' && /^\s*:/.test(after) && /[{,]\s*$/.test(before)) push('p', v);
    else push('', v);
    i = at + v.length;
  }
  push('', code.slice(i));
  return out;
}

function highlightHttp(code: string): Token[] {
  const split = code.indexOf('\n\n');
  const head = split === -1 ? code : code.slice(0, split);
  const body = split === -1 ? '' : code.slice(split);
  const out: Token[] = [];
  head.split('\n').forEach((line, idx) => {
    if (idx > 0) out.push({ k: '', v: '\n' });
    if (idx === 0) {
      const sp = line.indexOf(' ');
      out.push({ k: 'm', v: sp === -1 ? line : line.slice(0, sp) });
      if (sp !== -1) out.push({ k: 's', v: line.slice(sp) });
      return;
    }
    const colon = line.indexOf(':');
    if (colon === -1) out.push({ k: '', v: line });
    else out.push({ k: 'p', v: line.slice(0, colon) }, { k: '', v: line.slice(colon) });
  });
  if (body) out.push(...highlight(body, 'json'));
  return out;
}
