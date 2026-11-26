import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';

const migrationsFolder = path.resolve(import.meta.dirname, '../../migrations');
const adminUrl = process.env.HATCH_POSTGRES_TEST_DATABASE_URL;

type Database = {
  exec(sql: string): Promise<void>;
  rows<T>(sql: string): Promise<T[]>;
  close(): Promise<void>;
};

function pglite(): Database {
  const client = new PGlite();
  return {
    exec: async (sql) => {
      await client.exec(sql);
    },
    rows: async <T>(sql: string) => (await client.query<T>(sql)).rows,
    close: () => client.close(),
  };
}

/** A fresh database on the server behind `HATCH_POSTGRES_TEST_DATABASE_URL`. */
async function server(): Promise<Database> {
  const name = `hatch_pins_migration_${process.pid}_${Date.now()}`;
  const admin = postgres(adminUrl!, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database "${name}"`);
  const url = new URL(adminUrl!);
  url.pathname = `/${name}`;
  const client = postgres(url.toString(), { max: 1, onnotice: () => {} });
  return {
    // The simple protocol runs a seed's several statements in one call.
    exec: async (sql) => {
      await client.unsafe(sql).simple();
    },
    rows: async <T>(sql: string) => [...(await client.unsafe(sql))] as T[],
    close: async () => {
      await client.end({ timeout: 1 });
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
      await admin.end();
    },
  };
}

/**
 * Applies every migration before the per-user one, runs `seed`, applies it,
 * and hands the database to `check`.
 */
async function migrate(
  open: () => Database | Promise<Database>,
  seed: string,
  check: (database: Database) => Promise<void>,
) {
  const database = await open();
  try {
    const migrations = readMigrationFiles({ migrationsFolder });
    const index = migrations.findIndex((migration) =>
      migration.sql.some((statement) =>
        statement.includes('CREATE TABLE "user_dashboards"'),
      ),
    );
    expect(index).toBeGreaterThan(0);
    for (const migration of migrations.slice(0, index))
      for (const statement of migration.sql) await database.exec(statement);
    if (seed) await database.exec(seed);
    // The migrator runs a migration as one transaction.
    await database.exec('BEGIN');
    for (const statement of migrations[index]!.sql)
      await database.exec(statement);
    await database.exec('COMMIT');
    await check(database);
  } finally {
    await database.close();
  }
}

const USERS = `
  INSERT INTO "user" (id, name, email, created_at) VALUES
    ('u-a', 'A', 'a@example.test', '2026-01-01'),
    ('u-b', 'B', 'b@example.test', '2026-01-02');`;

const WORKSPACE = `
  INSERT INTO apps (id, slug, name) VALUES
    ('app-notes', 'notes', 'Notes'),
    ('app-mail', 'mail', 'Mail');
  INSERT INTO sidebar_items (id, app_id, label, entry_hash, sort_order, created_at)
  VALUES
    ('pin-1', 'app-notes', 'Notes', NULL, 1, '2026-02-01'),
    ('pin-2', 'app-mail', 'Inbox', '/inbox', 0, '2026-02-02'),
    ('pin-3', 'app-notes', 'Journal', '/journal', 2, '2026-02-03');
  INSERT INTO dashboards (id, name, pinned, sort_order, created_at) VALUES
    ('d-home', 'Home', true, 1, '2026-03-01'),
    ('d-ops', 'Ops', false, 0, '2026-03-02');`;

type Pin = {
  id: string;
  user_id: string;
  app_id: string;
  label: string;
  entry_hash: string | null;
  sort_order: number;
};

const pinsOf = (database: Database) =>
  database.rows<Pin>(
    `SELECT id, user_id, app_id, label, entry_hash, sort_order
     FROM sidebar_items ORDER BY user_id, sort_order`,
  );

const themesOf = (database: Database) =>
  database.rows(
    `SELECT user_id, accent, dock_labels FROM user_preferences ORDER BY user_id`,
  );

function scenarios(open: () => Database | Promise<Database>) {
  it('gives every user a copy of the instance pins, order and theme', () =>
    migrate(
      open,
      `${USERS}${WORKSPACE}
      INSERT INTO user_preferences (user_id, homepage, agent_message_mode, language)
      VALUES ('u-b', '{"kind":"page","page":"apps"}', 'queue', 'zh-CN');
      INSERT INTO platform_config (key, value)
      VALUES ('ui.theme', '{"accent":"teal","dockLabels":true}');`,
      async (database) => {
        const pins = await pinsOf(database);
        for (const userId of ['u-a', 'u-b']) {
          expect(
            pins
              .filter((pin) => pin.user_id === userId)
              .map(({ app_id, label, entry_hash, sort_order }) => ({
                app_id,
                label,
                entry_hash,
                sort_order,
              })),
          ).toEqual([
            {
              app_id: 'app-mail',
              label: 'Inbox',
              entry_hash: '/inbox',
              sort_order: 0,
            },
            {
              app_id: 'app-notes',
              label: 'Notes',
              entry_hash: null,
              sort_order: 1,
            },
            {
              app_id: 'app-notes',
              label: 'Journal',
              entry_hash: '/journal',
              sort_order: 2,
            },
          ]);
        }
        // Every copy has its own id, shaped like the ones the app mints.
        expect(new Set(pins.map((pin) => pin.id)).size).toBe(6);
        for (const pin of pins) expect(pin.id).toMatch(/^[0-9a-z]{26}$/);

        expect(
          await database.rows(
            `SELECT user_id, dashboard_id, pinned, sort_order
             FROM user_dashboards ORDER BY user_id, sort_order`,
          ),
        ).toEqual([
          {
            user_id: 'u-a',
            dashboard_id: 'd-ops',
            pinned: false,
            sort_order: 0,
          },
          {
            user_id: 'u-a',
            dashboard_id: 'd-home',
            pinned: true,
            sort_order: 1,
          },
          {
            user_id: 'u-b',
            dashboard_id: 'd-ops',
            pinned: false,
            sort_order: 0,
          },
          {
            user_id: 'u-b',
            dashboard_id: 'd-home',
            pinned: true,
            sort_order: 1,
          },
        ]);
        expect(
          await database.rows(
            `SELECT column_name FROM information_schema.columns
             WHERE table_name = 'dashboards'
               AND column_name IN ('pinned', 'sort_order')`,
          ),
        ).toEqual([]);

        expect(
          await database.rows(
            `SELECT user_id, homepage, agent_message_mode, language, accent,
                    dock_labels
             FROM user_preferences ORDER BY user_id`,
          ),
        ).toEqual([
          {
            user_id: 'u-a',
            homepage: { kind: 'page', page: 'dashboard' },
            agent_message_mode: 'steer',
            language: null,
            accent: 'teal',
            dock_labels: true,
          },
          // An existing row keeps its other preferences.
          {
            user_id: 'u-b',
            homepage: { kind: 'page', page: 'apps' },
            agent_message_mode: 'queue',
            language: 'zh-CN',
            accent: 'teal',
            dock_labels: true,
          },
        ]);
        expect(
          await database.rows(
            `SELECT key FROM platform_config WHERE key = 'ui.theme'`,
          ),
        ).toEqual([]);

        // A pin now always belongs to a user.
        await expect(
          database.exec(
            `INSERT INTO sidebar_items (id, app_id, label)
             VALUES ('orphan', 'app-notes', 'Notes')`,
          ),
        ).rejects.toThrow(/user_id/);
      },
    ));

  it('copies only the theme fields that hold a usable value', () =>
    migrate(
      open,
      `${USERS}
      INSERT INTO platform_config (key, value)
      VALUES ('ui.theme', '{"accent":"teal","dockLabels":"yes"}');`,
      async (database) => {
        expect(await themesOf(database)).toEqual([
          { user_id: 'u-a', accent: 'teal', dock_labels: null },
          { user_id: 'u-b', accent: 'teal', dock_labels: null },
        ]);
      },
    ));

  it('leaves users on the defaults when the instance never set a theme', () =>
    migrate(open, USERS, async (database) => {
      expect(await themesOf(database)).toEqual([]);
      expect(await pinsOf(database)).toEqual([]);
      expect(await database.rows('SELECT * FROM user_dashboards')).toEqual([]);
    }));

  it('drops pins and the theme when there is no user to keep them', () =>
    migrate(
      open,
      `${WORKSPACE}
      INSERT INTO platform_config (key, value)
      VALUES ('ui.theme', '{"accent":"teal","dockLabels":true}');`,
      async (database) => {
        expect(await pinsOf(database)).toEqual([]);
        expect(await database.rows('SELECT * FROM user_dashboards')).toEqual(
          [],
        );
        expect(
          await database.rows('SELECT id FROM dashboards ORDER BY id'),
        ).toEqual([{ id: 'd-home' }, { id: 'd-ops' }]);
        expect(await database.rows('SELECT key FROM platform_config')).toEqual(
          [],
        );
      },
    ));

  it('runs on an empty database', () =>
    migrate(open, '', async (database) => {
      expect(await pinsOf(database)).toEqual([]);
      expect(await themesOf(database)).toEqual([]);
    }));
}

describe('per-user theme and pins migration on PGlite', () => {
  scenarios(pglite);
});

describe.skipIf(!adminUrl)(
  'per-user theme and pins migration on PostgreSQL',
  () => {
    scenarios(server);
  },
);
