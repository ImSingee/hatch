import { NodeExecutionEnv } from './node-execution-env';
import { describe, expect, it } from 'vitest';
import type { PlatformClient } from './platform-client';
import { createTools } from './tools';

describe('Agent capability registration', () => {
  it('leaves App and Workflow operations to the CLI', () => {
    const env = new NodeExecutionEnv({ cwd: process.cwd() });
    const names = createTools(env, { platform: {} as PlatformClient }).map(
      (tool) => tool.name,
    );

    expect(names).toContain('run_command');
    expect(names).toContain('report_deployed_apps');
    expect(names.filter((name) => /_apps?$|workflow/i.test(name))).toEqual([
      'report_deployed_apps',
    ]);
  });
});
