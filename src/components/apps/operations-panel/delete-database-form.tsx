import {
  Button,
  Group,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { useMutation } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Trans } from 'react-i18next';
import { useErrorText, useI18n } from '~i18n';

export function DeleteDatabaseForm({
  appName,
  managed,
  modalId,
  onDelete,
}: {
  appName: string;
  managed: boolean;
  modalId: string;
  onDelete: (confirmation: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const errorText = useErrorText();
  const [confirmation, setConfirmation] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const remove = useMutation({
    mutationFn: () => onDelete(confirmation),
    onSuccess: () => modals.close(modalId),
    // The failure is shown inline below.
    meta: { errorToast: false },
  });
  const confirmed = confirmation === appName;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (confirmed && !remove.isPending) remove.mutate();
      }}
    >
      <Stack gap="sm">
        <Text size="sm">
          <Trans
            t={t}
            i18nKey={
              managed
                ? 'ops.deleteForm.dataBody'
                : 'ops.deleteForm.databaseBody'
            }
            values={{ app: appName }}
            components={{
              app: <Text span fw={700} style={{ overflowWrap: 'anywhere' }} />,
            }}
          />
        </Text>
        <Text size="sm" c="dimmed">
          {managed
            ? t('ops.deleteForm.dataAgain')
            : t('ops.deleteForm.databaseAgain')}
        </Text>
        <Stack gap={4}>
          <Group gap={4}>
            <Trans
              t={t}
              i18nKey="ops.deleteForm.typeToConfirm"
              values={{ app: appName }}
              components={{
                before: <Text size="sm" />,
                name: (
                  <UnstyledButton
                    type="button"
                    aria-label={t('ops.deleteForm.fillName', { app: appName })}
                    fz="sm"
                    fw={700}
                    disabled={remove.isPending}
                    style={{
                      overflowWrap: 'anywhere',
                      textDecoration: 'underline',
                    }}
                    onClick={() => {
                      setConfirmation(appName);
                      input.current?.focus();
                    }}
                  />
                ),
                after: <Text size="sm" />,
              }}
            />
          </Group>
          <TextInput
            ref={input}
            aria-label={t('ops.deleteForm.inputLabel', { app: appName })}
            value={confirmation}
            onChange={(event) => setConfirmation(event.currentTarget.value)}
            disabled={remove.isPending}
            autoComplete="off"
            data-autofocus
          />
        </Stack>
        {remove.isError ? (
          <Text size="sm" c="red" role="alert">
            {errorText(remove.error, 'ops.deleteForm.failed')}
          </Text>
        ) : null}
        <Group justify="flex-end" gap="sm">
          <Button
            type="button"
            variant="default"
            disabled={remove.isPending}
            onClick={() => modals.close(modalId)}
          >
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            color="red"
            loading={remove.isPending}
            disabled={!confirmed}
          >
            {managed
              ? t('ops.deleteForm.deleteData')
              : t('ops.database.delete')}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
