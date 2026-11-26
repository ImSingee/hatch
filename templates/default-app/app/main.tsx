/**
 * The App's frontend on Hatch's native runtime: the whole UI comes from
 * `@hatch/ui` (see the design system reference in the building-apps skill),
 * and every request goes through the shell (`@hatch/app/native`), which holds
 * the session. The same source renders in the Web Desk and in Hatch's apps.
 */
import { createClient } from '@connectrpc/connect';
import { createAppDataClient } from '@hatch/app/native';
import { createAppTransport } from '@hatch/app/native/rpc';
import {
  AppShell,
  Button,
  Card,
  IconInfoCircle,
  IconPlus,
  IconHash,
  Page,
  Stat,
  Text,
  Toast,
  mount,
  signal,
} from '@hatch/ui';
import type schema from '../data/schema.ts';
import { CounterService } from '../gen/service_pb.ts';

// Connect RPC to this App's backend, through the shell.
const client = createClient(CounterService, createAppTransport());
// This App's Data Tables, through the shell: live queries without a backend.
const data = createAppDataClient<typeof schema>();

function Counter() {
  const count = signal<number | null>(null);
  const saving = signal(false);
  const report = (cause: unknown) =>
    Toast.error(
      'Could not reach the counter',
      cause instanceof Error ? cause.message : String(cause),
    );
  client.getCount({}).then((reply) => count.set(reply.count), report);
  // The stored row changes whenever any client increments it.
  data.watch(
    { table: 'counters', limit: 1 },
    (result) => {
      const row = result.items[0];
      if (row) count.set(row.value);
    },
    report,
  );
  const increment = async () => {
    saving.set(true);
    try {
      count.set((await client.increment({ amount: 1 })).count);
    } catch (cause) {
      report(cause);
    } finally {
      saving.set(false);
    }
  };
  return (
    <Page
      title="Counter"
      description="A number kept by the App's backend in a Data Table."
      width="narrow"
      actions={
        <Button
          label="Increment"
          kind="primary"
          icon={IconPlus}
          loading={saving()}
          disabled={count() === null}
          onPress={increment}
        />
      }
    >
      <Stat
        label="Count"
        value={count() === null ? '…' : String(count())}
        icon={IconHash}
      />
    </Page>
  );
}

function About() {
  return (
    <Page title="About" width="narrow">
      <Card title="How this App is made">
        <Text tone="muted">
          A native frontend built from Hatch's component library, a Deno Connect
          backend and a managed Data Table. The same source runs in the Web Desk
          and in Hatch's apps, and follows the instance's theme.
        </Text>
      </Card>
    </Page>
  );
}

function App() {
  return (
    <AppShell
      title={__APP_NAME__}
      sections={[
        {
          id: 'counter',
          label: 'Counter',
          icon: IconHash,
          content: Counter,
        },
        { id: 'about', label: 'About', icon: IconInfoCircle, content: About },
      ]}
    />
  );
}

mount(App);
