/**
 * Builds the catalogue section of `design-system.md` from the library's
 * source: every exported component with its props (name, type, whether it is
 * optional, and its doc comment), the imperative helpers, the shared types
 * and the icon names.
 *
 * It reads the syntax trees TypeScript 7 parses (`typescript/unstable`, as
 * `scripts/build-hatch-sdk.ts` does), without resolving imports, so it needs
 * neither NSH's declarations nor a build. It enforces the catalogue's rules
 * while it reads: a component that takes `class` or `style`, or that is
 * missing from the categories below, fails generation.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Node, SourceFile, TypeNode } from 'typescript/unstable/ast';
import * as is from 'typescript/unstable/ast/is';
import { API } from 'typescript/unstable/sync';
import { ICON_GROUPS, type GeneratedIcon } from './icons.ts';

const UI_ROOT = path.resolve(import.meta.dirname, '..');
const LIB = path.join(UI_ROOT, 'src');
const REFERENCE = path.resolve(
  UI_ROOT,
  '../../skills/building-apps/references/design-system.md',
);

const START = '<!-- catalogue:start -->';
const END = '<!-- catalogue:end -->';

/** The catalogue of plan section 3.2, by category, in reading order. */
export const CATEGORIES: readonly {
  title: string;
  names: readonly string[];
}[] = [
  {
    title: 'Layout',
    names: ['Page', 'Section', 'Stack', 'Row', 'Grid', 'Card', 'Divider'],
  },
  { title: 'Navigation', names: ['AppShell', 'NavStack', 'Tabs'] },
  {
    title: 'Input',
    names: [
      'Button',
      'IconButton',
      'TextField',
      'TextArea',
      'NumberField',
      'Select',
      'Combobox',
      'Checkbox',
      'Switch',
      'RadioGroup',
      'Slider',
      'DatePicker',
      'Form',
      'Field',
    ],
  },
  {
    title: 'Display',
    names: [
      'Text',
      'Heading',
      'Badge',
      'Avatar',
      'List',
      'ListItem',
      'DataTable',
      'Stat',
      'Progress',
      'EmptyState',
      'Skeleton',
      'Icon',
    ],
  },
  {
    title: 'Feedback',
    names: ['Dialog', 'Sheet', 'AlertDialog', 'Toast', 'Tooltip', 'Menu'],
  },
  {
    title: 'Page patterns',
    names: ['ListDetailPage', 'FormPage', 'SettingsPage', 'DashboardPage'],
  },
  {
    title: 'State and start-up',
    names: [
      'mount',
      'signal',
      'memo',
      'effect',
      'resource',
      'If',
      'Each',
      'createNavStack',
    ],
  },
];

/** Props no component may take: variation is by typed props only. */
export const FORBIDDEN_PROPS = ['class', 'classList', 'style'] as const;

type Prop = { name: string; type: string; optional: boolean; doc: string };

/** What the shared vocabulary means, for props whose declaration has no doc
 * comment of its own. */
const COMMON_DOCS: Record<string, string> = {
  children: 'The content.',
  title: 'The title, in sentence case.',
  description: 'One sentence under the title or label.',
  disabled: 'Turns it off: it shows dimmed and takes no input.',
  onChange: 'Called with the new value as the user changes it.',
  onPress: 'Called when it is pressed.',
  placeholder:
    'An example shown while it is empty; never the only instruction.',
  value: 'The value, when the App controls it.',
  options: 'The choices.',
  items: 'The items.',
  label: 'What it is, in sentence case; screen readers read it as its name.',
  icon: 'An icon: one of the `Icon…` constants.',
  min: 'The smallest value.',
  max: 'The largest value.',
  maxLength: 'The most characters it takes.',
  readOnly: 'Shows the value for reading and copying, not editing.',
  justify: 'Main-axis distribution of the children.',
  tone: 'What its colour means.',
  kind: 'Its emphasis.',
  grow: 'Takes the space left in its parent.',
  size: 'Its size.',
};

export type ComponentEntry = {
  name: string;
  doc: string;
  /** Props for components; members for helper objects; empty otherwise. */
  props: Prop[];
  /** `component`, `object` (Toast, AlertDialog) or `function`. */
  kind: 'component' | 'object' | 'function' | 'reexport';
  signature?: string;
};

type Module = { file: string; source: SourceFile };

const modules = new Map<string, Module>();

function libraryFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return libraryFiles(file);
    return /\.tsx?$/.test(entry.name) ? [file] : [];
  });
}

/** Parses every library file once, with imports left unresolved. */
function parseLibrary(): void {
  if (modules.size > 0) return;
  const config = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'hatch-ui-catalogue-')),
    'tsconfig.json',
  );
  const files = libraryFiles(LIB);
  fs.writeFileSync(
    config,
    JSON.stringify({
      compilerOptions: {
        noResolve: true,
        noEmit: true,
        jsx: 'preserve',
        allowImportingTsExtensions: true,
        types: [],
      },
      files,
    }),
  );
  const api = new API();
  try {
    const project = api
      .updateSnapshot({ openProjects: [config] })
      .getProjects()[0];
    for (const file of files) {
      const source = project.program.getSourceFile(file);
      if (!source) throw new Error(`TypeScript did not parse ${file}`);
      // Read what the trees hold now: the API closes below.
      modules.set(file, { file, source });
      void source.statements.length;
    }
  } finally {
    api.close();
    fs.rmSync(path.dirname(config), { recursive: true, force: true });
  }
}

function load(file: string): Module {
  parseLibrary();
  const resolved = [
    file,
    `${file}.ts`,
    `${file}.tsx`,
    path.join(file, 'index.ts'),
  ].find((candidate) => modules.has(candidate));
  if (!resolved) throw new Error(`Cannot find ${file}`);
  return modules.get(resolved) as Module;
}

function docOf(node: Node): string {
  const docs = (node.jsDoc ?? []).filter(is.isJSDoc);
  return docs
    .map((doc) =>
      (doc.comment ?? [])
        .map((part) => (part as { text?: string }).text ?? '')
        .join(''),
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function typeText(node: Node, module: Module): string {
  return node
    .getText(module.source)
    .replace(/\s+/g, ' ')
    .replace(/;\s*}/g, ' }')
    .trim();
}

/** Where `name` is declared, following imports within the library. */
function findDeclaration(
  name: string,
  module: Module,
): { node: Node; module: Module } | null {
  for (const statement of module.source.statements) {
    if (
      (is.isTypeAliasDeclaration(statement) ||
        is.isInterfaceDeclaration(statement) ||
        is.isFunctionDeclaration(statement)) &&
      statement.name?.text === name
    ) {
      return { node: statement, module };
    }
    if (is.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          is.isIdentifier(declaration.name) &&
          declaration.name.text === name
        ) {
          return { node: statement, module };
        }
      }
    }
  }
  for (const statement of module.source.statements) {
    // `export { HatchIf as If }`: the local declaration under another name.
    if (
      is.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      is.isNamedExports(statement.exportClause)
    ) {
      const element = statement.exportClause.elements.find(
        (item) =>
          item.name.getText(module.source) === name && item.propertyName,
      );
      if (element?.propertyName) {
        return findDeclaration(
          element.propertyName.getText(module.source),
          module,
        );
      }
    }
  }
  for (const statement of module.source.statements) {
    if (
      !is.isImportDeclaration(statement) ||
      !is.isStringLiteral(statement.moduleSpecifier) ||
      !statement.moduleSpecifier.text.startsWith('.')
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !is.isNamedImports(bindings)) continue;
    const imported = bindings.elements.find(
      (element) => element.name.text === name,
    );
    if (!imported) continue;
    const target = load(
      path.resolve(path.dirname(module.file), statement.moduleSpecifier.text),
    );
    return findDeclaration(
      (imported.propertyName ?? imported.name).text,
      target,
    );
  }
  return null;
}

/** The members of a props type, resolving intersections, local aliases and
 * `Omit`. */
function membersOf(type: TypeNode, module: Module): Prop[] {
  if (is.isParenthesizedTypeNode(type)) return membersOf(type.type, module);
  if (is.isIntersectionTypeNode(type)) {
    const merged = new Map<string, Prop>();
    for (const part of type.types) {
      for (const prop of membersOf(part, module)) merged.set(prop.name, prop);
    }
    return [...merged.values()];
  }
  if (is.isTypeLiteralNode(type)) {
    return type.members.flatMap((member) => {
      if (!is.isPropertySignatureDeclaration(member) || !member.type) return [];
      return [
        {
          name: member.name.getText(module.source),
          type: typeText(member.type, module),
          optional: member.postfixToken?.getText() === '?',
          doc:
            docOf(member) ||
            COMMON_DOCS[member.name.getText(module.source)] ||
            '',
        },
      ];
    });
  }
  if (is.isTypeReferenceNode(type)) {
    const name = type.typeName.getText(module.source);
    if (name === 'Omit' && type.typeArguments?.length === 2) {
      const omitted = new Set(
        type.typeArguments[1]
          .getText(module.source)
          .split('|')
          .map((key) => key.trim().replace(/^'|'$/g, '')),
      );
      return membersOf(type.typeArguments[0], module).filter(
        (prop) => !omitted.has(prop.name),
      );
    }
    const found = findDeclaration(name, module);
    if (found && is.isTypeAliasDeclaration(found.node)) {
      return membersOf(found.node.type, found.module);
    }
    if (found && is.isInterfaceDeclaration(found.node)) {
      return found.node.members.flatMap((member) =>
        is.isPropertySignatureDeclaration(member) && member.type
          ? [
              {
                name: member.name.getText(found.module.source),
                type: typeText(member.type, found.module),
                optional: member.postfixToken?.getText() === '?',
                doc:
                  docOf(member) ||
                  COMMON_DOCS[member.name.getText(found.module.source)] ||
                  '',
              },
            ]
          : [],
      );
    }
  }
  throw new Error(
    `Cannot read the props type ${type.getText(module.source)} in ${path.relative(UI_ROOT, module.file)}`,
  );
}

/** The value exports of `src/index.ts`: name -> the module that declares it. */
function exportedValues(): Map<
  string,
  { module: Module; local: string } | 'nsh'
> {
  const index = load(path.join(LIB, 'index.ts'));
  const found = new Map<string, { module: Module; local: string } | 'nsh'>();
  for (const statement of index.source.statements) {
    if (
      !is.isExportDeclaration(statement) ||
      statement.isTypeOnly ||
      !statement.moduleSpecifier ||
      !is.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    if (!statement.exportClause) continue; // `export *`: the icons.
    if (!is.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) {
      if (element.isTypeOnly) continue;
      const local = (element.propertyName ?? element.name).text;
      found.set(
        element.name.text,
        specifier.startsWith('.')
          ? { module: load(path.join(LIB, specifier)), local }
          : 'nsh',
      );
    }
  }
  return found;
}

const NSH_DOCS: Record<string, string> = {
  signal:
    'A value that components follow: `const count = signal(0)`; read `count()`, write `count.set(1)` or `count.update((n) => n + 1)`.',
  memo: 'A value derived from signals, computed again when they change: `const total = memo(() => items().length)`.',
  effect:
    'Runs after rendering and again when the signals it reads change; a returned function cleans up.',
  resource:
    'Loads a value asynchronously: `const notes = resource(() => client.listNotes({}))`, or `resource(source, (value) => …)` to load again when the `source` accessor changes. Read `notes()` (undefined until loaded); `notes.loading()`, `notes.error()`, `notes.state()`, `notes.refetch()` and `notes.mutate(value)` control it.',
};

function describe(
  name: string,
  target: { module: Module; local: string } | 'nsh',
): ComponentEntry {
  if (target === 'nsh') {
    return { name, doc: NSH_DOCS[name] ?? '', props: [], kind: 'reexport' };
  }
  const found = findDeclaration(target.local, target.module);
  if (!found) throw new Error(`Cannot find the declaration of ${name}`);
  const { node, module } = found;
  if (is.isFunctionDeclaration(node)) {
    const doc = docOf(node);
    const parameter = node.parameters[0];
    const isComponent = /^[A-Z]/.test(name) && parameter?.type !== undefined;
    if (isComponent && parameter.name.getText(module.source) === 'props') {
      const props = membersOf(parameter.type as TypeNode, module);
      for (const forbidden of FORBIDDEN_PROPS) {
        if (props.some((prop) => prop.name === forbidden)) {
          throw new Error(`${name} takes \`${forbidden}\`: no component may`);
        }
      }
      return { name, doc, props, kind: 'component' };
    }
    const parameters = node.parameters
      .map((p) => p.getText(module.source))
      .join(', ');
    const result = node.type ? `: ${typeText(node.type, module)}` : '';
    return {
      name,
      doc,
      props: [],
      kind: 'function',
      signature: `${name}(${parameters})${result}`.replace(/\s+/g, ' '),
    };
  }
  if (is.isVariableStatement(node)) {
    const declaration = node.declarationList.declarations.find(
      (item) => is.isIdentifier(item.name) && item.name.text === target.local,
    );
    const initializer = declaration?.initializer;
    if (!initializer || !is.isObjectLiteralExpression(initializer)) {
      throw new Error(`${name} is a value the catalogue cannot describe`);
    }
    const members: Prop[] = initializer.properties.map((property) => {
      if (is.isSpreadAssignment(property)) {
        throw new Error(`${name} spreads another object; list its members`);
      }
      const memberName = property.name.getText(module.source);
      let signature = memberName;
      let doc = docOf(property);
      if (is.isShorthandPropertyAssignment(property)) {
        const local = findDeclaration(memberName, module);
        if (local && is.isFunctionDeclaration(local.node)) {
          const parameters = local.node.parameters
            .map((p) => p.getText(local.module.source))
            .join(', ');
          signature = `${memberName}(${parameters})`;
          doc ||= docOf(local.node);
        }
      } else if (
        is.isPropertyAssignment(property) &&
        is.isArrowFunction(property.initializer)
      ) {
        const parameters = property.initializer.parameters
          .map((p) => p.getText(module.source))
          .join(', ');
        signature = `${memberName}(${parameters})`;
      }
      return {
        name: memberName,
        type: signature.replace(/\s+/g, ' '),
        optional: false,
        doc,
      };
    });
    return { name, doc: docOf(node), props: members, kind: 'object' };
  }
  throw new Error(`${name} is a value the catalogue cannot describe`);
}

/** Every catalogue entry, checked against the categories. */
export function catalogueEntries(): Map<string, ComponentEntry> {
  const values = exportedValues();
  const listed = new Set(CATEGORIES.flatMap((category) => category.names));
  for (const name of values.keys()) {
    if (!listed.has(name)) {
      throw new Error(`${name} is exported but in no catalogue category`);
    }
  }
  const entries = new Map<string, ComponentEntry>();
  for (const name of listed) {
    const target = values.get(name);
    if (!target)
      throw new Error(`${name} is in the catalogue but not exported`);
    entries.set(name, describe(name, target));
  }
  return entries;
}

/** Shared types worth a table: exported object types that are not props. */
const SHARED_TYPES = [
  'Action',
  'AppSection',
  'TabItem',
  'SelectOption',
  'RadioOption',
  'MenuEntry',
  'DataTableColumn',
  'ToastOptions',
];

function sharedType(name: string): { doc: string; props: Prop[] } {
  for (const module of modules.values()) {
    const found = findDeclaration(name, module);
    if (found && is.isTypeAliasDeclaration(found.node)) {
      const type = found.node.type;
      if (is.isUnionTypeNode(type)) {
        const literal = type.types.find(is.isTypeLiteralNode);
        return {
          doc: `${docOf(found.node)} Or ${type.types
            .filter((part) => !is.isTypeLiteralNode(part))
            .map((part) => `\`${part.getText(found.module.source)}\``)
            .join(', ')}.`.trim(),
          props: literal ? membersOf(literal, found.module) : [],
        };
      }
      return { doc: docOf(found.node), props: membersOf(type, found.module) };
    }
  }
  throw new Error(`Cannot find the shared type ${name}`);
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function propTable(props: readonly Prop[], header = 'Prop'): string[] {
  if (props.length === 0) return [];
  const marked = header !== 'Member';
  return [
    `| ${header} | Type | Description |`,
    '| --- | --- | --- |',
    ...props.map(
      (prop) =>
        `| \`${prop.name}\`${marked && !prop.optional ? ' (required)' : ''} | \`${cell(prop.type)}\` | ${cell(prop.doc)} |`,
    ),
  ];
}

export function renderCatalogue(icons: readonly GeneratedIcon[]): string {
  const entries = catalogueEntries();
  const lines: string[] = [];
  for (const category of CATEGORIES) {
    lines.push(`### ${category.title}`, '');
    for (const name of category.names) {
      const entry = entries.get(name) as ComponentEntry;
      lines.push(`#### ${name}`, '');
      if (entry.doc) lines.push(entry.doc, '');
      if (entry.signature) lines.push(`\`${entry.signature}\``, '');
      if (entry.kind === 'object') {
        lines.push(...propTable(entry.props, 'Member'), '');
      } else if (entry.props.length > 0) {
        lines.push(...propTable(entry.props), '');
      }
    }
  }
  lines.push('### Shared types', '');
  for (const name of SHARED_TYPES) {
    const shared = sharedType(name);
    lines.push(`#### ${name}`, '');
    if (shared.doc) lines.push(shared.doc, '');
    lines.push(...propTable(shared.props, 'Field'), '');
  }
  lines.push(
    '### Icons',
    '',
    'Pass an icon constant: `<Icon icon={IconLeaf} />`, `<Button icon={IconPlus} … />`. ' +
      `There are ${icons.length}; a bundle keeps only those it imports.`,
    '',
  );
  const byName = new Map(icons.map((icon) => [icon.name, icon.exportName]));
  for (const [group, names] of Object.entries(ICON_GROUPS)) {
    lines.push(
      `- ${group}: ${names.map((name) => `\`${byName.get(name)}\``).join(', ')}`,
    );
  }
  return lines.join('\n');
}

export function buildCatalogueReference(
  icons: readonly GeneratedIcon[],
): string {
  const current = fs.readFileSync(REFERENCE, 'utf8');
  const start = current.indexOf(START);
  const end = current.indexOf(END);
  if (start === -1 || end < start) {
    throw new Error(`${REFERENCE} lost its catalogue markers`);
  }
  return `${current.slice(0, start + START.length)}\n\n${renderCatalogue(icons)}\n\n${current.slice(end)}`;
}
