import {
  AppShell,
  Button,
  Card,
  Each,
  IconLeaf,
  IconPencil,
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
const editing = signal(false);
const beds = Array.from({ length: 14 }, (_, index) => `Bed ${index + 1}`);

function Notes() {
  return (
    <Page
      title="Garden notes"
      actions={
        <Button
          label={editing() ? 'Done' : 'Edit'}
          icon={editing() ? undefined : IconPencil}
          onPress={() => editing.set(!editing())}
        />
      }
    >
      <Button label="Save" kind="primary" />
      <TextField label="Name" value="North bed" />
      <List title="Beds">
        <ListItem title="North bed" onPress={() => undefined} />
        <ListItem title="South bed" control={<Button label="Water" />} />
      </List>
      <Card title="Harvest" actions={<Button label="Log" />}>
        <Button label="Share" />
      </Card>
      <Button label="Filter" onPress={() => open.set(true)} />
      <Sheet
        open={open()}
        onOpenChange={(next) => open.set(next)}
        title="Filter plants"
      >
        <TextField label="Contains" />
      </Sheet>
      <List title="All beds">
        <Each of={beds}>{(bed) => <ListItem title={bed()} />}</Each>
      </List>
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
