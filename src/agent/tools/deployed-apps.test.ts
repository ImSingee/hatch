import { describe, expect, it } from 'vitest';
import { createDeployedAppsTool } from './deployed-apps';

describe('report_deployed_apps', () => {
  it('reports each named App once, trimmed', async () => {
    const reportTool = createDeployedAppsTool();
    const result = await reportTool.execute('call', {
      app_ids: [' app-a ', 'app-b', 'app-a'],
    });

    expect(result.details).toEqual({ appIds: ['app-a', 'app-b'] });
    expect(result.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining('app-a, app-b'),
      }),
    ]);
  });

  it.each([{ app_ids: [] }, { app_ids: [' '] }, {}])(
    'rejects %j without naming a deployed App',
    async (args) => {
      await expect(
        createDeployedAppsTool().execute('call', args),
      ).rejects.toThrow(/at least one non-empty App id/);
    },
  );
});
