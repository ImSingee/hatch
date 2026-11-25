/**
 * A Data Table watch resumes its change stream from the revision it has
 * seen. After a reset, a query that started before it must not move that
 * cursor back to the old, higher revision.
 */
import { describe, expect, it } from 'vitest';
import {
  createDataClient,
  type DataChangeEvent,
  type DataTransport,
} from '../../../../sdk-internal/app/src/data';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Data Table watch cursor', () => {
  it('resumes from the reset revision when a query spans the reset', async () => {
    const queries: ReturnType<typeof deferred<number>>[] = [];
    const streams: {
      since: number;
      emit: (event: DataChangeEvent) => void;
      end: () => void;
    }[] = [];
    const transport: DataTransport = {
      post<T>(action: 'query' | 'mutate'): Promise<T> {
        if (action !== 'query') throw new Error('unexpected mutation');
        const query = deferred<number>();
        queries.push(query);
        return query.promise.then(
          (revision) => ({ items: [], cursor: null, revision }) as T,
        );
      },
      changes(_table, since, signal, onChange) {
        return new Promise<void>((resolve) => {
          streams.push({ since, emit: onChange, end: resolve });
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    };
    const client = createDataClient({
      transport,
      cacheNamespace: JSON.stringify(['watch-reset-test']),
    });
    const stop = client.watch({ table: 'notes' } as never, () => {});
    const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

    queries[0].resolve(100);
    await settle();
    expect(streams[0].since).toBe(100);

    // A change starts a query; a reset to revision 2 arrives while it runs.
    streams[0].emit({ revision: 101, reset: false });
    await settle();
    streams[0].emit({ revision: 2, reset: true });
    queries[1].resolve(101); // began before the reset
    await settle();
    queries[2].resolve(2); // the query the reset asked for
    await settle();

    // The stream drops; the next one resumes from the reset revision.
    streams[0].end();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(streams[1]?.since).toBe(2);
    stop();
  });
});
