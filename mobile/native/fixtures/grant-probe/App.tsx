/**
 * Test fixture of the native runtimes' engine tests: an App that declares
 * every capability and tries what a Hatch App must never reach, then reports
 * each result through `hatch.nav.setTitle` (a call Hatch grants) as JSON.
 */
import { Clipboard, host, mount, openUrl, Text } from 'nsh';

async function attempt(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'OK';
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : 'ERROR';
  }
}

async function probe() {
  const results = {
    // A local port nothing listens on: the grant decides, never the network.
    fetch: await attempt(() => fetch('http://127.0.0.1:9/')),
    clipboard: await attempt(() => Clipboard.writeText('grant-probe')),
    openUrl: await attempt(() => openUrl('hatch-grant-probe://x')),
    host: await attempt(() => host.call('probe.reach', {})),
  };
  await host.call('hatch.nav.setTitle', { title: JSON.stringify(results) });
}

void probe();
mount(() => <Text>grant probe</Text>);
