import { NodeExecutionEnv } from './node-execution-env';
import { describe, expect, it } from 'vitest';
import type { PlatformClient } from './platform-client';
import { createTools } from './tools';

describe('Agent capability registration', () => {
  it('registers App tools and no tool for the removed Workflows', () => {
    const env = new NodeExecutionEnv({ cwd: process.cwd() });
    const names = createTools(env, { platform: {} as PlatformClient }).map(
      (tool) => tool.name,
    );

    expect(names).toEqual(expect.arrayContaining(['list_apps', 'get_app']));
    expect(names.filter((name) => /workflow/i.test(name))).toEqual([]);
  });
});
