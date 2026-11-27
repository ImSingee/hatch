/**
 * Build output reaches the platform in order, and a batch the logs endpoint
 * never took is marked where it was lost: its note comes before any output
 * that followed it, and says how many lines the gap holds.
 */
import { describe, expect, it } from 'vitest';
import { LogShipper } from './log-shipper';

const note = (count: number) =>
  `[builder] ${count} line(s) of build output were dropped: the platform did not take them in time.`;

/**
 * A logs endpoint that answers each call in turn from `answers` (then 200),
 * running `during(call)` while the call is in flight, as build output that
 * arrives meanwhile would.
 */
function endpoint(
  answers: number[],
  during: (call: number) => void = () => {},
) {
  const calls: string[][] = [];
  const send = async (lines: string[]) => {
    calls.push(lines);
    during(calls.length);
    // 4xx is not retried, so a failed batch is dropped without waiting.
    return new Response(null, { status: answers[calls.length - 1] ?? 200 });
  };
  return { calls, send };
}

describe('build output shipped to the platform', () => {
  it('marks a failed batch before the output queued behind it', async () => {
    let shipper!: LogShipper;
    const { calls, send } = endpoint([400], (call) => {
      if (call === 1) shipper.push(['after 1', 'after 2']);
    });
    shipper = new LogShipper(send);

    shipper.push(['lost 1', 'lost 2']);
    await shipper.flush();
    shipper.push(['later']);
    await shipper.flush();

    expect(calls).toEqual([
      ['lost 1', 'lost 2'],
      [note(2), 'after 1', 'after 2'],
      ['later'],
    ]);
  });

  it('keeps one note per gap when the batch carrying a note fails too', async () => {
    let shipper!: LogShipper;
    const { calls, send } = endpoint([400, 400], (call) => {
      if (call <= 2) shipper.push([`during ${call}`]);
    });
    shipper = new LogShipper(send);

    shipper.push(['first']);
    await shipper.drain(10_000, new AbortController().signal);

    // The second batch lost its note's line and its own: one gap of two.
    expect(calls).toEqual([
      ['first'],
      [note(1), 'during 1'],
      [note(2), 'during 2'],
    ]);
  });

  it('reports a last batch that failed once nothing else is left', async () => {
    const { calls, send } = endpoint([400, 400]);
    const shipper = new LogShipper(send);

    shipper.push(['a', 'b', 'c']);
    await shipper.drain(10_000, new AbortController().signal);

    expect(calls).toEqual([['a', 'b', 'c'], [note(3)]]);
  });
});
