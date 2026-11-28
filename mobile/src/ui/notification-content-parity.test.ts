/**
 * The phone's renderer decisions agree with the platform: each inline
 * question it reads from the tree is the field the platform compiled, each
 * stack of buttons holds the buttons the renderer-neutral outline lists,
 * a preview checks the options the outline checks, and content splits into
 * paragraphs where the catalog places it inline. Each holds with the
 * notification's reply bound and without one, where the phone reads the
 * questions from the tree.
 */
import { describe, expect, it } from 'vitest';
import {
  CONTENT_COMPONENTS,
  inlineText,
  nodeChildren,
  walkContent,
  type ContentNode,
} from '../../../packages/hatch-platform-api/notification-content';
import { CARD_EXAMPLES } from '../../../packages/hatch-platform-api/notification-content-examples';
import { contentOutline } from '../../../packages/hatch-platform-api/notification-content-outline';
import {
  answerOf,
  optionName,
  type ReplyForm,
} from '../../../packages/hatch-platform-api/notification-reply';
import { compileCardMarkup } from '../../../packages/hatch-platform-api/notification-content-schema';
import {
  fieldFromTree,
  flowGroups,
  holdsButtons,
  inlineField,
  shownAnswers,
  stackButtons,
} from './notification-content-model';

const examples = CARD_EXAMPLES.map((example) => ({
  id: example.id,
  ...compileCardMarkup(example.markup!),
}));

/**
 * Where the phone knowingly differs from the outline: the button labels of
 * a row that holds buttons, by example id and row. The phone stacks a row's
 * buttons one per line, main action first and links last
 * (`stackButtons`), where the outline keeps the sender's order.
 */
const KNOWN_BUTTON_ORDER: Record<string, string[]> = {
  'pr258.Row': ['修复它', '稍后处理', '查看 PR'],
};

describe('notification content parity', () => {
  it('reads every inline question from the tree as the platform compiled it', () => {
    for (const { id, content, reply } of examples) {
      const fromTree = [...walkContent(content)].flatMap(({ node }) => {
        const field = fieldFromTree(node);
        return field ? [field] : [];
      });
      expect({ [id]: fromTree }).toEqual({ [id]: reply?.fields ?? [] });
    }
    expect(examples.filter((example) => example.reply).length).toBeGreaterThan(
      5,
    );
  });

  it.each([
    ['bound to the reply', true],
    ['without a reply', false],
  ])(
    'stacks the buttons the outline lists for each row of buttons, %s',
    (_, bound) => {
      const found: Record<string, string[]> = {};
      let rows = 0;
      for (const { id, content, reply: compiled } of examples) {
        const reply: ReplyForm | null = bound ? compiled : null;
        for (const { node } of walkContent(content)) {
          if (node.type !== 'Row' && node.type !== 'Column') continue;
          if (!holdsButtons(node)) continue;
          rows += 1;
          // The field the renderer finds for the button's Buttons.
          const optionLabels = (buttons: ContentNode, optionId: string) => {
            const { field } = inlineField(buttons, reply);
            if (!field || field.type === 'text') return [];
            return field.options
              .filter((option) => option.id === optionId)
              .map((option) => option.label);
          };
          const outline = contentOutline(node)
            .entries.filter((entry) => entry.role === 'button')
            .map((entry) => entry.name);
          // As a preview: without a live form, no submit button.
          const stacked = stackButtons(nodeChildren(node)).buttons.flatMap(
            (item) =>
              item.kind === 'link'
                ? [inlineText(nodeChildren(item.node)) || item.href]
                : item.kind === 'answer'
                  ? optionLabels(item.field, item.optionId)
                  : [],
          );
          if (stacked.join('\n') === outline.join('\n')) continue;
          // The same buttons, only in another order, or a real difference.
          const key = `${id}.${node.type}`;
          expect({ [key]: [...stacked].sort() }).toEqual({
            [key]: [...outline].sort(),
          });
          found[key] = stacked;
        }
      }
      expect(rows).toBeGreaterThan(1);
      expect(found).toEqual(KNOWN_BUTTON_ORDER);
    },
  );

  it.each([
    ['bound to the reply', true],
    ['without a reply', false],
  ])('checks in a preview the options the outline checks, %s', (_, bound) => {
    let options = 0;
    for (const { id, content, reply: compiled } of examples) {
      const reply: ReplyForm | null = bound ? compiled : null;
      const outline = contentOutline(content).entries.filter(
        (entry) => entry.role === 'radio' || entry.role === 'checkbox',
      );
      // Each option as the phone draws it unanswered, in reading order.
      const drawn = [...walkContent(content)].flatMap(({ node }) => {
        if (node.type !== 'Choice') return [];
        const { field } = inlineField(node, reply);
        if (!field || (field.type !== 'single' && field.type !== 'multiple')) {
          return [];
        }
        const current = answerOf(shownAnswers(field, null), field.id);
        return field.options.map((option) => ({
          role: field.type === 'single' ? 'radio' : 'checkbox',
          name: optionName(option),
          checked: Array.isArray(current)
            ? current.includes(option.id)
            : current === option.id,
        }));
      });
      options += drawn.length;
      expect({ [id]: drawn }).toEqual({ [id]: outline });
    }
    expect(options).toBeGreaterThan(3);
  });

  it('shows the answer given, not the defaults, once a round is answered', () => {
    const choice = examples
      .flatMap(({ reply }) => reply?.fields ?? [])
      .find((field) => field.type === 'multiple' && field.default?.length);
    expect(choice).toBeDefined();
    // Answered without choosing any: nothing is checked.
    expect(answerOf(shownAnswers(choice!, {}), choice!.id)).toBeUndefined();
  });

  it('splits flow content where the catalog places a component inline', () => {
    const split = (name: string) =>
      flowGroups([{ type: name, children: ['x'] }])[0]?.kind === 'block'
        ? 'block'
        : 'inline';
    expect(
      Object.fromEntries(
        CONTENT_COMPONENTS.map((spec) => [spec.name, split(spec.name)]),
      ),
    ).toEqual(
      Object.fromEntries(
        CONTENT_COMPONENTS.map((spec) => [
          spec.name,
          spec.placement === 'inline' || spec.placement === 'both'
            ? 'inline'
            : 'block',
        ]),
      ),
    );
  });
});
