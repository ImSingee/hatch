import { createClient } from '@connectrpc/connect';
import {
  createAppDataClient,
  initialRoute,
  onNavigate,
  setRoute,
  setTitle,
} from '@hatch/app/native';
import { createAppTransport } from '@hatch/app/native/rpc';
import type schema from '../data/schema.ts';
import { CounterService } from '../gen/service_pb.ts';
import { Button, Label, mount, Page, signal } from './custom/ui.tsx';

const client = createClient(CounterService, createAppTransport());
const data = createAppDataClient<typeof schema>();

function titleFor(route: string): string {
  return route === '/about' ? 'About the counter' : 'Fixture counter';
}

function App() {
  const route = signal(initialRoute() || '/');
  const count = signal('…');
  const stored = signal('…');
  const error = signal('');
  const show = (next: string) => {
    route.set(next);
    setTitle(titleFor(next));
  };
  onNavigate(show);
  show(route());
  const report = (cause: unknown) =>
    error.set(cause instanceof Error ? cause.message : String(cause));
  client.getCount({}).then((answer) => count.set(String(answer.count)), report);
  data.watch(
    { table: 'counters', limit: 5 },
    (result) =>
      stored.set(
        result.items.map((item) => String(item.value)).join(',') || 'none',
      ),
    report,
  );
  const go = (next: string) => {
    show(next);
    setRoute(next);
  };
  return (
    <Page title="Fixture counter">
      <Label>{`route:${route()}`}</Label>
      <Label>{`count:${count()}`}</Label>
      <Label>{`stored:${stored()}`}</Label>
      <Label>{`error:${error()}`}</Label>
      <Button
        label="Increment"
        onPress={() =>
          client
            .increment({ amount: 1 })
            .then((answer) => count.set(String(answer.count)), report)
        }
      />
      <Button
        label={route() === '/about' ? 'Home' : 'About'}
        onPress={() => go(route() === '/about' ? '/' : '/about')}
      />
    </Page>
  );
}

mount(App);
