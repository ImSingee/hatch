/**
 * Server-only: the deploy-time source rules of a `native` App frontend that
 * NSH's own checks do not cover. Each finding names the App-relative file
 * and line.
 *
 * - Outside `app/custom/`, App files take their UI from `@hatch/ui` and may
 *   not import `nsh` or `nsh/*` directly.
 * - `nsh` modules are imported by name: the web player links each import,
 *   and a namespace import or `export *` of one cannot start there.
 * - No bare colours: arbitrary Tailwind colour values (`bg-[#f00]`) and
 *   Tailwind palette classes (`bg-red-500`), which NSH accepts silently,
 *   and colour literals given to colour style keys.
 * - No calls to streaming RPC methods: the host bridge carries unary calls.
 *
 * The files are parsed with the platform's TypeScript (JSX-aware, with
 * bindings resolved), not scanned as text.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';
import {
  SyntaxKind,
  type BinaryExpression,
  type CallExpression,
  type ElementAccessExpression,
  type ExportDeclaration,
  type Identifier,
  type ImportDeclaration,
  type JsxAttribute,
  type JsxExpression,
  type Node,
  type PropertyAccessExpression,
  type PropertyAssignment,
  type SourceFile,
  type VariableDeclaration,
} from 'typescript/unstable/ast';
import { API, type Checker } from 'typescript/unstable/async';
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

/** protobuf-es names a method's client function in lowerCamelCase. */
function localMethodName(name: string): string {
  const camel = name.replace(/_([a-z\d])/gi, (_, c: string) => c.toUpperCase());
  return camel.charAt(0).toLowerCase() + camel.slice(1);
}

type StreamingMethod = { label: string; kind: string };

/** Streaming methods by service descriptor name, then by client method. */
function streamingMethods(
  services: readonly RpcServiceApi[],
): Map<string, Map<string, StreamingMethod>> {
  const byService = new Map<string, Map<string, StreamingMethod>>();
  for (const service of services) {
    const methods = new Map<string, StreamingMethod>();
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
    // Generated code exports each service descriptor under its proto name.
    if (methods.size) byService.set(service.name.split('.').at(-1)!, methods);
  }
  return byService;
}

const isNshModule = (specifier: string) => /^nsh(?:\/|$)/.test(specifier);

const NSH_NAMESPACE_MESSAGE =
  'the web player links `nsh` imports by name; a namespace import or ' +
  '`export *` of an `nsh` module cannot start there. Import the names ' +
  'you use (`import { Canvas } from "nsh"`).';

function isStringLike(node: Node): node is Node & { text: string } {
  return (
    node.kind === SyntaxKind.StringLiteral ||
    node.kind === SyntaxKind.NoSubstitutionTemplateLiteral
  );
}

/** The text of an identifier, string or numeric literal name, if any. */
function nameText(node: Node | undefined): string | undefined {
  if (!node) return undefined;
  if (node.kind === SyntaxKind.Identifier || isStringLike(node)) {
    return (node as Node & { text: string }).text;
  }
  return undefined;
}

/** Skip parentheses, `!`, `as` and `satisfies` around an expression. */
function unwrap(node: Node): Node {
  let current = node as Node & { expression?: Node };
  while (
    (current.kind === SyntaxKind.ParenthesizedExpression ||
      current.kind === SyntaxKind.NonNullExpression ||
      current.kind === SyntaxKind.AsExpression ||
      current.kind === SyntaxKind.SatisfiesExpression) &&
    current.expression
  ) {
    current = current.expression as Node & { expression?: Node };
  }
  return current;
}

/** `createClient(Service, ...)` -> `Service`. */
function createdClientService(node: Node): string | undefined {
  const call = unwrap(node) as CallExpression;
  if (call.kind !== SyntaxKind.CallExpression) return undefined;
  const callee = unwrap(call.expression);
  if (
    nameText(callee) !== 'createClient' ||
    callee.kind !== SyntaxKind.Identifier
  ) {
    return undefined;
  }
  const first = call.arguments[0];
  return first && first.kind === SyntaxKind.Identifier
    ? (first as Identifier).text
    : undefined;
}

/**
 * Run the source rules over the App-authored files of the module graph. The
 * files are parsed by the platform's TypeScript (JSX-aware), and a call is a
 * streaming RPC only when its receiver binds to a Connect client of the
 * service that declares the method.
 */
export async function checkNativeSourceRules(options: {
  root: string;
  files: readonly string[];
  services: readonly RpcServiceApi[];
}): Promise<void> {
  const files = options.files.filter((file) => /\.[cm]?[jt]sx?$/.test(file));
  if (files.length === 0) return;
  const streaming = streamingMethods(options.services);
  const findings: SourceFinding[] = [];
  const project = await fs.mkdtemp(
    path.join(os.tmpdir(), 'hatch-native-rules-'),
  );
  const api = new API({ cwd: project });
  try {
    const tsconfig = path.join(project, 'tsconfig.json');
    await fs.writeFile(
      tsconfig,
      JSON.stringify({
        compilerOptions: {
          jsx: 'preserve',
          allowJs: true,
          noEmit: true,
          noLib: true,
          noResolve: true,
          types: [],
        },
        files: files.map((file) => path.join(options.root, file)),
      }),
      'utf8',
    );
    const snapshot = await api.updateSnapshot({ openProjects: [tsconfig] });
    const [tsProject] = snapshot.getProjects();
    if (!tsProject)
      throw new Error('Could not load the App source for its rules.');
    for (const file of files) {
      const source = await tsProject.program.getSourceFile(
        path.join(options.root, file),
      );
      if (!source) continue;
      findings.push(
        ...(await fileFindings(file, source, tsProject.checker, streaming)),
      );
    }
  } finally {
    await api.close();
    await fs.rm(project, { recursive: true, force: true });
  }
  if (findings.length) {
    findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    throw new NativeSourceError(
      findings,
      'Native App source validation failed:',
    );
  }
}

async function fileFindings(
  file: string,
  source: SourceFile,
  checker: Checker,
  streaming: Map<string, Map<string, StreamingMethod>>,
): Promise<SourceFinding[]> {
  const findings: SourceFinding[] = [];
  const lineOf = (node: Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const report = (node: Node, message: string) =>
    findings.push({ file, line: lineOf(node), message });
  const colourValue = (key: string | undefined, value: Node | undefined) => {
    if (!key || !COLOR_KEY.test(key) || !value) return;
    const literal = unwrap(value);
    if (isStringLike(literal) && isColorLiteral(literal.text)) {
      report(
        literal,
        `bare colour "${literal.text.trim()}" for ${key}; use a theme token ` +
          '(a class, or `token(name)` in app/custom/).',
      );
    }
  };

  // Client bindings and the member calls whose receiver may be one.
  const clientDeclarations: { name: Node; service: string }[] = [];
  const memberCalls: { receiver: Node; method: string; at: Node }[] = [];

  const visit = (node: Node): void => {
    switch (node.kind) {
      case SyntaxKind.StringLiteral:
      case SyntaxKind.NoSubstitutionTemplateLiteral:
      case SyntaxKind.TemplateHead:
      case SyntaxKind.TemplateMiddle:
      case SyntaxKind.TemplateTail: {
        const text = (node as Node & { text: string }).text;
        if (ARBITRARY_COLOR.test(text) || PALETTE_COLOR.test(text)) {
          report(
            node,
            'bare colour in a class; use a theme token class such as ' +
              '`bg-primary` or `text-muted-foreground`.',
          );
        }
        break;
      }
      case SyntaxKind.ImportDeclaration: {
        const declaration = node as ImportDeclaration;
        const specifier = nameText(declaration.moduleSpecifier);
        if (
          specifier &&
          isNshModule(specifier) &&
          declaration.importClause?.namedBindings?.kind ===
            SyntaxKind.NamespaceImport
        ) {
          report(node, `"${specifier}": ${NSH_NAMESPACE_MESSAGE}`);
        }
        break;
      }
      case SyntaxKind.ExportDeclaration: {
        const declaration = node as ExportDeclaration;
        const specifier = nameText(declaration.moduleSpecifier);
        if (
          specifier &&
          isNshModule(specifier) &&
          (!declaration.exportClause ||
            declaration.exportClause.kind === SyntaxKind.NamespaceExport)
        ) {
          report(node, `"${specifier}": ${NSH_NAMESPACE_MESSAGE}`);
        }
        break;
      }
      case SyntaxKind.PropertyAssignment: {
        const property = node as PropertyAssignment;
        colourValue(nameText(property.name), property.initializer);
        break;
      }
      case SyntaxKind.JsxAttribute: {
        const attribute = node as JsxAttribute;
        const value = attribute.initializer;
        colourValue(
          nameText(attribute.name),
          value?.kind === SyntaxKind.JsxExpression
            ? (value as JsxExpression).expression
            : value,
        );
        break;
      }
      case SyntaxKind.BinaryExpression: {
        const binary = node as BinaryExpression;
        const left = unwrap(binary.left);
        if (
          binary.operatorToken.kind === SyntaxKind.EqualsToken &&
          left.kind === SyntaxKind.PropertyAccessExpression
        ) {
          colourValue(
            nameText((left as PropertyAccessExpression).name),
            binary.right,
          );
        }
        break;
      }
      case SyntaxKind.VariableDeclaration: {
        const declaration = node as VariableDeclaration;
        const service =
          declaration.initializer &&
          createdClientService(declaration.initializer);
        if (service && declaration.name.kind === SyntaxKind.Identifier) {
          clientDeclarations.push({ name: declaration.name, service });
        }
        break;
      }
      case SyntaxKind.CallExpression: {
        const call = node as CallExpression;
        const callee = unwrap(call.expression);
        let receiver: Node | undefined;
        let method: string | undefined;
        if (callee.kind === SyntaxKind.PropertyAccessExpression) {
          const access = callee as PropertyAccessExpression;
          receiver = unwrap(access.expression);
          method = nameText(access.name);
        } else if (callee.kind === SyntaxKind.ElementAccessExpression) {
          const access = callee as ElementAccessExpression;
          receiver = unwrap(access.expression);
          method = nameText(unwrap(access.argumentExpression));
        }
        if (receiver && method) {
          memberCalls.push({ receiver, method, at: callee });
        }
        break;
      }
    }
    node.forEachChild(visit);
  };
  visit(source);

  if (streaming.size === 0 || memberCalls.length === 0) return findings;
  const reportStreaming = (service: string, method: string, at: Node) => {
    const found = streaming.get(service)?.get(method);
    if (!found) return;
    report(
      at,
      `${found.label} is a ${found.kind} RPC; the native runtime ` +
        'supports unary RPC only.',
    );
  };
  // `createClient(Service, t).watch(...)`
  const byName = memberCalls.filter(({ receiver, method, at }) => {
    const inline = createdClientService(receiver);
    if (inline) reportStreaming(inline, method, at);
    return !inline && receiver.kind === SyntaxKind.Identifier;
  });
  if (clientDeclarations.length === 0 || byName.length === 0) return findings;
  // `client.watch(...)` where `client` resolves to a client declaration.
  const symbols = await checker.getSymbolAtLocation([
    ...clientDeclarations.map(({ name }) => name),
    ...byName.map(({ receiver }) => receiver),
  ]);
  const services = new Map<number, string>();
  clientDeclarations.forEach(({ service }, index) => {
    const symbol = symbols[index];
    if (symbol) services.set(symbol.id, service);
  });
  byName.forEach(({ method, at }, index) => {
    const symbol = symbols[clientDeclarations.length + index];
    const service = symbol && services.get(symbol.id);
    if (service) reportStreaming(service, method, at);
  });
  return findings;
}
