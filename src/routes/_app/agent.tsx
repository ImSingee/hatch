import {
  ActionIcon,
  Box,
  Center,
  Drawer,
  Loader,
  Text,
  ThemeIcon,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import {
  Outlet,
  createFileRoute,
  useNavigate,
  useParams,
} from '@tanstack/react-router';
import { IconMessages, IconSparkles } from '@tabler/icons-react';
import { Suspense } from 'react';
import { SessionsPanel } from '~components/agent/sessions-panel';
import { DeskWindow } from '~components/desk/window';
import { InsideWindowProvider } from '~components/page/window-context';
import { useI18n } from '~i18n';
import {
  providersQueryOptions,
  sessionQueryOptions,
  sessionsQueryOptions,
} from '~queries/agent';
import classes from '~components/agent/chat.module.css';

export const Route = createFileRoute('/_app/agent')({
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(sessionsQueryOptions),
      context.queryClient.ensureQueryData(providersQueryOptions),
    ]);
  },
  component: AgentLayout,
});

function AgentLayout() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { threadId } = useParams({ strict: false });
  const [drawerOpened, drawer] = useDisclosure(false);
  // The tab names the open chat, following its automatic title and renames
  // through the same cache the chat reads; a new chat is just "Agent".
  const { data: chatTitle } = useQuery({
    ...sessionQueryOptions(threadId ?? ''),
    enabled: Boolean(threadId),
    select: (session) => session?.title,
  });

  const select = (id: string | null) => {
    drawer.close();
    if (id) {
      void navigate({ to: '/agent/$threadId', params: { threadId: id } });
    } else {
      void navigate({ to: '/agent' });
    }
  };

  return (
    <DeskWindow
      fill
      maxWidth={1360}
      title={t('nav.agent')}
      documentTitle={(threadId && chatTitle) || t('nav.agent')}
      tile={
        <ThemeIcon size={22} radius="xs" color="primary">
          <IconSparkles size={13} stroke={2.4} />
        </ThemeIcon>
      }
    >
      <Box className={classes.root}>
        <Suspense
          fallback={
            <Center style={{ flex: 1 }}>
              <Loader />
            </Center>
          }
        >
          <Box className={classes.sessionsRail}>
            <SessionsPanel selected={threadId ?? null} onSelect={select} />
          </Box>

          <Drawer
            opened={drawerOpened}
            onClose={drawer.close}
            position="left"
            size={300}
            title={t('agent.layout.chats')}
            padding="md"
            classNames={{ body: classes.drawerBody }}
          >
            <SessionsPanel selected={threadId ?? null} onSelect={select} />
          </Drawer>

          <Box className={classes.agentMain}>
            <Box className={classes.mobileBar}>
              <ActionIcon
                variant="default"
                radius="md"
                aria-label={t('agent.layout.openChats')}
                onClick={drawer.open}
              >
                <IconMessages size={18} stroke={1.6} />
              </ActionIcon>
              <Text fw={700} size="sm" truncate>
                {threadId
                  ? t('agent.chat.fallbackTitle')
                  : t('agent.sessions.new')}
              </Text>
            </Box>

            <InsideWindowProvider value>
              <Outlet />
            </InsideWindowProvider>
          </Box>
        </Suspense>
      </Box>
    </DeskWindow>
  );
}
