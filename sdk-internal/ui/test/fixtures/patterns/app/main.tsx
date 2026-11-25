import { ListDetailPage, Text, mount, signal } from '@hatch/ui';

const BEDS = [0, 1, 2];

function App() {
  const search = signal('');
  return (
    <ListDetailPage
      title="Beds"
      items={BEDS}
      getKey={String}
      renderItem={(bed) => ({ title: `Bed ${bed}` })}
      detailTitle={(bed) => `Bed ${bed}`}
      renderDetail={(bed) => <Text>Soil of bed {String(bed)}</Text>}
      search={{ value: search(), onChange: (value) => search.set(value) }}
    />
  );
}

mount(App);
