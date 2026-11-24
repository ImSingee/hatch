import { describe, expect, it, vi } from 'vitest';
import { MAX_RUN_STEP_EVENTS, RunEventStream } from './run-events';

describe('run event stream', () => {
  it('splits records across chunks, keeps plain lines as log and ignores unstored records', async () => {
    const events: unknown[] = [];
    const stream = new RunEventStream({
      onEvent: async (event) => {
        events.push(event);
      },
      onOverflow: () => {},
    });
    stream.stdout(
      '[[hatch]]{"t":"run:start","startedAt":"x"}\nhello\n[[hatch]]{"t":"step:st',
    );
    stream.stdout('art","seq":0,"name":"a"}\n[[hatch]]not json\n');
    stream.stderr('warning\n');
    stream.stdout('[[hatch]]{"t":"run:end","status":"succeeded","output":1}');
    await stream.finish();
    expect(events).toEqual([{ t: 'step:start', seq: 0, name: 'a' }]);
    // stdout lines keep their order; stderr interleaves as it arrives.
    expect(stream.text).toMatch(/hello\n\[\[hatch\]\]not json\n/);
    expect(stream.text).toContain('warning\n');
    expect(stream.text).not.toContain('run:start');
    expect(stream.runEnd).toEqual({
      t: 'run:end',
      status: 'succeeded',
      output: 1,
    });
  });

  it('stops persisting and asks for a kill past the step event cap', async () => {
    const onOverflow = vi.fn<() => void>();
    let stored = 0;
    const stream = new RunEventStream({
      onEvent: async () => {
        stored += 1;
      },
      onOverflow,
    });
    const line = '[[hatch]]{"t":"step:start","seq":1,"name":"loop"}\n';
    stream.stdout(line.repeat(MAX_RUN_STEP_EVENTS + 5));
    stream.stdout('[[hatch]]{"t":"run:end","status":"succeeded"}\n');
    await stream.finish();
    expect(stored).toBe(MAX_RUN_STEP_EVENTS);
    expect(onOverflow).toHaveBeenCalledTimes(1);
    expect(stream.overflow).toBe('steps');
    // An overflow voids a success the process reported afterwards.
    expect(stream.runEnd).toBeNull();
  });
});
