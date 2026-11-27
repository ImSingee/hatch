/** Shared reorder persistence for sortOrder-carrying tables. */
import { and, asc, eq, type SQL } from 'drizzle-orm';
import { db, schema } from '~/db';
import { AppError } from './errors';

type SortableTable =
  | typeof schema.sidebarItems
  | typeof schema.agentProviders
  | typeof schema.agentModels;

/**
 * Move the listed rows to the front in the given order; rows that are not
 * listed keep their relative order after them, so a caller that only knows
 * part of the list still leaves every row with a distinct position.
 *
 * One transaction: a mid-flight failure must not leave half the rows on the
 * new order and half on the old. Rows are updated in id order so two
 * concurrent reorders acquire row locks in the same sequence (no deadlock);
 * whichever transaction commits last wins wholesale.
 *
 * `scope` limits the list to the rows one order covers (a provider's models,
 * a user's App pins); an id outside it counts as unknown.
 *
 * Returns every row id in its new order. Rejects duplicate and unknown ids.
 */
export async function persistSortOrder(
  table: SortableTable,
  orderedIds: string[],
  scope?: SQL,
): Promise<string[]> {
  if (new Set(orderedIds).size !== orderedIds.length)
    throw new AppError('The same id is listed more than once.', 400);
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: table.id })
      .from(table)
      .where(scope)
      .orderBy(asc(table.sortOrder), asc(table.createdAt));
    const known = new Set(rows.map((row) => row.id));
    const unknown = orderedIds.filter((id) => !known.has(id));
    if (unknown.length)
      throw new AppError(`Not found: ${unknown.join(', ')}.`, 404);
    const listed = new Set(orderedIds);
    const order = [
      ...orderedIds,
      ...rows.map((row) => row.id).filter((id) => !listed.has(id)),
    ];
    const targets = order
      .map((id, index) => ({ id, index }))
      .sort((a, b) => a.id.localeCompare(b.id));
    for (const { id, index } of targets) {
      await tx
        .update(table)
        .set({ sortOrder: index })
        .where(and(eq(table.id, id), scope));
    }
    return order;
  });
}
