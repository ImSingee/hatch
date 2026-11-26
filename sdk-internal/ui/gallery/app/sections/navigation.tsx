import {
  Button,
  Card,
  IconCalendar,
  IconLeaf,
  IconList,
  NavStack,
  Page,
  Stack,
  Tabs,
  Text,
  createNavStack,
} from '@hatch/ui';

type Route =
  | { name: 'beds' }
  | { name: 'bed'; id: string }
  | { name: 'plant'; id: string };

const nav = createNavStack<Route>([{ name: 'beds' }]);

function Beds() {
  return (
    <Page
      title="Navigation"
      description="Tabs inside a page, and a stack of pages."
    >
      <Card title="Tabs">
        <Tabs
          label="View"
          items={[
            {
              id: 'list',
              label: 'List',
              icon: IconList,
              content: () => <Text>Every plant, A to Z.</Text>,
            },
            {
              id: 'calendar',
              label: 'Calendar',
              icon: IconCalendar,
              badge: '3',
              content: () => <Text>Sowing and harvest dates.</Text>,
            },
            {
              id: 'beds',
              label: 'Beds',
              icon: IconLeaf,
              content: () => <Text>Plants grouped by bed.</Text>,
            },
            { id: 'archive', label: 'Archive', disabled: true },
          ]}
        />
        <Tabs
          label="Period"
          fullWidth
          items={[
            { id: 'week', label: 'Week' },
            { id: 'month', label: 'Month' },
            { id: 'year', label: 'Year' },
          ]}
        />
      </Card>
      <Card
        title="Stack of pages"
        description="Push a page; it gets a back button."
      >
        <Stack gap="sm">
          <Button
            label="Open North bed"
            onPress={() => nav.push({ name: 'bed', id: 'north' })}
          />
        </Stack>
      </Card>
    </Page>
  );
}

function Bed(props: { id: string }) {
  return (
    <Page title="North bed" description={`Bed ${props.id}: 12 plants.`}>
      <Button
        label="Open a plant"
        onPress={() => nav.push({ name: 'plant', id: 'tomato' })}
      />
    </Page>
  );
}

function Plant() {
  return (
    <Page title="Cherry tomato" description="Planted 12 April.">
      <Button label="Back to the first page" onPress={() => nav.popToRoot()} />
    </Page>
  );
}

export function Navigation() {
  return (
    <NavStack stack={nav}>
      {(route) =>
        route.name === 'beds' ? (
          <Beds />
        ) : route.name === 'bed' ? (
          <Bed id={route.id} />
        ) : (
          <Plant />
        )
      }
    </NavStack>
  );
}
