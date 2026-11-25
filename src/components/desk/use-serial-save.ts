import { useCallback, useEffect, useRef } from 'react';

/**
 * Save whole-state values (such as a complete order) one at a time. A value
 * submitted while a save is in flight waits for it and replaces any value
 * still waiting, so requests reach the server in submit order and the last
 * submitted value is the last one written. Two overlapping saves could
 * otherwise land out of order and leave the older value stored.
 *
 * `onIdle` runs once the queue drains (to refetch the saved state) rather
 * than after every save, so a refetch never shows an intermediate value.
 * A failed save is left to `save` to report; the queue moves on.
 */
export function useSerialSave<T>(
  save: (value: T) => Promise<unknown>,
  onIdle: () => unknown,
): (value: T) => void {
  const saveRef = useRef(save);
  const onIdleRef = useRef(onIdle);
  useEffect(() => {
    saveRef.current = save;
    onIdleRef.current = onIdle;
  });
  const state = useRef<{ running: boolean; next: { value: T } | null }>({
    running: false,
    next: null,
  });

  return useCallback((value: T) => {
    const queue = state.current;
    if (queue.running) {
      queue.next = { value };
      return;
    }
    queue.running = true;
    void (async () => {
      let current: { value: T } | null = { value };
      while (current) {
        queue.next = null;
        try {
          await saveRef.current(current.value);
        } catch {
          // Reported by `save`; the refetch in `onIdle` restores what the
          // server holds.
        }
        current = queue.next;
      }
      queue.running = false;
      await onIdleRef.current();
    })();
  }, []);
}
