/** Server Functions for App icons and the instance image model (Web UI). */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { db } from '~/db';
import { authMiddleware } from './auth';
import { clearAppIcon, MAX_APP_ICON_BYTES, setAppIcon } from './apps/icon';
import {
  clearImageModel,
  getImageModelState,
  setImageModel,
} from './images/model';

/** Icon key per App id, only for Apps that have a stored icon. */
export const listAppIconsFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async (): Promise<Record<string, string>> => {
    const rows = await db.query.apps.findMany({
      columns: { id: true, icon: true },
    });
    return Object.fromEntries(
      rows.flatMap((row) => (row.icon ? [[row.id, row.icon]] : [])),
    );
  });

const uploadSchema = z.object({
  id: z.string().min(1).max(191),
  // Base64 of at most MAX_APP_ICON_BYTES; the domain service re-checks bytes.
  imageBase64: z
    .string()
    .min(1)
    .max(Math.ceil(MAX_APP_ICON_BYTES / 3) * 4),
});

export const uploadAppIconFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((data: z.input<typeof uploadSchema>) => uploadSchema.parse(data))
  .handler(({ data }) =>
    setAppIcon(data.id, Buffer.from(data.imageBase64, 'base64')),
  );

export const clearAppIconFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((id: string) => z.string().min(1).max(191).parse(id))
  .handler(({ data }) => clearAppIcon(data));

export const getImageModelFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(() => getImageModelState());

const setModelSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1).max(128),
});

export const setImageModelFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((data: z.input<typeof setModelSchema>) =>
    setModelSchema.parse(data),
  )
  .handler(({ data }) => setImageModel(data));

export const clearImageModelFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .handler(() => clearImageModel());
