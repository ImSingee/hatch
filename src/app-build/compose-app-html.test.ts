/**
 * The App page runs the storage installer before any page script and the
 * bundle as a live module script, wherever the authored markup puts its
 * tags. Text the browser does not read as a tag (comments, attribute values,
 * raw-text elements, inert templates) never decides either place.
 */
import { describe, expect, it } from 'vitest';
import { composeAppHtml } from './produce';

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
  });
});
