/**
 * The composed App page runs in a browser as composed: the storage
 * installer first, the authored scripts intact, and the App bundle as a
 * module script once the authored body is parsed, whatever text that looks
 * like tags the authored scripts and styles hold.
 */
import { afterEach, expect, test } from 'vitest';
import { composeAppHtml } from './app-html';

const record = (name: string) => `(window.ran ??= []).push('${name}');`;

/** Runs only as a module script, once the authored body is parsed. */
const bundle =
  `export {}; ${record('bundle')}` +
  "window.ran.push(document.getElementById('last') ? 'body parsed' : 'early');";

afterEach(() => document.querySelectorAll('iframe').forEach((f) => f.remove()));

/** What the page's scripts recorded, once it has loaded. */
async function run(html: string): Promise<string[] | undefined> {
  const frame = document.createElement('iframe');
  const loaded = new Promise((resolve) =>
    frame.addEventListener('load', resolve, { once: true }),
  );
  frame.srcdoc = html;
  document.body.append(frame);
  await loaded;
  return (frame.contentWindow as (Window & { ran?: string[] }) | null)?.ran;
}

test('the installer, an authored script and the bundle all run in order', async () => {
  const authored =
    '<!doctype html><html><head><title>App</title></head><body>' +
    // Script data the HTML tokenizer escapes: the `</script>` and `</body>`
    // in it are text of this one script.
    `<script>${record('authored')} const a = "<!--<script>"; ` +
    'const b = "</script>"; const c = "</body>"; //--></script>' +
    '<style>p::after { content: "</body>"; }</style>' +
    '<p id="last">x</p></body></html>';

  const ran = await run(
    composeAppHtml(authored, record('installer'), bundle, 'app/index.html'),
  );

  expect(ran).toEqual(['installer', 'authored', 'bundle', 'body parsed']);
});

test('SVG and MathML content is read as the browser reads it', async () => {
  // No head: the installer goes before the first script, an SVG one here.
  // SVG `style` holds markup (its CDATA hides text); integration points
  // hold HTML raw text again.
  const authored =
    `<body><svg><style/><script>${record('svg')}</script></svg>` +
    '<svg><style><![CDATA[ p::after { content: "</body>"; } ]]></style>' +
    '<foreignObject><style>p::after { content: "</body>"; }</style>' +
    '</foreignObject><desc><textarea></body></textarea></desc></svg>' +
    '<math><mi><style>p::after { content: "</body>"; }</style></mi>' +
    '<annotation-xml encoding="text/html"><xmp></body></xmp>' +
    '</annotation-xml></math><p id="last">x</p></body>';

  const ran = await run(
    composeAppHtml(authored, record('installer'), bundle, 'app/index.html'),
  );

  expect(ran).toEqual(['installer', 'svg', 'bundle', 'body parsed']);
});
