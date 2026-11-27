import {
  AppShell,
  Button,
  IconLeaf,
  IconSettings,
  List,
  ListItem,
  Page,
  Sheet,
  TextField,
  mount,
  signal,
} from '@hatch/ui';

const open = signal(false);

function Notes() {
  return (
    <Page title="Garden notes">
      <Button label="Save" kind="primary" />
      <TextField label="Name" value="North bed" />
      <List title="Beds">
        <ListItem title="North bed" onPress={() => undefined} />
      </List>
      <Button label="Filter" onPress={() => open.set(true)} />
      <Sheet
        open={open()}
        onOpenChange={(next) => open.set(next)}
        title="Filter plants"
      >
        <TextField label="Contains" />
      </Sheet>
    </Page>
  );
}

function Settings() {
  return <Page title="Settings" />;
}

function App() {
  return (
    <AppShell
      title="Garden"
      sections={[
        { id: 'notes', label: 'Notes', icon: IconLeaf, content: Notes },
        {
          id: 'settings',
          label: 'Settings',
          icon: IconSettings,
          content: Settings,
        },
      ]}
    />
  );
}

mount(App);
