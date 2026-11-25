import { Button, Form, Page, TextField, Toast, mount } from '@hatch/ui';
import type { FormValues } from '@hatch/ui';

function describe(values: FormValues): string {
  return Object.entries(values)
    .map(([name, value]) => `${name}=${String(value)}`)
    .join(' ');
}

function App() {
  return (
    <Page title="Draft">
      <Form id="note" onSubmit={() => Toast.show({ title: 'Sent' })}>
        <TextField name="title" label="Title" />
        <TextField name="secret" label="Secret" kind="password" />
        <Button label="Send" type="submit" />
      </Form>
      <Form
        id="plant"
        initialValues={{ plant: 'Fern' }}
        onSubmit={(values) =>
          Toast.show({ title: `Saved ${describe(values)}` })
        }
      >
        <TextField name="plant" label="Plant" />
        <TextField name="bed" label="Bed" required value="North bed" />
        <Button label="Save" type="submit" />
      </Form>
    </Page>
  );
}

mount(App);
