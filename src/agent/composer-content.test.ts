import { describe, expect, it } from 'vitest';
import {
  compactComposerInput,
  composerDisplayText,
  composerInputSchema,
  composerModelText,
  hasComposerReference,
  hasComposerText,
  parseComposerText,
  restoreComposerInput,
} from './composer-content';

describe('Agent Composer content', () => {
  it('round-trips the public inline snapshot format without losing escaped fields or text', () => {
    const parts = [
      { type: 'text' as const, text: 'Compare\n' },
      {
        type: 'app' as const,
        id: 'app-1',
        name: 'Notes "{draft}" \\ path\nnext',
        slug: 'notes',
      },
      { type: 'text' as const, text: ' and ' },
      { type: 'app' as const, id: 'app-2', name: 'Digest }', slug: 'digest' },
      { type: 'app' as const, id: 'app-2', name: 'Digest }', slug: 'digest' },
      { type: 'text' as const, text: '\n\nDone\n' },
    ];
    expect(parseComposerText(composerModelText(parts))).toEqual(parts);
  });

  it('preserves invalid references verbatim while restoring valid neighboring references', () => {
    const invalid = [
      '@Notes',
      '@UNKNOWN{name="Notes" id="app-1"}',
      '@APP{name="Notes" id="app-1"}',
      '@APP{name="Notes" id="" slug="notes"}',
      '@APP{name="Bad\\q" id="app-1" slug="notes"}',
      '@APP{name="Notes" id="app-1" slug="notes"',
      `@APP{name=${JSON.stringify('x'.repeat(501))} id="app-1" slug="notes"}`,
    ].join('\n');
    const valid = {
      type: 'app' as const,
      id: 'app-1',
      name: 'Notes',
      slug: 'notes',
    };
    expect(
      parseComposerText(invalid + '\n' + composerModelText([valid])),
    ).toEqual([{ type: 'text', text: invalid + '\n' }, valid]);
  });

  it('keeps a removed Workflow marker from old history as plain text', () => {
    const text = 'Run @WORKFLOW{name="Digest" id="workflow-1"} nightly';
    expect(parseComposerText(text)).toEqual([{ type: 'text', text }]);
    expect(
      composerInputSchema.safeParse([
        { type: 'workflow', id: 'workflow-1', name: 'Digest' },
      ]).success,
    ).toBe(false);
  });

  it('restores a stored removed Workflow mention as its visible text', () => {
    expect(
      restoreComposerInput([
        { type: 'text', text: 'Run ' },
        { type: 'workflow', id: 'workflow-1', name: 'Digest' },
        { type: 'text', text: ' with ' },
        { type: 'app', id: 'app-1', name: 'Notes', slug: 'notes' },
      ]),
    ).toEqual([
      { type: 'text', text: 'Run @Digest with ' },
      { type: 'app', id: 'app-1', name: 'Notes', slug: 'notes' },
    ]);
  });

  it('serializes resource references differently for the UI and model', () => {
    const content = [
      { type: 'text' as const, text: 'Match ' },
      {
        type: 'app' as const,
        id: 'app-1',
        name: 'Meal "Planner"',
        slug: 'meal-planner',
      },
      { type: 'text' as const, text: '\nthen' },
    ];

    expect(composerDisplayText(content)).toBe('Match @Meal "Planner"\nthen');
    expect(composerModelText(content)).toBe(
      'Match @APP{name="Meal \\"Planner\\"" id="app-1" slug="meal-planner"}' +
        '\nthen',
    );
  });

  it('keeps reference order while compacting only adjacent text', () => {
    expect(
      compactComposerInput([
        { type: 'text', text: 'one' },
        { type: 'text', text: '' },
        { type: 'text', text: ' two' },
        { type: 'app', id: 'app-1', name: 'App One', slug: 'app-one' },
        { type: 'text', text: ' three' },
        { type: 'app', id: 'app-2', name: 'App Two', slug: 'app-two' },
      ]),
    ).toEqual([
      { type: 'text', text: 'one two' },
      { type: 'app', id: 'app-1', name: 'App One', slug: 'app-one' },
      { type: 'text', text: ' three' },
      { type: 'app', id: 'app-2', name: 'App Two', slug: 'app-two' },
    ]);
  });

  it('does not treat resource references alone as a request', () => {
    const app = {
      type: 'app' as const,
      id: 'app-1',
      name: 'App One',
      slug: 'app-one',
    };
    expect(hasComposerReference([app])).toBe(true);
    expect(hasComposerText([app])).toBe(false);
    expect(hasComposerText([{ type: 'text', text: '  ' }, app])).toBe(false);
    expect(hasComposerText([app, { type: 'text', text: 'Update this' }])).toBe(
      true,
    );
  });

  it('bounds App references', () => {
    const references = Array.from({ length: 32 }, (_, index) => ({
      type: 'app' as const,
      id: `app-${index}`,
      name: `App ${index}`,
      slug: `app-${index}`,
    }));
    expect(composerInputSchema.safeParse(references).success).toBe(true);
    expect(
      composerInputSchema.safeParse(
        references.concat({
          type: 'app',
          id: 'app-over-limit',
          name: 'App over limit',
          slug: 'app-over-limit',
        }),
      ).success,
    ).toBe(false);
  });
});
