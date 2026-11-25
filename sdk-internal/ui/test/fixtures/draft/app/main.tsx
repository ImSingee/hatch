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
  const nickname = signal(false);
  const memoOpen = signal(true);
  const finishSend: { resolve: () => void } = { resolve: () => undefined };
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
      <Form
        id="rename"
        initialValues={{ nick: 'Ivy G' }}
        onSubmit={(values) =>
          Toast.show({ title: `Named ${describe(values)}` })
        }
      >
        <TextField
          name={nickname() ? 'nick' : 'name'}
          label="Call me"
          required
        />
        <Button label="Use nickname" onPress={() => nickname.set(true)} />
        <Button label="Save name" type="submit" />
      </Form>
      <If when={memoOpen()}>
        <Form
          id="memo"
          onSubmit={() =>
            new Promise<void>((resolve) => {
              finishSend.resolve = resolve;
            })
          }
        >
          <TextField name="memo" label="Memo" />
          <Button label="Send memo" type="submit" />
        </Form>
      </If>
      <Button label="Close memo" onPress={() => memoOpen.set(false)} />
      <Button label="Open memo" onPress={() => memoOpen.set(true)} />
      <Button label="Finish sending" onPress={() => finishSend.resolve()} />
      <Button
        label="Finish and reopen"
        onPress={() => {
          finishSend.resolve();
          setTimeout(() => memoOpen.set(true), 50);
        }}
      />
    </Page>
  );
}

mount(App);
