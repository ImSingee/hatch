import { Alert, Code, Stack, Text } from '@mantine/core';
import type { ExtraPermissionsView } from '~/extra-permissions';
import { useI18n } from '~i18n';

export function ExtraPermissionsDetails({
  access,
}: {
  access: ExtraPermissionsView | null;
}) {
  const { t } = useI18n();
  if (!access || access.flags.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        {access ? t('permissions.noneDeclared') : t('permissions.notDeployed')}
      </Text>
    );
  }
  return (
    <Stack gap="xs" style={{ minWidth: 0 }}>
      {access.flags.map((flag) => (
        <Code
          key={flag}
          block
          style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
        >
          {flag}
        </Code>
      ))}
      {access.hostAccess ? (
        <Alert
          color="orange"
          title={
            <Text size="sm" fw={700} c="orange.8">
              {t('permissions.hostAccess')}
            </Text>
          }
        >
          {t('permissions.hostAccessBody')}
        </Alert>
      ) : null}
    </Stack>
  );
}
