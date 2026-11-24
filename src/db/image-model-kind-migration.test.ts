import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { describe, expect, it } from 'vitest';

const migrationsFolder = path.resolve(import.meta.dirname, '../../migrations');

async function apply(client: PGlite, statements: string[]) {
  for (const statement of statements) await client.exec(statement);
}

describe('agent model kind migration', () => {
  it('turns the single image model selection into an image model', async () => {
    const migrations = readMigrationFiles({ migrationsFolder });
    const index = migrations.findIndex((migration) =>
      migration.sql.some((statement) =>
        statement.includes('ADD COLUMN "kind"'),
      ),
    );
    expect(index).toBeGreaterThan(0);

    const run = async (config: unknown) => {
      const client = new PGlite();
      for (const migration of migrations.slice(0, index))
        await apply(client, migration.sql);
      await client.query(
        `INSERT INTO agent_providers (id, name, api_type, base_url, api_key)
         VALUES ('p1', 'OpenAI', 'openai-responses', 'https://x.test/v1', 'k')`,
      );
      await client.query(
        `INSERT INTO agent_models (id, provider_id, model_id, name, sort_order)
         VALUES ('chat', 'p1', 'gpt-5.5', 'GPT-5.5', 3)`,
      );
      if (config === null)
        await client.query(
          `INSERT INTO platform_config (key, value)
           VALUES ('image.model', 'null'::jsonb)`,
        );
      else if (config !== undefined)
        await client.query(
          `INSERT INTO platform_config (key, value) VALUES ('image.model', $1)`,
          [config],
        );
      await apply(client, migrations[index].sql);
      const models = await client.query<{
        id: string;
        provider_id: string;
        model_id: string;
        name: string;
        kind: string;
        sort_order: number;
      }>(
        `SELECT id, provider_id, model_id, name, kind, sort_order
         FROM agent_models ORDER BY sort_order`,
      );
      const left = await client.query(
        `SELECT key FROM platform_config WHERE key = 'image.model'`,
      );
      await client.close();
      return { models: models.rows, configLeft: left.rows.length };
    };

    const migrated = await run({ providerId: 'p1', modelId: 'gpt-image-1' });
    expect(migrated.configLeft).toBe(0);
    expect(migrated.models).toEqual([
      expect.objectContaining({ id: 'chat', kind: 'chat' }),
      expect.objectContaining({
        provider_id: 'p1',
        model_id: 'gpt-image-1',
        name: 'gpt-image-1',
        kind: 'image',
        sort_order: 4,
      }),
    ]);

    // A selection naming a deleted provider, a cleared one and none at all
    // leave only the chat model.
    for (const config of [
      { providerId: 'gone', modelId: 'gpt-image-1' },
      null,
      undefined,
    ]) {
      const result = await run(config);
      expect(result.configLeft).toBe(0);
      expect(result.models.map((model) => model.id)).toEqual(['chat']);
    }
  });
});
