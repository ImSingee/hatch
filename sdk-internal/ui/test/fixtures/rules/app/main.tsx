/**
 * Compiles only if no component of `@hatch/ui` takes `class`, `classList` or
 * `style`, with the props NSH's types resolve to. `nsh check` runs it.
 */
import * as UI from '@hatch/ui';
import { Button, Card, Page, Text, mount } from '@hatch/ui';

type Props<C> = C extends (props: infer P) => unknown ? P : never;
type Forbidden = 'class' | 'classList' | 'style';
type Offenders = {
  [K in keyof typeof UI]: [
    Extract<keyof Props<(typeof UI)[K]>, Forbidden>,
  ] extends [never]
    ? never
    : K;
}[keyof typeof UI];

export const noComponentTakesClassOrStyle: [Offenders] extends [never]
  ? true
  : false = true;

function App() {
  return (
    <Page title="Rules">
      <Card title="Card">
        {/* @ts-expect-error: a component takes no class. */}
        <Button label="Save" class="bg-red-500" />
        {/* @ts-expect-error: a component takes no style. */}
        <Text style={{ color: 'red' }}>Plain text</Text>
      </Card>
      {/* @ts-expect-error: only typed tones, no colour names. */}
      <Button label="Save" kind="red" />
    </Page>
  );
}

mount(App);
