// A fast, dependency-free rebuild of makefun-site 1.0.0's build, written
// from the specification and the reference behaviour.
//
// The output must match the reference byte for byte on every input the
// generator can draw: same front matter, same Markdown subset, same template
// dialect, same slug rule, same report. The speed comes from single-pass
// work with no throwaway objects: bodies are scanned in place rather than
// split into lines, blocks render straight into one shared output array,
// templates render into that same array, and slugs are memoised. The build
// reads no clock, no environment and no randomness.

const CMP = (x, y) => (x < y ? -1 : x > y ? 1 : 0);

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const INLINE_RE = /[\\`*[&<>"']/g;
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const HAS_WS_RE = /\s/;
const COMBINING_RE = /\p{M}/gu;

// The characters a backslash can escape in inline text.
const ESCAPABLE = new Set([
  '\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>',
]);

// The keys a source's front matter may carry.
const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** `text` with &, <, >, " and ' escaped; the same string back when it holds none. */
function esc(text) {
  ESC_RE.lastIndex = 0;
  let built = '';
  let cut = 0;
  let hit;
  while ((hit = ESC_RE.exec(text)) !== null) {
    built += text.slice(cut, hit.index) + ESCAPES[hit[0]];
    cut = hit.index + 1;
  }
  if (cut === 0) return text;
  return built + text.slice(cut);
}

// ------------------------------------------------------------ slugs and dates

const slugCache = new Map();

/** The slug of `text`, memoised: NFKD, combining marks dropped, each run of other characters one "-". */
function slugOf(text) {
  const cached = slugCache.get(text);
  if (cached !== undefined) return cached;
  const decomposed = text.normalize('NFKD').replace(COMBINING_RE, '');
  let out = '';
  let pendingDash = false;
  for (const ch of decomposed) {
    let letter = null;
    if (ch >= 'A' && ch <= 'Z') letter = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) letter = ch;
    if (letter === null) {
      pendingDash = out.length > 0;
      continue;
    }
    if (pendingDash) out += '-';
    pendingDash = false;
    out += letter;
  }
  out = out.slice(0, 64);
  let end = out.length;
  while (end > 0 && out[end - 1] === '-') end--;
  out = out.slice(0, end);
  if (out === '') out = 'untitled';
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and recorded there): slug, slug-2, slug-3, ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let k = 2; taken.has(out); k++) out = slug + '-' + k;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, read from the string alone. */
function longDateOf(date) {
  const year = date.slice(0, 4);
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  return day + ' ' + MONTHS[month - 1] + ' ' + year;
}

// ------------------------------------------------------------ small text scans

/** Whether every character of `s` from `a` to `b` is a space or a tab. */
function onlySpaceTab(s, a, b) {
  for (let i = a; i < b; i++) {
    const ch = s[i];
    if (ch !== ' ' && ch !== '\t') return false;
  }
  return true;
}

/** The slice `s[a..b)` with spaces and tabs trimmed off both ends. */
function trimSlice(s, a, b) {
  while (a < b && (s[a] === ' ' || s[a] === '\t')) a++;
  while (b > a && (s[b - 1] === ' ' || s[b - 1] === '\t')) b--;
  return s.slice(a, b);
}

function isDigit(c) {
  return '0' <= c && c <= '9';
}

/** `rel` resolved against directory `dir`, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const stack = dir === '' ? [] : dir.split('/');
  for (const piece of rel.split('/')) {
    if (piece === '' || piece === '.') continue;
    if (piece === '..') {
      if (stack.length === 0) return null;
      stack.pop();
    } else stack.push(piece);
  }
  return stack.join('/');
}

const dirOf = (path) => {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
};

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let ws;
    if (c < 128) ws = c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13;
    else ws = HAS_WS_RE.test(text[i]);
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ------------------------------------------------------------ front matter reading

function daysInMonth(year, month) {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** A quoted or bare string value, or the reason it is refused. */
function stringValue(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) {
      return { error: 'a quoted string is not closed' };
    }
    let decoded = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const ch = raw[i];
      if (ch === '\\') {
        const next = raw[i + 1];
        if ((next !== '"' && next !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        decoded += next;
        i++;
      } else if (ch === '"') {
        return { error: 'a quoted string holds a stray quote' };
      } else decoded += ch;
    }
    return { value: decoded };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function keyValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const parsed = stringValue(raw);
      if ('error' in parsed) return { error: 'key "' + key + '": ' + parsed.error };
      return parsed;
    }
    case 'date': {
      let valid = raw.length === 10 && raw[4] === '-' && raw[7] === '-';
      if (valid) {
        for (let i = 0; i < 10 && valid; i++) {
          if (i !== 4 && i !== 7 && !isDigit(raw[i])) valid = false;
        }
      }
      const year = valid ? Number(raw.slice(0, 4)) : 0;
      const month = valid ? Number(raw.slice(5, 7)) : 0;
      const day = valid ? Number(raw.slice(8, 10)) : 0;
      if (!valid || year < 1970 || year > 2099 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
        return { error: 'key "tags": not a list [a, b]' };
      }
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const tag of tags) {
        if (tag === '' || tag.includes('"') || tag.includes('[') || tag.includes(']')) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      if (raw === 'true') return { value: true };
      if (raw === 'false') return { value: false };
      return { error: 'key "draft": true or false' };
    case 'layout': {
      let valid = raw.length > 0;
      for (let i = 0; i < raw.length && valid; i++) {
        const c = raw[i];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-')) valid = false;
      }
      if (!valid) return { error: 'key "layout": not a template name' };
      return { value: raw };
    }
    case 'slug': {
      let valid = raw.length >= 1 && raw.length <= 64;
      let afterDash = true;
      for (let i = 0; i < raw.length && valid; i++) {
        const c = raw[i];
        const alnum = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
        if (c === '-') {
          if (afterDash) valid = false;
          afterDash = true;
        } else if (alnum) afterDash = false;
        else valid = false;
      }
      if (!valid || afterDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: 'unknown key "' + key + '"' };
  }
}

function isKeyText(key) {
  if (key.length === 0) return false;
  for (let i = 0; i < key.length; i++) {
    const ch = key[i];
    if (!((ch >= 'a' && ch <= 'z') || ch === '_')) return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` already has "\n" line ends.
 */
function parseFront(text) {
  const firstBreak = text.indexOf('\n');
  const first = firstBreak === -1 ? text : text.slice(0, firstBreak);
  if (first !== '---') return { error: 'no front matter' };
  const fmPos = firstBreak === -1 ? text.length : firstBreak + 1;
  let closeAt = -1;
  let contentAt = text.length;
  let cursor = fmPos;
  while (cursor <= text.length) {
    const e = text.indexOf('\n', cursor);
    const lineEnd = e === -1 ? text.length : e;
    if (lineEnd - cursor === 3 && text[cursor] === '-' && text[cursor + 1] === '-' && text[cursor + 2] === '-') {
      closeAt = cursor;
      contentAt = e === -1 ? text.length : e + 1;
      break;
    }
    if (e === -1) break;
    cursor = e + 1;
  }
  if (closeAt === -1) return { error: 'the front matter is not closed' };
  const data = {};
  cursor = fmPos;
  let lineNo = 2;
  while (cursor < closeAt) {
    const e = text.indexOf('\n', cursor);
    const lineEnd = e === -1 ? text.length : e;
    if (!onlySpaceTab(text, cursor, lineEnd) && text[cursor] !== '#') {
      const colon = text.indexOf(':', cursor);
      if (colon === -1 || colon >= lineEnd) return { error: 'line ' + lineNo + ' is not "key: value"' };
      const key = text.slice(cursor, colon);
      if (!isKeyText(key)) return { error: 'line ' + lineNo + ' is not "key: value"' };
      let raw;
      if (colon + 1 === lineEnd) raw = '';
      else if (text[colon + 1] === ' ') {
        let rawEnd = lineEnd;
        while (rawEnd > colon + 2 && (text[rawEnd - 1] === ' ' || text[rawEnd - 1] === '\t')) rawEnd--;
        raw = text.slice(colon + 2, rawEnd);
      } else return { error: 'line ' + lineNo + ' is not "key: value"' };
      if (!FM_KEYS.has(key)) return { error: 'unknown key "' + key + '"' };
      if (Object.hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
      if (raw === '') return { error: 'key "' + key + '" has no value' };
      const parsed = keyValue(key, raw);
      if ('error' in parsed) return parsed;
      data[key] = parsed.value;
    }
    cursor = lineEnd + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(contentAt) };
}

// ------------------------------------------------------------ Markdown rendering

function isLangChar(c) {
  return (
    ('A' <= c && c <= 'Z') ||
    ('a' <= c && c <= 'z') ||
    ('0' <= c && c <= '9') ||
    c === '_' ||
    c === '+' ||
    c === '-'
  );
}

/** The fence language a line opens, "" for a bare fence, or null when it is no fence. */
function fenceOpen(s, a, b) {
  if (b - a < 3 || s[a] !== '`' || s[a + 1] !== '`' || s[a + 2] !== '`') return null;
  let k = a + 3;
  while (k < b && isLangChar(s[k])) k++;
  if (!onlySpaceTab(s, k, b)) return null;
  return s.slice(a + 3, k);
}

function fenceClose(s, a, b) {
  if (b - a < 3) return false;
  if (s[a] !== '`' || s[a + 1] !== '`' || s[a + 2] !== '`') return false;
  return onlySpaceTab(s, a + 3, b);
}

/** A heading line's depth and trimmed text span, or null (its text is never empty). */
function headingOf(s, a, b) {
  let depth = 0;
  while (depth < 6 && a + depth < b && s[a + depth] === '#') depth++;
  if (depth === 0) return null;
  if (a + depth >= b || (s[a + depth] !== ' ' && s[a + depth] !== '\t')) return null;
  let start = a + depth;
  while (start < b && (s[start] === ' ' || s[start] === '\t')) start++;
  let stop = b;
  while (stop > start && (s[stop - 1] === ' ' || s[stop - 1] === '\t')) stop--;
  if (start >= stop) return null;
  return { d: depth, s: start, e: stop };
}

function isHr(s, a, b) {
  if (b - a < 3) return false;
  const dashes = s[a] === '-' && s[a + 1] === '-' && s[a + 2] === '-';
  const stars = s[a] === '*' && s[a + 1] === '*' && s[a + 2] === '*';
  return (dashes || stars) && onlySpaceTab(s, a + 3, b);
}

/** A list item's kind, first number and trimmed text span, or null. */
function listOpen(s, a, b) {
  if (a + 1 < b && (s[a] === '-' || s[a] === '*') && s[a + 1] === ' ') {
    return { ordered: false, start: 1, s: a + 2, e: b };
  }
  let k = a;
  while (k < b && isDigit(s[k])) k++;
  const digits = k - a;
  if (digits >= 1 && digits <= 9 && k + 1 < b && s[k] === '.' && s[k + 1] === ' ') {
    return { ordered: true, start: Number(s.slice(a, k)), s: k + 2, e: b };
  }
  return null;
}

/** Whether a line continues a list item: two or more spaces, then a non-space. */
function isContinued(s, a, b) {
  let k = a;
  while (k < b && s[k] === ' ') k++;
  if (k - a < 2 || k >= b) return false;
  return !HAS_WS_RE.test(s[k]);
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a break. */
function endsParagraph(s, a, b) {
  if (a === b) return true;
  const c0 = s[a];
  if (c0 === ' ' || c0 === '\t') return onlySpaceTab(s, a, b);
  if (c0 === '`') return fenceOpen(s, a, b) !== null;
  if (c0 === '#') return headingOf(s, a, b) !== null;
  if (c0 === '-' || c0 === '*') return isHr(s, a, b);
  return false;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const wanted = what.length;
  for (let k = from; k <= s.length - wanted; k++) {
    if (s[k] === '\\' && k + 1 < s.length && ESCAPABLE.has(s[k + 1])) {
      k++;
      continue;
    }
    if (s.startsWith(what, k)) return k;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let k = from; k < s.length; k++) {
    const ch = s[k];
    if (ch === '\\' && k + 1 < s.length && ESCAPABLE.has(s[k + 1])) {
      k++;
      continue;
    }
    if (ch !== '*') continue;
    if (s[k + 1] === '*') {
      k++;
      continue;
    }
    return k;
  }
  return -1;
}

/** Renders `s` inline into `out`; `link(target)` resolves a link's href. */
function inlineInto(s, link, out) {
  const re = INLINE_RE;
  let i = 0;
  const n = s.length;
  let plain = 0;
  while (true) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (m === null) break;
    const j = m.index;
    const ch = m[0];
    if (ch === '\\' && j + 1 < n && ESCAPABLE.has(s[j + 1])) {
      if (j > plain) out.push(s.slice(plain, j));
      out.push(s[j + 1] === '>' ? '&gt;' : s[j + 1]);
      i = j + 2;
      plain = i;
      continue;
    }
    if (ch === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (j > plain) out.push(s.slice(plain, j));
        out.push('<code>', esc(s.slice(j + 1, k)), '</code>');
        i = k + 1;
        plain = i;
      } else i = j + 1;
      continue;
    }
    if (ch === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          if (j > plain) out.push(s.slice(plain, j));
          out.push('<strong>');
          inlineInto(s.slice(j + 2, k), link, out);
          out.push('</strong>');
          i = k + 2;
          plain = i;
        } else i = j + 2;
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        if (j > plain) out.push(s.slice(plain, j));
        out.push('<em>');
        inlineInto(s.slice(j + 1, k), link, out);
        out.push('</em>');
        i = k + 1;
        plain = i;
      } else i = j + 1;
      continue;
    }
    if (ch === '[') {
      const k = findUnescaped(s, ']', j + 1);
      const m2 = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m2 === -1 ? '' : s.slice(k + 2, m2);
      if (target !== '' && !HAS_WS_RE.test(target)) {
        if (j > plain) out.push(s.slice(plain, j));
        out.push('<a href="', esc(link(target)), '">');
        inlineInto(s.slice(j + 1, k), link, out);
        out.push('</a>');
        i = m2 + 1;
        plain = i;
      } else i = j + 1;
      continue;
    }
    if (ch === '&' || ch === '<' || ch === '>' || ch === '"' || ch === "'") {
      if (j > plain) out.push(s.slice(plain, j));
      out.push(ESCAPES[ch]);
      i = j + 1;
      plain = i;
      continue;
    }
    i = j + 1;
  }
  if (n > plain) out.push(s.slice(plain, n));
}

/**
 * `src` rendered: its HTML (every block on its own lines, a "\n" after the
 * last one), its table of contents (each level 2 and 3 heading) and its
 * excerpt (the first paragraph's inline HTML, or "").
 */
function renderBody(src, link) {
  const out = [];
  const toc = [];
  const seenIds = new Set();
  let excerpt = null;
  const n = src.length;
  let pos = 0;
  const lineEnd = (p) => {
    const found = src.indexOf('\n', p);
    return found === -1 ? n : found;
  };
  const nextLine = (end) => (end < n ? end + 1 : n);
  while (pos < n) {
    const e = lineEnd(pos);
    const nx = nextLine(e);
    const c0 = src[pos];
    if (e === pos || ((c0 === ' ' || c0 === '\t') && onlySpaceTab(src, pos, e))) {
      pos = nx;
      continue;
    }
    if (c0 === '`') {
      const lang = fenceOpen(src, pos, e);
      if (lang !== null) {
        let p = nx;
        const bodyStart = p;
        let bodyEnd = p;
        let count = 0;
        let closed = false;
        while (p < n) {
          const e2 = lineEnd(p);
          if (fenceClose(src, p, e2)) {
            p = nextLine(e2);
            closed = true;
            break;
          }
          bodyEnd = e2;
          count++;
          p = nextLine(e2);
        }
        let inner = count === 0 ? '' : esc(src.slice(bodyStart, bodyEnd)) + '\n';
        if (!closed && src[n - 1] === '\n') inner += '\n';
        out.push(
          '<pre><code' +
            (lang === '' ? '' : ' class="language-' + esc(lang) + '"') +
            '>' +
            inner +
            '</code></pre>\n',
        );
        pos = p;
        continue;
      }
    }
    if (c0 === '#') {
      const hd = headingOf(src, pos, e);
      if (hd !== null) {
        const text = src.slice(hd.s, hd.e);
        const id = uniqueSlug(slugOf(text), seenIds);
        if (hd.d === 2 || hd.d === 3) {
          const hp = [];
          inlineInto(text, link, hp);
          const html = hp.join('');
          out.push('<h' + hd.d + ' id="' + id + '">' + html + '</h' + hd.d + '>\n');
          toc.push({ level: hd.d, id, html });
        } else {
          out.push('<h' + hd.d + ' id="' + id + '">');
          inlineInto(text, link, out);
          out.push('</h' + hd.d + '>\n');
        }
        pos = nx;
        continue;
      }
    }
    if ((c0 === '-' || c0 === '*') && isHr(src, pos, e)) {
      out.push('<hr>\n');
      pos = nx;
      continue;
    }
    if (src[pos] === '>') {
      const quoted = [];
      let cursor = pos;
      while (cursor < n) {
        const lineStop = lineEnd(cursor);
        if (src[cursor] !== '>') break;
        let content = cursor + 1;
        if (src[content] === ' ') content++;
        const line = trimSlice(src, content, lineStop);
        if (line !== '') quoted.push(line);
        cursor = nextLine(lineStop);
      }
      if (quoted.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        out.push('<blockquote>\n<p>');
        inlineInto(quoted.length === 1 ? quoted[0] : quoted.join('\n'), link, out);
        out.push('</p>\n</blockquote>\n');
      }
      pos = cursor;
      continue;
    }
    const first =
      c0 === '-' || c0 === '*' || (c0 >= '0' && c0 <= '9') ? listOpen(src, pos, e) : null;
    if (first !== null) {
      const ordered = first.ordered;
      const items = [];
      let current = [trimSlice(src, first.s, first.e)];
      items.push(current);
      let cursor = nx;
      while (cursor < n) {
        const lineStop = lineEnd(cursor);
        const found = listOpen(src, cursor, lineStop);
        if (found !== null && found.ordered === ordered) {
          current = [trimSlice(src, found.s, found.e)];
          items.push(current);
          cursor = nextLine(lineStop);
        } else if (isContinued(src, cursor, lineStop)) {
          current.push(trimSlice(src, cursor, lineStop));
          cursor = nextLine(lineStop);
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && first.start !== 1 ? '<ol start="' + first.start + '">' : '<' + tag + '>';
      out.push(open + '\n');
      for (const parts of items) {
        out.push('<li>');
        inlineInto(parts.length === 1 ? parts[0] : parts.join('\n'), link, out);
        out.push('</li>\n');
      }
      out.push('</' + tag + '>\n');
      pos = cursor;
      continue;
    }
    const lines = [trimSlice(src, pos, e)];
    let cursor = nx;
    while (cursor < n) {
      const lineStop = lineEnd(cursor);
      if (endsParagraph(src, cursor, lineStop)) break;
      lines.push(trimSlice(src, cursor, lineStop));
      cursor = nextLine(lineStop);
    }
    const hp = [];
    const text = lines.length === 1 ? lines[0] : lines.join('\n');
    if (excerpt === null) {
      inlineInto(text, link, hp);
      const html = hp.join('');
      excerpt = html;
      out.push('<p>' + html + '</p>\n');
    } else {
      out.push('<p>');
      inlineInto(text, link, out);
      out.push('</p>\n');
    }
    pos = cursor;
  }
  const done = excerpt === null ? '' : excerpt;
  return { html: out.join(''), toc, excerpt: done };
}

// ------------------------------------------------------------ template dialect

class TplError extends Error {}

function tplFail(name, reason) {
  return new TplError('template "' + name + '": ' + reason);
}

/** The path `text` names, split at its dots, or a template error. */
function pathParts(name, text) {
  if (text.length === 0) throw tplFail(name, JSON.stringify(text) + ' is not a path');
  const pieces = text.split('.');
  for (const piece of pieces) {
    if (piece.length === 0) throw tplFail(name, JSON.stringify(text) + ' is not a path');
    const head = piece[0];
    if (!((head >= 'A' && head <= 'Z') || (head >= 'a' && head <= 'z') || head === '_')) {
      throw tplFail(name, JSON.stringify(text) + ' is not a path');
    }
    for (let i = 1; i < piece.length; i++) {
      const ch = piece[i];
      if (
        !((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '_')
      ) {
        throw tplFail(name, JSON.stringify(text) + ' is not a path');
      }
    }
  }
  return pieces;
}

function isPathText(text) {
  if (text.length === 0) return false;
  for (let i = 0; i < text.length; i++) {
    if (HAS_WS_RE.test(text[i])) return false;
  }
  return true;
}

/** `{% for x in path %}` read out of a tag, or null when it is no for tag. */
function forTag(name, tag) {
  if (!tag.startsWith('for ')) return null;
  const tail = tag.slice(4);
  const gap = tail.indexOf(' ');
  if (gap === -1) return null;
  const varName = tail.slice(0, gap);
  if (varName.length === 0) return null;
  const head = varName[0];
  if (!((head >= 'A' && head <= 'Z') || (head >= 'a' && head <= 'z') || head === '_')) return null;
  for (let i = 1; i < varName.length; i++) {
    const ch = varName[i];
    if (!((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '_')) return null;
  }
  if (!tail.slice(gap).startsWith(' in ')) return null;
  const pathText = tail.slice(gap + 4);
  if (!isPathText(pathText)) return null;
  return { varName, path: pathParts(name, pathText) };
}

/** `{% if [not] path %}` read out of a tag, or null when it is no if tag. */
function ifTag(name, tag) {
  if (!tag.startsWith('if ')) return null;
  let tail = tag.slice(3);
  let not = false;
  if (tail.startsWith('not ')) {
    not = true;
    tail = tail.slice(4);
  }
  if (!isPathText(tail)) return null;
  return { not, path: pathParts(name, tail) };
}

/** `{% include "name" %}` read out of a tag, or null when it is no include tag. */
function includeTag(tag) {
  if (!tag.startsWith('include "') || !tag.endsWith('"') || tag.length < 11) return null;
  const inner = tag.slice(9, -1);
  if (inner.length === 0) return null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (!((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '-')) return null;
  }
  return inner;
}

/** `src` split into tokens: text, {{ }}, {{{ }}} and {% %}, standalone tags lifted. */
function tokenizeTpl(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === n - 1) {
      text += src.slice(i);
      break;
    }
    const nextCh = src[open + 1];
    if (nextCh !== '{' && nextCh !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (nextCh === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw tplFail(name, 'a ' + (raw ? '{{{' : '{{') + ' is not closed');
      if (text !== '') {
        tokens.push({ k: 'text', s: text });
        text = '';
      }
      tokens.push({
        k: raw ? 'raw' : 'var',
        path: pathParts(name, src.slice(open + (raw ? 3 : 2), close).trim()),
      });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw tplFail(name, 'a {% is not closed');
    const end = close + 2;
    const rowStart = src.lastIndexOf('\n', open - 1) + 1;
    const newlineAt = src.indexOf('\n', end);
    const rowEnd = newlineAt === -1 ? n : newlineAt;
    const standalone =
      onlySpaceTab(src, rowStart, open) && onlySpaceTab(src, end, rowEnd);
    if (standalone) text = text.slice(0, text.length - (open - rowStart));
    if (text !== '') {
      tokens.push({ k: 'text', s: text });
      text = '';
    }
    tokens.push({ k: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (newlineAt === -1 ? n : newlineAt + 1) : end;
  }
  if (text !== '') tokens.push({ k: 'text', s: text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a template error when it does not parse). */
function parseTpl(name, src) {
  const root = [];
  const stack = [{ kind: 'root', body: root }];
  let body = root;
  for (const tok of tokenizeTpl(name, src)) {
    if (tok.k === 'text') body.push({ k: 'text', s: tok.s });
    else if (tok.k === 'var' || tok.k === 'raw') body.push({ k: tok.k, path: tok.path });
    else {
      const tag = tok.tag;
      const head = stack[stack.length - 1];
      let found;
      if ((found = forTag(name, tag)) !== null) {
        const node = { k: 'for', kind: 'for', varName: found.varName, path: found.path, body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((found = ifTag(name, tag)) !== null) {
        const node = { k: 'if', kind: 'if', not: found.not, path: found.path, then: [], els: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (head.kind !== 'if' || head.els !== null) {
          throw tplFail(name, 'an else outside an if');
        }
        head.els = [];
        body = head.els;
      } else if (tag === 'endfor' || tag === 'endif') {
        const wanted = tag === 'endfor' ? 'for' : 'if';
        if (head.kind !== wanted) {
          throw tplFail(name, 'an ' + tag + ' with no open ' + tag.slice(3));
        }
        stack.pop();
        const above = stack[stack.length - 1];
        body =
          above.kind === 'root'
            ? above.body
            : above.kind === 'for'
              ? above.body
              : above.els !== null && above.els !== undefined
                ? above.els
                : above.then;
      } else if ((found = includeTag(tag)) !== null) {
        body.push({ k: 'include', name: found });
      } else {
        throw tplFail(name, '{% ' + tag + ' %} is not a tag');
      }
    }
  }
  if (stack.length > 1) {
    throw tplFail(name, 'a ' + stack[stack.length - 1].kind + ' is not closed');
  }
  return root;
}

/** The value at `path` in the frame chain: first name from the nearest frame holding it. */
function lookup(frames, path) {
  const first = path[0];
  for (let f = frames.length - 1; f >= 0; f--) {
    const scope = frames[f];
    if (!Object.hasOwn(scope, first)) continue;
    let value = scope[first];
    for (let k = 1; k < path.length; k++) {
      if (value === null || typeof value !== 'object' || !Object.hasOwn(value, path[k])) return undefined;
      value = value[path[k]];
    }
    return value;
  }
  return undefined;
}

/** A value as text: string itself, a number in its own digits, true/false, array joined by ", ". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let joined = '';
    for (let k = 0; k < v.length; k++) {
      if (k > 0) joined += ', ';
      joined += textOf(v[k]);
    }
    return joined;
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered into `out` in `frames` (depth counts includes).
 * `frames` is a stack of variable maps, innermost last.
 */
function renderTpl(nodes, frames, tpls, out, depth) {
  for (const n of nodes) {
    switch (n.k) {
      case 'text':
        out.push(n.s);
        break;
      case 'var':
        out.push(esc(textOf(lookup(frames, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(frames, n.path)));
        break;
      case 'if': {
        const test = truthy(lookup(frames, n.path));
        const branch = test !== n.not ? n.then : n.els;
        if (branch !== null) renderTpl(branch, frames, tpls, out, depth);
        break;
      }
      case 'for': {
        const items = lookup(frames, n.path);
        if (!Array.isArray(items)) break;
        for (let k = 0; k < items.length; k++) {
          const scope = {};
          scope[n.varName] = items[k];
          scope.loop = { index: k + 1, first: k === 0, last: k === items.length - 1, length: items.length };
          frames.push(scope);
          renderTpl(n.body, frames, tpls, out, depth);
          frames.pop();
        }
        break;
      }
      case 'include': {
        const nested = tpls.get(n.name);
        if (nested !== undefined && depth < 8) renderTpl(nested, frames, tpls, out, depth + 1);
        break;
      }
    }
  }
}

// ------------------------------------------------------------ the build itself

/** A page's link record as templates read it. */
function linkOf(s) {
  if (s === null) return null;
  const dated = s.data.date !== undefined;
  return {
    title: s.data.title,
    url: s.url,
    date: dated ? s.data.date : '',
    date_long: dated ? longDateOf(s.data.date) : '',
  };
}

/** One site's output tree: every path it writes, and that file's text. */
export function run(input) {
  const report = [];
  const parsed = new Map();
  const ordered = Object.keys(input.templates).sort(CMP);
  for (const name of ordered) {
    try {
      parsed.set(name, parseTpl(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TplError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const orderedFiles = [...input.files].sort((x, y) => CMP(x.path, y.path));
  const markdown = [];
  const statics = [];
  for (const f of orderedFiles) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      markdown.push({ path: f.path, text });
    } else statics.push(f);
  }
  const sources = [];
  for (const s of markdown) {
    const front = parseFront(s.text);
    if ('error' in front) {
      report.push('refused ' + s.path + ': ' + front.error);
      continue;
    }
    s.data = front.data;
    s.body = front.body;
    s.post = s.path.startsWith('posts/');
    let owned = null;
    if (s.path.startsWith('tags/')) owned = 'tags';
    else if (s.path.startsWith('page/')) owned = 'page';
    if (owned !== null) {
      report.push('refused ' + s.path + ': ' + owned + '/ is the generator\'s own');
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push('refused ' + s.path + ': a post needs a date');
      continue;
    }
    const chosen = s.data.layout !== undefined ? s.data.layout : s.post ? 'post' : 'page';
    if (!parsed.has(chosen)) {
      report.push('refused ' + s.path + ': layout "' + chosen + '" is no template that parses');
      continue;
    }
    s.layout = chosen;
    if (s.data.draft === true) {
      report.push('draft ' + s.path);
      continue;
    }
    sources.push(s);
  }
  const usedSlugs = new Map();
  const byPath = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let takenHere = usedSlugs.get(dir);
    if (takenHere === undefined) {
      takenHere = new Set(dir === '' ? ['posts', 'tags', 'page'] : []);
      usedSlugs.set(dir, takenHere);
    }
    const pageSlug = uniqueSlug(s.data.slug !== undefined ? s.data.slug : slugOf(s.data.title), takenHere);
    s.slug = pageSlug;
    s.outDir = dir === '' ? pageSlug : dir + '/' + pageSlug;
    s.url = base + '/' + s.outDir + '/';
    byPath.set(s.path, s);
  }
  const staticSet = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of sources) {
    const sourceDir = dirOf(s.path);
    const resolve = (target) => {
      if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const mark = target.indexOf('#');
      const relative = mark === -1 ? target : target.slice(0, mark);
      const fragment = mark === -1 ? '' : target.slice(mark);
      const found = relative === '' ? null : resolvePath(sourceDir, relative);
      if (found !== null && byPath.has(found)) return byPath.get(found).url + fragment;
      if (found !== null && staticSet.has(found)) return base + '/' + found + fragment;
      broken.add('broken-link ' + s.path + ' -> ' + target);
      return target;
    };
    const rendered = renderBody(s.body, resolve);
    s.html = rendered.html;
    s.toc = rendered.toc;
    s.excerpt = rendered.excerpt;
  }
  const orderedPosts = sources.filter((s) => s.post);
  orderedPosts.sort((x, y) => CMP(y.data.date, x.data.date) || CMP(x.slug, y.slug));
  orderedPosts.forEach((p, k) => {
    p.newer = k === 0 ? null : orderedPosts[k - 1];
    p.older = k === orderedPosts.length - 1 ? null : orderedPosts[k + 1];
  });
  const tagIndex = new Map();
  const sourceTags = (s) => {
    const seenSlugs = new Set();
    const names = [];
    const listed = s.data.tags === undefined ? [] : s.data.tags;
    for (const name of listed) {
      const slug = slugOf(name);
      if (!seenSlugs.has(slug)) {
        seenSlugs.add(slug);
        names.push(name);
      }
    }
    return names;
  };
  for (const p of orderedPosts) {
    p.tagRefs = [];
    for (const name of sourceTags(p)) {
      const slug = slugOf(name);
      let tag = tagIndex.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] };
        tagIndex.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (s.post) continue;
    s.tagRefs = sourceTags(s).map((name) => {
      const slug = slugOf(name);
      const tag = tagIndex.get(slug);
      return tag !== undefined ? tag : { name, slug, url: '', posts: [] };
    });
  }
  const tagList = [...tagIndex.values()].sort(
    (x, y) => y.posts.length - x.posts.length || CMP(x.slug, y.slug),
  );
  const cardOf = (s) => {
    if (s.card !== undefined) return s.card;
    const made = {
      title: s.data.title,
      url: s.url,
      date: s.data.date === undefined ? '' : s.data.date,
      date_long: s.data.date === undefined ? '' : longDateOf(s.data.date),
      summary: s.data.summary === undefined ? '' : s.data.summary,
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    s.card = made;
    return made;
  };
  const pageOf = (s) => {
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
      newer: linkOf(s.newer === undefined ? null : s.newer),
      older: linkOf(s.older === undefined ? null : s.older),
      is_post: s.post,
    };
  };
  const siteView = { title: input.site.title, base_url: base };
  const tagViews = tagList.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recentCards = orderedPosts.slice(0, input.site.recent).map((p) => cardOf(p));
  const tree = {};
  const sharedFrame = { site: siteView, tags: tagViews, recent: recentCards };
  const renderNamed = (name, vars) => {
    const ops = parsed.get(name);
    if (ops === undefined) return null;
    const scope = [sharedFrame, vars];
    const pieces = [];
    renderTpl(ops, scope, parsed, pieces, 0);
    return pieces.join('');
  };
  for (const s of sources) {
    tree[s.outDir + '/index.html'] = renderNamed(s.layout, { page: pageOf(s) });
  }
  const perPage = input.site.per_page;
  const indexPages = Math.max(1, Math.ceil(orderedPosts.length / perPage));
  const indexHref = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let pageNo = 1; pageNo <= indexPages; pageNo++) {
    const html = renderNamed('index', {
      posts: orderedPosts.slice((pageNo - 1) * perPage, pageNo * perPage).map((p) => cardOf(p)),
      pager: {
        number: pageNo,
        total: indexPages,
        url: indexHref(pageNo),
        newer_url: pageNo === 1 ? '' : indexHref(pageNo - 1),
        older_url: pageNo === indexPages ? '' : indexHref(pageNo + 1),
      },
    });
    if (html !== null) tree[pageNo === 1 ? 'index.html' : 'page/' + pageNo + '/index.html'] = html;
  }
  for (const tag of tagList) {
    const html = renderNamed('tag', {
      tag: {
        name: tag.name,
        slug: tag.slug,
        url: tag.url,
        count: tag.posts.length,
        posts: tag.posts.map((p) => cardOf(p)),
      },
    });
    if (html !== null) tree['tags/' + tag.slug + '/index.html'] = html;
  }
  const tagsPage = renderNamed('tags', {});
  if (tagsPage !== null) tree['tags/index.html'] = tagsPage;
  for (const file of statics) {
    if (Object.hasOwn(tree, file.path)) report.push('shadowed ' + file.path + ': a built page has its path');
    else tree[file.path] = file.content;
  }
  const reportLines = [...report, ...broken].sort(CMP);
  let plainCount = 0;
  for (const s of sources) if (!s.post) plainCount++;
  reportLines.push(
    'built ' +
      plainCount +
      ' pages, ' +
      orderedPosts.length +
      ' posts, ' +
      tagList.length +
      ' tags and ' +
      statics.length +
      ' static files',
  );
  tree['build-report.txt'] = reportLines.join('\n') + '\n';
  return tree;
}
