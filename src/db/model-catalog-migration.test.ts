import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { describe, expect, it } from 'vitest';

const migrationsFolder = path.resolve(import.meta.dirname, '../../migrations');

async function applyStatements(client: PGlite, statements: string[]) {
  for (const statement of statements) {
    await client.exec(statement);
  }
}

describe('model catalog migration', () => {
  it('links known vendor endpoints and keeps every stored model value', async () => {
    const client = new PGlite();
    try {
      const migrations = readMigrationFiles({ migrationsFolder });
      const index = migrations.findIndex((migration) =>
        migration.sql.some((statement) =>
          statement.includes('CREATE TABLE "model_catalog_snapshots"'),
        ),
      );
      expect(index).toBeGreaterThan(0);
      for (const migration of migrations.slice(0, index))
        await applyStatements(client, migration.sql);

      await client.query(
        `INSERT INTO agent_providers (id, name, api_type, base_url, api_key)
         VALUES
           ('p-openai', 'OpenAI', 'openai-responses', 'https://api.openai.com/v1/', 'sk-a'),
           ('p-claude', 'Claude', 'anthropic-messages', 'https://API.anthropic.com', ''),
           ('p-gateway', 'Gateway', 'openai-completions', 'https://llm.internal.example/v1', 'sk-b')`,
      );
      await client.query(
        `INSERT INTO agent_models
           (id, provider_id, model_id, name, reasoning, context_window, max_tokens)
         VALUES
           ('m-openai', 'p-openai', 'gpt-6.2-sol', 'Sol', true, 400000, 64000),
           ('m-claude', 'p-claude', 'claude-opus-5-5', 'Opus', true, 1000000, 128000),
           ('m-gateway', 'p-gateway', 'deepseek-v4-pro', 'DeepSeek', false, 128000, 8192)`,
      );

      await applyStatements(client, migrations[index].sql);

      const providers = await client.query<{
        id: string;
        catalog_provider_id: string | null;
      }>('SELECT id, catalog_provider_id FROM agent_providers ORDER BY id');
      expect(providers.rows).toEqual([
        { id: 'p-claude', catalog_provider_id: 'anthropic' },
        { id: 'p-gateway', catalog_provider_id: null },
        { id: 'p-openai', catalog_provider_id: 'openai' },
      ]);
      const models = await client.query(
        `SELECT id, catalog_ref, reasoning, context_window, max_tokens
         FROM agent_models ORDER BY id`,
      );
      // Stored values stay as overrides, so no model changes behavior.
      expect(models.rows).toEqual([
        {
          id: 'm-claude',
          catalog_ref: 'anthropic/claude-opus-5-5',
          reasoning: true,
          context_window: 1000000,
          max_tokens: 128000,
        },
        {
          id: 'm-gateway',
          catalog_ref: null,
          reasoning: false,
          context_window: 128000,
          max_tokens: 8192,
        },
        {
          id: 'm-openai',
          catalog_ref: 'openai/gpt-6.2-sol',
          reasoning: true,
          context_window: 400000,
          max_tokens: 64000,
        },
      ]);
      // Overrides can now be cleared to follow the catalog.
      await client.query(
        `UPDATE agent_models SET reasoning = NULL, context_window = NULL,
           max_tokens = NULL WHERE id = 'm-claude'`,
      );
      await client.query(
        `INSERT INTO agent_sessions (id, title, thinking_level) VALUES ('s', 't', 'xhigh')`,
      );
      await expect(
        client.query(
          `INSERT INTO agent_sessions (id, title, thinking_level) VALUES ('s2', 't', 'extreme')`,
        ),
      ).rejects.toThrow(/thinking_level_check/);
    } finally {
      await client.close();
    }
  });
});
