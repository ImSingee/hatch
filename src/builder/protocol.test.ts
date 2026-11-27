/**
 * A failure report always fits the platform's `/fail` limit, so a build
 * whose tool printed more than that still ends failed with its error: the
 * report keeps the message's start and end.
 */
import { expect, it } from 'vitest';
import { boundFailureMessage, FAILURE_MESSAGE_MAX_CHARS } from './protocol';

const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

it('cuts a failure message to the report limit, keeping its start and end', () => {
  const fits = 'x'.repeat(FAILURE_MESSAGE_MAX_CHARS);
  expect(boundFailureMessage(fits)).toBe(fits);

  const message = `buf build failed:\n${'.'.repeat(1_000_000)}\nfinal error`;
  const reported = boundFailureMessage(message);
  expect(reported.length).toBeLessThanOrEqual(FAILURE_MESSAGE_MAX_CHARS);
  expect(reported.startsWith('buf build failed:\n')).toBe(true);
  expect(reported.endsWith('\nfinal error')).toBe(true);
  expect(reported).toMatch(/\d+ characters left out here/);

  // A cut never leaves half of a character.
  for (const pad of ['', 'x']) {
    const emoji = boundFailureMessage(pad + '😀'.repeat(40_000));
    expect(emoji.length).toBeLessThanOrEqual(FAILURE_MESSAGE_MAX_CHARS);
    expect(emoji).not.toMatch(LONE_SURROGATE);
  }
});
