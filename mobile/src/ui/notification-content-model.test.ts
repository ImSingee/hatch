/** The phone draws every component of the catalog and survives new ones. */
import { describe, expect, it } from 'vitest';
import {
  CONTENT_COMPONENTS,
  isNode,
  nodeChildren,
  propString,
  type ContentNode,
} from '../../../packages/hatch-platform-api/notification-content';
import {
  CARD_EXAMPLES,
  MARKDOWN_EXAMPLE,
} from '../../../packages/hatch-platform-api/notification-content-examples';
import {
  compileCardMarkup,
  compileMarkdown,
} from '../../../packages/hatch-platform-api/notification-content-schema';
import {
  BLOCK_TYPES,
  INLINE_TYPES,
  PART_TYPES,
  codeLines,
  contentTime,
  fieldFromTree,
  flowGroups,
  holdsButtons,
  inlineForm,
  isKnownType,
  stackButtons,
  trendBars,
} from './notification-content-model';

const examples = CARD_EXAMPLES.map((example) => ({
  id: example.id,
  ...compileCardMarkup(example.markup!),
}));

type Walked = { types: Set<string>; unread: string[]; times: string[] };

/**
 * Walks a tree the way the renderer does, running every decision it makes
 * for each node: the types it met, inputs it could not read and the times
 * it showed.
 */
function walk(node: ContentNode, seen: Walked) {
  seen.types.add(node.type);
  for (const group of flowGroups(nodeChildren(node))) {
    if (group.kind === 'block') walk(group.node, seen);
    else
      for (const child of group.children) if (isNode(child)) walk(child, seen);
  }
  if (holdsButtons(node)) stackButtons(nodeChildren(node));
  if (node.type === 'Code') codeLines(node);
  if (node.type === 'Trend') {
    const values = node.props?.values;
    trendBars(Array.isArray(values) ? values : [], undefined);
  }
  if (
    ['Choice', 'Buttons', 'Input'].includes(node.type) &&
    !fieldFromTree(node)
  ) {
    seen.unread.push(node.type);
  }
  const at = propString(node, 'at') ?? propString(node, 'datetime');
  if (at) seen.times.push(contentTime(at, 'step'));
}

describe('notification content renderer', () => {
  it('draws every component in the catalog', () => {
    const drawn = new Set<string>([
      ...BLOCK_TYPES,
      ...INLINE_TYPES,
      ...Object.keys(PART_TYPES),
    ]);
    for (const spec of CONTENT_COMPONENTS) expect(drawn).toContain(spec.name);
    // Parts are drawn by parents it draws.
    for (const parent of Object.values(PART_TYPES))
      expect(drawn).toContain(parent);
  });

  it('walks every example card and the Markdown example', () => {
    const seen: Walked = { types: new Set(), unread: [], times: [] };
    for (const example of examples) walk(example.content, seen);
    walk(compileMarkdown(MARKDOWN_EXAMPLE.markdown!), seen);
    expect([...seen.types].filter((type) => !isKnownType(type))).toEqual([]);
    // The examples exercise the catalog, not a corner of it.
    expect(seen.types.size).toBeGreaterThan(35);
    expect(seen.unread).toEqual([]);
    expect(seen.times.length).toBeGreaterThan(0);
    expect(seen.times.filter((time) => !time || time.includes('T'))).toEqual(
      [],
    );
  });

  it('reads each inline question from the tree as the platform compiled it', () => {
    expect(
      examples
        .filter((example) => !example.reply)
        .map((example) => inlineForm(example.content, example.reply)),
    ).toEqual(examples.filter((e) => !e.reply).map(() => null));
    const asking = examples.filter((example) => example.reply);
    expect(asking.length).toBeGreaterThan(5);
    for (const { content, reply } of asking) {
      const fromTree: unknown[] = [];
      const visit = (node: ContentNode) => {
        const field = fieldFromTree(node);
        if (field) fromTree.push(field);
        for (const child of nodeChildren(node)) if (isNode(child)) visit(child);
      };
      visit(content);
      const shape = (field: unknown) => {
        const { id, type, label, required, options } = field as {
          id: string;
          type: string;
          label: string;
          required: boolean;
          options?: { id: string; label: string }[];
        };
        return {
          id,
          type,
          label,
          required,
          options: options?.map((option) => [option.id, option.label]),
        };
      };
      expect(fromTree.map(shape)).toEqual(reply!.fields.map(shape));
    }
  });

  it('adds a submit button only when the card has none and no buttons send it', () => {
    const byId = new Map(examples.map((example) => [example.id, example]));
    const form = (id: string) =>
      inlineForm(byId.get(id)!.content, byId.get(id)!.reply);
    expect(form('alert')).toEqual({ addSubmit: false }); // has <Submit>
    expect(form('perm')).toEqual({ addSubmit: false }); // buttons send it
    expect(form('digest')).toBeNull();
    const input = compileCardMarkup(
      '<Card><Input id="why" label="Why?" required /></Card>',
    );
    expect(inlineForm(input.content, input.reply)).toEqual({ addSubmit: true });
  });

  it('stacks a row of buttons with the main action first and links last', () => {
    const pr258 = examples.find((example) => example.id === 'pr258')!;
    const row = pr258.content.children!.find(
      (child): child is ContentNode => isNode(child) && child.type === 'Row',
    )!;
    expect(holdsButtons(row)).toBe(true);
    expect(
      stackButtons(nodeChildren(row)).buttons.map((item) =>
        item.kind === 'answer' ? item.optionId : item.kind,
      ),
    ).toEqual(['fix', 'later', 'link']);
  });

  it('draws what a type it does not know holds, and skips it when empty', () => {
    expect(
      flowGroups([
        { type: 'Sparkline', props: { values: [1, 2] } },
        {
          type: 'Highlight',
          children: ['New ', { type: 'b', children: ['text'] }],
        },
        { type: 'Panel', children: [{ type: 'Divider' }] },
      ]),
    ).toEqual([
      { kind: 'inline', children: ['New ', { type: 'b', children: ['text'] }] },
      { kind: 'block', node: { type: 'Divider' } },
    ]);
  });
});
