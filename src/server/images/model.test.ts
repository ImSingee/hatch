import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

const { db, schema } = await import('~/db');
const {
  createImageModel,
  deleteImageModel,
  listImageModels,
  resolveImageModel,
  updateImageModel,
} = await import('./model');
const { assertApiTypeKeepsModels, createProviderModel, updateProviderModel } =
  await import('~server/provider-models');
const { listModelViews, setProviderModelKind } =
  await import('~server/provider-service');
const listProviderModels = (kind?: 'chat' | 'image') =>
  listModelViews({ kind });
const { getAgentModelCatalog } = await import('~server/agent-model-catalog');

const FIRST = '01JZZZZZZZZZZZZZZZZZZZZZZA';
const SECOND = '01JZZZZZZZZZZZZZZZZZZZZZZB';
const CLAUDE = '01JZZZZZZZZZZZZZZZZZZZZZZC';

beforeEach(async () => {
  await db.delete(schema.agentProviders);
  await db.insert(schema.agentProviders).values([
    {
      id: FIRST,
      name: 'First',
      apiType: 'openai-responses',
      baseUrl: 'https://first.example.test/v1',
      apiKey: 'sk-first',
      enabled: true,
      sortOrder: 0,
    },
    {
      id: SECOND,
      name: 'Second',
      apiType: 'openai-completions',
      baseUrl: 'https://second.example.test/v1',
      apiKey: 'sk-second',
      enabled: true,
      sortOrder: 1,
    },
    {
      id: CLAUDE,
      name: 'Claude',
      apiType: 'anthropic-messages',
      baseUrl: 'https://claude.example.test',
      apiKey: 'sk-claude',
      enabled: true,
      sortOrder: 2,
    },
  ]);
});

describe('image models', () => {
  it('lets each generation pick one of several models, else the default', async () => {
    const draft = await createImageModel({
      providerId: FIRST,
      modelId: 'draft-model',
      description: 'Fast drafts',
    });
    const fine = await createImageModel({
      providerId: SECOND,
      modelId: 'fine-model',
      name: 'Fine',
    });

    const list = await listImageModels();
    expect(list.models.map((model) => model.id)).toEqual([draft.id, fine.id]);
    expect(list.defaultModelId).toBe(draft.id);
    expect(list.models[0]).toMatchObject({
      name: 'draft-model',
      description: 'Fast drafts',
      usable: true,
    });
    // Only providers whose API can make images may hold image models.
    expect(list.providers.map((provider) => provider.id)).toEqual([
      FIRST,
      SECOND,
    ]);

    expect(await resolveImageModel()).toMatchObject({
      id: draft.id,
      modelId: 'draft-model',
      provider: { apiKey: 'sk-first' },
    });
    expect(await resolveImageModel(fine.id)).toMatchObject({
      id: fine.id,
      modelId: 'fine-model',
      provider: { apiKey: 'sk-second' },
    });

    // A disabled provider: its model is unusable when named, skipped as the
    // default.
    await db
      .update(schema.agentProviders)
      .set({ enabled: false })
      .where(eq(schema.agentProviders.id, FIRST));
    await expect(resolveImageModel(draft.id)).rejects.toMatchObject({
      status: 409,
    });
    expect((await resolveImageModel()).id).toBe(fine.id);
    expect((await listImageModels()).defaultModelId).toBe(fine.id);

    await deleteImageModel(fine.id);
    await expect(resolveImageModel()).rejects.toMatchObject({ status: 409 });
    await expect(resolveImageModel(fine.id)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('keeps image and chat models apart', async () => {
    const chat = await createProviderModel({
      providerId: FIRST,
      kind: 'chat',
      modelId: 'chat-model',
    });
    const image = await createImageModel({
      providerId: FIRST,
      modelId: 'image-model',
    });

    // Image models never run the Agent; chat models never make images.
    const catalog = await getAgentModelCatalog();
    expect(catalog.providers[0].models.map((model) => model.id)).toEqual([
      chat.id,
    ]);
    await expect(resolveImageModel(chat.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      updateImageModel({ id: chat.id, name: 'Renamed' }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(deleteImageModel(chat.id)).rejects.toMatchObject({
      status: 404,
    });
    expect(
      await db.query.agentModels.findFirst({ where: { id: chat.id } }),
    ).toMatchObject({ name: 'chat-model', kind: 'chat' });

    const updated = await updateImageModel({
      id: image.id,
      modelId: 'image-model-2',
      description: 'Photos',
    });
    expect(updated).toMatchObject({
      modelId: 'image-model-2',
      description: 'Photos',
    });
    expect(
      (await updateImageModel({ id: image.id, description: '' })).description,
    ).toBe('');
  });

  it('moves a model between chat and image when its kind changes', async () => {
    const chat = await createProviderModel({
      providerId: FIRST,
      kind: 'chat',
      modelId: 'gpt-image-1',
    });
    await updateProviderModel({ id: chat.id, kind: 'image' });
    expect((await resolveImageModel()).id).toBe(chat.id);
    expect((await getAgentModelCatalog()).providers).toEqual([]);

    // The public call moves it back, as the Web form's Category does.
    expect(await setProviderModelKind(chat.id, 'chat')).toMatchObject({
      id: chat.id,
      kind: 'chat',
    });
    await expect(resolveImageModel()).rejects.toMatchObject({ status: 409 });
    expect((await listProviderModels('image')).map((m) => m.id)).toEqual([]);
    expect((await listProviderModels('chat')).map((m) => m.id)).toEqual([
      chat.id,
    ]);

    const claude = await createProviderModel({
      providerId: CLAUDE,
      kind: 'chat',
      modelId: 'claude-model',
    });
    await expect(
      setProviderModelKind(claude.id, 'image'),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects image models a provider could not run', async () => {
    await expect(
      createImageModel({ providerId: CLAUDE, modelId: 'image-model' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      createImageModel({ providerId: FIRST, modelId: 'bad id' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      createImageModel({
        providerId: FIRST,
        modelId: 'image-model',
        description: 'x'.repeat(201),
      }),
    ).rejects.toMatchObject({ status: 400 });

    await createImageModel({ providerId: FIRST, modelId: 'image-model' });
    // Switching to an API type without an image driver would orphan it.
    await expect(
      assertApiTypeKeepsModels(FIRST, 'anthropic-messages'),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      assertApiTypeKeepsModels(FIRST, 'openai-completions'),
    ).resolves.toBeUndefined();
    // Saving a provider resends its unchanged API type; that never blocks.
    await db
      .update(schema.agentProviders)
      .set({ apiType: 'anthropic-messages' })
      .where(eq(schema.agentProviders.id, FIRST));
    await expect(
      assertApiTypeKeepsModels(FIRST, 'anthropic-messages'),
    ).resolves.toBeUndefined();
    await expect(
      assertApiTypeKeepsModels(SECOND, 'anthropic-messages'),
    ).resolves.toBeUndefined();
  });
});
