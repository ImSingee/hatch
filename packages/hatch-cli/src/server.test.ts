import { expect, it } from 'vitest';
import { parseServerCommand } from './server';

const rejected = (...args: string[]) => {
  try {
    parseServerCommand(args, 0);
  } catch (error) {
    return error as { code?: string; message?: string };
  }
  return { code: 'accepted' };
};

it('maps server info with the global flags', () => {
  expect(
    parseServerCommand(['server', 'info', '--json', '--profile', 'w'], 0).flags,
  ).toMatchObject({ json: true, profile: 'w' });
});

it('rejects unusable input before any request', () => {
  for (const args of [
    ['server'],
    ['server', 'status'],
    ['server', 'info', 'extra'],
    ['server', 'info', '--commit', 'abc'],
  ])
    expect(rejected(...args)).toMatchObject({ code: 'invalid_arguments' });
});
