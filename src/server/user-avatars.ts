/** Server Functions for the signed-in user's own avatar (Web UI). */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { authMiddleware, requireSession } from './auth';
import { MAX_SQUARE_IMAGE_BYTES } from './images/square-image';
import { clearUserAvatar, setUserAvatar } from './user-avatar-store';

const uploadSchema = z.object({
  // Base64 of at most 4 MB; the domain service re-checks the bytes.
  imageBase64: z
    .string()
    .min(1)
    .max(Math.ceil(MAX_SQUARE_IMAGE_BYTES / 3) * 4),
});

export const uploadMyAvatarFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((data: z.input<typeof uploadSchema>) => uploadSchema.parse(data))
  .handler(async ({ data }) => {
    const session = await requireSession();
    return setUserAvatar(
      session.user.id,
      Buffer.from(data.imageBase64, 'base64'),
    );
  });

export const clearMyAvatarFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .handler(async () => {
    const session = await requireSession();
    return clearUserAvatar(session.user.id);
  });
