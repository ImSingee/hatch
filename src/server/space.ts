import { createServerFn } from '@tanstack/react-start';
import { db } from '~/db';
import { authMiddleware } from './auth';

/**
 * The name the menu bar shows for this instance. A Hatch instance is one
 * shared space, so the name is the same for every signed-in user: it comes
 * from the first account, the one that set the instance up. There is no
 * stored, editable space name; this is a label, not a setting.
 */
export function spaceName(ownerName: string | null | undefined): string {
  const first = ownerName?.trim().split(/\s+/)[0];
  return first ? `${first}’s space` : 'Hatch';
}

export const getSpaceSummary = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async (): Promise<{ name: string }> => {
    const owner = await db.query.user.findFirst({
      orderBy: { createdAt: 'asc', id: 'asc' },
      columns: { name: true },
    });
    return { name: spaceName(owner?.name) };
  });
