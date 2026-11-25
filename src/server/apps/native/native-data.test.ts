/**
 * A native App's Data Table watch goes through `hatch.data.events` long
 * polls. A poll that answers empty at once (an empty proxy response) must
 * reach the watch loop's backoff instead of being asked again immediately.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const call = vi.fn<(name: string, args: unknown) => Promise<unknown>>();

vi.mock('nsh', () => ({
  host: {
    call: (name: string, args: unknown) => call(name, args),
    on: vi.fn<() => () => void>(),
  },
  setTheme: vi.fn<() => void>(),
}));

const { createAppDataClient } =
  await import('../../../../sdk-internal/app/src/native');

afterEach(() => {
  call.mockReset();
  vi.useRealTimers();
});

describe('native Data Table watch', () => {
  it('backs off when event polls come back empty at once', async () => {
    vi.useFakeTimers();
    call.mockImplementation(async (name) => {
      if (name === 'hatch.data.query') {
        return { ok: true, result: { items: [], revision: 1 } };
      }
      // An empty proxy response: the poll ends quickly with no events.
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { ok: true, events: [] };
    });
    const client = createAppDataClient();
    const stop = client.watch({ table: 'counters' } as never, () => {});
    const polls = () =>
      call.mock.calls.filter(([name]) => name === 'hatch.data.events').length;
    await vi.advanceTimersByTimeAsync(0);
    const first = polls();
    expect(first).toBeGreaterThan(0);
    // Without a backoff this asks again every 10 ms (~300 polls); with it,
    // about one poll per second.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(polls() - first).toBeLessThanOrEqual(4);
    stop();
  });
});
