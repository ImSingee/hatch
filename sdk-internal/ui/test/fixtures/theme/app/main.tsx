import { Button, Page, mount } from '@hatch/ui';

function App() {
  return (
    <Page title="Theme">
      <Button label="Save" kind="primary" />
    </Page>
  );
}

mount(App);
