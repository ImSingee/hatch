import {
  Alert,
  Button,
  Group,
  Select,
  Skeleton,
  Stack,
  Text,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { authClient } from '~auth/client';
import { AppRouteAutocomplete } from '~components/apps/app-route-autocomplete';
import { HOMEPAGE_PAGES, type HomepageTarget } from '~/homepage';
import { type PlainTranslationKey, useErrorText, useI18n } from '~i18n';
import { normalizedManifestQueryOptions } from '~queries/apps';
import { dashboardsQueryOptions } from '~queries/dashboards';
import { homepageSettingsQueryOptions } from '~queries/homepage';
import {
  updateHomepageSettings,
  type HomepageSettings,
} from '~server/homepage';

const PAGE_LABELS: Record<
  (typeof HOMEPAGE_PAGES)[number]['value'],
  PlainTranslationKey
> = {
  dashboard: 'homepage.page.dashboard',
  agent: 'homepage.page.agent',
  apps: 'homepage.page.apps',
  dashboards: 'homepage.page.dashboards',
  executions: 'homepage.page.executions',
  settings: 'homepage.page.settings',
};

function targetValue(target: HomepageTarget): string {
  if (target.kind === 'page') return `page:${target.page}`;
  if (target.kind === 'dashboard') return `dashboard:${target.dashboardId}`;
  return `app:${target.appId}`;
}

export function HomepagePanel() {
  const { t } = useI18n();
  const session = authClient.useSession();
  if (session.isPending) return <Skeleton height={120} />;
  if (!session.data || session.error) {
    return (
      <Alert color="red" title={t('homepage.loadFailed')}>
        <Button
          type="button"
          variant="subtle"
          onClick={() => void session.refetch()}
        >
          {t('common.tryAgain')}
        </Button>
      </Alert>
    );
  }
  return (
    <AccountHomepage key={session.data.user.id} userId={session.data.user.id} />
  );
}

function AccountHomepage({ userId }: { userId: string }) {
  const { t } = useI18n();
  const errorText = useErrorText();
  const settings = useQuery(homepageSettingsQueryOptions(userId));
  const dashboards = useQuery(dashboardsQueryOptions);
  const error = settings.error ?? dashboards.error;
  if (error) {
    return (
      <Alert color="red" title={t('homepage.loadFailed')}>
        <Text size="sm">{errorText(error, 'homepage.loadFailedBody')}</Text>
        <Button
          type="button"
          variant="subtle"
          onClick={() => {
            void settings.refetch();
            void dashboards.refetch();
          }}
        >
          {t('common.tryAgain')}
        </Button>
      </Alert>
    );
  }
  if (!settings.data || !dashboards.data) return <Skeleton height={120} />;

  const options = [
    {
      group: t('homepage.group.pages'),
      items: HOMEPAGE_PAGES.map((page) => ({
        value: `page:${page.value}`,
        label: t(PAGE_LABELS[page.value]),
        target: { kind: 'page', page: page.value } satisfies HomepageTarget,
      })),
    },
    {
      group: t('homepage.group.dashboards'),
      items: dashboards.data.map((dashboard) => ({
        value: `dashboard:${dashboard.id}`,
        label: dashboard.name,
        target: {
          kind: 'dashboard',
          dashboardId: dashboard.id,
        } satisfies HomepageTarget,
      })),
    },
    {
      group: t('homepage.group.apps'),
      items: settings.data.apps.map((app) => ({
        value: `app:${app.id}`,
        label: app.name,
        target: {
          kind: 'app',
          appId: app.id,
          entryHash: null,
        } satisfies HomepageTarget,
      })),
    },
  ];
  const savedValue = targetValue(settings.data.homepage);
  const missing = !options.some((group) =>
    group.items.some((option) => option.value === savedValue),
  );
  const data: HomepageOptionGroup[] = options;
  if (missing)
    data.push({
      group: t('homepage.group.unavailable'),
      items: [
        {
          value: savedValue,
          label: t('homepage.previousUnavailable'),
          target: settings.data.homepage,
          disabled: true,
        },
      ],
    });

  return (
    <HomepageForm
      key={`${userId}:${JSON.stringify(settings.data.homepage)}`}
      settings={settings.data}
      options={data}
    />
  );
}

type HomepageOptionGroup = {
  group: string;
  items: {
    value: string;
    label: string;
    target: HomepageTarget;
    disabled?: boolean;
  }[];
};

function HomepageForm({
  settings,
  options,
}: {
  settings: HomepageSettings;
  options: HomepageOptionGroup[];
}) {
  const { t } = useI18n();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const [target, setTarget] = useState(settings.homepage);
  const appId = target.kind === 'app' ? target.appId : '';
  const manifest = useQuery({
    ...normalizedManifestQueryOptions(appId),
    enabled: Boolean(appId),
  });
  const save = useMutation({
    mutationFn: (homepage: HomepageTarget) =>
      updateHomepageSettings({ data: homepage }),
    meta: { errorToast: false },
    retry: false,
    networkMode: 'always',
    onSuccess: (saved) => {
      queryClient.setQueryData(
        homepageSettingsQueryOptions(saved.userId).queryKey,
        saved,
      );
      toast.success(t('homepage.saved'));
    },
  });
  const value = targetValue(target);
  const selected = options
    .flatMap((group) => group.items)
    .find((item) => item.value === value);
  const changed = JSON.stringify(target) !== JSON.stringify(settings.homepage);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!save.isPending && changed && selected && !selected.disabled)
          save.mutate(target);
      }}
    >
      <Stack gap="md">
        <Stack gap={2}>
          <Text fw={700}>{t('homepage.title')}</Text>
          <Text size="sm" c="dimmed">
            {t('homepage.description')}
          </Text>
        </Stack>
        {!settings.available && (
          <Alert color="yellow" title={t('homepage.savedUnavailable.title')}>
            {t('homepage.savedUnavailable.body')}
          </Alert>
        )}
        <Select
          label={t('homepage.select.label')}
          data={options}
          value={value}
          searchable
          nothingFoundMessage={t('homepage.select.nothingFound')}
          allowDeselect={false}
          disabled={save.isPending}
          onChange={(next) => {
            const option = options
              .flatMap((group) => group.items)
              .find((item) => item.value === next);
            if (option && !option.disabled) setTarget(option.target);
          }}
        />
        {target.kind === 'app' && (
          <AppRouteAutocomplete
            label={t('homepage.entry.label')}
            description={t('homepage.entry.description')}
            placeholder="/settings"
            routes={manifest.data?.app?.routes ?? []}
            value={target.entryHash ?? ''}
            disabled={save.isPending || Boolean(selected?.disabled)}
            onChange={(entryHash) =>
              setTarget({ ...target, entryHash: entryHash || null })
            }
          />
        )}
        {target.kind === 'app' && manifest.error && (
          <Alert color="yellow" title={t('homepage.entry.suggestionsFailed')}>
            {t('homepage.entry.suggestionsFailedBody')}
            <Button
              type="button"
              variant="subtle"
              onClick={() => void manifest.refetch()}
            >
              {t('common.tryAgain')}
            </Button>
          </Alert>
        )}
        {save.error && (
          <Alert color="red" title={t('homepage.saveFailed')} role="alert">
            {errorText(save.error, 'homepage.saveFailedBody')}
          </Alert>
        )}
        <Group justify="flex-start">
          <Button
            type="submit"
            loading={save.isPending}
            disabled={!changed || !selected || selected.disabled}
          >
            {t('homepage.save')}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
