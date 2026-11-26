import { describe, expect, it } from 'vitest';
import { compileCardMarkup } from '../../../packages/hatch-platform-api/notification-content-schema';
import {
  card,
  cardFragment,
} from '../../../sdk-internal/app/src/notifications';

// Text a user controls, trying to close the element and add its own.
const hostile = `x" tone="danger'></Title><b>&amp;</b>`;

describe('App SDK card template tag', () => {
  it('keeps interpolated values as text in content and attribute values', () => {
    const markup = card`<Card status="${hostile.slice(0, 24)}">
  <Title>${hostile}</Title>
  <Fields><Field label="${hostile}" mono="${true}">${hostile}</Field></Fields>
  <Trend values="${[3, 1.5, 7]}" threshold="${5}" />
  <Text><time datetime="${new Date('2026-11-25T02:14:00Z')}" />${null}${undefined}</Text>
</Card>`;
    const { content } = compileCardMarkup(markup);
    expect(content).toEqual({
      type: 'Card',
      props: { status: hostile.slice(0, 24) },
      children: [
        { type: 'Title', children: [hostile] },
        {
          type: 'Fields',
          children: [
            {
              type: 'Field',
              props: { label: hostile, mono: true },
              children: [hostile],
            },
          ],
        },
        {
          type: 'Trend',
          props: { values: [3, 1.5, 7], threshold: 5 },
        },
        {
          type: 'Text',
          children: [
            { type: 'time', props: { datetime: '2026-11-25T02:14:00.000Z' } },
          ],
        },
      ],
    });
  });

  it('nests fragments as markup and escapes the values inside them', () => {
    const steps = [
      { state: 'done', name: 'lint' },
      { state: 'failed', name: hostile },
    ].map(
      (step) => cardFragment`<Step state="${step.state}">${step.name}</Step>`,
    );
    const { content } = compileCardMarkup(
      card`<Card><Steps>${steps}</Steps></Card>`,
    );
    expect(content.children).toEqual([
      {
        type: 'Steps',
        children: [
          { type: 'Step', props: { state: 'done' }, children: ['lint'] },
          { type: 'Step', props: { state: 'failed' }, children: [hostile] },
        ],
      },
    ]);
    // A string that looks like markup is still text.
    expect(card`<Title>${'<b>x</b>'}</Title>`).toBe(
      '<Title>&lt;b&gt;x&lt;/b&gt;</Title>',
    );
    expect(() => card`<Text>${{ text: 'x' }}</Text>`).toThrow(TypeError);
    expect(() => card`<Text>${[steps[0], 'x']}</Text>`).toThrow(TypeError);
  });
});
