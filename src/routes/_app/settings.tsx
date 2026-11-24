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
import { UserAvatar } from '~components/auth/user-avatar';
import { DeskWindow } from '~components/desk/window';
import { type PlainTranslationKey, useI18n } from '~i18n';
import { WindowBody } from '~components/page/page';
import { Rail, RailIdentity, WindowSplit } from '~components/page/split';
import { userAvatarSrc } from '~lib/user-avatar';

export const Route = createFileRoute('/_app/settings')({
  component: SettingsLayout,
});

const icon = (Icon: typeof IconBell) => <Icon size={15} stroke={2} />;

type SettingsItem = {
  to: LinkProps['to'];
  label: PlainTranslationKey;
  icon: ReactNode;
  color: string;
  keywords: PlainTranslationKey;
};

const GROUPS: { label: PlainTranslationKey; items: SettingsItem[] }[] = [
  {
    label: 'settings.group.personal',
    items: [
      {
        to: '/settings/account',
        label: 'settings.account.label',
        icon: icon(IconUserCircle),
        color: 'primary',
        keywords: 'settings.account.keywords',
      },
      {
        to: '/settings/appearance',
        label: 'settings.appearance.label',
        icon: icon(IconPalette),
        color: 'violet',
        keywords: 'settings.appearance.keywords',
      },
    ],
  },
  {
    label: 'settings.group.space',
    items: [
      {
        to: '/settings/providers',
        label: 'settings.providers.label',
        icon: icon(IconServer2),
        color: 'orange',
        keywords: 'settings.providers.keywords',
      },
      {
        to: '/settings/users',
        label: 'settings.users.label',
        icon: icon(IconUsers),
        color: 'pink',
        keywords: 'settings.users.keywords',
      },
      {
        to: '/settings/notifications',
        label: 'settings.notifications.label',
        icon: icon(IconBell),
        color: 'amber',
        keywords: 'settings.notifications.keywords',
      },
      {
        to: '/settings/tailscale',
        label: 'settings.tailscale.label',
        icon: icon(IconNetwork),
        color: 'dark',
        keywords: 'settings.tailscale.keywords',
      },
    ],
  },
  {
    label: 'settings.group.status',
    items: [
      {
        to: '/settings/backends',
        label: 'settings.backends.label',
        icon: icon(IconServerBolt),
        color: 'blue',
        keywords: 'settings.backends.keywords',
      },
      {
        to: '/settings/agent-runner',
        label: 'settings.agentRunner.label',
        icon: icon(IconRobot),
        color: 'green',
        keywords: 'settings.agentRunner.keywords',
      },
      {
        to: '/settings/about',
        label: 'settings.about.label',
        icon: icon(IconInfoCircle),
        color: 'gray',
        keywords: 'settings.about.keywords',
      },
    ],
  },
];

function SettingsLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { data } = authClient.useSession();
  const { signOut, leaving } = useSignOut();
  const { t } = useI18n();
  const name =
    data?.user.name || data?.user.email || t('settings.accountFallback');
  const current = GROUPS.flatMap((group) => group.items).find(
    (item) =>
      pathname === item.to || pathname.startsWith(`${String(item.to)}/`),
  );

  return (
    <DeskWindow
      fill
      title={
        current
          ? t('settings.titleWithSection', { section: t(current.label) })
          : t('settings.title')
      }
      tile={
        <ThemeIcon size={22} radius="xs" color="gray.7">
          <IconSettings size={13} stroke={2.4} />
        </ThemeIcon>
      }
    >
      <WindowSplit
        rail={
          <Rail
            label={t('settings.sections')}
            searchLabel={t('settings.search')}
            identity={
              <RailIdentity
                tile={
                  data && userAvatarSrc(data.user.id, data.user.image, 48) ? (
                    <UserAvatar
                      userId={data.user.id}
                      image={data.user.image}
                      name={name}
                      size={48}
                      radius="md"
                    />
                  ) : undefined
                }
                monogram={Array.from(name.trim())[0]?.toUpperCase() ?? '?'}
                name={name}
                meta={data?.user.email}
              />
            }
            groups={GROUPS.map((group) => ({
              label: t(group.label),
              items: group.items.map((item) => ({
                key: String(item.to),
                label: t(item.label),
                icon: item.icon,
                color: item.color,
                keywords: t(item.keywords),
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
                {t('common.signOut')}
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
