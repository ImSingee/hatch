/**
 * The App page: authored HTML with the storage installer and the App bundle
 * inlined where the browser will run them. Pure string work, so the page can
 * be checked in a browser as well as composed by a build.
 */

/**
 * HTML elements whose contents the browser reads as text up to their end
 * tag. In SVG and MathML, elements of these names hold markup like any other.
 */
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

/**
 * Start tags that end SVG or MathML content (back to an integration point
 * or HTML), as the HTML parser's rules for foreign content list them; `font`
 * only with one of FONT_BREAKOUT_ATTRIBUTES.
 */
const BREAKOUT_START_TAGS = new Set([
  'b',
  'big',
  'blockquote',
  'body',
  'br',
  'center',
  'code',
  'dd',
  'div',
  'dl',
  'dt',
  'em',
  'embed',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'head',
  'hr',
  'i',
  'img',
  'li',
  'listing',
  'menu',
  'meta',
  'nobr',
  'ol',
  'p',
  'pre',
  'ruby',
  's',
  'small',
  'span',
  'strong',
  'strike',
  'sub',
  'sup',
  'table',
  'tt',
  'u',
  'ul',
  'var',
]);
const FONT_BREAKOUT_ATTRIBUTES = ['color', 'face', 'size'];

/** MathML elements whose start tags (but these two) are HTML again. */
const MATHML_TEXT_INTEGRATION_POINTS = new Set([
  'mi',
  'mo',
  'mn',
  'ms',
  'mtext',
]);
const MATHML_TEXT_FOREIGN_TAGS = new Set(['mglyph', 'malignmark']);
/** SVG elements whose start tags are HTML again (lowercase names). */
const SVG_HTML_INTEGRATION_POINTS = new Set(['foreignobject', 'desc', 'title']);

/** The `src` values that name the SPA bundle next to the page. */
const BUNDLE_SRC = new Set(['app.js', './app.js', '/app.js']);

/**
 * The named character references that stand for ASCII text; every other one
 * stands for text with a non-ASCII character (see attributeValue).
 */
const ASCII_CHARACTER_REFERENCES: Record<string, string> = {
  Tab: '\t',
  NewLine: '\n',
  excl: '!',
  quot: '"',
  QUOT: '"',
  num: '#',
  dollar: '$',
  percnt: '%',
  amp: '&',
  AMP: '&',
  apos: "'",
  lpar: '(',
  rpar: ')',
  ast: '*',
  midast: '*',
  plus: '+',
  comma: ',',
  period: '.',
  sol: '/',
  colon: ':',
  semi: ';',
  lt: '<',
  LT: '<',
  equals: '=',
  gt: '>',
  GT: '>',
  quest: '?',
  commat: '@',
  lsqb: '[',
  lbrack: '[',
  bsol: '\\',
  rsqb: ']',
  rbrack: ']',
  Hat: '^',
  lowbar: '_',
  UnderBar: '_',
  grave: '`',
  DiacriticalGrave: '`',
  fjlig: 'fj',
  lcub: '{',
  lbrace: '{',
  verbar: '|',
  vert: '|',
  VerticalLine: '|',
  rcub: '}',
  rbrace: '}',
};
/** What numeric references to 0x80-0x9F stand for (windows-1252). */
const C1_REPLACEMENTS: Record<number, number> = {
  0x80: 0x20ac,
  0x82: 0x201a,
  0x83: 0x0192,
  0x84: 0x201e,
  0x85: 0x2026,
  0x86: 0x2020,
  0x87: 0x2021,
  0x88: 0x02c6,
  0x89: 0x2030,
  0x8a: 0x0160,
  0x8b: 0x2039,
  0x8c: 0x0152,
  0x8e: 0x017d,
  0x91: 0x2018,
  0x92: 0x2019,
  0x93: 0x201c,
  0x94: 0x201d,
  0x95: 0x2022,
  0x96: 0x2013,
  0x97: 0x2014,
  0x98: 0x02dc,
  0x99: 0x2122,
  0x9a: 0x0161,
  0x9b: 0x203a,
  0x9c: 0x0153,
  0x9e: 0x017e,
  0x9f: 0x0178,
};
/** A numeric reference (its `;` optional) or a named one written in full. */
const CHARACTER_REFERENCE =
  /&(?:#[xX]([0-9A-Fa-f]+);?|#([0-9]+);?|([A-Za-z][A-Za-z0-9]*);)/g;

const SPACE = /[\t\n\f\r ]/;
/** A `<script` start or `</script` end tag (name complete) at `lastIndex`. */
const SCRIPT_START = /<script[\t\n\f\r />]/iy;
const SCRIPT_END = /<\/script[\t\n\f\r />]/iy;

/** The text a numeric character reference to `code` stands for. */
function numericReference(code: number): string {
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
    return '\ufffd';
  }
  return String.fromCodePoint(C1_REPLACEMENTS[code] ?? code);
}

/**
 * An attribute value as the browser reads it from `raw`, its markup, as far
 * as comparisons with this module's values (ASCII, without `&`, `<`, `>` or
 * `"`) go: numeric character references are decoded, and named ones written
 * in full that stand for ASCII text. Any other reference either stays text
 * in the browser too or stands for a character none of those values has (a
 * non-ASCII one, or the `&`, `<`, `>` or `"` of a legacy reference without
 * its `;`), so it is left as written, and its `&` keeps the value unequal.
 */
function attributeValue(raw: string): string {
  return raw.replace(
    CHARACTER_REFERENCE,
    (
      match: string,
      hex: string | undefined,
      decimal: string | undefined,
      name: string | undefined,
    ) => {
      if (hex !== undefined || decimal !== undefined) {
        // Leading zeros aside, eight digits are past 0x10FFFF already.
        const digits = (hex ?? decimal)!.replace(/^0+/, '').slice(0, 8);
        return numericReference(Number.parseInt(digits || '0', hex ? 16 : 10));
      }
      return Object.hasOwn(ASCII_CHARACTER_REFERENCES, name!)
        ? ASCII_CHARACTER_REFERENCES[name!]!
        : match;
    },
  );
}

/**
 * The URL text of a `src` attribute as the URL parser takes it: leading and
 * trailing C0 controls and spaces stripped, tabs and newlines removed.
 */
function urlText(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end -= 1;
  return value.slice(start, end).replace(/[\t\n\r]/g, '');
}

/**
 * Where page code can go in authored HTML, from one scan of its tags as the
 * browser tokenizes them: comments, raw-text element contents, CDATA
 * sections and quoted attribute values are never read as tags, SVG and
 * MathML content is read by the foreign-content rules (no raw text there,
 * `/>` closes an element), and nothing inside an HTML `<template>` (inert
 * content) counts. Offsets index into the scanned text.
 */
type HtmlPlaces = {
  /** Just after the first `<head>` start tag. */
  headStart: number | null;
  /**
   * Where code runs before the first script element: its start, or that of
   * the outermost SVG or MathML element it is in.
   */
  firstScript: number | null;
  /** The first HTML `<script src="app.js">` element, through its end tag. */
  bundleScript: { start: number; end: number } | null;
  /**
   * The start of the first `</body>`, and of the first `</html>`, outside
   * SVG, MathML and templates.
   */
  bodyEnd: number | null;
  htmlEnd: number | null;
  /**
   * Whether the text ends inside a comment, tag, raw-text element, template
   * or SVG or MathML element.
   */
  openAtEnd: boolean;
};

type Tag = {
  /** Lowercase tag name. */
  name: string;
  closing: boolean;
  /** A `/` just before the `>` (outside an attribute value). */
  selfClosing: boolean;
  /** Raw attribute values (references not decoded), the first of a repeated
   * name winning, as in the DOM. */
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
  let slash = false;
  while (cursor < html.length) {
    const char = html[cursor];
    if (char === '>') {
      return {
        name,
        closing,
        selfClosing: slash,
        attributes,
        end: cursor + 1,
      };
    }
    slash = char === '/';
    if (SPACE.test(char) || slash) {
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

/**
 * An element open on the scan's stack: an SVG or MathML element, or an HTML
 * `<template>`. Other HTML elements are not tracked, so non-conforming
 * markup that ends an element with others still open in it (an HTML element
 * in an integration point, or SVG left open in a `<div>` that is closed)
 * may be read differently from the browser.
 */
type OpenElement = {
  name: string;
  namespace: 'html' | 'svg' | 'math';
  /** Its start tags are read by the HTML rules (SVG `foreignObject`…). */
  htmlIntegration: boolean;
  /** The start of the outermost SVG or MathML element it is in. */
  foreignRoot: number;
};

const isForeign = (element: OpenElement | undefined) =>
  element !== undefined && element.namespace !== 'html';

/** Whether the start tag `tag` is read by the HTML rules under `current`. */
function htmlRulesFor(current: OpenElement | undefined, tag: Tag): boolean {
  if (!isForeign(current)) return true;
  if (current!.htmlIntegration) return true;
  if (current!.namespace !== 'math') return false;
  if (MATHML_TEXT_INTEGRATION_POINTS.has(current!.name)) {
    return !MATHML_TEXT_FOREIGN_TAGS.has(tag.name);
  }
  return current!.name === 'annotation-xml' && tag.name === 'svg';
}

/** Whether the start tag `tag` ends foreign content. */
function breaksOut(tag: Tag): boolean {
  if (BREAKOUT_START_TAGS.has(tag.name)) return true;
  return (
    tag.name === 'font' &&
    FONT_BREAKOUT_ATTRIBUTES.some((name) => tag.attributes.has(name))
  );
}

function isHtmlIntegrationPoint(namespace: 'svg' | 'math', tag: Tag): boolean {
  if (namespace === 'svg') return SVG_HTML_INTEGRATION_POINTS.has(tag.name);
  if (tag.name !== 'annotation-xml') return false;
  const encoding = attributeValue(
    tag.attributes.get('encoding') ?? '',
  ).toLowerCase();
  return encoding === 'text/html' || encoding === 'application/xhtml+xml';
}

/**
 * Pop foreign elements up to an integration point, an HTML element or the
 * end of the stack, as a breakout tag does.
 */
function popForeign(stack: OpenElement[]): void {
  for (;;) {
    const current = stack.at(-1);
    if (
      !isForeign(current) ||
      current!.htmlIntegration ||
      (current!.namespace === 'math' &&
        MATHML_TEXT_INTEGRATION_POINTS.has(current!.name))
    ) {
      return;
    }
    stack.pop();
  }
}

/**
 * The end tag `name` read by the foreign-content rules: it closes the
 * nearest foreign element of that name, unless an HTML element comes first.
 * Returns whether the HTML rules read it after all.
 */
function closeForeign(stack: OpenElement[], name: string): boolean {
  for (let index = stack.length - 1; ;) {
    if (stack[index]!.name === name) {
      stack.length = index;
      return false;
    }
    index -= 1;
    if (index < 0 || !isForeign(stack[index])) return true;
  }
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
  const stack: OpenElement[] = [];
  const inTemplate = () => stack.some((element) => !isForeign(element));
  let index = 0;
  for (;;) {
    const open = html.indexOf('<', index);
    // A document that ends inside `<template>` would take an appended bundle
    // into the template's inert content, where it never runs; one that ends
    // inside SVG or MathML would read it as a foreign element.
    if (open === -1) {
      return stack.length > 0 ? { ...places, openAtEnd: true } : places;
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
    // Only in SVG or MathML is `<![CDATA[` a section, of text up to `]]>`.
    if (html.startsWith('<![CDATA[', open) && isForeign(stack.at(-1))) {
      const end = html.indexOf(']]>', open + 9);
      if (end === -1) return { ...places, openAtEnd: true };
      index = end + 3;
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
      // End tags in SVG or MathML: `</p>` and `</br>` break out of it,
      // others close the foreign element they name.
      if (isForeign(stack.at(-1))) {
        if (name === 'p' || name === 'br') popForeign(stack);
        else if (!closeForeign(stack, name)) continue;
      }
      if (name === 'template') {
        // It closes the innermost template and whatever is open in it.
        while (inTemplate()) {
          if (!isForeign(stack.pop())) break;
        }
      } else if (stack.length === 0 && name === 'body') {
        places.bodyEnd ??= open;
      } else if (stack.length === 0 && name === 'html') {
        places.htmlEnd ??= open;
      }
      continue;
    }

    const current = stack.at(-1);
    if (!htmlRulesFor(current, tag)) {
      if (!breaksOut(tag)) {
        // A foreign element: no raw text, and `/>` closes it. An SVG
        // script runs, so the installer goes before its outermost element.
        if (name === 'script' && current!.namespace === 'svg') {
          if (!inTemplate()) places.firstScript ??= current!.foreignRoot;
        }
        if (!tag.selfClosing) {
          const namespace = current!.namespace as 'svg' | 'math';
          stack.push({
            name,
            namespace,
            htmlIntegration: isHtmlIntegrationPoint(namespace, tag),
            foreignRoot: current!.foreignRoot,
          });
        }
        continue;
      }
      popForeign(stack); // Then read by the HTML rules.
    }
    const parent = stack.at(-1);
    // Code placed before this tag is read in the same context, so a script
    // in SVG or MathML is preceded at its outermost element (in HTML).
    const at = isForeign(parent) ? parent!.foreignRoot : open;
    if (name === 'svg' || name === 'math') {
      if (!tag.selfClosing) {
        stack.push({
          name,
          namespace: name,
          htmlIntegration: false,
          foreignRoot: at,
        });
      }
      continue;
    }
    if (name === 'template') {
      stack.push({
        name,
        namespace: 'html',
        htmlIntegration: false,
        foreignRoot: at,
      });
      continue;
    }
    if (stack.length === 0 && name === 'head') places.headStart ??= tag.end;
    if (!inTemplate() && name === 'script') places.firstScript ??= at;
    if (!RAW_TEXT_ELEMENTS.has(name)) continue;
    const close = rawTextEnd(html, name, tag.end);
    const closeTag = close === -1 ? null : readTag(html, close);
    if (!closeTag) return { ...places, openAtEnd: true };
    if (
      name === 'script' &&
      !inTemplate() &&
      !places.bundleScript &&
      BUNDLE_SRC.has(urlText(attributeValue(tag.attributes.get('src') ?? '')))
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
