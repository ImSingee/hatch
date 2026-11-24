import { Box, MantineProvider } from '@mantine/core';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import type { AskAnswer, AskQuestion } from '~agent/events';
import { AskForm } from './ask-form';

// Icon candidates arrive in one inline prompt line (the app-icon skill's
// format); each must still land on its own row rather than packing into a
// single wrapped line.
test('stacks prompt images one per line', async () => {
  const candidate = (id: string) => `/api/images/candidates/${id.repeat(32)}`;
  const question: AskQuestion = {
    id: 'icon',
    prompt:
      `Which icon? ` +
      `A ![A](${candidate('a')}) ` +
      `B ![B](${candidate('b')}) ` +
      `C ![C](${candidate('c')})`,
    options: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
      { id: 'c', label: 'C' },
    ],
    allowMultiple: false,
  };
  const screen = await render(
    <MantineProvider>
      <Box w={560}>
        <AskForm
          questions={[question]}
          onSubmit={vi.fn<(answers: AskAnswer[]) => void>()}
        />
      </Box>
    </MantineProvider>,
  );
  const tops = [...screen.container.querySelectorAll('img')].map(
    (image) => image.getBoundingClientRect().top,
  );
  expect(tops).toHaveLength(3);
  expect(tops[1]).toBeGreaterThan(tops[0]);
  expect(tops[2]).toBeGreaterThan(tops[1]);
});
