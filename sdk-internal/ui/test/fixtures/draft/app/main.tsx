import {
  Button,
  Checkbox,
  Form,
  If,
  Page,
  Switch,
  TextField,
  Toast,
  mount,
  signal,
} from '@hatch/ui';
import type { FormValues } from '@hatch/ui';

function describe(values: FormValues): string {
  return Object.entries(values)
    .map(([name, value]) => `${name}=${String(value)}`)
    .join(' ');
}

function App() {
  const showPin = signal(true);
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
        <Checkbox name="mulch" label="Mulch" />
        <Button label="Save" type="submit" />
      </Form>
      <Form id="account" onSubmit={() => undefined}>
        <TextField name="nickname" label="Nickname" />
        <If when={showPin()}>
          <TextField name="pin" label="PIN" kind="password" />
        </If>
        <Button label="Hide PIN" onPress={() => showPin.set(false)} />
      </Form>
      <Form
        id="terms"
        saveDraft={false}
        validate={(values) =>
          values.agree === true ? undefined : { agree: 'Agree to continue.' }
        }
        onSubmit={() => Toast.show({ title: 'Agreed' })}
      >
        <Switch name="agree" label="I agree" />
        <Button label="Continue" type="submit" />
      </Form>
    </Page>
  );
}

mount(App);
