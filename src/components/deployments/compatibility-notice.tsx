import { Alert, Anchor, Text } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import { Trans } from 'react-i18next';
import type { DeploymentCompatibility } from '~/deployment-compatibility';
import { useI18n } from '~i18n';

export function CompatibilityNotice({
  compatibility,
}: {
  compatibility: DeploymentCompatibility | null;
}) {
  const { t } = useI18n();
  if (!compatibility || compatibility.isLatest) return null;

  const agentLink = {
    agent: <Anchor component={Link} to="/agent" fw={700} />,
  };

  if (!compatibility.isSupported) {
    if (compatibility.version > compatibility.latestVersion) {
      return (
        <Alert
          color="red"
          variant="light"
          icon={<IconAlertTriangle size={18} />}
          title={t('compatibility.platformUpdate.title')}
        >
          <Text size="sm">
            {t('compatibility.platformUpdate.body', {
              version: compatibility.version,
              latest: compatibility.latestVersion,
            })}
          </Text>
        </Alert>
      );
    }

    return (
      <Alert
        color="red"
        variant="light"
        icon={<IconAlertTriangle size={18} />}
        title={t('compatibility.appUpdate.title')}
      >
        <Text size="sm">
          <Trans
            t={t}
            i18nKey="compatibility.appUpdate.body"
            values={{
              version: compatibility.version,
              minimum: compatibility.minimumSupportedVersion,
            }}
            components={agentLink}
          />
        </Text>
      </Alert>
    );
  }

  return (
    <Alert
      color="orange"
      variant="light"
      icon={<IconRefresh size={18} />}
      title={t('compatibility.available.title')}
    >
      <Text size="sm">
        <Trans
          t={t}
          i18nKey="compatibility.available.body"
          values={{
            version: compatibility.version,
            latest: compatibility.latestVersion,
          }}
          components={agentLink}
        />
      </Text>
    </Alert>
  );
}
