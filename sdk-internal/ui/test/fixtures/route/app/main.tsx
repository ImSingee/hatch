import {
  AppShell,
  Button,
  IconCalendar,
  IconNotes,
  NavStack,
  Page,
  Text,
  createNavStack,
  mount,
} from '@hatch/ui';

type Route = { name: 'list' } | { name: 'note'; id: string };

const notes = createNavStack<Route>([{ name: 'list' }]);

function Notes() {
  return (
    <NavStack
      stack={notes}
      routes={{
        path: (stack) => {
          const top = stack[stack.length - 1];
          return top?.name === 'note' ? `/${top.id}` : '';
        },
        parse: (path): Route[] | null => {
          const id = /^\/(\d+)$/.exec(path)?.[1];
          return id ? [{ name: 'list' }, { name: 'note', id }] : null;
        },
      }}
    >
      {(route) =>
        route.name === 'note' ? (
          <Page title={`Note ${route.id}`}>
            <Text>{`Body of note ${route.id}`}</Text>
          </Page>
        ) : (
          <Page title="Notes">
            <Button
              label="Open note 7"
              onPress={() => notes.push({ name: 'note', id: '7' })}
            />
          </Page>
        )
      }
    </NavStack>
  );
}

function App() {
  return (
    <AppShell
      title="Route fixture"
      sections={[
        {
          id: 'today',
          label: 'Today',
          icon: IconCalendar,
          content: () => (
            <Page title="Today">
              <Text>Today's page</Text>
            </Page>
          ),
        },
        { id: 'notes', label: 'Notes', icon: IconNotes, content: Notes },
      ]}
    />
  );
}

mount(App);
