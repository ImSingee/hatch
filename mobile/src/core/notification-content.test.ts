/** What the phone reads from a notification's content fields. */
import { create } from '@bufbuild/protobuf';
import {
  ListNotificationRevisionsResponseSchema,
  NotificationSummarySchema,
} from '@hatch/platform-api';
import { describe, expect, it } from 'vitest';
import {
  notificationSummaryProjection,
  versionsPageProjection,
} from './rpc-projections';

const tree = {
  type: 'Card',
  props: { status: 'CI failed', tone: 'danger', flag: 'Urgent' },
  children: [
    { type: 'Title', children: ['PR #261'] },
    {
      type: 'Text',
      children: ['Two checks ', { type: 'b', children: ['failed'] }],
    },
  ],
};

const summary = (fields: Record<string, unknown>) =>
  notificationSummaryProjection(
    create(NotificationSummarySchema, {
      id: 'n1',
      sourceType: 'app',
      sourceName: 'GitHub',
      kind: 'pr',
      kindName: 'Pull request',
      occurredAt: '2026-11-25T10:00:00Z',
      createdAt: '2026-11-25T10:00:00Z',
      activityAt: '2026-11-25T10:00:00Z',
      status: 'delivered',
      revision: 1,
      ...fields,
    }),
  );

describe('notification content projection', () => {
  it('keeps a text notification as title and body', () => {
    expect(
      summary({ format: 'text', title: 'Backup done', body: '14 GB' }),
    ).toMatchObject({
      format: 'text',
      title: 'Backup done',
      body: '14 GB',
      summary: null,
      content: null,
    });
    // Instances from before formats send none.
    expect(summary({ title: 'Backup done' })).toMatchObject({
      format: 'text',
      title: 'Backup done',
    });
  });

  it('reads a card by its format, not the title and body kept for old builds', () => {
    expect(
      summary({
        format: 'card',
        // What builds without formats show.
        title: 'PR #261 failed CI',
        body: 'PR #261\nTwo checks failed',
        summary: 'PR #261 failed CI',
        contentJson: JSON.stringify(tree),
        text: 'PR #261\nTwo checks failed',
        card: { status: { label: 'CI failed', tone: 'danger' } },
      }),
    ).toMatchObject({
      format: 'card',
      title: null,
      body: null,
      summary: 'PR #261 failed CI',
      markdown: null,
      content: tree,
      text: 'PR #261\nTwo checks failed',
    });
  });

  it('keeps the Markdown source of a Markdown notification', () => {
    const projected = summary({
      format: 'markdown',
      title: 'v12 released',
      summary: 'v12 released',
      markdown: '## v12\n- fixed login',
      contentJson: JSON.stringify({
        type: 'Document',
        children: [{ type: 'Title', children: ['v12'] }],
      }),
    });
    expect(projected.markdown).toBe('## v12\n- fixed login');
    expect(projected.content?.type).toBe('Document');
  });

  it('never fails on content it cannot read, and falls back to the plain text', () => {
    for (const contentJson of ['{', '[]', 'null', '"Card"', '{"type":5}']) {
      expect(
        summary({
          format: 'card',
          title: 'Summary',
          summary: 'Summary',
          contentJson,
          text: 'Plain',
        }),
      ).toMatchObject({ content: null, summary: 'Summary', text: 'Plain' });
    }
    // Malformed parts are dropped; the rest still renders.
    expect(
      summary({
        format: 'card',
        summary: 'Summary',
        contentJson: JSON.stringify({
          type: 'Card',
          props: { status: 'Ok', tone: { bad: true }, percent: Infinity },
          children: [
            'text',
            '',
            7,
            null,
            { children: ['no type'] },
            { type: 'Text', children: 'not a list' },
            { type: 'Trend', props: { values: [1, 'two', 3] } },
          ],
        }),
      }).content,
    ).toEqual({
      type: 'Card',
      props: { status: 'Ok' },
      children: ['text', { type: 'Text' }, { type: 'Trend', props: {} }],
    });
  });

  it('shows a format added later the way builds without formats do', () => {
    expect(
      summary({
        format: 'diagram',
        title: 'A summary',
        body: 'Plain text',
        contentJson: JSON.stringify(tree),
      }),
    ).toMatchObject({
      format: 'text',
      title: 'A summary',
      body: 'Plain text',
      content: null,
    });
  });

  it('projects kept versions the same way', () => {
    const page = versionsPageProjection(
      create(ListNotificationRevisionsResponseSchema, {
        revisions: [
          {
            revision: 2,
            format: 'card',
            title: 'Earlier',
            summary: 'Earlier',
            contentJson: JSON.stringify(tree),
            activityAt: '2026-11-25T10:00:00Z',
            replacedAt: '2026-11-25T11:00:00Z',
          },
          {
            revision: 1,
            format: 'card',
            title: 'Unreadable',
            summary: 'Unreadable',
            contentJson: '{"type":',
            text: 'Plain',
            activityAt: '2026-11-25T09:00:00Z',
            replacedAt: '2026-11-25T10:00:00Z',
          },
        ],
      }),
    );
    expect(page.versions[0]).toMatchObject({
      format: 'card',
      title: null,
      summary: 'Earlier',
      content: tree,
    });
    expect(page.versions[1]).toMatchObject({ content: null, text: 'Plain' });
  });
});
