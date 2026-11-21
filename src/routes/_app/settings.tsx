import { Button } from '@mantine/core';
import {
  type LinkProps,
  Outlet,
  createFileRoute,
  useRouterState,
} from '@tanstack/react-router';
import {
  IconBell,
  IconInfoCircle,
  IconLogout,
  IconNetwork,
  IconPalette,
  IconRobot,
  IconServer2,
  IconServerBolt,
  IconSettings,
  IconUserCircle,
  IconUsers,
} from '@tabler/icons-react';
import { ThemeIcon } from '@mantine/core';
import type { ReactNode } from 'react';
import { authClient } from '~auth/client';
import { useSignOut } from '~auth/use-sign-out';
import { DeskWindow } from '~components/desk/window';
import { WindowBody } from '~components/page/page';
import { Rail, RailIdentity, WindowSplit } from '~components/page/split';

export const Route = createFileRoute('/_app/settings')({
  component: SettingsLayout,
});

const icon = (Icon: typeof IconBell) => <Icon size={15} stroke={2} />;

type SettingsItem = {
  to: LinkProps['to'];
  label: string;
  icon: ReactNode;
  color: string;
  keywords: string;
};

const GROUPS: { label: string; items: SettingsItem[] }[] = [
  {
    label: 'Personal',
    items: [
      {
        to: '/settings/account',
        label: 'Account',
        icon: icon(IconUserCircle),
        color: 'primary',
        keywords: 'profile password passkeys api keys sessions homepage',
      },
      {
        to: '/settings/appearance',
        label: 'Appearance',
        icon: icon(IconPalette),
        color: 'violet',
        keywords: 'accent colour color theme',
      },
    ],
  },
  {
    label: 'Space',
    items: [
      {
        to: '/settings/providers',
        label: 'AI Providers',
        icon: icon(IconServer2),
        color: 'orange',
        keywords: 'models image model keys',
      },
      {
        to: '/settings/users',
        label: 'Users',
        icon: icon(IconUsers),
        color: 'pink',
        keywords: 'sign-up members',
      },
      {
        to: '/settings/notifications',
        label: 'Notifications',
        icon: icon(IconBell),
        color: 'amber',
        keywords: 'destinations groups routes channels webhook',
      },
      {
        to: '/settings/tailscale',
        label: 'Tailscale',
        icon: icon(IconNetwork),
        color: 'dark',
        keywords: 'tailnet private network',
      },
    ],
  },
  {
    label: 'Status',
    items: [
      {
        to: '/settings/backends',
        label: 'Backends',
        icon: icon(IconServerBolt),
        color: 'blue',
        keywords: 'app backend runtime',
      },
      {
        to: '/settings/agent-runner',
        label: 'Agent Runner',
        icon: icon(IconRobot),
        color: 'green',
        keywords: 'runners runs',
      },
      {
        to: '/settings/about',
        label: 'About',
        icon: icon(IconInfoCircle),
        color: 'gray',
        keywords: 'version revision build',
      },
    ],
  },
];

function SettingsLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { data } = authClient.useSession();
  const { signOut, leaving } = useSignOut();
  const name = data?.user.name || data?.user.email || 'Account';
  const current = GROUPS.flatMap((group) => group.items).find(
    (item) =>
      pathname === item.to || pathname.startsWith(`${String(item.to)}/`),
  );

  return (
    <DeskWindow
      fill
      title={current ? `Settings · ${current.label}` : 'Settings'}
      tile={
        <ThemeIcon size={22} radius="xs" color="gray.7">
          <IconSettings size={13} stroke={2.4} />
        </ThemeIcon>
      }
    >
      <WindowSplit
        rail={
          <Rail
            label="Settings sections"
            searchLabel="Search settings"
            identity={
              <RailIdentity
                monogram={Array.from(name.trim())[0]?.toUpperCase() ?? '?'}
                name={name}
                meta={data?.user.email}
              />
            }
            groups={GROUPS.map((group) => ({
              label: group.label,
              items: group.items.map((item) => ({
                key: String(item.to),
                label: item.label,
                icon: item.icon,
                color: item.color,
                keywords: item.keywords,
                link: { to: item.to },
                current: item === current,
              })),
            }))}
            footer={
              <Button
                fullWidth
                variant="default"
                leftSection={<IconLogout size={16} stroke={1.8} />}
                loading={leaving}
                onClick={signOut}
              >
                Sign out
              </Button>
            }
          />
        }
      >
        <WindowBody size={1080}>
          <Outlet />
        </WindowBody>
      </WindowSplit>
    </DeskWindow>
  );
}
