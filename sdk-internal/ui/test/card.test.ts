/**
 * `@hatch/ui/card` holds to the notification card contract without NSH:
 * every catalog component has a component with the catalog's props, and the
 * library's copy of the compiler builds what the platform stores.
 */
import { describe, expect, it } from 'vitest';
import {
  CONTENT_COMPONENTS,
  type PropSpec,
} from '../../../packages/hatch-platform-api/notification-content';
import { CARD_EXAMPLES } from '../../../packages/hatch-platform-api/notification-content-examples';
import { compileCardMarkup } from '../../../packages/hatch-platform-api/notification-content-schema';
import { catalogueEntries } from '../scripts/catalogue.ts';
import { compileCardMarkupWith } from '../src/card/content/compile.gen.ts';

/** The TSX names of the inline marks, which NSH cannot spell lowercase. */
const TSX_NAMES: Record<string, string> = {
  b: 'Bold',
  i: 'Italic',
  s: 'Strike',
  code: 'InlineCode',
  a: 'Link',
  time: 'Time',
  br: 'LineBreak',
};

/** Props a TSX component has beyond the markup's: the App's own. */
const APP_PROPS: Record<string, readonly string[]> = {
  Card: [
    'onSubmit',
    'onChange',
    'answers',
    'busy',
    'submitLabel',
    'repeatable',
    'onLinkPress',
  ],
  Button: ['onPress'],
};

const camel = (name: string) =>
  name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());

/** The values a prop type admits, as the catalogue writes them. */
function admits(type: string, spec: PropSpec): boolean {
  switch (spec.type) {
    case 'enum':
      return spec.values.every(
        (value) =>
          type.includes(`'${value}'`) ||
          ['ContentTone', 'Spacing', 'StepState', 'CardIconName'].some(
            (alias) => type.includes(alias),
          ),
      );
    case 'bool':
      return type === 'boolean';
    case 'int':
    case 'number':
      return type === 'number' || /^\d( \| \d)+$/.test(type);
    case 'numbers':
      return type === 'number[]';
    default:
      return type === 'string';
  }
}

describe('the card components', () => {
  const entries = catalogueEntries('card');

  it.each(
    CONTENT_COMPONENTS.filter((spec) => spec.name !== 'Document').map(
      (spec) => [spec.name, spec] as const,
    ),
  )('%s takes the catalog props', (_name, spec) => {
    const name = TSX_NAMES[spec.name] ?? spec.name;
    const entry = entries.get(name);
    expect(entry, `${name} is exported`).toBeDefined();
    const props = new Map(entry!.props.map((prop) => [prop.name, prop]));
    const expected = Object.keys(spec.props).map(camel);
    const given = [...props.keys()].filter(
      (prop) => prop !== 'children' && !APP_PROPS[name]?.includes(prop),
    );
    expect(given.sort()).toEqual([...expected].sort());
    for (const [markupName, prop] of Object.entries(spec.props)) {
      const tsx = props.get(camel(markupName))!;
      expect([markupName, tsx.optional]).toEqual([markupName, !prop.required]);
      expect([markupName, tsx.type, admits(tsx.type, prop)]).toEqual([
        markupName,
        tsx.type,
        true,
      ]);
    }
  });
});

describe("the library's copy of the compiler", () => {
  it.each(CARD_EXAMPLES.map((example) => [example.id, example.markup!]))(
    'builds the tree and form the platform stores for %s',
    (_id, markup) => {
      expect(
        compileCardMarkupWith(markup, { markdownToBlocks: () => [] }),
      ).toEqual(compileCardMarkup(markup));
    },
  );
});
