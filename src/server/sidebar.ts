/** Server functions for sidebar app pins; the domain logic is in `pins.ts`. */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { authMiddleware, requireSession } from './auth';
import { pinApp, reorderAppPins, unpinApp, updateAppPin } from './pins';
import { readSidebarItems } from './workspace-read';
import { idListSchema, idSchema, nameSchema } from './validation';

export type { SidebarItem } from './workspace-read';

/** The signed-in user's App pins; every function here acts on their own. */
export const listSidebarItems = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async () => readSidebarItems((await requireSession()).user.id));

/**
 * App-level pin toggle used by the app page: `pinned: true` ensures the app has
 * at least one sidebar pin, `pinned: false` removes every pin for the app.
 */
export const setSidebarPin = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { appId: string; pinned: boolean }) =>
    z.object({ appId: idSchema, pinned: z.boolean() }).parse(input),
  )
  .handler(async ({ data }) => {
    const { user } = await requireSession();
    if (data.pinned)
      return (await pinApp(user.id, { app: data.appId, ifAbsent: true })).pin;
    await unpinApp(user.id, { app: data.appId });
    return { ok: true };
  });

/** Always create an additional sidebar pin (apps may be pinned many times). */
export const addSidebarItem = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { appId: string }) =>
    z.object({ appId: idSchema }).parse(input),
  )
  .handler(async ({ data }) => {
    const { user } = await requireSession();
    return (await pinApp(user.id, { app: data.appId })).pin;
  });

/** Remove a single sidebar pin by its id (leaves the app's other pins). */
export const removeSidebarItem = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { id: string }) => z.object({ id: idSchema }).parse(input))
  .handler(async ({ data }) => {
    const { user } = await requireSession();
    await unpinApp(user.id, { pinId: data.id });
    return { ok: true };
  });

export const updateSidebarItem = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { id: string; label: string; entryHash?: string }) =>
    z
      .object({
        id: idSchema,
        label: nameSchema,
        // normalizeEntryHash caps the stored length; this only bounds the input.
        entryHash: z.string().max(2048).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { user } = await requireSession();
    // An empty entry point means the app root; an absent one is left as is.
    await updateAppPin(user.id, data.id, {
      label: data.label,
      entryHash:
        data.entryHash === undefined ? undefined : data.entryHash || null,
    });
    return { ok: true };
  });

export const reorderSidebarItems = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((orderedIds: string[]) => idListSchema.parse(orderedIds))
  .handler(async ({ data: orderedIds }) => {
    const { user } = await requireSession();
    await reorderAppPins(user.id, orderedIds);
    return { ok: true };
  });
