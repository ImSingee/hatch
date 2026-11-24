import {
  Button,
  Group,
  Paper,
  PasswordInput,
  Stack,
  Switch,
  Text,
} from '@mantine/core';
import { IconKey } from '@tabler/icons-react';
import { useRef, useState } from 'react';
import type { EnvVariableField } from '~agent/events';
import { useI18n } from '~i18n';
import classes from './chat.module.css';

export type EnvEntry = { key: string; value: string; secret: boolean };

function initialValues(variables: EnvVariableField[]): Record<string, string> {
  return Object.fromEntries(variables.map((variable) => [variable.key, '']));
}

function initialPrivacy(
  variables: EnvVariableField[],
): Record<string, boolean> {
  return Object.fromEntries(
    variables.map((variable) => [variable.key, variable.secret]),
  );
}

/** What the screen-reader status line last reported about a submission. */
type Announcement = 'saving' | 'saved' | 'notSaved' | null;

export function EnvForm({
  reason,
  variables,
  onSubmit,
  disabled,
}: {
  reason: string;
  variables: EnvVariableField[];
  onSubmit: (entries: EnvEntry[]) => Promise<boolean>;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [values, setValues] = useState<Record<string, string>>(() =>
    initialValues(variables),
  );
  const [privacy, setPrivacy] = useState<Record<string, boolean>>(() =>
    initialPrivacy(variables),
  );
  const [submitting, setSubmitting] = useState(false);
  const [announcement, setAnnouncement] = useState<Announcement>(null);
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const submittingRef = useRef(false);
  const sharedCount = variables.filter(
    (variable) => !(privacy[variable.key] ?? variable.secret),
  ).length;
  const privateCount = variables.length - sharedCount;
  const counts = {
    variables: t('agent.env.variableCount', { count: variables.length }),
    values: t('agent.env.valueCount', { count: sharedCount }),
  };
  const summary =
    sharedCount === 0
      ? t('agent.env.summaryPrivate', counts)
      : t('agent.env.summaryShared', counts);
  const submitLabel = t('agent.env.submit', {
    variables: counts.variables,
    shared: sharedCount,
  });
  const announcementText =
    announcement === 'saving'
      ? sharedCount === 0
        ? t('agent.env.savingPrivate', counts)
        : t('agent.env.savingShared', counts)
      : announcement === 'saved'
        ? t('agent.env.saved')
        : announcement === 'notSaved'
          ? t('agent.env.notSaved')
          : t('agent.env.needs', {
              variables: counts.variables,
              private: privateCount,
              shared: sharedCount,
            });

  const submit = async () => {
    if (disabled || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setAnnouncement('saving');
    const entries = variables.map((variable) => ({
      key: variable.key,
      value: values[variable.key] ?? '',
      secret: privacy[variable.key] ?? variable.secret,
    }));
    try {
      if (await onSubmit(entries)) {
        setValues(initialValues(variables));
        setAnnouncement('saved');
      } else {
        setAnnouncement('notSaved');
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <Paper
      className={classes.envCard}
      radius="xl"
      p="md"
      withBorder
      aria-busy={submitting || undefined}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Stack gap="md">
          <Stack gap={6}>
            <Group gap={6}>
              <IconKey size={16} className={classes.envIcon} />
              <Text size="xs" fw={700} className={classes.envHeading}>
                {t('agent.env.title')}
              </Text>
            </Group>
            <Text size="sm" fw={700}>
              {reason}
            </Text>
            <Text size="xs" c="dimmed" className={classes.envNote}>
              {t('agent.env.note')}
            </Text>
          </Stack>

          {variables.map((variable) => {
            const isPrivate = privacy[variable.key] ?? variable.secret;
            const isVisible = visible[variable.key] ?? false;
            return (
              <Stack key={variable.key} gap={8} className={classes.envVariable}>
                <PasswordInput
                  label={variable.key}
                  description={variable.description}
                  value={values[variable.key] ?? ''}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setValues((current) => ({
                      ...current,
                      [variable.key]: value,
                    }));
                  }}
                  disabled={disabled || submitting}
                  autoComplete="new-password"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  visible={isVisible}
                  onVisibilityChange={(nextVisible) => {
                    setVisible((current) => ({
                      ...current,
                      [variable.key]: nextVisible,
                    }));
                  }}
                  visibilityToggleButtonProps={{
                    'aria-label': isVisible
                      ? t('agent.env.hideValue', { key: variable.key })
                      : t('agent.env.showValue', { key: variable.key }),
                    tabIndex: 0,
                  }}
                  styles={{
                    label: {
                      fontFamily: 'var(--mantine-font-family-monospace)',
                    },
                  }}
                />
                <Switch
                  checked={isPrivate}
                  onChange={(event) => {
                    const nextPrivate = event.currentTarget.checked;
                    setPrivacy((current) => ({
                      ...current,
                      [variable.key]: nextPrivate,
                    }));
                  }}
                  disabled={disabled || submitting}
                  color="primary.7"
                  label={t('agent.env.keepPrivate')}
                  aria-label={t('agent.env.keepKeyPrivate', {
                    key: variable.key,
                  })}
                  description={
                    isPrivate
                      ? t('agent.env.privateDescription')
                      : t('agent.env.sharedDescription')
                  }
                />
              </Stack>
            );
          })}

          <Stack gap={6}>
            <Text
              size="xs"
              c={sharedCount > 0 ? 'orange.8' : 'dimmed'}
              className={classes.envSummary}
            >
              {summary}
            </Text>
            <Group justify="flex-end">
              <Button
                type="submit"
                size="sm"
                color="primary.7"
                loading={submitting}
                disabled={disabled || submitting}
              >
                {submitLabel}
              </Button>
            </Group>
          </Stack>
          <Text
            component="output"
            className={classes.visuallyHidden}
            aria-live="polite"
            aria-atomic="true"
          >
            {announcementText}
          </Text>
        </Stack>
      </form>
    </Paper>
  );
}
