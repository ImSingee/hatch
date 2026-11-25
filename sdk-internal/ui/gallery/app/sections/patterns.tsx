import {
  Card,
  DashboardPage,
  FormPage,
  IconDashboard,
  IconLeaf,
  IconList,
  IconPencil,
  IconSettings,
  List,
  ListDetailPage,
  ListItem,
  NavStack,
  Page,
  Progress,
  Section,
  Select,
  SettingsPage,
  Stack,
  Switch,
  Text,
  TextArea,
  TextField,
  Toast,
  createNavStack,
  signal,
} from '@hatch/ui';

type Route = 'menu' | 'dashboard' | 'records' | 'form' | 'settings';
const nav = createNavStack<Route>(['menu']);

type Plant = {
  id: string;
  name: string;
  bed: string;
  sown: string;
  note: string;
};
const PLANTS: Plant[] = [
  {
    id: 'p1',
    name: 'Cherry tomato',
    bed: 'North bed',
    sown: '12 April',
    note: 'Pinch out side shoots weekly.',
  },
  {
    id: 'p2',
    name: 'Sweet basil',
    bed: 'Patio pots',
    sown: '20 April',
    note: 'Keep out of cold wind.',
  },
  {
    id: 'p3',
    name: 'Runner beans',
    bed: 'North bed',
    sown: '2 May',
    note: 'Tie in to the canes.',
  },
  {
    id: 'p4',
    name: 'Courgette',
    bed: 'South bed',
    sown: '8 May',
    note: 'Water at the base.',
  },
];

function Menu() {
  const open = (route: Route) => () => nav.push(route);
  return (
    <Page title="Patterns" description="Whole pages built from the catalogue.">
      <List>
        <ListItem
          icon={IconDashboard}
          title="Dashboard"
          description="DashboardPage"
          onPress={open('dashboard')}
        />
        <ListItem
          icon={IconList}
          title="Records"
          description="ListDetailPage"
          onPress={open('records')}
        />
        <ListItem
          icon={IconPencil}
          title="New plant"
          description="FormPage"
          onPress={open('form')}
        />
        <ListItem
          icon={IconSettings}
          title="Settings"
          description="SettingsPage"
          onPress={open('settings')}
        />
      </List>
    </Page>
  );
}

function Dashboard() {
  return (
    <DashboardPage
      title="This season"
      description="Updated this morning."
      stats={[
        {
          label: 'Harvested',
          value: '12.4 kg',
          change: '+18 %',
          trend: 'up',
          comparison: 'vs July',
        },
        { label: 'Plants', value: '26' },
        {
          label: 'Waterings',
          value: '41',
          change: '−3',
          trend: 'down',
          upIsGood: true,
        },
        { label: 'Beds', value: '3' },
      ]}
    >
      <Card title="Next up" description="Due this week.">
        <List>
          <ListItem icon={IconLeaf} title="Thin the carrots" value="Tue" />
          <ListItem icon={IconLeaf} title="Feed the tomatoes" value="Thu" />
        </List>
      </Card>
      <Card title="Beds">
        <Stack gap="lg">
          <Progress label="North bed planted" value={80} />
          <Progress label="South bed planted" value={45} />
        </Stack>
      </Card>
    </DashboardPage>
  );
}

function Records() {
  const query = signal('');
  const shown = () =>
    PLANTS.filter((plant) =>
      plant.name.toLowerCase().includes(query().toLowerCase()),
    );
  return (
    <ListDetailPage
      title="Plants"
      items={shown()}
      getKey={(plant) => plant.id}
      search={{
        value: query(),
        onChange: query.set,
        placeholder: 'Search plants',
      }}
      renderItem={(plant) => ({
        title: plant.name,
        description: `${plant.bed} · sown ${plant.sown}`,
        icon: IconLeaf,
      })}
      detailTitle={(plant) => plant.name}
      renderDetail={(plant) => (
        <Card title="Care">
          <Text>{plant().note}</Text>
        </Card>
      )}
      empty={{ title: 'No plants match', description: 'Try another name.' }}
    />
  );
}

function NewPlant() {
  return (
    <FormPage
      title="New plant"
      description="Add a plant to a bed."
      formId="gallery-form-page"
      submitLabel="Add plant"
      onCancel={() => nav.pop()}
      onSubmit={() => {
        Toast.success('Plant added');
        nav.pop();
      }}
    >
      <TextField name="name" label="Name" required />
      <Select
        name="bed"
        label="Bed"
        required
        options={[
          { value: 'north', label: 'North bed' },
          { value: 'south', label: 'South bed' },
        ]}
      />
      <TextArea name="note" label="Care note" />
    </FormPage>
  );
}

function Settings() {
  return (
    <SettingsPage
      title="Settings"
      description="How the garden journal behaves."
    >
      <Section title="Notifications">
        <List>
          <ListItem
            title="Watering reminders"
            description="At 7:00 on watering days"
            control={<Switch label="Watering reminders" checked labelHidden />}
          />
          <ListItem
            title="Frost alerts"
            control={<Switch label="Frost alerts" labelHidden />}
          />
        </List>
      </Section>
      <Section title="Garden">
        <List>
          <ListItem title="Beds" value="3" onPress={() => {}} />
          <ListItem title="Units" value="Metric" onPress={() => {}} />
        </List>
      </Section>
    </SettingsPage>
  );
}

export function Patterns() {
  return (
    <NavStack stack={nav}>
      {(route) =>
        route === 'dashboard' ? (
          <Dashboard />
        ) : route === 'records' ? (
          <Records />
        ) : route === 'form' ? (
          <NewPlant />
        ) : route === 'settings' ? (
          <Settings />
        ) : (
          <Menu />
        )
      }
    </NavStack>
  );
}
