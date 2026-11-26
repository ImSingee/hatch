import {
  Button,
  ListDetailPage,
  Stack,
  Text,
  TextField,
  mount,
  signal,
} from '@hatch/ui';

type Bed = { id: string; name: string; soil: string };

const BEDS: Bed[] = [
  { id: 'north', name: 'North bed', soil: 'dry' },
  { id: 'south', name: 'South bed', soil: 'dry' },
];

function App() {
  const beds = signal(BEDS);
  return (
    <ListDetailPage
      title="Beds"
      items={beds()}
      getKey={(bed) => bed.id}
      renderItem={(bed) => ({ title: bed.name })}
      detailTitle={(bed) => bed.name}
      renderDetail={(bed) => (
        <Stack>
          <Text>Soil is {bed().soil}</Text>
          <TextField label="Notes" />
        </Stack>
      )}
      actions={
        <Button
          label="Water all"
          onPress={() =>
            beds.set(beds().map((bed) => ({ ...bed, soil: 'wet' })))
          }
        />
      }
    />
  );
}

mount(App);
