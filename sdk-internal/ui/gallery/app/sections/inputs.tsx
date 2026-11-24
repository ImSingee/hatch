import {
  Button,
  Card,
  Checkbox,
  Combobox,
  DatePicker,
  RadioGroup,
  Slider,
  Switch,
  Form,
  IconButton,
  IconChevronDown,
  IconDownload,
  IconPencil,
  IconPlus,
  IconSearch,
  IconStar,
  IconTrash,
  NumberField,
  Page,
  Row,
  Select,
  Stack,
  TextArea,
  TextField,
  Toast,
  signal,
} from '@hatch/ui';

const PLOTS = [
  { value: 'north', label: 'North bed', group: 'Raised beds' },
  { value: 'south', label: 'South bed', group: 'Raised beds' },
  { value: 'pots', label: 'Patio pots', group: 'Containers' },
  { value: 'window', label: 'Window box', group: 'Containers', disabled: true },
];

const TAGS = [
  { value: 'herb', label: 'Herb' },
  { value: 'vegetable', label: 'Vegetable' },
  { value: 'flower', label: 'Flower' },
  { value: 'perennial', label: 'Perennial' },
];

export function Inputs() {
  const starred = signal(false);
  return (
    <Page
      title="Inputs"
      description="Buttons and fields in every kind, size and state."
    >
      <Card title="Button kinds">
        <Row wrap>
          <Button label="Add plant" kind="primary" icon={IconPlus} />
          <Button label="Export" icon={IconDownload} />
          <Button label="Edit" kind="tint" icon={IconPencil} />
          <Button label="More" kind="subtle" iconEnd={IconChevronDown} />
          <Button label="Delete" kind="danger" icon={IconTrash} />
        </Row>
        <Row wrap>
          <Button label="Small" size="sm" kind="primary" />
          <Button label="Medium" size="md" kind="primary" />
          <Button label="Large" size="lg" kind="primary" />
        </Row>
        <Row wrap>
          <Button label="Saving" kind="primary" loading />
          <Button label="Disabled" kind="primary" disabled />
          <Button label="Disabled" disabled />
          <IconButton icon={IconSearch} label="Search" />
          <IconButton icon={IconPlus} label="Add" kind="primary" />
          <IconButton icon={IconPencil} label="Edit" kind="default" />
          <IconButton
            icon={IconStar}
            label="Favourite"
            selected={starred()}
            onPress={() => starred.update((on) => !on)}
          />
          <IconButton icon={IconTrash} label="Delete" disabled />
        </Row>
        <Button label="Full width" fullWidth />
      </Card>

      <Card title="Text fields">
        <Stack gap="lg">
          <TextField label="Plant name" placeholder="Cherry tomato" />
          <TextField
            label="Variety"
            description="As printed on the seed packet."
            placeholder="Sungold"
            required
          />
          <TextField
            label="Email"
            kind="email"
            icon={IconSearch}
            placeholder="name@example.com"
          />
          <TextField label="Spacing" error="Enter a number of centimetres." />
          <TextField label="Plot code" value="NB-04" disabled />
          <TextField label="Read only" value="Planted 12 April" readOnly />
          <TextField label="Password" kind="password" />
          <TextArea
            label="Notes"
            placeholder="What did you notice today?"
            maxLength={280}
          />
          <NumberField label="Plants" min={0} max={50} unit="plants" />
          <NumberField label="Disabled count" value={3} disabled />
        </Stack>
      </Card>

      <Card title="Choices">
        <Stack gap="lg">
          <Select label="Plot" options={PLOTS} placeholder="Choose a plot" />
          <Select
            label="Plot, searchable"
            options={PLOTS}
            searchable
            clearable
          />
          <Select
            label="Required plot"
            options={PLOTS}
            required
            error="Choose where it grows."
          />
          <Combobox
            label="Tags"
            options={TAGS}
            multiple
            placeholder="Search tags"
          />
        </Stack>
      </Card>

      <Card title="Toggles and ranges">
        <Stack gap="lg">
          <Checkbox label="Water in the morning" />
          <Checkbox
            label="Send a reminder"
            description="A notification at 7:00 on watering days."
            checked
          />
          <Checkbox label="All beds" indeterminate />
          <Checkbox label="Locked option" disabled />
          <Switch
            label="Frost alerts"
            description="Warn when the night drops below 2 °C."
            checked
          />
          <Switch label="Weekly summary" />
          <Switch label="Unavailable" disabled />
          <RadioGroup
            label="Units"
            options={[
              {
                value: 'metric',
                label: 'Metric',
                description: 'Kilograms and litres',
              },
              {
                value: 'imperial',
                label: 'Imperial',
                description: 'Pounds and gallons',
              },
              { value: 'mixed', label: 'Mixed', disabled: true },
            ]}
            value="metric"
          />
          <RadioGroup
            label="Week starts on"
            direction="row"
            options={[
              { value: 'mon', label: 'Monday' },
              { value: 'sun', label: 'Sunday' },
            ]}
          />
          <Slider
            label="Shade"
            value={40}
            formatValue={(value) => `${value} %`}
          />
          <Slider label="Disabled" value={70} disabled />
          <DatePicker label="Sown on" placeholder="Pick a date" clearable />
          <DatePicker label="Next watering" withTime value="2026-04-12T07:30" />
        </Stack>
      </Card>

      <Card
        title="Form with a draft"
        description="Type, leave and come back: unsent input is kept on the device."
      >
        <Form
          id="gallery-new-plant"
          onSubmit={async (values) => {
            await new Promise((resolve) => setTimeout(resolve, 600));
            Toast.success('Plant added', String(values.name ?? ''));
          }}
        >
          <TextField
            name="name"
            label="Name"
            required
            placeholder="Lemon balm"
          />
          <Select name="plot" label="Plot" options={PLOTS} required />
          <NumberField name="count" label="How many" min={1} />
          <TextArea name="notes" label="Notes" />
          <Row justify="end">
            <Button label="Add plant" type="submit" />
          </Row>
        </Form>
      </Card>
    </Page>
  );
}
