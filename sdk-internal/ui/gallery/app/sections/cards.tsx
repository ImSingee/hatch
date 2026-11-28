import { Each, Grid, Page, Section, Stack, Toast, signal } from '@hatch/ui';
import * as Card from '@hatch/ui/card';
import type { ReplyAnswers } from '@hatch/ui/card';
import { CARD_EXAMPLES, MARKDOWN_EXAMPLE } from '../card-examples.gen';

/** Every card of the notification designs, from their markup, then cards
 * written in TSX, a live form and an unusable card. Sample content only. */
export function Cards() {
  return (
    <Page
      title="Cards"
      description="The cards notifications show, from markup and in TSX."
    >
      <Section title="From markup" description="The notification examples.">
        <Grid columns={2} gap="md">
          <Each of={CARD_EXAMPLES} key={(example) => example.id}>
            {(example) => (
              <Card.CardMarkup
                source={example().markup!}
                onSubmit={(answers) => answered(example().id, answers)}
                onLinkPress={(href) => Toast.show({ title: `Opens ${href}` })}
              />
            )}
          </Each>
          <Card.CardMarkup
            source={`<Card><Markdown><![CDATA[${MARKDOWN_EXAMPLE.markdown!}]]></Markdown></Card>`}
            onLinkPress={(href) => Toast.show({ title: `Opens ${href}` })}
          />
        </Grid>
      </Section>
      <Section title="In TSX" description="The same parts, composed in code.">
        <Grid columns={2} gap="md">
          <WaterCard />
          <HarvestCard />
          <PlanCard />
        </Grid>
      </Section>
      <Section
        title="States"
        description="Answered, busy, failing and unusable cards."
      >
        <Grid columns={2} gap="md">
          <Card.CardMarkup
            source={
              CARD_EXAMPLES.find((example) => example.id === 'perm')!.markup!
            }
            answers={{ decision: 'once' }}
          />
          <FailingCard />
          <Card.CardMarkup source={'<Card>\n  <Txt>Wrong tag</Txt>\n</Card>'} />
        </Grid>
      </Section>
    </Page>
  );
}

function answered(id: string, answers: ReplyAnswers) {
  Toast.show({ title: `${id}: ${JSON.stringify(answers)}` });
}

function WaterCard() {
  const litres = signal(310);
  return (
    <Card.Card icon="chart" status="Above plan" tone="warning">
      <Card.Row justify="between" align="end">
        <Card.Column gap="xs">
          <Card.Text size="xl" weight="bold">{`${litres()} l`}</Card.Text>
          <Card.Caption>Water used in August</Card.Caption>
        </Card.Column>
        <Card.Badge tone="danger">+6% vs July</Card.Badge>
      </Card.Row>
      <Card.Trend
        values={[38, 41, 36, 44, 52, 49, 50]}
        threshold={48}
        unit="l"
        label="Last 7 days"
      />
      <Card.Divider />
      <Card.Grid columns={3}>
        <Card.Stat value="120 l" label="North bed" />
        <Card.Stat value="110 l" label="South bed" />
        <Card.Stat value="80 l" label="Patio pots" />
      </Card.Grid>
      <Card.Row justify="end">
        <Card.Button onPress={() => litres.update((value) => value + 10)}>
          Log 10 l
        </Card.Button>
      </Card.Row>
    </Card.Card>
  );
}

function HarvestCard() {
  return (
    <Card.Card icon="task" status="In progress" tone="working">
      <Card.Title>Harvest the north bed</Card.Title>
      <Card.Text>
        Tomatoes first, then the beans. Weigh everything on the{' '}
        <Card.Bold>kitchen scale</Card.Bold>.
      </Card.Text>
      <Card.Steps>
        <Card.Step state="done" detail="08:10">
          Pick the tomatoes
        </Card.Step>
        <Card.Step state="running" detail="now">
          Pick the beans
        </Card.Step>
        <Card.Step>Weigh and log</Card.Step>
      </Card.Steps>
      <Card.Fields>
        <Card.Field label="Plot">North bed</Card.Field>
        <Card.Field label="Crop code" mono>
          NB-TOM-0826
        </Card.Field>
      </Card.Fields>
      <Card.Callout tone="info" title="Rain after 15:00">
        Cover the seedlings before you leave.
      </Card.Callout>
    </Card.Card>
  );
}

function PlanCard() {
  return (
    <Card.Card
      icon="clock"
      status="Your choice"
      tone="warning"
      onSubmit={async (answers) => {
        await new Promise((resolve) => setTimeout(resolve, 600));
        answered('plan', answers);
      }}
    >
      <Card.Title>When should the sprinkler run?</Card.Title>
      <Card.Choice id="slot" label="Time" required>
        <Card.Option
          id="dawn"
          note="cooler"
          thenStatus="Dawn"
          thenTone="success"
          default
        >
          At dawn
        </Card.Option>
        <Card.Option id="dusk" thenStatus="Dusk" thenTone="success">
          At dusk
        </Card.Option>
      </Card.Choice>
      <Card.Choice id="beds" label="Beds" multiple>
        <Card.Option id="north" default>
          North bed
        </Card.Option>
        <Card.Option id="south" badge="new">
          South bed
        </Card.Option>
      </Card.Choice>
      <Card.Input
        id="note"
        label="Note for the gardener"
        placeholder="Optional"
        multiline
      />
      <Card.Submit>Save plan</Card.Submit>
    </Card.Card>
  );
}

function FailingCard() {
  return (
    <Card.Card
      status="Needs you"
      tone="danger"
      flag="Urgent"
      onSubmit={() => Promise.reject(new Error('The valve did not answer.'))}
    >
      <Card.Title>Open the main valve?</Card.Title>
      <Stack>
        <Card.Buttons id="valve">
          <Card.Button
            id="open"
            primary
            thenStatus="Opening"
            thenTone="working"
          >
            Open it
          </Card.Button>
          <Card.Button id="wait">Not yet</Card.Button>
        </Card.Buttons>
      </Stack>
    </Card.Card>
  );
}
