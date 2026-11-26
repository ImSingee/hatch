/**
 * A reply form whose last question is a row of required buttons: the
 * buttons replace the submit button, and clicking one sends every answer in
 * the form, defaults included, after the usual confirmation.
 */
import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { appCssVariablesResolver, appTheme } from '~/ui/theme';
import type {
  ReplyAnswers,
  ReplyForm,
} from '../../../packages/hatch-platform-api/notification-reply';
import { ReplySection } from './reply-section';

const sent = vi.hoisted(
  () => [] as { id: string; round: number; answers: ReplyAnswers }[],
);

// Server Functions cannot load in the browser project.
vi.mock('~server/notifications', () => ({
  respondToNotificationFn: async ({
    data,
  }: {
    data: { id: string; round: number; answers: ReplyAnswers };
  }) => {
    sent.push(data);
    return {};
  },
}));
vi.mock('~queries/notifications', () => ({ NOTIFICATIONS_KEY: ['n'] }));

const reply: ReplyForm = {
  fields: [
    {
      id: 'env',
      type: 'single',
      label: 'Where',
      required: false,
      default: 'staging',
      options: [
        { id: 'staging', label: 'Staging', note: 'about 1 minute' },
        { id: 'prod', label: 'Production', badge: 'risky' },
      ],
    },
    {
      id: 'how',
      type: 'text',
      label: 'Tell the Agent how',
      required: false,
      multiline: true,
      maxLength: 1000,
    },
    {
      id: 'next',
      type: 'buttons',
      label: '',
      required: true,
      options: [
        { id: 'later', label: 'Later' },
        { id: 'fix', label: 'Fix it', primary: true },
      ],
    },
  ],
  submitLabel: 'Submit',
};

test('the trailing buttons send the whole form', async () => {
  const screen = await render(
    <MantineProvider
      theme={appTheme}
      cssVariablesResolver={appCssVariablesResolver}
    >
      <ModalsProvider>
        <QueryClientProvider client={new QueryClient()}>
          <ReplySection
            notificationId="n1"
            reply={reply}
            round={2}
            response={null}
            recalledAt={null}
          />
        </QueryClientProvider>
      </ModalsProvider>
    </MantineProvider>,
  );
  await expect
    .element(screen.getByRole('radio', { name: /Staging/ }))
    .toBeChecked();
  await expect
    .element(screen.getByRole('button', { name: 'Submit' }))
    .not.toBeInTheDocument();

  await screen
    .getByRole('textbox', { name: 'Tell the Agent how' })
    .fill('Cap it at 30 s');
  await screen.getByRole('button', { name: 'Fix it' }).click();
  await screen.getByRole('button', { name: 'Send answer' }).click();
  await vi.waitFor(() =>
    expect(sent).toEqual([
      {
        id: 'n1',
        round: 2,
        answers: { env: 'staging', how: 'Cap it at 30 s', next: 'fix' },
      },
    ]),
  );
});
