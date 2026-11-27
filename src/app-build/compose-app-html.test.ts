/**
 * The App page runs the storage installer before any page script and the
 * bundle as a live module script, wherever the authored markup puts its
 * tags. Text the browser does not read as a tag (comments, attribute values,
 * raw-text elements, inert templates) never decides either place.
 */
import { describe, expect, it } from 'vitest';
import { composeAppHtml } from './app-html';

const I = '<script>install()</script>';
const B = '<script type="module">bundle()</script>';
const compose = (html: string) =>
  composeAppHtml(html, 'install()', 'bundle()', 'app/index.html');

describe('composing the App page', () => {
  it('puts the installer after an explicit head and replaces the bundle tag', () => {
    expect(
      compose(
        '<!doctype html><!-- the <head> and <script src="app.js"></script> -->' +
          '<html><head><title><script></title>' +
          "<script>localStorage.setItem('theme', 'dark')</script>" +
          '</head><body><script type="module" src="./app.js"></script></body></html>',
      ),
    ).toBe(
      '<!doctype html><!-- the <head> and <script src="app.js"></script> -->' +
        `<html><head>${I}<title><script></title>` +
        "<script>localStorage.setItem('theme', 'dark')</script>" +
        `</head><body>${B}</body></html>`,
    );
  });

  it('runs the installer before a script that precedes any head tag', () => {
    // Without a head start tag, markup in a later attribute value is text.
    expect(
      compose(
        '<script>early()</script><p title="<head>">x</p><script src=app.js></script>',
      ),
    ).toBe(`${I}<script>early()</script><p title="<head>">x</p>${B}`);
  });

  it('adds the bundle at the end of the body without a bundle tag', () => {
    expect(compose('<HTML><BODY><p>x</p></BODY></HTML>')).toBe(
      `<HTML><BODY><p>x</p>${I}${B}\n</BODY></HTML>`,
    );
    expect(compose('<p>x</p>')).toBe(`<p>x</p>${I}${B}\n`);
    // A script after the body still follows the installer.
    expect(compose('<body><p>x</p></body><script>late()</script>')).toBe(
      `<body><p>x</p>${B}\n</body>${I}<script>late()</script>`,
    );
    // A commented-out tag and one in an inert template are not the page's.
    expect(
      compose(
        '<body><!-- <script src="app.js"></script> --><template>' +
          '<script src="app.js"></script></body></template></body>',
      ),
    ).toBe(
      '<body><!-- <script src="app.js"></script> --><template>' +
        `<script src="app.js"></script></body></template>${I}${B}\n</body>`,
    );
  });

  it('reads a script element to the end tag the browser ends it at', () => {
    const atBodyEnd = (script: string) =>
      expect(compose(`<body><script>${script}</script><p>x</p></body>`)).toBe(
        `<body>${I}<script>${script}</script><p>x</p>${B}\n</body>`,
      );
    atBodyEnd('const s = "</body>";');
    // Inside `<!--`, a `<script>` tag makes the next `</script>` text.
    atBodyEnd(
      'const a = "<!--<script>"; const b = "</script>"; ' +
        'const c = "</body>"; //-->',
    );
    // `--!>` leaves a comment but not escaped script text.
    atBodyEnd('<!--<script>--!></script></body>-->');
    // `<!-->` is over at once, and `<scriptx>` is no script tag.
    expect(compose('<body><script><!--><script></script></body>')).toBe(
      `<body>${I}<script><!--><script></script>${B}\n</body>`,
    );
    expect(compose('<body><script><!--<scriptx></script></body>')).toBe(
      `<body>${I}<script><!--<scriptx></script>${B}\n</body>`,
    );
    // The bundle tag is replaced through its end tag's attributes.
    expect(compose('<body><script src="app.js"></script x=">"></body>')).toBe(
      `<body>${I}${B}</body>`,
    );
    expect(() => compose('<body><script><!--<script></script>')).toThrow(
      /unclosed/,
    );
  });

  it('reads SVG and MathML content by the foreign-content rules', () => {
    // A self-closing SVG `style` is over at `/>`; it holds no raw text.
    expect(
      compose('<body><svg><style/></svg><script src="app.js"></script></body>'),
    ).toBe(`<body><svg><style/></svg>${I}${B}</body>`);
    // SVG `style` and `script` contents are markup, so a CDATA section is
    // what hides text there; an SVG script runs, after the installer.
    expect(
      compose(
        '<body><svg><style><![CDATA[ p::after { content: "</body>"; } ]]>' +
          '</style><script>early()</script></svg><p>x</p></body>',
      ),
    ).toBe(
      `<body>${I}<svg><style><![CDATA[ p::after { content: "</body>"; } ]]>` +
        `</style><script>early()</script></svg><p>x</p>${B}\n</body>`,
    );
    // HTML integration points and MathML text integration points take HTML
    // elements again, raw text included.
    const integrated =
      '<svg><foreignObject><style>"</body>"</style></foreignObject>' +
      '<desc><textarea></body></textarea></desc></svg>' +
      '<math><mi><style>"</body>"</style></mi>' +
      '<annotation-xml encoding="TEXT&sol;html"><xmp></body></xmp>' +
      '</annotation-xml></math>';
    expect(compose(`<body>${integrated}<p>x</p></body>`)).toBe(
      `<body>${integrated}<p>x</p>${I}${B}\n</body>`,
    );
    // An HTML start tag such as `<p>` breaks out of SVG.
    expect(compose('<body><svg><g><p><style>"</body>"</style></body>')).toBe(
      `<body><svg><g><p><style>"</body>"</style>${I}${B}\n</body>`,
    );
    // An SVG `template` is no inert HTML template, and an SVG script's
    // `src` names no bundle.
    expect(
      compose(
        '<body><svg><template/><script src="app.js"/></svg>' +
          '<script src="app.js"></script></body>',
      ),
    ).toBe(`<body>${I}<svg><template/><script src="app.js"/></svg>${B}</body>`);
    // An HTML template's end closes the SVG left open in it.
    expect(
      compose(
        '<body><template><svg></template><style>"</body>"</style></body>',
      ),
    ).toBe(
      `<body><template><svg></template><style>"</body>"</style>${I}${B}\n</body>`,
    );
    // The bundle never goes into an SVG element left open.
    expect(() => compose('<body><svg><circle/></body></html>')).toThrow(
      /unclosed/,
    );
  });

  it('matches the bundle tag by the src value the browser reads', () => {
    for (const src of [
      '&#46;/app.js',
      '&#x2E;&sol;app&period;js',
      '&#46/app.js',
      ' &#9;app.js ',
      'ap&#x0A;p.js',
    ]) {
      expect(compose(`<body><script src="${src}"></script></body>`)).toBe(
        `<body>${I}${B}</body>`,
      );
    }
    for (const src of ['&amp;#46;/app.js', '&nbsp;app.js', '&period/app.js']) {
      expect(compose(`<body><script src="${src}"></script></body>`)).toBe(
        `<body>${I}<script src="${src}"></script>${B}\n</body>`,
      );
    }
  });

  it('keeps the bundle from closing its own script element', () => {
    expect(
      composeAppHtml('<body></body>', '', 'x("</SCRIPT>")', 'app/index.html'),
    ).toBe('<body><script type="module">x("<\\/SCRIPT>")</script>\n</body>');
  });

  it('refuses a page whose end is still inside a comment or element', () => {
    expect(() => compose('<p>x</p><!-- unclosed')).toThrow(
      /app\/index\.html ends inside an unclosed/,
    );
    expect(() => compose('<textarea>notes')).toThrow(/unclosed/);
    // An unclosed template would hold the appended bundle as inert content.
    expect(() => compose('<template><p>x</p>')).toThrow(/unclosed/);
  });
});
