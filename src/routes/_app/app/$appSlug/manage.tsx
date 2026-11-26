import {
  ActionIcon,
  Anchor,
  Button,
  Group,
  Menu,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Link,
  createFileRoute,
  notFound,
  useNavigate,
  useRouter,
  useRouterState,
} from '@tanstack/react-router';
import {
  IconApi,
  IconArchive,
  IconArchiveOff,
  IconBook,
  IconBell,
  IconCheck,
  IconClock,
  IconDatabase,
  IconDots,
  IconExternalLink,
  IconFileZip,
  IconFolder,
  IconGitBranch,
  IconHistory,
  IconKey,
  IconLayoutDashboard,
  IconListCheck,
  IconPencil,
  IconPin,
  IconPinnedOff,
  IconServerBolt,
  IconSparkles,
  IconTable,
  IconTrash,
  IconWebhook,
  IconX,
} from '@tabler/icons-react';
import copy from 'copy-to-clipboard';
import dayjs from 'dayjs';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Trans } from 'react-i18next';
import { toast } from 'sonner';
import { APP_SLUG_MAX_LENGTH } from '~/app-identity';
import { useI18n } from '~i18n';
import { useOptionalAppSessionStore } from '~components/desk/app-sessions';
import { DeskWindow } from '~components/desk/window';
import {
  Column,
  Columns,
  GroupCard,
  GroupFooter,
  PageHeading,
  Row,
  Section,
  WindowBody,
} from '~components/page/page';
import { Rail, RailIdentity, WindowSplit } from '~components/page/split';
import { ApiPanel } from '~components/apps/api-panel';
import { AppCompatibilityNotice } from '~components/apps/app-compatibility-notice';
import { AppGlyph } from '~components/apps/app-glyph';
import { AppIconSettings } from '~components/apps/app-icon-settings';
import { DeploymentActivity } from '~components/apps/deployment-activity';
import { DeploymentHistory } from '~components/apps/deployment-history';
import { DocsPanel } from '~components/apps/docs-panel';
import { OperationsPanel } from '~components/apps/operations-panel';
import { StatusBadge } from '~components/system/status-badge';
import {
  appOpsQueryOptions,
  appsQueryOptions,
  normalizedManifestQueryOptions,
} from '~queries/apps';
import { sidebarItemsQueryOptions } from '~queries/sidebar';
import {
  archiveAppFn,
  deleteAppFn,
  getAppBySlug,
  setAppSlugFn,
} from '~server/apps';
import { setSidebarPin } from '~server/sidebar';

export const Route = createFileRoute('/_app/app/$appSlug/manage')({
  loader: async ({ params }) => {
    const app = await getAppBySlug({ data: params.appSlug });
    if (!app) {
      throw notFound();
    }
    return app;
  },
  component: AppDetailPage,
});

function AppDetailPage() {
  const { t } = useI18n();
  const app = Route.useLoaderData();
  const router = useRouter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const sessions = useOptionalAppSessionStore();
  const { data: pins } = useQuery(sidebarItemsQueryOptions);
  const isPinned = Boolean(pins?.some((p) => p.appId === app.id));
  const capabilities = app.capabilities ?? null;
  const hasFrontend = Boolean(capabilities?.frontend);
  const runtimeSupported = app.compatibility?.isSupported ?? false;

  const isArchived = app.status === 'archived';
  // Source only lands on `master` once an app has been deployed at least once.
  const hasSource = Boolean(app.currentSourceCommit);

  // The App is part of each mutation's variables: this page may show
  // another App by the time a request settles.
  const archive = useMutation({
    mutationFn: ({
      archived,
      id,
    }: {
      archived: boolean;
      id: string;
      slug: string;
    }) => archiveAppFn({ data: { id, archived } }),
    onSuccess: (_result, { archived, id, slug }) => {
      toast.success(
        archived ? t('appManage.archived') : t('appManage.unarchived'),
      );
      // Archiving stops the backend/cron; restoring re-enables them. The
      // Operations panel reads appOpsQueryOptions, so invalidate it too or it
      // keeps showing pre-toggle running/idle state until a later refetch.
      void queryClient.invalidateQueries(appOpsQueryOptions(id));
      // An archived App cannot run: stop a running copy rather than leave it
      // in the dock and beside this page.
      if (archived) sessions?.quitApp(id, slug);
      void router.invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: ({ id }: { id: string; slug: string; name: string }) =>
      deleteAppFn({ data: id }),
    onSuccess: (_result, { id, slug, name }) => {
      toast.success(t('appManage.deleted', { name }));
      // Stop a running copy: its dock tile would lead to a 404.
      sessions?.quitApp(id, slug);
      // The delete cascades to sidebar pins, so drop those caches too; otherwise
      // the deleted app lingers in the sidebar / pin menu and links to a 404
      // until the next focus refetch.
      void queryClient.invalidateQueries({
        queryKey: sidebarItemsQueryOptions.queryKey,
      });
      void queryClient.invalidateQueries({
        queryKey: appsQueryOptions.queryKey,
      });
      // Leave only if this page still shows the deleted App.
      const shown = router.state.location.pathname;
      const own = router.buildLocation({
        to: '/app/$appSlug/manage',
        params: { appSlug: slug },
      }).pathname;
      if (shown === own) void navigate({ to: '/apps' });
    },
  });

  const pin = useMutation({
    mutationFn: (pinned: boolean) =>
      setSidebarPin({ data: { appId: app.id, pinned } }),
    onSuccess: (_result, pinned) => {
      toast.success(pinned ? t('dock.pinned') : t('library.removedFromDock'));
      void queryClient.invalidateQueries({
        queryKey: sidebarItemsQueryOptions.queryKey,
      });
    },
  });

  const confirmDelete = () =>
    modals.openConfirmModal({
      title: t('appManage.deleteConfirm.title', { name: app.name }),
      children: <Text size="sm">{t('appManage.deleteConfirm.body')}</Text>,
      labels: {
        confirm: t('appManage.deleteApp'),
        cancel: t('common.cancel'),
      },
      confirmProps: { color: 'red' },
      onConfirm: () =>
        remove.mutate({ id: app.id, slug: app.slug, name: app.name }),
    });

  const sections = useManageSections(
    app.id,
    Boolean(capabilities?.backend),
    isArchived,
  );
  const manifestHasTasks = Boolean(capabilities?.tasks);
  const hash = useRouterState({ select: (state) => state.location.hash });
  const current = sections.some((section) => section.key === hash)
    ? hash
    : 'overview';

  // The rail links to anchors in one scrolling page; bring the section into
  // view when the hash changes (the window body, not the page, scrolls).
  // The sections after the overview appear once the App's operations load.
  const loadedSections = sections.length;
  useEffect(() => {
    if (!hash) return;
    document
      .getElementById(hash)
      ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [hash, loadedSections]);

  const openApp = hasFrontend ? (
    <Button
      fullWidth
      variant="default"
      renderRoot={(props) => (
        <Link to="/app/$appSlug" params={{ appSlug: app.slug }} {...props} />
      )}
      disabled={app.status !== 'deployed' || !runtimeSupported}
      leftSection={<IconExternalLink size={16} stroke={1.8} />}
    >
      {t('appManage.openApp')}
    </Button>
  ) : null;

  const moreMenu = (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <ActionIcon
          variant="light"
          color="gray"
          size={30}
          radius="sm"
          aria-label={t('appManage.moreActions')}
        >
          <IconDots size={16} stroke={2} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>{t('appManage.download')}</Menu.Label>
        <Menu.Item
          leftSection={<IconFileZip size={16} />}
          component="a"
          href={`/api/app/${app.id}/download?mode=source`}
          download
          disabled={!hasSource}
        >
          {t('appManage.downloadSource')}
        </Menu.Item>
        <Menu.Item
          leftSection={<IconGitBranch size={16} />}
          component="a"
          href={`/api/app/${app.id}/download?mode=repo`}
          download
          disabled={!hasSource}
        >
          {t('appManage.downloadRepo')}
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item
          leftSection={
            isPinned ? <IconPinnedOff size={16} /> : <IconPin size={16} />
          }
          onClick={() => pin.mutate(!isPinned)}
        >
          {isPinned ? t('library.removeFromDock') : t('library.pinToDock')}
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item
          leftSection={
            isArchived ? (
              <IconArchiveOff size={16} />
            ) : (
              <IconArchive size={16} />
            )
          }
          onClick={() =>
            archive.mutate({
              archived: !isArchived,
              id: app.id,
              slug: app.slug,
            })
          }
        >
          {isArchived ? t('appManage.unarchive') : t('appManage.archive')}
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item
          color="red"
          leftSection={<IconTrash size={16} />}
          onClick={confirmDelete}
        >
          {t('appManage.deleteApp')}
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );

  return (
    <DeskWindow
      fill
      title={t('appManage.windowTitle', { name: app.name })}
      tile={<AppGlyph name={app.name} seed={app.id} size="sm" />}
      badge={<StatusBadge status={app.status} />}
      toolbar={moreMenu}
      closeTo={{ link: { to: '/apps' }, label: t('nav.allApps') }}
    >
      <WindowSplit
        rail={
          <Rail
            label={t('appManage.sections')}
            searchLabel={t('appManage.searchSections')}
            identity={
              <RailIdentity
                tile={<AppGlyph name={app.name} seed={app.id} size="lg" />}
                name={app.name}
                meta={`/${app.slug}`}
              />
            }
            groups={[
              {
                items: sections.map((section) => ({
                  key: section.key,
                  label: section.label,
                  icon: section.icon,
                  color: section.color,
                  link: { to: '.', hash: section.key, replace: true },
                  current: section.key === current,
                })),
              },
            ]}
            footer={
              <>
                {openApp}
                {manifestHasTasks ? (
                  <Button
                    fullWidth
                    variant="default"
                    renderRoot={(props) => (
                      <Link
                        to="/app/$appSlug/tasks"
                        params={{ appSlug: app.slug }}
                        {...props}
                      />
                    )}
                    leftSection={<IconListCheck size={16} stroke={1.8} />}
                  >
                    {t('appManage.runTasks')}
                  </Button>
                ) : null}
                <Button
                  fullWidth
                  variant="default"
                  component={Link}
                  to="/agent"
                  leftSection={<IconSparkles size={16} stroke={1.8} />}
                >
                  {t('appManage.editWithAgent')}
                </Button>
              </>
            }
          />
        }
      >
        <WindowBody>
          <AppCompatibilityNotice compatibility={app.compatibility} />
          {app.description ? (
            <PageHeading description={app.description} />
          ) : null}
          <Columns>
            <Column grow basis={440}>
              <Section id="overview" title={t('appManage.section.overview')}>
                <GroupCard>
                  <Row label={t('common.name')}>
                    <strong>{app.name}</strong>
                  </Row>
                  <SlugField
                    appId={app.id}
                    slug={app.slug}
                    runtimeSupported={runtimeSupported}
                  />
                  <Row label={t('appManage.appId')} mono>
                    <CopyValue value={app.id} />
                  </Row>
                  <Row label={t('appManage.icon')} stack>
                    <AppIconSettings appId={app.id} appName={app.name} />
                  </Row>
                  <Row label={t('appManage.updated')}>
                    {dayjs(app.updatedAt).format('YYYY-MM-DD HH:mm')}
                  </Row>
                  <GroupFooter>
                    <span>
                      <Trans
                        t={t}
                        i18nKey="appManage.continueWithAgent"
                        components={{
                          agent: (
                            <Anchor component={Link} to="/agent" size="sm" />
                          ),
                        }}
                      />
                    </span>
                  </GroupFooter>
                </GroupCard>
              </Section>

              <OperationsPanel
                appId={app.id}
                appName={app.name}
                appSlug={app.slug}
                runtimeSupported={runtimeSupported}
              />

              {capabilities?.backend ? <ApiPanel appId={app.id} /> : null}

              {/* An archived App publishes no docs, matching the CLI. */}
              {isArchived ? null : <DocsPanel appId={app.id} slug={app.slug} />}
            </Column>
            <Column basis={360}>
              <DeploymentActivity appId={app.id} />
              <DeploymentHistory appId={app.id} />
            </Column>
          </Columns>
        </WindowBody>
      </WindowSplit>
    </DeskWindow>
  );
}

type ManageSection = {
  key: string;
  label: string;
  icon: ReactNode;
  color: string;
};

/** The rail's sections: the overview, each operation the App has, its API,
 * its published docs and its deployments, in page order. */
function useManageSections(
  appId: string,
  hasApi: boolean,
  isArchived: boolean,
): ManageSection[] {
  const { t } = useI18n();
  const { data: ops } = useQuery(appOpsQueryOptions(appId));
  const { data: manifest } = useQuery(normalizedManifestQueryOptions(appId));
  const icon = (Icon: typeof IconLayoutDashboard) => (
    <Icon size={15} stroke={2} />
  );
  const sections: (ManageSection | false | undefined)[] = [
    {
      key: 'overview',
      label: t('appManage.section.overview'),
      icon: icon(IconLayoutDashboard),
      color: 'primary',
    },
    ops?.backend.capable && {
      key: 'backend',
      label: t('appManage.section.backend'),
      icon: icon(IconServerBolt),
      color: 'dark',
    },
    (ops?.database.enabled || Boolean(ops?.database.dbName)) && {
      key: 'database',
      label: t('appManage.section.database'),
      icon: icon(IconDatabase),
      color: 'blue',
    },
    ops?.storage.enabled && {
      key: 'storage',
      label: t('appManage.section.storage'),
      icon: icon(IconFolder),
      color: 'gray',
    },
    (ops?.dataTable.enabled || Boolean(ops?.dataTable.dbName)) && {
      key: 'data-tables',
      label: t('appManage.section.dataTables'),
      icon: icon(IconTable),
      color: 'teal',
    },
    ops?.cron.enabled && {
      key: 'schedules',
      label: t('appManage.section.schedules'),
      icon: icon(IconClock),
      color: 'amber',
    },
    Boolean(manifest?.tasks) && {
      key: 'tasks',
      label: t('appManage.section.tasks'),
      icon: icon(IconListCheck),
      color: 'primary',
    },
    ops?.webhook.enabled && {
      key: 'webhook',
      label: t('appManage.section.webhook'),
      icon: icon(IconWebhook),
      color: 'violet',
    },
    ops?.kv.enabled && {
      key: 'kv',
      label: t('appManage.section.kv'),
      icon: icon(IconKey),
      color: 'indigo',
    },
    Boolean(manifest?.notifications) && {
      key: 'notifications',
      label: t('appManage.section.notifications'),
      icon: icon(IconBell),
      color: 'pink',
    },
    hasApi && {
      key: 'api',
      label: t('appManage.section.api'),
      icon: icon(IconApi),
      color: 'blue',
    },
    !isArchived &&
      Boolean(manifest?.docs?.length) && {
        key: 'docs',
        label: t('appManage.section.docs'),
        icon: icon(IconBook),
        color: 'cyan',
      },
    {
      key: 'deployments',
      label: t('appManage.section.deployments'),
      icon: icon(IconHistory),
      color: 'dark',
    },
  ];
  return sections.filter((section): section is ManageSection =>
    Boolean(section),
  );
}

/** A value that copies itself when clicked. */
function CopyValue({ value }: { value: string }) {
  const { t } = useI18n();
  return (
    <Tooltip label={t('common.copy')} withArrow position="top">
      <UnstyledButton
        onClick={() => {
          copy(value);
          toast.success(t('common.copied'));
        }}
        ff="monospace"
        fz="xs"
      >
        {value}
      </UnstyledButton>
    </Tooltip>
  );
}

/**
 * Editable URL-slug row. The slug is the only part of an app's identity that
 * users can change; it appears in the human-facing `/app/<slug>` URL. Renaming
 * it never requires a rebuild because technical APIs and storage are keyed off
 * the immutable id.
 */
function SlugField({
  appId,
  slug,
  runtimeSupported,
}: {
  appId: string;
  slug: string;
  runtimeSupported: boolean;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(slug);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const save = useMutation({
    mutationFn: (next: string) =>
      setAppSlugFn({ data: { id: appId, slug: next } }),
    onSuccess: (result) => {
      toast.success(t('appManage.slugChanged', { slug: result.slug }));
      setEditing(false);
      void navigate({
        to: '/app/$appSlug/manage',
        params: { appSlug: result.slug },
        search: true,
        hash: true,
        replace: true,
      }).then(async () => {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: appsQueryOptions.queryKey,
          }),
          queryClient.invalidateQueries({
            queryKey: sidebarItemsQueryOptions.queryKey,
          }),
          queryClient.invalidateQueries({
            queryKey: ['dashboard', 'widgets'],
          }),
          queryClient.invalidateQueries({
            queryKey: normalizedManifestQueryOptions(appId).queryKey,
          }),
        ]);
        await router.invalidate();
      });
    },
  });

  const submit = () => {
    const next = draft.trim();
    if (next === slug) {
      setEditing(false);
      return;
    }
    save.mutate(next);
  };

  return (
    <Row label={t('appManage.slug')}>
      {editing ? (
        <Group gap="xs" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
          <TextInput
            ref={inputRef}
            value={draft}
            maxLength={APP_SLUG_MAX_LENGTH}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
              if (e.key === 'Escape') {
                setDraft(slug);
                setEditing(false);
              }
            }}
            size="xs"
            disabled={save.isPending}
            styles={{ input: { fontFamily: 'monospace' } }}
            style={{ flex: 1, minWidth: 160 }}
          />
          <Tooltip label={t('common.save')} withArrow position="top">
            <ActionIcon
              variant="light"
              color="green"
              onClick={submit}
              loading={save.isPending}
              aria-label={t('appManage.saveSlug')}
            >
              <IconCheck size={16} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={t('common.cancel')} withArrow position="top">
            <ActionIcon
              variant="subtle"
              color="gray"
              onClick={() => {
                setDraft(slug);
                setEditing(false);
              }}
              disabled={save.isPending}
              aria-label={t('common.cancel')}
            >
              <IconX size={16} />
            </ActionIcon>
          </Tooltip>
        </Group>
      ) : (
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          <Text size="sm" ff="monospace" truncate>
            {slug}
          </Text>
          {runtimeSupported ? (
            <Tooltip label={t('appManage.openApp')} withArrow position="top">
              <ActionIcon
                variant="subtle"
                color="gray"
                component="a"
                href={`/app/${slug}/embed/`}
                target="_blank"
                aria-label={t('appManage.openApp')}
              >
                <IconExternalLink size={15} />
              </ActionIcon>
            </Tooltip>
          ) : (
            <Tooltip
              label={t('appManage.openBlocked')}
              withArrow
              position="top"
            >
              <ActionIcon
                variant="subtle"
                color="gray"
                disabled
                aria-label={t('appManage.openUnavailable')}
              >
                <IconExternalLink size={15} />
              </ActionIcon>
            </Tooltip>
          )}
          <Tooltip label={t('appManage.editSlug')} withArrow position="top">
            <ActionIcon
              variant="subtle"
              color="gray"
              onClick={() => {
                setDraft(slug);
                setEditing(true);
              }}
              aria-label={t('appManage.editSlug')}
            >
              <IconPencil size={15} />
            </ActionIcon>
          </Tooltip>
        </Group>
      )}
    </Row>
  );
}
