import { expect, test, vi } from 'vitest';
import { renderHook } from 'vitest-browser-react';
import { useSerialSave } from './use-serial-save';

test('a slow first save cannot overwrite the order submitted after it', async () => {
  // The "server" keeps whatever is written last.
  let stored: string[] = ['a', 'b', 'c'];
  const pending: Array<() => void> = [];
  const save = vi.fn<(order: string[]) => Promise<void>>(
    (order) =>
      new Promise((resolve) => {
        pending.push(() => {
          stored = order;
          resolve();
        });
      }),
  );
  const onIdle = vi.fn<() => void>();
  const { result } = await renderHook(() => useSerialSave(save, onIdle));

  result.current(['b', 'a', 'c']); // first move, its request is slow
  result.current(['b', 'c', 'a']); // second move
  result.current(['c', 'b', 'a']); // third move, the final order

  // Only the first request is out while it is pending.
  expect(save).toHaveBeenCalledTimes(1);
  pending.shift()!();
  // The newest waiting order goes next; the second move was superseded.
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save).toHaveBeenLastCalledWith(['c', 'b', 'a']);
  expect(onIdle).not.toHaveBeenCalled();

  pending.shift()!();
  await vi.waitFor(() => expect(onIdle).toHaveBeenCalledTimes(1));
  expect(stored).toEqual(['c', 'b', 'a']);
});

test('a failed save still lets the next order through, then refetches', async () => {
  const save = vi
    .fn<(order: string[]) => Promise<void>>()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(undefined);
  const onIdle = vi.fn<() => void>();
  const { result } = await renderHook(() => useSerialSave(save, onIdle));

  result.current(['b', 'a']);
  result.current(['a', 'b']);

  await vi.waitFor(() => expect(onIdle).toHaveBeenCalledTimes(1));
  expect(save.mock.calls).toEqual([[['b', 'a']], [['a', 'b']]]);
});
