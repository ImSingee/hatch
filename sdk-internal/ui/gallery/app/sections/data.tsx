import { Card, DataTable, Page, Toast } from '@hatch/ui';

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

export function Data() {
  return (
    <Page title="Data" description="Tables, lists and figures.">
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
    </Page>
  );
}
