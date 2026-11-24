/**
 * Server-only: the deploy-time source rules of a `native` App frontend that
 * NSH's own checks do not cover. Each finding names the App-relative file
 * and line.
 *
 * - Outside `app/custom/`, App files take their UI from `@hatch/ui` and may
 *   not import `nsh` or `nsh/*` directly.
 * - No bare colours: arbitrary Tailwind colour values (`bg-[#f00]`) and
 *   Tailwind palette classes (`bg-red-500`), which NSH accepts silently,
 *   and colour literals given to colour style keys.
 * - No calls to streaming RPC methods: the host bridge carries unary calls.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { sourceBoundaryPlugin } from '../../../toolchain/esbuild-plugins';
import type { RpcServiceApi } from '../manifest';

export type SourceFinding = { file: string; line: number; message: string };

export class NativeSourceError extends Error {
  constructor(
    readonly findings: SourceFinding[],
    summary: string,
  ) {
    super(
      `${summary}\n${findings
        .map((finding) => `${finding.file}:${finding.line}: ${finding.message}`)
        .join('\n')}`,
    );
    this.name = 'NativeSourceError';
  }
}

/** Directory whose files may use `nsh` directly (canvases, games). */
export const NATIVE_CUSTOM_DIR = 'app/custom/';

const ASSET_LOADERS: Record<string, esbuild.Loader> = Object.fromEntries(
  [
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.webp',
    '.svg',
    '.ttf',
    '.otf',
    '.woff',
    '.woff2',
    '.mp3',
    '.wav',
    '.mp4',
  ].map((extension) => [extension, 'empty' as const]),
);

function isAuthored(relative: string): boolean {
  return (
    !relative.startsWith('node_modules/') &&
    !relative.startsWith('.hatch/') &&
    !relative.includes('/node_modules/')
  );
}

/**
 * Walk the module graph from the App entry the way NSH will bundle it
 * (through the generated aliases) and return the App-authored files it
 * reaches. Violations of the import rule fail with every location found.
 */
export async function nativeModuleGraph(options: {
  root: string;
  entry: string;
  aliases: Readonly<Record<string, string>>;
}): Promise<string[]> {
  const { root, entry, aliases } = options;
  const canonicalRoot = await fs.realpath(root);
  const findings: SourceFinding[] = [];
  const specifiers = Object.keys(aliases).sort().join(', ');
  const plugin: esbuild.Plugin = {
    name: 'native-imports',
    setup(build) {
      build.onResolve({ filter: /^nsh(?:[/:]|$)/ }, (args) => {
        const importer = path
          .relative(canonicalRoot, args.importer)
          .split(path.sep)
          .join('/');
        if (isAuthored(importer) && !importer.startsWith(NATIVE_CUSTOM_DIR)) {
          return {
            errors: [
              {
                text:
                  `"${args.path}" may be imported only under ` +
                  `${NATIVE_CUSTOM_DIR}; take UI from @hatch/ui.`,
              },
            ],
          };
        }
        return { path: args.path, external: true };
      });
      build.onResolve({ filter: /^@hatch(?:\/|$)/ }, (args) => {
        const target = aliases[args.path];
        if (target) return { path: path.join(root, target) };
        return {
          errors: [
            {
              text:
                `Unknown Hatch SDK import "${args.path}" for a native App. ` +
                `Use one of: ${specifiers}.`,
            },
          ],
        };
      });
    },
  };
  let result: esbuild.BuildResult<{ metafile: true }>;
  try {
    result = await esbuild.build({
      absWorkingDir: root,
      entryPoints: [path.join(root, entry)],
      bundle: true,
      write: false,
      metafile: true,
      format: 'esm',
      platform: 'neutral',
      mainFields: ['module', 'main'],
      conditions: ['browser'],
      jsx: 'preserve',
      loader: ASSET_LOADERS,
      logLevel: 'silent',
      plugins: [plugin, sourceBoundaryPlugin(canonicalRoot, 'Native frontend')],
      // Keep every value import, used or not, so each one is resolved and
      // checked (TypeScript would otherwise drop unused ones as types).
      tsconfigRaw: {
        compilerOptions: { jsx: 'preserve', verbatimModuleSyntax: true },
      },
    });
  } catch (error) {
    const failure = error as esbuild.BuildFailure;
    if (!Array.isArray(failure.errors)) throw error;
    for (const message of failure.errors) {
      findings.push({
        file: message.location?.file ?? entry,
        line: message.location?.line ?? 1,
        message: message.text,
      });
    }
    throw new NativeSourceError(
      findings,
      'Native App source validation failed:',
    );
  }
  return Object.keys(result.metafile.inputs)
    .map((file) => file.split(path.sep).join('/'))
    .filter((file) => isAuthored(file) && /\.[cm]?[jt]sx?$/.test(file))
    .sort();
}

type Token =
  | { kind: 'string'; value: string; line: number }
  | { kind: 'word'; value: string; line: number }
  | { kind: 'punct'; value: string; line: number };

/**
 * A small lexer: string and template literal contents, identifiers and
 * punctuation, with comments skipped. Quoted strings end at a newline, so an
 * apostrophe in JSX text cannot swallow more than its own line.
 */
function tokens(source: string): Token[] {
  const out: Token[] = [];
  let line = 1;
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '\n') {
      line += 1;
      index += 1;
    } else if (char === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
    } else if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end < 0 ? source.length : end + 2;
      for (; index < stop; index += 1) if (source[index] === '\n') line += 1;
    } else if (char === '"' || char === "'" || char === '`') {
      const start = line;
      let value = '';
      index += 1;
      while (index < source.length && source[index] !== char) {
        if (char !== '`' && source[index] === '\n') break;
        if (source[index] === '\\') {
          value += source[index + 1] ?? '';
          index += 2;
          continue;
        }
        if (source[index] === '\n') line += 1;
        value += source[index];
        index += 1;
      }
      index += 1;
      out.push({ kind: 'string', value, line: start });
    } else if (/[A-Za-z_$]/.test(char)) {
      const match = /^[\w$]+/.exec(source.slice(index))!;
      out.push({ kind: 'word', value: match[0], line });
      index += match[0].length;
    } else if (/\s/.test(char)) {
      index += 1;
    } else {
      out.push({ kind: 'punct', value: char, line });
      index += 1;
    }
  }
  return out;
}

const COLOR_FUNCTION = '(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\\(';
const ARBITRARY_COLOR = new RegExp(
  `(?:^|[\\s:!])[a-z][\\w-]*-\\[(?:color:)?(?:#[0-9a-fA-F]{3,8}|${COLOR_FUNCTION}[^\\]]*\\))\\]`,
);
/**
 * Tailwind's built-in palette (`bg-red-500`, `text-white/80`): NSH knows
 * these classes, so they pass its unknown-class check, but they are fixed
 * colours that follow neither the theme nor the accent. A theme token never
 * has a palette name followed by a shade (`neutral-fill` is a token).
 */
const PALETTE_COLOR = new RegExp(
  '(?:^|[\\s:!])(?:bg|text|border(?:-[xytrblse])?|outline|ring(?:-offset)?|' +
    'divide|fill|stroke|from|via|to|placeholder|caret|accent|decoration|' +
    'shadow|inset-shadow|inset-ring)-(?:(?:slate|gray|zinc|neutral|stone|' +
    'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|' +
    'violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00|950)|black|white)' +
    '(?:\\/\\d+)?(?=$|[\\s!])',
);
const COLOR_KEY = /^(?:color|fill|stroke|fillStyle|strokeStyle|[a-z]\w*Color)$/;
const NAMED_COLORS = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black ' +
    'blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse ' +
    'chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan ' +
    'darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta ' +
    'darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen ' +
    'darkslateblue darkslategray darkslategrey darkturquoise darkviolet ' +
    'deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite ' +
    'forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green ' +
    'greenyellow grey honeydew hotpink indianred indigo ivory khaki ' +
    'lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral ' +
    'lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey ' +
    'lightpink lightsalmon lightseagreen lightskyblue lightslategray ' +
    'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta ' +
    'maroon mediumaquamarine mediumblue mediumorchid mediumpurple ' +
    'mediumseagreen mediumslateblue mediumspringgreen mediumturquoise ' +
    'mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite ' +
    'navy oldlace olive olivedrab orange orangered orchid palegoldenrod ' +
    'palegreen paleturquoise palevioletred papayawhip peachpuff peru pink ' +
    'plum powderblue purple rebeccapurple red rosybrown royalblue ' +
    'saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue ' +
    'slateblue slategray slategrey snow springgreen steelblue tan teal ' +
    'thistle tomato turquoise violet wheat white whitesmoke yellow ' +
    'yellowgreen'
  ).split(' '),
);
const COLOR_VALUE = new RegExp(
  `^\\s*(?:#[0-9a-fA-F]{3,8}|${COLOR_FUNCTION}.*\\))\\s*$`,
);

function isColorLiteral(value: string): boolean {
  return (
    COLOR_VALUE.test(value) || NAMED_COLORS.has(value.trim().toLowerCase())
  );
}

/** Bare colours in one file's source. */
export function bareColorFindings(
  file: string,
  source: string,
): SourceFinding[] {
  const findings: SourceFinding[] = [];
  const list = tokens(source);
  for (let index = 0; index < list.length; index += 1) {
    const token = list[index];
    if (
      token.kind === 'string' &&
      (ARBITRARY_COLOR.test(token.value) || PALETTE_COLOR.test(token.value))
    ) {
      findings.push({
        file,
        line: token.line,
        message:
          'bare colour in a class; use a theme token class such as ' +
          '`bg-primary` or `text-muted-foreground`.',
      });
      continue;
    }
    // `color: '#fff'`, `backgroundColor: "red"`, `color="#fff"`,
    // `cx.fillStyle = '#B4472A'`.
    if (
      (token.kind === 'word' || token.kind === 'string') &&
      COLOR_KEY.test(token.value)
    ) {
      const separator = list[index + 1];
      const value = list[index + 2];
      if (
        separator?.kind === 'punct' &&
        (separator.value === ':' || separator.value === '=') &&
        value?.kind === 'string' &&
        isColorLiteral(value.value)
      ) {
        findings.push({
          file,
          line: value.line,
          message:
            `bare colour "${value.value.trim()}" for ${token.value}; use a ` +
            'theme token (a class, or `token(name)` in app/custom/).',
        });
      }
    }
  }
  return findings;
}

/** protobuf-es names a method's client function in lowerCamelCase. */
function localMethodName(name: string): string {
  const camel = name.replace(/_([a-z\d])/gi, (_, c: string) => c.toUpperCase());
  return camel.charAt(0).toLowerCase() + camel.slice(1);
}

/**
 * Calls to streaming RPC methods in one file's source. A call counts only
 * when its receiver is a Connect client of the service that declares the
 * method: `const client = createClient(CounterService, transport)` then
 * `client.watchCount(...)`, or `createClient(CounterService, t).watchCount(...)`.
 * A same-named method on anything else (`data.watch(...)`, a unary method of
 * another service) is not a finding. A client passed around under another
 * name is not followed; the bridge still refuses its streaming calls at run
 * time.
 */
export function streamingCallFindings(
  file: string,
  source: string,
  services: readonly RpcServiceApi[],
): SourceFinding[] {
  // Generated code exports each service descriptor under its proto name.
  const streamingByService = new Map<
    string,
    Map<string, { label: string; kind: string }>
  >();
  for (const service of services) {
    const methods = new Map<string, { label: string; kind: string }>();
    for (const method of service.methods) {
      if (!method.clientStreaming && !method.serverStreaming) continue;
      methods.set(localMethodName(method.name), {
        label: `${service.name}/${method.name}`,
        kind:
          method.clientStreaming && method.serverStreaming
            ? 'bidirectional streaming'
            : method.clientStreaming
              ? 'client-streaming'
              : 'server-streaming',
      });
    }
    if (methods.size) {
      streamingByService.set(service.name.split('.').at(-1)!, methods);
    }
  }
  if (streamingByService.size === 0) return [];
  const list = tokens(source);
  const isPunct = (index: number, value: string) =>
    list[index]?.kind === 'punct' && list[index].value === value;
  /** The service of a `createClient(Service` starting at `index`. */
  const createdClient = (index: number) =>
    list[index]?.kind === 'word' &&
    list[index].value === 'createClient' &&
    isPunct(index + 1, '(') &&
    list[index + 2]?.kind === 'word'
      ? list[index + 2].value
      : null;
  /** Skip a balanced `( ... )` starting at `index`; returns the index after. */
  const afterParens = (index: number) => {
    let depth = 0;
    for (let at = index; at < list.length; at += 1) {
      if (isPunct(at, '(')) depth += 1;
      else if (isPunct(at, ')') && --depth === 0) return at + 1;
    }
    return list.length;
  };
  // Client variables: `<name> = createClient(<Service>, ...)`.
  const clients = new Map<string, string>();
  for (let index = 0; index + 2 < list.length; index += 1) {
    const service = createdClient(index + 2);
    if (service && list[index].kind === 'word' && isPunct(index + 1, '=')) {
      clients.set(list[index].value, service);
    }
  }
  const findings: SourceFinding[] = [];
  const report = (service: string, methodIndex: number) => {
    const name = list[methodIndex];
    if (name?.kind !== 'word' || !isPunct(methodIndex + 1, '(')) return;
    const method = streamingByService.get(service)?.get(name.value);
    if (!method) return;
    findings.push({
      file,
      line: name.line,
      message:
        `${method.label} is a ${method.kind} RPC; the native runtime ` +
        'supports unary RPC only.',
    });
  };
  for (let index = 0; index < list.length; index += 1) {
    const token = list[index];
    if (token.kind !== 'word') continue;
    // `client.watchCount(`, unless `client` is a property (`x.client`).
    const service = clients.get(token.value);
    if (service && !isPunct(index - 1, '.') && isPunct(index + 1, '.')) {
      report(service, index + 2);
      continue;
    }
    // `createClient(Service, transport).watchCount(`
    const inline = createdClient(index);
    if (inline) {
      const after = afterParens(index + 1);
      if (isPunct(after, '.')) report(inline, after + 1);
    }
  }
  return findings;
}

/** Run the lexical rules over the App-authored files of the module graph. */
export async function checkNativeSourceRules(options: {
  root: string;
  files: readonly string[];
  services: readonly RpcServiceApi[];
}): Promise<void> {
  const findings: SourceFinding[] = [];
  for (const file of options.files) {
    const source = await fs.readFile(path.join(options.root, file), 'utf8');
    findings.push(
      ...bareColorFindings(file, source),
      ...streamingCallFindings(file, source, options.services),
    );
  }
  if (findings.length) {
    throw new NativeSourceError(
      findings,
      'Native App source validation failed:',
    );
  }
}
