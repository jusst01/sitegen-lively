// A faster drop-in for makefun-site 1.0.0. run(input) returns that program's output tree, byte for byte.
//
// Model first: the site description is parsed once into a model (sources with their front matter, slugs, rendered
// Markdown, collections and tags), and every template is compiled, once per build, into a generated JavaScript function
// whose body the compiler writes out (text as literals, values as expressions, loops as loops, includes inlined at the
// point they are used, since an include renders in the same scope). Rendering a page then runs that function; nothing
// is interpreted or re-scanned per page.

/* ---------------------------------------------------------------- text (README, "Text") */

/** The five characters escapeHtml writes, and how it writes them. */
const ESCAPE_RE = /[&<>"']/g;
const escapeRepl = (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;');

/**
 * `text` with & < > " and ' escaped. Most text holds none of them, and five indexOf probes (which run in V8's own
 * compiled scanner) cost less than the regexp machinery or a JavaScript character loop.
 */
function escapeHtml(text) {
  if (text.indexOf('&') === -1 && text.indexOf('<') === -1 && text.indexOf('>') === -1 && text.indexOf('"') === -1 && text.indexOf("'") === -1) return text;
  return text.replace(ESCAPE_RE, escapeRepl);
}

/** One character (by code) as escapeHtml writes it. */
function escapeCode(c) {
  if (c === 38) return '&amp;';
  if (c === 60) return '&lt;';
  if (c === 62) return '&gt;';
  if (c === 34) return '&quot;';
  if (c === 39) return '&#39;';
  return String.fromCharCode(c);
}

const SLUG_MAX = 64;
const slugCache = new Map();
const NON_ASCII = /[^\x00-\x7f]/;

/** The slug of `text` (README, "Text"); memoised, since titles and tag names repeat. */
export function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  // NFKD and the mark strip are the identity on ASCII, which is nearly every title: skip the ICU work for them.
  const plain = NON_ASCII.test(text) ? text.normalize('NFKD').replace(/\p{M}/gu, '') : text;
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = null;
    if (c >= 65 && c <= 90) keep = String.fromCharCode(c + 32);
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = String.fromCharCode(c);
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  const slug = out === '' ? 'untitled' : out;
  slugCache.set(text, slug);
  return slug;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dateCache = new Map();

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const hit = dateCache.get(date);
  if (hit !== undefined) return hit;
  const [y, m, d] = date.split('-');
  const s = `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
  dateCache.set(date, s);
  return s;
}

/** The words of a body: its runs of characters other than whitespace (/\S+/ counted, no array built). */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    // /\s/ exactly: tab-LF-VT-FF-CR, space, NBSP, OGHAM, EN QUAD..HAIR SPACE, LS, PS, NNBSP, MMSP, IDEOGRAPHIC, BOM.
    if (c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff) {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/* ---------------------------------------------------------------- front matter (README, "Front matter") */

const KEYS = Object.freeze(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error }. The text's line ends are "\n". The body is sliced
 * out of the original text, never rebuilt line by line.
 */
function parseFrontMatter(text) {
  const n = text.length;
  const first = text.indexOf('\n');
  const head = first === -1 ? text : text.slice(0, first);
  if (head !== '---') return { error: 'no front matter' };
  // Find the next line that is exactly "---", by scanning line starts.
  let closeStart = -1;
  let closeEnd = -1;
  let pos = first + 1;
  while (pos <= n) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? n : nl;
    if (end - pos === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      closeStart = pos;
      closeEnd = end;
      break;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let lineStart = first + 1;
  let lineNo = 1;
  while (lineStart < closeStart) {
    const nl = text.indexOf('\n', lineStart);
    const lineEnd = nl === -1 ? n : nl;
    lineNo++;
    const line = text.slice(lineStart, lineEnd);
    lineStart = lineEnd + 1;
    let blank = true;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) {
        blank = false;
        break;
      }
    }
    if (blank || line.charCodeAt(0) === 35) continue;
    const m = LINE.exec(line);
    if (!m) return { error: `line ${lineNo} is not "key: value"` };
    const key = m[1];
    let raw = m[2] ?? '';
    // trailing spaces and tabs dropped
    let e = raw.length;
    while (e > 0) {
      const c = raw.charCodeAt(e - 1);
      if (c === 32 || c === 9) e--;
      else break;
    }
    if (e !== raw.length) raw = raw.slice(0, e);
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  // lines.slice(close + 1).join('\n'): everything after the closing line's newline.
  const body = closeEnd >= n ? '' : text.slice(closeEnd + 1);
  return { data, body };
}

/* ---------------------------------------------------------------- Markdown (README, "Markdown") */

const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const QUOTE = /^>/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;

/** A heading line's level and text, or null. */
function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph. */
function endsParagraph(line) {
  return BLANK.test(line) || FENCE_OPEN.test(line) || headingOf(line) !== null || HR.test(line);
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c === 32 || c === 9) a++;
    else break;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c === 32 || c === 9) b--;
    else break;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether a line is blank (spaces and tabs only) — the test the block loop makes of every line it meets. */
function isBlank(line) {
  for (let k = 0; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s block tokens, in order. A line's first character narrows which of the priced regexes it can match. */
function lex(src) {
  const lines = src.split('\n');
  const tokens = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const f = line.charCodeAt(0);
    if (f === 96) {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        const body = [];
        i++;
        while (i < lines.length && !FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
        i++;
        tokens.push({ type: 'code', lang: fence[1], lines: body });
        continue;
      }
    } else if (f === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        tokens.push({ type: 'heading', depth: heading.depth, text: heading.text });
        i++;
        continue;
      }
    } else if ((f === 45 || f === 42) && HR.test(line)) {
      tokens.push({ type: 'hr' });
      i++;
      continue;
    }
    if (f === 62) {
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(lines[i++].replace(/^> ?/, ''));
      tokens.push({ type: 'blockquote', lines: body.map(trimLine).filter((l) => l !== '') });
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = bullet === null ? ORDERED.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED : BULLET;
      const items = [];
      while (i < lines.length) {
        const m = marker.exec(lines[i]);
        if (m !== null) {
          items.push([trimLine(isOrdered ? m[2] : m[1])]);
          i++;
        } else if (CONTINUED.test(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      tokens.push({ type: 'list', ordered: isOrdered, start: isOrdered ? Number(ordered[1]) : 1, items: items.map((parts) => parts.join('\n')) });
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    tokens.push({ type: 'paragraph', text: body.join('\n') });
  }
  return tokens;
}

const ESCAPABLE = new Uint8Array(128);
for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) ESCAPABLE[ch.charCodeAt(0)] = 1;
const isEscapable = (c) => c < 128 && ESCAPABLE[c] === 1;

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const n = s.length;
  const m = what.length;
  for (let j = from; j <= n - m; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from`, outside an escape, or -1. */
function findSingleStar(s, from) {
  const n = s.length;
  for (let j = from; j < n; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** The characters that open an inline construct; V8's own scanner finds them faster than a char loop. */
const MARKER_RE = /[\\`*[]/g;
/**
 * Plain-run delimiters: every inline marker plus every character escapeHtml would escape. A run between two of these
 * holds neither, so it is copied out untouched — the one scan does the work of the marker search and the escape probe.
 */
const RUN_RE = /[\\`*[&<>"']/g;
/** A link target holding whitespace is no link. */
const WS_RE = /\s/;

/** `s` rendered inline; `env.link(target)` is a link's href. Built into an array and joined once. */
function inline(s, env) {
  // Most text carries no inline marker at all: escape it and be done, with no array.
  MARKER_RE.lastIndex = 0;
  if (MARKER_RE.exec(s) === null) return escapeHtml(s);
  const parts = [];
  let i = 0;
  const n = s.length;
  // The end of the plain run starting at `i`: the next character that is either an inline marker or one escapeHtml
  // would rewrite. Everything before it is copied out verbatim.
  const runEnd = (from) => {
    RUN_RE.lastIndex = from;
    const r = RUN_RE.exec(s);
    return r === null ? n : r.index;
  };
  while (i < n) {
    const j = runEnd(i);
    if (j > i) {
      parts.push(s.slice(i, j));
      i = j;
      if (i >= n) break;
    }
    const c = s.charCodeAt(i);
    if (c === 92) {
      if (i + 1 < n && isEscapable(s.charCodeAt(i + 1))) {
        parts.push(escapeCode(s.charCodeAt(i + 1)));
        i += 2;
      } else {
        parts.push('\\');
        i++;
      }
      continue;
    }
    if (c === 96) {
      const close = s.indexOf('`', i + 1);
      if (close > i + 1) {
        parts.push('<code>', escapeHtml(s.slice(i + 1, close)), '</code>');
        i = close + 1;
      } else {
        parts.push('`');
        i++;
      }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const close = findUnescaped(s, '**', i + 2);
        if (close > i + 2) {
          parts.push('<strong>', inline(s.slice(i + 2, close), env), '</strong>');
          i = close + 2;
        } else {
          parts.push('**');
          i += 2;
        }
        continue;
      }
      const close = findSingleStar(s, i + 1);
      if (close > i + 1) {
        parts.push('<em>', inline(s.slice(i + 1, close), env), '</em>');
        i = close + 1;
      } else {
        parts.push('*');
        i++;
      }
      continue;
    }
    if (c === 91) {
      // A link: [text](target). The text and the target are read from where the `[` sits.
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !WS_RE.test(target)) {
        parts.push('<a href="', escapeHtml(env.link(target)), '">', inline(s.slice(i + 1, k), env), '</a>');
        i = m + 1;
        continue;
      }
      parts.push('[');
      i++;
      continue;
    }
    // An escapable: a run of one, so the replace of a one-character string is the escape itself.
    parts.push(escapeCode(c));
    i++;
  }
  return parts.length === 0 ? '' : parts.length === 1 ? parts[0] : parts.join('');
}

/**
 * `src` rendered: its HTML, its table of contents and its excerpt. The blocks are collected and joined once, which
 * allocates far less than growing one string a block at a time.
 */
function renderMarkdown(src, env) {
  const ids = new Set();
  const toc = [];
  let excerpt = null;
  const parts = [];
  for (const t of lex(src)) {
    switch (t.type) {
      case 'heading': {
        const id = uniqueSlug(slugify(t.text), ids);
        const inner = inline(t.text, env);
        parts.push(`<h${t.depth} id="${id}">${inner}</h${t.depth}>\n`);
        if (t.depth === 2 || t.depth === 3) toc.push({ level: t.depth, id, html: inner });
        break;
      }
      case 'code': {
        const cls = t.lang === '' ? '' : ` class="language-${escapeHtml(t.lang)}"`;
        let s = `<pre><code${cls}>`;
        for (const l of t.lines) s += `${escapeHtml(l)}\n`;
        parts.push(s + '</code></pre>\n');
        break;
      }
      case 'hr':
        parts.push('<hr>\n');
        break;
      case 'blockquote':
        parts.push(t.lines.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(t.lines.join('\n'), env)}</p>\n</blockquote>\n`);
        break;
      case 'list': {
        const tag = t.ordered ? 'ol' : 'ul';
        const open = t.ordered && t.start !== 1 ? `<ol start="${t.start}">` : `<${tag}>`;
        let s = `${open}\n`;
        for (const item of t.items) s += `<li>${inline(item, env)}</li>\n`;
        parts.push(s + `</${tag}>\n`);
        break;
      }
      case 'paragraph': {
        const inner = inline(t.text, env);
        if (excerpt === null) excerpt = inner;
        parts.push(`<p>${inner}</p>\n`);
        break;
      }
    }
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}

/* ---------------------------------------------------------------- templates (README, "Templates") */

const INCLUDE_DEPTH = 8;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/* ---- the value helpers the compiled functions use (the template dialect's own semantics) */

/** The own property `k` of `o`, or undefined (never an inherited one, never a throw). */
function own(o, k) {
  return o !== null && typeof o === 'object' && Object.hasOwn(o, k) ? o[k] : undefined;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let i = 0; i < v.length; i++) out += (i === 0 ? '' : ', ') + textOf(v[i]);
    return out;
  }
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

const HELPERS = Object.freeze([escapeHtml, own, textOf, truthy]);

/* ---- the interpreter: only used for a template whose include graph cannot be inlined */

function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function renderNodesSlow(nodes, scope, templates, depth) {
  let out = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out += n.text;
        break;
      case 'var':
        out += escapeHtml(textOf(lookup(scope, n.path)));
        break;
      case 'raw':
        out += textOf(lookup(scope, n.path));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodesSlow(branch, scope, templates, depth);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          out += renderNodesSlow(n.body, { vars, parent: scope }, templates, depth);
        }
        break;
      }
      case 'include': {
        const t = templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) out += renderNodesSlow(t, scope, templates, depth + 1);
        break;
      }
    }
  }
  return out;
}

/* ---- the compiler: template AST -> one generated function */

/** Names a loop element's subtree may read and still be a pure function of the element (and the shared values). */
const SHARED = new Set(['site', 'tags', 'recent']);

/**
 * Whether `node`, inside a loop over `elem`, renders the same text for the same element every time: it reads nothing
 * but `elem` (and names bound inside it), the shared values, and the `loop` of a loop nested inside it. Such a body is
 * rendered once per distinct element value and reused — the same post's card appears on the index and every tag page.
 */
function elementPure(node, elem, templates, depth, bound) {
  switch (node.kind) {
    case 'text':
      return true;
    case 'var':
    case 'raw':
      return node.path[0] === elem || SHARED.has(node.path[0]) || bound.has(node.path[0]);
    case 'if':
      if (node.path[0] !== elem && !SHARED.has(node.path[0]) && !bound.has(node.path[0])) return false;
      return node.then.every((n) => elementPure(n, elem, templates, depth, bound)) &&
        (node.else === null || node.else.every((n) => elementPure(n, elem, templates, depth, bound)));
    case 'for': {
      if (node.path[0] !== elem && !SHARED.has(node.path[0]) && !bound.has(node.path[0])) return false;
      const inner = new Set(bound);
      inner.add(node.name);
      inner.add('loop');
      return node.body.every((n) => elementPure(n, elem, templates, depth, inner));
    }
    case 'include': {
      if (depth >= INCLUDE_DEPTH) return true;
      const t = templates.get(node.name);
      return t === undefined ? true : t.every((n) => elementPure(n, elem, templates, depth + 1, bound));
    }
  }
  return false;
}

/** Whether `node` reads the name `name` anywhere, includes followed (within the depth). */
function readsName(node, name, templates, depth) {
  switch (node.kind) {
    case 'text':
      return false;
    case 'var':
    case 'raw':
      return node.path[0] === name;
    case 'if':
      return node.path[0] === name || node.then.some((n) => readsName(n, name, templates, depth)) ||
        (node.else !== null && node.else.some((n) => readsName(n, name, templates, depth)));
    case 'for':
      return node.path[0] === name || node.body.some((n) => readsName(n, name, templates, depth));
    case 'include': {
      if (depth >= INCLUDE_DEPTH) return false;
      const t = templates.get(node.name);
      return t !== undefined && t.some((n) => readsName(n, name, templates, depth + 1));
    }
  }
  return false;
}

class BudgetError extends Error {}

const MAX_EMITTED = 60000;
/** The names a template's values come from that change from page to page; a subtree free of them can be folded. */
const DYNAMIC = new Set(['page', 'posts', 'pager', 'tag']);

/**
 * Whether `node`'s output can depend on nothing but the shared values (site, tags, recent). Loop-bound names are never
 * static, and an include is static only when it is in the graph and within the depth, and names nothing dynamic.
 */
function isStatic(node, templates, depth, bound) {
  switch (node.kind) {
    case 'text':
      return true;
    case 'var':
    case 'raw':
      if (bound.has(node.path[0]) || DYNAMIC.has(node.path[0])) return false;
      return true;
    case 'if':
      if (bound.has(node.path[0]) || DYNAMIC.has(node.path[0])) return false;
      return node.then.every((n) => isStatic(n, templates, depth, bound)) &&
        (node.else === null || node.else.every((n) => isStatic(n, templates, depth, bound)));
    case 'for': {
      if (bound.has(node.path[0]) || DYNAMIC.has(node.path[0])) return false;
      const inner = new Set(bound);
      inner.add(node.name);
      inner.add('loop');
      return node.body.every((n) => isStatic(n, templates, depth, inner));
    }
    case 'include': {
      if (depth >= INCLUDE_DEPTH) return true; // renders nothing
      const t = templates.get(node.name);
      return t === undefined ? true : t.every((n) => isStatic(n, templates, depth + 1, bound));
    }
  }
  return false;
}

/**
 * Compile a parsed template into `function (site, tags, recent, vars) -> string`, includes inlined at the point they
 * are used (an include renders in the caller's scope, so its nodes are simply compiled there), loops as real loops and
 * paths as own-property reads from either the enclosing loop's local or the root vars. A subtree that reads none of the
 * page-specific names is rendered once, at compile time, and spliced in as a literal.
 */
function compileTemplate(nodes, templates, site, tags, recent, memoCaches) {
  // Fold a static subtree by rendering it in a scope of only the shared values.
  const rootScope = { site, tags, recent };
  const fold = (node) => {
    try {
      return renderNodesSlow([node], { vars: rootScope, parent: null }, templates, 0);
    } catch {
      return null;
    }
  };

  const lines = [];
  const locals = [];
  const caches = [];
  let counter = 0;
  let emitted = 0;

  const expr = (path) => {
    let base = null;
    let nullable = false;
    for (let i = locals.length - 1; i >= 0; i--) {
      if (locals[i].name === path[0]) {
        base = locals[i].js;
        break;
      }
    }
    let e;
    // The roots other than site/tags/recent are the values that can be absent (a page layout run for the index has no
    // `tag`, a page has no `pager`), so a read of a key off one is guarded: it yields undefined exactly as the
    // dialect's own-property lookup does, rather than throwing. Loop locals always hold an element of an array this
    // build made, so they are read plainly.
    if (base !== null) e = base;
    else if (path[0] === 'site') e = '$site';
    else if (path[0] === 'tags') e = '$tags';
    else if (path[0] === 'recent') e = '$recent';
    else if (path[0] === 'page') { e = '$page'; nullable = true; }
    else if (path[0] === 'posts') { e = '$posts'; nullable = true; }
    else if (path[0] === 'pager') { e = '$pager'; nullable = true; }
    else if (path[0] === 'tag') { e = '$tag'; nullable = true; }
    else e = 'undefined';
    // Every value a template reads is an object this build made from literals, so a read of a name it holds is a plain
    // property read. The roots (`page`, `posts`, `pager`, `tag`) are the only values that can be absent, and a post's
    // newer/older neighbours are null at either end, so a guard sits where the lookup would otherwise throw, and it
    // yields undefined exactly as the dialect's own-property lookup does.
    for (let k = 1; k < path.length; k++) {
      const key = path[k];
      e = nullable ? `(${e}==null?undefined:${e}.${key})` : `${e}.${key}`;
      nullable = key === 'newer' || key === 'older';
    }
    return e;
  };

  const walk = (list, depth, bound, acc = 'out') => {
    for (const n of list) {
      if (++emitted > MAX_EMITTED) throw new BudgetError();
      if (n.kind !== 'text' && isStatic(n, templates, depth, bound)) {
        const text = fold(n);
        if (text !== null) {
          if (text !== '') lines.push(acc + '+=' + JSON.stringify(text) + ';');
          continue;
        }
      }
      switch (n.kind) {
        case 'text':
          lines.push(acc + '+=' + JSON.stringify(n.text) + ';');
          break;
        case 'var':
          lines.push(acc + '+=$esc($text(' + expr(n.path) + '));');
          break;
        case 'raw':
          lines.push(acc + '+=$text(' + expr(n.path) + ');');
          break;
        case 'if': {
          lines.push('if($truthy(' + expr(n.path) + ')!==' + (n.not ? 'true' : 'false') + '){');
          walk(n.then, depth, bound, acc);
          lines.push('}');
          if (n.else !== null) {
            lines.push('else{');
            walk(n.else, depth, bound, acc);
            lines.push('}');
          }
          break;
        }
        case 'for': {
          const id = ++counter;
          const xs = '$xs' + id;
          const k = '$k' + id;
          const v = '$v' + id;
          const lp = '$lp' + id;
          lines.push('var ' + xs + '=' + expr(n.path) + ';');
          lines.push('if(Array.isArray(' + xs + ')){for(var ' + k + '=0;' + k + '<' + xs + '.length;' + k + '++){');
          lines.push('var ' + v + '=' + xs + '[' + k + '];');
          lines.push('var ' + lp + '={index:' + k + '+1,first:' + k + '===0,last:' + k + '===' + xs + '.length-1,length:' + xs + '.length};');
          const mark = locals.length;
          locals.push({ name: n.name, js: v }, { name: 'loop', js: lp });
          const inner = new Set(bound);
          inner.add(n.name);
          inner.add('loop');
          const memo = n.body.length > 0 && n.body.every((m) => elementPure(m, n.name, templates, depth, new Set())) &&
            n.body.some((m) => readsName(m, n.name, templates, depth));
          if (memo) {
            // The body renders the same for the same element (it reads nothing but the element and the shared values),
            // so it is rendered once per distinct element and reused: a post's card is built once and appears again,
            // unchanged, on every page that lists it. The cache lives on the build, so it spans templates too.
            const slot = memoCaches.length;
            memoCaches.push(new Map());
            caches.push(slot);
            const cache = '$mc' + slot;
            const hit = '$mh' + id;
            lines.push('var ' + hit + '=' + cache + '.get(' + v + ');');
            lines.push('if(' + hit + '===undefined){');
            lines.push('var $mb' + id + '="";');
            walk(n.body, depth, inner, '$mb' + id);
            lines.push(cache + '.set(' + v + ', $mb' + id + ');' + hit + '=$mb' + id + ';}');
            lines.push(acc + '+=' + hit + ';');
          } else {
            walk(n.body, depth, inner, acc);
          }
          locals.length = mark;
          lines.push('}}');
          break;
        }
        case 'include': {
          if (depth >= INCLUDE_DEPTH) break;
          const t = templates.get(n.name);
          if (t !== undefined) walk(t, depth + 1, bound, acc);
          break;
        }
      }
    }
  };

  walk(nodes, 0, new Set());
  // The memo caches outlive the compiled function (they are the build's), so a card rendered for the index is reused on
  // every tag page. The helper tuple is per compile, so the generated code captures nothing from the build object.
  const body = 'var $esc=$H[0],$own=$H[1],$text=$H[2],$truthy=$H[3];var out="";' +
    (caches.length > 0 ? 'var ' + caches.map((slot) => '$mc' + slot + '=$H[4][' + slot + ']').join(',') + ';' : '') +
    lines.join('') + 'return out;';
  const helper = [HELPERS[0], HELPERS[1], HELPERS[2], HELPERS[3], memoCaches];
  return new Function('$H', 'return function($site,$tags,$recent,$page,$posts,$pager,$tag){' + body + '}')(helper);
}

/* ---------------------------------------------------------------- the build */

const RESERVED = Object.freeze(['posts', 'tags', 'page']);

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** A page's link record as templates read it. */
function linkOf(s) {
  if (s === null) return null;
  return { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
}

/** A post's card, as lists show it. A page's card is the same object, so it is built once per source. */
function cardOf(s) {
  if (s.card !== undefined) return s.card;
  const card = {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
  s.card = card;
  return card;
}

/** A page as its layout reads it. */
function pageOf(s) {
  const card = cardOf(s);
  return {
    title: card.title,
    url: card.url,
    date: card.date,
    date_long: card.date_long,
    summary: card.summary,
    excerpt: card.excerpt,
    reading_minutes: card.reading_minutes,
    tags: card.tags,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const base = input.site.base_url.replace(/\/+$/, '');
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  // The compiled-function cache, keyed by template name (each build has one set of templates). Compiling needs the
  // shared values (site, tags, recent) so that the footers, headers and navs they alone feed fold to literals.
  const compiled = new Map();
  // Memo caches for element-pure loop bodies, one per such loop site, shared across the templates of this build: a
  // post's card rendered on the index is reused on every tag page that lists it.
  const memoCaches = [];
  let site = undefined;
  let allTags = undefined;
  let recent = undefined;
  const getCompiled = (name) => {
    let f = compiled.get(name);
    if (f !== undefined) return f;
    const nodes = templates.get(name);
    if (nodes === undefined) {
      compiled.set(name, null);
      return null;
    }
    try {
      f = compileTemplate(nodes, templates, site, allTags, recent, memoCaches);
    } catch (err) {
      if (!(err instanceof BudgetError)) throw err;
      f = null;
    }
    if (f === null) {
      const slow = (site_, tags_, recent_, page, posts, pager, tag) =>
        renderNodesSlow(nodes, { vars: { site: site_, tags: tags_, recent: recent_, page, posts, pager, tag }, parent: null }, templates, 0);
      f = slow;
    }
    compiled.set(name, f);
    return f;
  };

  // 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const content = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text: content });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let ownDir;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) {
        ownDir = d;
        break;
      }
    }
    if (ownDir !== undefined) {
      report.push(`refused ${s.path}: ${ownDir}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources.length = 0;

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/;
  for (const s of kept) {
    const dir = dirOf(s.path);
    const cache = new Map();
    const env = {
      link: (target) => {
        const hit = cache.get(target);
        if (hit !== undefined) return hit;
        let out;
        if (scheme.test(target) || target.startsWith('/') || target.startsWith('#')) out = target;
        else {
          const hash = target.indexOf('#');
          const rel = hash === -1 ? target : target.slice(0, hash);
          const frag = hash === -1 ? '' : target.slice(hash);
          const path = rel === '' ? null : resolvePath(dir, rel);
          if (path !== null && bySource.has(path)) out = `${bySource.get(path).url}${frag}`;
          else if (path !== null && staticPaths.has(path)) out = `${base}/${path}${frag}`;
          else {
            broken.add(`broken-link ${s.path} -> ${target}`);
            out = target;
          }
        }
        cache.set(target, out);
        return out;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. The tags: grouped by their slug, each named as first met in the posts' order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  site = { title: input.site.title, base_url: base };
  allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const f = getCompiled(name);
    if (f === null) return null;
    return f(site, allTags, recent, vars.page, vars.posts, vars.pager, vars.tag);
  };

  const output = Object.create(null);
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;

  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
