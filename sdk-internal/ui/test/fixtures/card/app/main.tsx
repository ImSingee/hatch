import { Page, Stack, mount, signal } from '@hatch/ui';
import * as Card from '@hatch/ui/card';
import type { ReplyAnswers } from '@hatch/ui/card';
import { View, host } from 'nsh';
import cases from './cases.json';

/** What the App's `onSubmit` received, shown for the test to read. */
const submitted = signal<string>('none');

/** The same card as the `deploy` example, written in TSX. */
function DeployCard() {
  return (
    <Card.Card icon="app" status="已上线" tone="success">
      <Card.Title>v12 已部署到生产</Card.Title>
      <Card.Text>
        这次部署包含 2 个改动，数据迁移已完成，旧版本的实例已经停掉。
      </Card.Text>
      <Card.Fields>
        <Card.Field label="版本">v12</Card.Field>
        <Card.Field label="耗时">48 秒</Card.Field>
        <Card.Field label="实例">2 个运行中</Card.Field>
      </Card.Fields>
    </Card.Card>
  );
}

/** A card answered in the App: a choice, a text answer, a row of buttons. */
function FormCard(props: { fail?: boolean; repeatable?: boolean }) {
  return (
    <Card.Card
      status="Waiting"
      flag="Urgent"
      repeatable={props.repeatable}
      onSubmit={(answers: ReplyAnswers) => {
        if (props.fail)
          return Promise.reject(new Error('The valve did not answer.'));
        submitted.set(JSON.stringify(answers));
      }}
    >
      <Card.Title>Water the beds</Card.Title>
      <Card.Choice id="slot" label="When" required>
        <Card.Option id="dawn" thenStatus="At dawn" thenTone="success">
          Dawn
        </Card.Option>
        <Card.Option id="dusk">Dusk</Card.Option>
      </Card.Choice>
      <Card.Input id="note" label="Note" />
      <Card.Buttons id="go">
        <Card.Button id="now" primary>
          Water now
        </Card.Button>
        <Card.Button id="later">Later</Card.Button>
      </Card.Buttons>
    </Card.Card>
  );
}

function App() {
  const params = host.available() ? host.params : {};
  const id = typeof params.example === 'string' ? params.example : '';
  const example = (cases as { id: string; markup: string }[]).find(
    (entry) => entry.id === id,
  );
  return (
    <Page title="Card">
      <Stack>
        <View testID="card">
          {id === 'tsx-deploy' ? <DeployCard /> : null}
          {id === 'form' ? <FormCard /> : null}
          {id === 'form-failing' ? <FormCard fail /> : null}
          {id === 'form-repeatable' ? <FormCard repeatable /> : null}
          {example ? (
            <Card.CardMarkup
              source={example.markup}
              answers={
                typeof params.answers === 'string'
                  ? (JSON.parse(params.answers) as ReplyAnswers)
                  : undefined
              }
              onLinkPress={(href) => submitted.set(`link ${href}`)}
            />
          ) : null}
        </View>
        <Card.Text>{`submitted: ${submitted()}`}</Card.Text>
      </Stack>
    </Page>
  );
}

mount(App);
