/**
 * The App page: authored HTML with the storage installer and the App bundle
 * inlined where the browser will run them. Pure string work, so the page can
 * be checked in a browser as well as composed by a build.
 */

/** Elements whose contents the browser reads as text up to their end tag. */
const RAW_TEXT_ELEMENTS = new Set([
  'iframe',
  'noembed',
  'noframes',
  'noscript',
  'plaintext',
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
]);

/** The `src` values that name the SPA bundle next to the page. */
const BUNDLE_SRC = new Set(['app.js', './app.js', '/app.js']);

const SPACE = /[\t\n\f\r ]/;
/** A `<script` start or `</script` end tag (name complete) at `lastIndex`. */
const SCRIPT_START = /<script[\t\n\f\r />]/iy;
const SCRIPT_END = /<\/script[\t\n\f\r />]/iy;

/**
 * Where page code can go in authored HTML, from one scan of its tags as the
 * browser tokenizes them: comments, raw-text element contents and quoted
 * attribute values are never read as tags, and nothing inside a
 * `<template>` (inert content) counts. Offsets index into the scanned text.
 */
type HtmlPlaces = {
  /** Just after the first `<head>` start tag. */
  headStart: number | null;
  /** The start of the first `<script>` element. */
  firstScript: number | null;
  /** The first `<script src="app.js">` element, through its end tag. */
  bundleScript: { start: number; end: number } | null;
  /** The start of the first `</body>`, and of the first `</html>`. */
  bodyEnd: number | null;
  htmlEnd: number | null;
  /** Whether the text ends inside a comment, tag or raw-text element. */
  openAtEnd: boolean;
};

type Tag = {
  /** Lowercase tag name. */
  name: string;
  closing: boolean;
  /** Attributes, with the first of a repeated name winning, as in the DOM. */
  attributes: Map<string, string>;
  /** Just past the tag's `>`. */
  end: number;
};

/**
 * The start or end tag at `open` (`<` or `</` and a letter), or null when
 * the text ends inside it. Quoted attribute values may hold `>`.
 */
function readTag(html: string, open: number): Tag | null {
  const closing = html[open + 1] === '/';
  let cursor = open + (closing ? 2 : 1);
  const nameStart = cursor;
  while (cursor < html.length && !/[\t\n\f\r />]/.test(html[cursor])) {
    cursor += 1;
  }
  const name = html.slice(nameStart, cursor).toLowerCase();
  const attributes = new Map<string, string>();
  while (cursor < html.length) {
    const char = html[cursor];
    if (char === '>') return { name, closing, attributes, end: cursor + 1 };
    if (SPACE.test(char) || char === '/') {
      cursor += 1;
      continue;
    }
    const attributeStart = cursor;
    cursor += 1; // A leading `=` belongs to the name.
    while (cursor < html.length && !/[\t\n\f\r />=]/.test(html[cursor])) {
      cursor += 1;
    }
    const attribute = html.slice(attributeStart, cursor).toLowerCase();
    while (cursor < html.length && SPACE.test(html[cursor])) cursor += 1;
    let value = '';
    if (html[cursor] === '=') {
      cursor += 1;
      while (cursor < html.length && SPACE.test(html[cursor])) cursor += 1;
      const quote = html[cursor];
      if (quote === '"' || quote === "'") {
        const end = html.indexOf(quote, cursor + 1);
        if (end === -1) return null;
        value = html.slice(cursor + 1, end);
        cursor = end + 1;
      } else {
        const valueStart = cursor;
        while (cursor < html.length && !/[\t\n\f\r >]/.test(html[cursor])) {
          cursor += 1;
        }
        value = html.slice(valueStart, cursor);
      }
    }
    if (!attributes.has(attribute)) attributes.set(attribute, value);
  }
  return null;
}

/** Whether `sticky` matches `html` exactly at `index`. */
function matchesAt(sticky: RegExp, html: string, index: number): boolean {
  sticky.lastIndex = index;
  return sticky.test(html);
}

/**
 * The start of the `</script>` that ends script data starting at `from`, or
 * -1. As in the HTML tokenizer, `<!--` escapes the text up to `-->` (the
 * dashes may be the ones that opened it); in there a `<script>` tag
 * double-escapes it, so a `</script>` only ends that nested script, and
 * only one outside it ends the element.
 */
function scriptDataEnd(html: string, from: number): number {
  let state: 'data' | 'escaped' | 'double' = 'data';
  /** Dashes just read in an escaped state: `-->` leaves it. */
  let dashes = 0;
  for (let index = from; index < html.length;) {
    const char = html[index];
    if (char === '<') {
      dashes = 0;
      if (state !== 'double' && matchesAt(SCRIPT_END, html, index)) {
        return index;
      }
      if (state === 'data' && html.startsWith('<!--', index)) {
        state = 'escaped';
        dashes = 2;
        index += 4;
        continue;
      }
      if (state === 'escaped' && matchesAt(SCRIPT_START, html, index)) {
        state = 'double';
        index += '<script'.length + 1;
        continue;
      }
      if (state === 'double' && matchesAt(SCRIPT_END, html, index)) {
        state = 'escaped';
        index += '</script'.length + 1;
        continue;
      }
    } else if (state !== 'data') {
      if (char === '-') dashes += 1;
      else {
        if (char === '>' && dashes >= 2) state = 'data';
        dashes = 0;
      }
    }
    index += 1;
  }
  return -1;
}

/**
 * The start of the end tag that closes the raw-text element `name` whose
 * text starts at `from`, or -1 when the text runs to the end.
 */
function rawTextEnd(html: string, name: string, from: number): number {
  // `plaintext` has no end tag: the rest of the document is its text.
  if (name === 'plaintext') return -1;
  if (name === 'script') return scriptDataEnd(html, from);
  const end = new RegExp(`</${name}[\\t\\n\\f\\r />]`, 'gi');
  end.lastIndex = from;
  return end.exec(html)?.index ?? -1;
}

function scanHtml(html: string): HtmlPlaces {
  const places: HtmlPlaces = {
    headStart: null,
    firstScript: null,
    bundleScript: null,
    bodyEnd: null,
    htmlEnd: null,
    openAtEnd: false,
  };
  let templates = 0;
  let index = 0;
  for (;;) {
    const open = html.indexOf('<', index);
    // A document that ends inside `<template>` would take an appended bundle
    // into the template's inert content, where it never runs.
    if (open === -1) {
      return templates > 0 ? { ...places, openAtEnd: true } : places;
    }
    if (html.startsWith('<!--', open)) {
      // `<!-->` and `<!--->` are whole (empty) comments.
      let end = -1;
      if (/^-?>/.test(html.slice(open + 4, open + 6))) {
        end = html.indexOf('>', open + 4) + 1;
      } else {
        const close = /--!?>/g;
        close.lastIndex = open + 4;
        const match = close.exec(html);
        if (match) end = match.index + match[0].length;
      }
      if (end === -1) return { ...places, openAtEnd: true };
      index = end;
      continue;
    }
    const closing = html[open + 1] === '/';
    if (!/[A-Za-z]/.test(html[open + (closing ? 2 : 1)] ?? '')) {
      if (closing || html[open + 1] === '!' || html[open + 1] === '?') {
        // `<!doctype>`, `<?…>` and `</…>` without a name end at the next `>`.
        const end = html.indexOf('>', open + 1);
        if (end === -1) return { ...places, openAtEnd: true };
        index = end + 1;
      } else {
        index = open + 1; // A `<` in text.
      }
      continue;
    }
    const tag = readTag(html, open);
    if (!tag) return { ...places, openAtEnd: true };
    const { name } = tag;
    index = tag.end;

    if (tag.closing) {
      if (name === 'template') templates = Math.max(0, templates - 1);
      else if (templates === 0 && name === 'body') places.bodyEnd ??= open;
      else if (templates === 0 && name === 'html') places.htmlEnd ??= open;
      continue;
    }
    if (name === 'template') templates += 1;
    if (templates === 0 && name === 'head') places.headStart ??= tag.end;
    if (templates === 0 && name === 'script') places.firstScript ??= open;
    if (!RAW_TEXT_ELEMENTS.has(name)) continue;
    const close = rawTextEnd(html, name, tag.end);
    const closeTag = close === -1 ? null : readTag(html, close);
    if (!closeTag) return { ...places, openAtEnd: true };
    if (
      name === 'script' &&
      templates === 0 &&
      !places.bundleScript &&
      BUNDLE_SRC.has(tag.attributes.get('src')?.trim() ?? '')
    ) {
      places.bundleScript = { start: open, end: closeTag.end };
    }
    index = closeTag.end;
  }
}

/**
 * `code` as the body of an inline script element: `<\/` reads as `</` in a
 * string, template or regular expression, and keeps the tag name's case.
 */
function scriptBody(code: string): string {
  return code.replace(/<\/(script)/gi, (_match, name: string) => `<\\/${name}`);
}

/**
 * The App page: the authored HTML with the storage installer as a classic
 * script before every page script, and the bundle as a live module script
 * in place of the authored `<script src="app.js">`, or at the end of the
 * body without one. Both places come from the authored markup, so markup in
 * the bundle is never matched.
 */
export function composeAppHtml(
  authored: string,
  installer: string,
  bundle: string,
  htmlFile: string,
): string {
  const places = scanHtml(authored);
  const end = places.bodyEnd ?? places.htmlEnd ?? authored.length;
  // Appended text would land in whatever the document leaves open.
  if (!places.bundleScript && end === authored.length && places.openAtEnd) {
    throw new Error(
      `${htmlFile} ends inside an unclosed comment, tag or element, so the ` +
        'App bundle cannot be added to it.',
    );
  }
  // An implied head starts at the first script; an explicit one may come
  // later (the browser then ignores the tag), so the earlier place wins.
  const candidates = [places.headStart, places.firstScript].filter(
    (place) => place !== null,
  );
  const bundlePlace = places.bundleScript ?? { start: end, end };
  const installerAt = candidates.length
    ? Math.min(...candidates)
    : bundlePlace.start;
  const installerTag = installer
    ? `<script>${scriptBody(installer)}</script>`
    : '';
  const bundleTag = `<script type="module">${scriptBody(bundle)}</script>${
    places.bundleScript ? '' : '\n'
  }`;
  // Either may come first (a script after `</body>`); at the same place the
  // installer goes first. Neither range overlaps the other.
  const edits = [
    { start: installerAt, end: installerAt, text: installerTag },
    { ...bundlePlace, text: bundleTag },
  ].sort((a, b) => a.start - b.start);
  let page = '';
  let cursor = 0;
  for (const edit of edits) {
    page += authored.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return page + authored.slice(cursor);
}
