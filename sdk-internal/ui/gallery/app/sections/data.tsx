import {
  Avatar,
  Badge,
  Card,
  DataTable,
  EmptyState,
  Grid,
  IconCalendar,
  IconDroplet,
  IconLeaf,
  IconPencil,
  IconPlant,
  IconScale,
  IconSun,
  IconTrash,
  List,
  ListItem,
  Page,
  Progress,
  Row,
  Skeleton,
  Stack,
  Stat,
  Switch,
  Toast,
} from '@hatch/ui';

type Harvest = {
  crop: string;
  plot: string;
  weight: number;
  picked: string;
};

const HARVESTS: Harvest[] = [
  { crop: 'Tomatoes', plot: 'North bed', weight: 2.4, picked: '2026-08-02' },
  { crop: 'Courgettes', plot: 'South bed', weight: 3.1, picked: '2026-08-03' },
  { crop: 'Basil', plot: 'Patio pots', weight: 0.3, picked: '2026-08-03' },
  { crop: 'Beans', plot: 'North bed', weight: 1.2, picked: '2026-08-05' },
  { crop: 'Peppers', plot: 'South bed', weight: 0.8, picked: '2026-08-06' },
  {
    crop: 'Strawberries',
    plot: 'Patio pots',
    weight: 0.9,
    picked: '2026-08-07',
  },
];

const BEDS = [
  { id: 'north', name: 'North bed', plants: 12, status: 'Thirsty' },
  { id: 'south', name: 'South bed', plants: 8, status: 'Fine' },
  { id: 'pots', name: 'Patio pots', plants: 6, status: 'Fine' },
];

export function Data() {
  return (
    <Page title="Data" description="Tables, lists and figures.">
      <Grid columns={4} gap="md">
        <Stat
          label="Harvested"
          value="12.4 kg"
          change="+18 %"
          trend="up"
          comparison="vs July"
          icon={IconScale}
        />
        <Stat
          label="Water used"
          value="310 l"
          change="+6 %"
          trend="up"
          upIsGood={false}
          comparison="vs July"
          icon={IconDroplet}
        />
        <Stat
          label="Sunny days"
          value="21"
          change="0"
          trend="flat"
          icon={IconSun}
        />
        <Stat label="Plants" value="26" />
      </Grid>

      <List
        title="Beds"
        items={BEDS}
        getKey={(bed) => bed.id}
        renderItem={(bed) => (
          <ListItem
            icon={IconLeaf}
            title={bed().name}
            description={`${bed().plants} plants`}
            badge={{
              label: bed().status,
              tone: bed().status === 'Thirsty' ? 'warning' : 'success',
              dot: true,
            }}
            onPress={() => Toast.show({ title: `Opened ${bed().name}` })}
            actions={[
              {
                label: 'Rename',
                icon: IconPencil,
                onPress: () => Toast.show({ title: 'Rename' }),
              },
              {
                label: 'Delete',
                icon: IconTrash,
                onPress: () => Toast.show({ title: 'Delete' }),
              },
            ]}
          />
        )}
      />

      <List title="Rows">
        <ListItem
          title="Selected row"
          description="The current item of a navigation list"
          icon={IconPlant}
          selected
          onPress={() => {}}
        />
        <ListItem title="Plain row with a value" value="6 plants" />
        <ListItem
          title="Ada Park"
          description="Waters on Tuesdays"
          avatar={{ name: 'Ada Park' }}
          value="Helper"
        />
        <ListItem
          title="Frost alerts"
          control={<Switch label="Frost alerts" checked labelHidden />}
        />
        <ListItem
          title="Disabled row"
          description="Not available offline"
          icon={IconCalendar}
          disabled
          onPress={() => {}}
        />
      </List>

      <Grid columns={3}>
        <List
          title="Empty list"
          items={[] as string[]}
          empty="No beds yet."
          renderItem={(name) => <ListItem title={name()} />}
        />
        <List
          title="Loading list"
          items={[] as string[]}
          loading
          renderItem={(name) => <ListItem title={name()} />}
        />
        <Card title="Skeletons">
          <Row gap="md">
            <Skeleton shape="circle" />
            <Stack grow>
              <Skeleton lines={2} />
            </Stack>
          </Row>
          <Skeleton shape="block" />
        </Card>
      </Grid>

      <Card title="Badges and avatars">
        <Row wrap gap="sm">
          <Badge label="Neutral" />
          <Badge label="Accent" tone="accent" />
          <Badge label="Ready" tone="success" dot />
          <Badge label="Thirsty" tone="warning" dot />
          <Badge label="Overdue" tone="danger" dot />
          <Badge label="New" tone="info" />
        </Row>
        <Row wrap gap="md">
          <Avatar name="Ada Park" size="sm" />
          <Avatar name="Ben Ortiz" size="md" />
          <Avatar name="Chen Wu" size="lg" />
          <Avatar name="Dara Lee" size="xl" />
          <Avatar name="Herb garden" shape="tile" size="lg" />
          <Avatar name="Orchard" shape="tile" size="xl" />
        </Row>
      </Card>

      <Card title="Progress">
        <Stack gap="lg">
          <Progress label="Season planted" value={64} />
          <Progress label="Rain barrel" value={92} tone="success" />
          <Progress label="Seed budget" value={88} tone="warning" />
          <Progress label="Syncing photos" indeterminate />
        </Stack>
      </Card>

      <Card title="Harvest log" padding="md">
        <DataTable
          label="Harvests"
          rows={HARVESTS}
          visibleRows={5}
          onRowPress={(row) =>
            Toast.show({ title: `${row.crop}: ${row.weight} kg` })
          }
          columns={[
            {
              key: 'crop',
              title: 'Crop',
              width: 'md',
              sortable: true,
              fixed: true,
            },
            { key: 'plot', title: 'Plot', width: 'md', sortable: true },
            {
              key: 'weight',
              title: 'Weight',
              width: 'sm',
              align: 'end',
              sortable: true,
              format: (value) => `${Number(value).toFixed(1)} kg`,
            },
            { key: 'picked', title: 'Picked', width: 'md', sortable: true },
          ]}
        />
      </Card>
      <Card title="Empty table">
        <DataTable
          label="Harvests"
          rows={[] as Harvest[]}
          visibleRows={5}
          empty="No harvests logged yet."
          columns={[
            { key: 'crop', title: 'Crop' },
            { key: 'weight', title: 'Weight', align: 'end' },
          ]}
        />
      </Card>

      <Card>
        <EmptyState
          icon={IconLeaf}
          tone="accent"
          title="No harvests yet"
          description="Log the first one when you pick something. It shows up here and in the weekly summary."
          action={{
            label: 'Log a harvest',
            onPress: () => Toast.show({ title: 'Log a harvest' }),
          }}
          secondaryAction={{
            label: 'Import',
            onPress: () => Toast.show({ title: 'Import' }),
          }}
        />
      </Card>
    </Page>
  );
}
