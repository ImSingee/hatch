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
import { providersQueryOptions, sessionsQueryOptions } from '~queries/agent';
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
  const navigate = useNavigate();
  const { threadId } = useParams({ strict: false });
  const [drawerOpened, drawer] = useDisclosure(false);

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
      title="Agent"
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
            title="Chats"
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
                aria-label="Open chats"
                onClick={drawer.open}
              >
                <IconMessages size={18} stroke={1.6} />
              </ActionIcon>
              <Text fw={700} size="sm" truncate>
                {threadId ? 'Chat' : 'New chat'}
              </Text>
            </Box>

            <Outlet />
          </Box>
        </Suspense>
      </Box>
    </DeskWindow>
  );
}
