import {
  Card,
  Divider,
  Grid,
  Heading,
  Icon,
  IconBell,
  IconCalendar,
  IconCircleCheck,
  IconHeart,
  IconLeaf,
  IconMapPin,
  IconStar,
  IconSun,
  Page,
  Row,
  Section,
  Stack,
  Text,
  Toast,
} from '@hatch/ui';

export function Basics() {
  return (
    <Page
      title="Basics"
      description="Type, layout and icons that every screen is built from."
    >
      <Card title="Headings" description="Four levels, heaviest first.">
        <Stack gap="sm">
          <Heading level={1}>Display: Spring planting plan</Heading>
          <Heading level={2}>Title: Garden journal</Heading>
          <Heading level={3}>Section: This week</Heading>
          <Heading level={4}>Subsection: Seedlings</Heading>
          <Heading level={4} tone="muted">
            Muted subsection
          </Heading>
        </Stack>
      </Card>

      <Card title="Text">
        <Stack gap="sm">
          <Text size="lg">
            Large lead text introduces a page in a sentence or two.
          </Text>
          <Text>
            Body text is 14 points at weight 500, the default of the product.
          </Text>
          <Text size="sm" tone="muted">
            Caption text carries meta lines such as “Updated 3 minutes ago”.
          </Text>
          <Row wrap gap="md">
            <Text weight="regular">Regular</Text>
            <Text weight="strong">Strong</Text>
            <Text weight="bold">Bold</Text>
            <Text mono>tomato-07</Text>
          </Row>
          <Row wrap gap="md">
            <Text tone="accent">Accent</Text>
            <Text tone="success">Success</Text>
            <Text tone="warning">Warning</Text>
            <Text tone="danger">Danger</Text>
            <Text tone="info">Info</Text>
            <Text tone="muted">Muted</Text>
          </Row>
          <Text lines={1}>
            One line only: this long sentence about watering the tomatoes every
            other morning before the sun gets too strong is cut with an
            ellipsis.
          </Text>
          <Text selectable mono>
            Selectable: GJ-2041-0418
          </Text>
        </Stack>
      </Card>

      <Section
        title="Grid of cards"
        description="Four columns in a wide pane, two in a medium one, one in a compact one."
      >
        <Grid columns={4}>
          <Card title="Tomatoes" description="12 plants" padding="md" />
          <Card title="Basil" description="6 pots" padding="md" />
          <Card title="Peppers" description="4 plants" padding="md" />
          <Card
            title="Open the plan"
            description="An interactive card"
            onPress={() => Toast.show({ title: 'Opened the plan' })}
          />
        </Grid>
      </Section>

      <Card title="Rows, stacks and dividers" padding="lg">
        <Row gap="lg" collapse>
          <Stack gap="xs" grow>
            <Text weight="bold">Row that collapses</Text>
            <Text tone="muted">Becomes a column in a compact pane.</Text>
          </Stack>
          <Divider vertical />
          <Stack gap="xs" grow>
            <Text weight="bold">Second column</Text>
            <Text tone="muted">Equal share of the width.</Text>
          </Stack>
        </Row>
        <Divider />
        <Row justify="between">
          <Text>Space between</Text>
          <Text tone="muted">End</Text>
        </Row>
      </Card>

      <Card title="Icons" description="Sizes 12 to 26, in each tone.">
        <Row wrap gap="lg" align="end">
          <Icon icon={IconLeaf} size="xs" />
          <Icon icon={IconLeaf} size="sm" />
          <Icon icon={IconLeaf} size="md" />
          <Icon icon={IconLeaf} size="lg" />
          <Icon icon={IconLeaf} size="xl" />
          <Icon icon={IconLeaf} size="2xl" label="Leaf" />
        </Row>
        <Row wrap gap="lg">
          <Icon icon={IconSun} tone="default" />
          <Icon icon={IconStar} tone="accent" />
          <Icon icon={IconCircleCheck} tone="success" />
          <Icon icon={IconBell} tone="warning" />
          <Icon icon={IconHeart} tone="danger" />
          <Icon icon={IconMapPin} tone="info" />
          <Icon icon={IconCalendar} tone="muted" />
        </Row>
      </Card>
    </Page>
  );
}
