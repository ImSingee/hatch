import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { describe, expect, it } from 'vitest';
import {
  CARD_ROOT,
  MAX_SUMMARY_LENGTH,
  textToInline,
  type ContentChild,
  type ContentNode,
} from '../../packages/hatch-platform-api/notification-content';

const migrationsFolder = path.resolve(import.meta.dirname, '../../migrations');

// The #319 card the migration converts, and the tree and summary it must
// write: the reference its SQL functions are checked against.
type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
type Block =
  | { type: 'progress'; label: string; percent: number; value?: string }
  | { type: 'stats'; items: { value: string; label: string }[] }
  | { type: 'quote'; author: string; text: string; location?: string };
type Legacy = {
  title: string;
  body: string | null;
  card: { status?: { label: string; tone: Tone }; block?: Block };
};

function element(
  type: string,
  props: Record<string, string | number> | undefined,
  children: ContentChild[],
): ContentNode {
  const node: ContentNode = { type };
  if (props && Object.keys(props).length > 0) node.props = props;
  if (children.length > 0) node.children = children;
  return node;
}

function blockToContent(block: Block, tone: Tone | undefined): ContentNode {
  switch (block.type) {
    case 'progress':
      return element(
        'Progress',
        {
          label: block.label,
          ...(block.value ? { value: block.value } : {}),
          percent: block.percent,
          // The bar took the status's colour.
          ...(tone && tone !== 'neutral' ? { tone } : {}),
        },
        [],
      );
    case 'stats': {
      const stats = block.items.map((item) =>
        element('Stat', { value: item.value, label: item.label }, []),
      );
      if (stats.length === 1) return stats[0]!;
      return element(
        'Grid',
        stats.length === 2 ? undefined : { columns: stats.length },
        stats,
      );
    }
    case 'quote':
      return element(
        'Quote',
        {
          author: block.author,
          ...(block.location ? { location: block.location } : {}),
        },
        textToInline(block.text),
      );
  }
}

/** The tree a #319 card becomes: title, body, then its block. */
function legacyToContent(legacy: Legacy): ContentNode {
  const { status, block } = legacy.card;
  const children: ContentNode[] = [
    element('Title', undefined, textToInline(legacy.title)),
  ];
  const body = legacy.body ? textToInline(legacy.body) : [];
  if (body.length > 0) children.push(element('Text', undefined, body));
  if (block) children.push(blockToContent(block, status?.tone));
  return element(
    CARD_ROOT,
    status
      ? {
          status: status.label,
          ...(status.tone !== 'neutral' ? { tone: status.tone } : {}),
        }
      : undefined,
    children,
  );
}

/** The summary a #319 card's title becomes: one line, at most 200 chars. */
function summaryFromTitle(title: string): string {
  const line = title
    .replace(/[\r\n]+/g, ' ')
    .replace(/[ \t\f]+/g, ' ')
    .trim();
  const chars = Array.from(line);
  return chars.length > MAX_SUMMARY_LENGTH
    ? `${chars.slice(0, MAX_SUMMARY_LENGTH - 1).join('')}…`
    : line;
}

// Every #319 shape: no status, each tone, each block and its options, and
// titles and bodies with line breaks, blank lines and runs of whitespace.
const LEGACY: Legacy[] = [
  {
    title: 'CI running',
    body: null,
    card: {
      block: {
        type: 'progress',
        label: 'Checks',
        percent: 21,
        value: '3 / 14',
      },
    },
  },
  {
    title: 'Queued',
    body: 'Waiting for a runner',
    card: {
      status: { label: 'Queued', tone: 'neutral' },
      block: { type: 'progress', label: 'Position', percent: 0 },
    },
  },
  {
    title: 'Deploying',
    body: '',
    card: {
      status: { label: 'Rolling out', tone: 'info' },
      block: { type: 'progress', label: 'Hosts', percent: 62.5, value: '5/8' },
    },
  },
  {
    title: 'Backup done',
    body: '14 GB in 3 minutes',
    card: {
      status: { label: 'Done', tone: 'success' },
      block: { type: 'stats', items: [{ value: '14 GB', label: 'size' }] },
    },
  },
  {
    title: 'Budget',
    body: null,
    card: {
      status: { label: 'Close', tone: 'warning' },
      block: {
        type: 'stats',
        items: [
          { value: '¥3,482', label: 'spent' },
          { value: '¥518', label: 'left' },
        ],
      },
    },
  },
  {
    title: 'Outage',
    body: 'Three services down',
    card: {
      status: { label: 'Down', tone: 'danger' },
      block: {
        type: 'stats',
        items: [
          { value: '3', label: 'services' },
          { value: '12 min', label: 'so far' },
          { value: '40%', label: 'errors' },
        ],
      },
    },
  },
  {
    title: 'Line one\nLine two',
    body: 'first\n\n  second  \t line \r\nthird\f end ',
    card: { status: { label: 'Note', tone: 'info' } },
  },
  {
    title: 'Review comment',
    body: null,
    card: {
      block: {
        type: 'quote',
        author: 'Ada',
        text: 'This leaks.\nPlease fix   before merging.',
        location: 'idle-shutdown.ts:142',
      },
    },
  },
  {
    title: 'Windows\r\nline\tbreaks   here',
    body: '   \n  ',
    card: {
      status: { label: 'Reviewed', tone: 'neutral' },
      block: { type: 'quote', author: 'Grace', text: 'Looks good' },
    },
  },
];

const TEXT = [
  { title: 'Plain\nnotification', body: 'Still\ntext' },
  { title: 'No body', body: null },
];

async function applyStatements(client: PGlite, statements: string[]) {
  for (const statement of statements) await client.exec(statement);
}

/** JSON equality, whatever the key order jsonb keeps. */
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

describe('notification content migration', () => {
  it('turns #319 cards into the trees legacyToContent writes and keeps text notifications', async () => {
    const client = new PGlite();
    try {
      const migrations = readMigrationFiles({ migrationsFolder });
      const index = migrations.findIndex((migration) =>
        migration.sql.some((statement) =>
          statement.includes('"hatch_migration_card"'),
        ),
      );
      expect(index).toBeGreaterThan(0);
      for (const migration of migrations.slice(0, index)) {
        await applyStatements(client, migration.sql);
      }

      const insert = (
        id: string,
        row: {
          title: string;
          body: string | null;
          card: Legacy['card'] | null;
        },
      ) =>
        client.query(
          `INSERT INTO notifications
             (id, source_type, source_name, kind, kind_name, title, body, card, occurred_at)
           VALUES ($1, 'platform', 'Hatch', 'alert', 'Alert', $2, $3, $4, now())`,
          [
            id,
            row.title,
            row.body,
            row.card === null ? null : JSON.stringify(row.card),
          ],
        );
      const insertRevision = (
        id: string,
        revision: number,
        row: {
          title: string;
          body: string | null;
          card: Legacy['card'] | null;
        },
      ) =>
        client.query(
          `INSERT INTO notification_revisions
             (notification_id, revision, title, body, card, reply_round, activity_at, replaced_at)
           VALUES ($1, $2, $3, $4, $5, 1, now(), now())`,
          [
            id,
            revision,
            row.title,
            row.body,
            row.card === null ? null : JSON.stringify(row.card),
          ],
        );
      for (const [i, legacy] of LEGACY.entries()) {
        await insert(`card-${i}`, legacy);
        // Its earlier versions: every other card shape, and one text version.
        await insertRevision(`card-${i}`, 1, LEGACY[(i + 1) % LEGACY.length]!);
        await insertRevision(`card-${i}`, 2, { ...TEXT[0]!, card: null });
      }
      for (const [i, text] of TEXT.entries()) {
        await insert(`text-${i}`, { ...text, card: null });
      }

      await applyStatements(client, migrations[index]!.sql);

      type Row = {
        id: string;
        format: string;
        title: string | null;
        body: string | null;
        summary: string | null;
        markdown: string | null;
        content: unknown;
      };
      const cardRow = (legacy: Legacy) => ({
        format: 'card',
        title: null,
        body: null,
        summary: summaryFromTitle(legacy.title),
        markdown: null,
        content: json(legacyToContent(legacy)),
      });
      const textRow = (text: (typeof TEXT)[number]) => ({
        format: 'text',
        title: text.title,
        body: text.body,
        summary: null,
        markdown: null,
        content: null,
      });

      const rows = await client.query<Row>(
        `SELECT id, format, title, body, summary, markdown, content
         FROM notifications ORDER BY id`,
      );
      const byId = new Map(rows.rows.map(({ id, ...row }) => [id, row]));
      for (const [i, legacy] of LEGACY.entries()) {
        expect({ i, row: byId.get(`card-${i}`) }).toStrictEqual({
          i,
          row: cardRow(legacy),
        });
      }
      for (const [i, text] of TEXT.entries()) {
        expect(byId.get(`text-${i}`)).toStrictEqual(textRow(text));
      }

      const revisions = await client.query<Row & { revision: number }>(
        `SELECT notification_id AS id, revision, format, title, body, summary, markdown, content
         FROM notification_revisions ORDER BY notification_id, revision`,
      );
      expect(revisions.rows).toHaveLength(LEGACY.length * 2);
      for (const { id, revision, ...row } of revisions.rows) {
        const i = Number(id.slice('card-'.length));
        expect({ id, revision, row }).toStrictEqual({
          id,
          revision,
          row:
            revision === 1
              ? cardRow(LEGACY[(i + 1) % LEGACY.length]!)
              : textRow(TEXT[0]!),
        });
      }

      // The migration leaves nothing behind but the content check.
      const helpers = await client.query(
        `SELECT proname FROM pg_proc WHERE proname LIKE 'hatch_migration_%'`,
      );
      expect(helpers.rows).toEqual([]);
      await expect(
        client.query(
          `INSERT INTO notifications
             (id, source_type, source_name, kind, kind_name, format, title, summary, content, occurred_at)
           VALUES ('bad', 'platform', 'Hatch', 'alert', 'Alert', 'card', 'Title', 'Summary', '{"type":"Card"}', now())`,
        ),
      ).rejects.toThrow(/notifications_content_check/);
    } finally {
      await client.close();
    }
  });
});
