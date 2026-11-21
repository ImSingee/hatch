import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

const { db, schema } = await import('~/db');
const {
  clearImageModel,
  getImageModelState,
  resolveImageModel,
  setImageModel,
} = await import('./model');

const PROVIDER_ID = '01JZZZZZZZZZZZZZZZZZZZZZZB';

beforeEach(async () => {
  await db.delete(schema.platformConfig);
  await db.delete(schema.agentProviders);
  await db.insert(schema.agentProviders).values({
    id: PROVIDER_ID,
    name: 'Images',
    apiType: 'openai-responses',
    baseUrl: 'https://images.example.test/v1',
    apiKey: 'sk-test',
    enabled: true,
  });
});

describe('image model selection', () => {
  it('can be selected, cleared and cleared again', async () => {
    const selected = await setImageModel({
      providerId: PROVIDER_ID,
      modelId: 'test-image-model',
    });
    expect(selected.selected).toMatchObject({
      providerId: PROVIDER_ID,
      modelId: 'test-image-model',
      usable: true,
    });

    expect((await clearImageModel()).selected).toBeNull();
    expect((await getImageModelState()).selected).toBeNull();
    // Generation must stop using the cleared model.
    await expect(resolveImageModel()).rejects.toMatchObject({ status: 409 });
    expect((await clearImageModel()).selected).toBeNull();
  });
});
