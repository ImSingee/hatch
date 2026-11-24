import { createFileRoute } from '@tanstack/react-router';
import { Column, Columns, GroupCard } from '~components/page/page';
import { AgentPreferencesPanel } from '~components/settings/agent-preferences-panel';
import { ApiKeysPanel } from '~components/settings/api-keys-panel';
import { AccountProfilePanel } from '~components/settings/account-profile-panel';
import { ActiveSessionsPanel } from '~components/settings/active-sessions-panel';
import { HomepagePanel } from '~components/settings/homepage-panel';
import { ChangePasswordPanel } from '~components/settings/change-password-panel';
import { PasskeysPanel } from '~components/settings/passkeys-panel';
import { SectionHead } from '~components/settings/section-head';
import { useI18n } from '~i18n';
import { passkeyOriginQueryOptions } from '~queries/passkeys';

export const Route = createFileRoute('/_app/settings/account')({
  loader: ({ context: { queryClient } }) =>
    queryClient.ensureQueryData(passkeyOriginQueryOptions),
  component: AccountRoute,
});

function AccountRoute() {
  const { t } = useI18n();
  const appOrigin = Route.useLoaderData();
  return (
    <>
      <SectionHead
        title={t('settings.account.label')}
        description={t('account.description')}
      />
      <Columns>
        <Column basis={380}>
          <GroupCard padded>
            <AccountProfilePanel />
          </GroupCard>
          <GroupCard padded>
            <HomepagePanel />
          </GroupCard>
          <GroupCard padded>
            <AgentPreferencesPanel />
          </GroupCard>
          <GroupCard padded>
            <ChangePasswordPanel />
          </GroupCard>
        </Column>
        <Column basis={380}>
          <GroupCard padded>
            <PasskeysPanel appOrigin={appOrigin} />
          </GroupCard>
          <GroupCard padded>
            <ApiKeysPanel />
          </GroupCard>
          <GroupCard padded>
            <ActiveSessionsPanel />
          </GroupCard>
        </Column>
      </Columns>
    </>
  );
}
