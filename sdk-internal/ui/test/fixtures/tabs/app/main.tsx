import {
  Button,
  List,
  ListItem,
  Page,
  Stack,
  Tabs,
  Text,
  TextField,
  mount,
  signal,
} from '@hatch/ui';
import type { TabItem } from '@hatch/ui';

const beds: TabItem[] = [
  { id: 'north', label: 'North', content: () => <Text>North bed</Text> },
  {
    id: 'south',
    label: 'South',
    content: () => (
      <Stack>
        <Text>South bed</Text>
        <TextField label="South notes" />
      </Stack>
    ),
  },
];

const ROWS = [
  { id: 'row-1', name: 'Bed 1', locked: false },
  { id: 'row-2', name: 'Bed 2', locked: true },
];

function App() {
  const items = signal<TabItem[]>([]);
  const rows = signal(ROWS);
  return (
    <Page title="Beds">
      <Stack>
        <Button label="Load beds" onPress={() => items.set(beds)} />
        <Button
          label="Remove north"
          onPress={() =>
            items.set(items().filter((item) => item.id !== 'north'))
          }
        />
        <Button
          label="Add west first"
          onPress={() =>
            items.set([
              {
                id: 'west',
                label: 'West',
                content: () => <Text>West bed</Text>,
              },
              ...items(),
            ])
          }
        />
        <Button
          label="Close north"
          onPress={() =>
            items.set(
              items().map((item) =>
                item.id === 'north' ? { ...item, disabled: true } : item,
              ),
            )
          }
        />
        <Tabs label="Beds" items={items()} />
        <Button
          label="Refresh beds"
          onPress={() => {
            rows.set(rows().map((row) => ({ ...row })));
            items.set(items().map((item) => ({ ...item })));
          }}
        />
        <List
          items={rows()}
          getKey={(row) => row.id}
          renderItem={(row) => (
            <ListItem
              title={row().name}
              disabled={row().locked}
              actions={[
                { label: `Clear ${row().name}`, onPress: () => undefined },
              ]}
              control={
                <TextField label={`Note for ${row().name}`} labelHidden />
              }
            />
          )}
        />
      </Stack>
    </Page>
  );
}

mount(App);
