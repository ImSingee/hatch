import { Button, Form, Page, TextField, Toast, mount } from '@hatch/ui';

function App() {
  return (
    <Page title="Draft">
      <Form id="note" onSubmit={() => Toast.show({ title: 'Sent' })}>
        <TextField name="title" label="Title" />
        <TextField name="secret" label="Secret" kind="password" />
        <Button label="Send" type="submit" />
      </Form>
    </Page>
  );
}

mount(App);
