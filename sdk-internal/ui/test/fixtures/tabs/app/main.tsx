import { Button, Page, Stack, Tabs, Text, mount, signal } from '@hatch/ui';
import type { TabItem } from '@hatch/ui';

const beds: TabItem[] = [
  { id: 'north', label: 'North', content: () => <Text>North bed</Text> },
  { id: 'south', label: 'South', content: () => <Text>South bed</Text> },
];

function App() {
  const items = signal<TabItem[]>([]);
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
        <Tabs label="Beds" items={items()} />
      </Stack>
    </Page>
  );
}

mount(App);
