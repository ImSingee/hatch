import { MantineProvider } from '@mantine/core';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import type { AgentThinkingLevel } from '~/db/schema';
import { ModelPicker, type ModelGroup } from './model-picker';

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    ...props
  }: { children?: React.ReactNode } & Record<string, unknown>) => (
    <a href="/settings/providers" {...props}>
      {children}
    </a>
  ),
}));

const groups: ModelGroup[] = [
  {
    id: 'p1',
    group: 'Provider',
    catalogProviderId: null,
    items: [
      {
        value: 'p1:thinker',
        label: 'Thinker',
        thinkingLevels: ['low', 'medium', 'high'],
        defaultThinkingLevel: 'medium',
      },
      {
        value: 'p1:plain',
        label: 'Plain',
        thinkingLevels: [],
        defaultThinkingLevel: 'off',
      },
    ],
  },
];

async function renderPicker(
  value: string | null,
  level: AgentThinkingLevel | null,
) {
  const onChange = vi.fn<(value: string, level: AgentThinkingLevel) => void>();
  const screen = await render(
    <MantineProvider>
      <ModelPicker
        groups={groups}
        value={value}
        thinkingLevel={level}
        onChange={onChange}
      />
    </MantineProvider>,
  );
  return { screen, onChange };
}

test('one menu picks a model and, for reasoning models, its thinking level', async () => {
  const { screen, onChange } = await renderPicker('p1:thinker', 'high');
  const pill = screen.getByRole('button', { name: 'Thinker · High' });
  await expect.element(pill).toBeVisible();

  await pill.click();
  await screen.getByRole('menuitem', { name: 'Thinker' }).hover();
  await screen.getByRole('menuitem', { name: 'Low' }).click();
  expect(onChange).toHaveBeenLastCalledWith('p1:thinker', 'low');

  // A model without thinking has no level list and picks directly.
  await pill.click();
  await screen.getByRole('menuitem', { name: 'Plain' }).click();
  expect(onChange).toHaveBeenLastCalledWith('p1:plain', 'off');
});

test('clicking a reasoning model keeps its current level, or uses the default', async () => {
  const { screen, onChange } = await renderPicker('p1:plain', 'off');
  await expect
    .element(screen.getByRole('button', { name: 'Plain', exact: true }))
    .toBeVisible();
  await screen.getByRole('button', { name: 'Plain', exact: true }).click();
  await screen.getByRole('menuitem', { name: 'Thinker' }).click();
  expect(onChange).toHaveBeenLastCalledWith('p1:thinker', 'medium');
});

test('search narrows the list', async () => {
  const { screen } = await renderPicker('p1:plain', 'off');
  await screen.getByRole('button', { name: 'Plain', exact: true }).click();
  await screen.getByPlaceholder('Search models').fill('think');
  await expect
    .element(screen.getByRole('menuitem', { name: 'Thinker' }))
    .toBeVisible();
  await expect
    .element(screen.getByRole('menuitem', { name: 'Plain' }))
    .not.toBeInTheDocument();
});
