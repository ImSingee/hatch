// A stand-in for @hatch/ui in platform tests: the smallest catalogue the
// fixture needs, built on nsh directly (which only app/custom/ may do).
import { mount as nshMount, signal, Scroll, Text, View } from 'nsh';
import type { JSX } from 'nsh';
import { Button as BaseButton } from 'nsh/base';
import { followShellTheme } from '@hatch/app/native';

export { signal };

export function mount(App: () => JSX.Element): void {
  followShellTheme();
  nshMount(App);
}

export function Page(props: { title: string; children?: JSX.Element }) {
  return (
    <Scroll class="flex-1 bg-background">
      <View class="gap-3 p-4">
        <Text class="text-2xl font-bold text-foreground">{props.title}</Text>
        {props.children}
      </View>
    </Scroll>
  );
}

export function Label(props: { children?: JSX.Element }) {
  return <Text class="text-foreground">{props.children}</Text>;
}

export function Button(props: { label: string; onPress: () => void }) {
  return (
    <BaseButton
      onPress={props.onPress}
      class="self-start rounded-(--radius) bg-primary px-4 py-2"
    >
      <Text class="text-primary-foreground">{props.label}</Text>
    </BaseButton>
  );
}
