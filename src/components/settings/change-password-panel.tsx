import {
  Alert,
  Button,
  Group,
  PasswordInput,
  Stack,
  Text,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { modals } from '@mantine/modals';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { authClient } from '~auth/client';
import { type PlainTranslationKey, useErrorText, useI18n } from '~i18n';
import { CodedError } from '~lib/error-codes';
import { accountSessionsQueryOptions } from '~queries/account-sessions';

/** Issue messages are catalog keys, translated when the form renders. */
const issue = (key: PlainTranslationKey) => key;

const passwordSchema = z
  .object({
    currentPassword: z
      .string()
      .min(1, issue('account.password.currentRequired')),
    newPassword: z
      .string()
      .min(8, issue('account.password.tooShort'))
      .max(128, issue('account.password.tooLong')),
    confirmPassword: z.string(),
  })
  .refine((values) => values.newPassword === values.confirmPassword, {
    message: issue('account.password.mismatch'),
    path: ['confirmPassword'],
  });

type PasswordField = 'currentPassword' | 'newPassword' | 'confirmPassword';

export function ChangePasswordPanel() {
  const { t } = useI18n();
  const modalId = useId();

  useEffect(() => () => modals.close(modalId), [modalId]);

  const open = () => {
    modals.open({
      modalId,
      title: t('account.password.change'),
      centered: true,
      children: (
        <ChangePasswordForm
          onClose={() => modals.close(modalId)}
          onPendingChange={(pending) =>
            modals.updateModal({
              modalId,
              closeOnClickOutside: !pending,
              closeOnEscape: !pending,
              withCloseButton: !pending,
            })
          }
        />
      ),
    });
  };

  return (
    <Stack gap="md" align="flex-start">
      <Stack gap={2}>
        <Text fw={700}>{t('account.password.title')}</Text>
        <Text size="sm" c="dimmed">
          {t('account.password.description')}
        </Text>
      </Stack>
      <Button type="button" onClick={open}>
        {t('account.password.change')}
      </Button>
    </Stack>
  );
}

function ChangePasswordForm({
  onClose,
  onPendingChange,
}: {
  onClose: () => void;
  onPendingChange: (pending: boolean) => void;
}) {
  const { t } = useI18n();
  const errorText = useErrorText();
  const submitting = useRef(false);
  const form = useForm({
    initialValues: {
      currentPassword: '',
      newPassword: '',
      confirmPassword: '',
    },
    validate: (values) => {
      const result = passwordSchema.safeParse(values);
      if (result.success) return {};
      return Object.fromEntries(
        result.error.issues.map((issue) => [issue.path[0], issue.message]),
      );
    },
  });
  const queryClient = useQueryClient();
  const change = useMutation({
    meta: { errorToast: false },
    networkMode: 'always',
    retry: false,
    gcTime: 0,
    // Keep passwords and the returned session token out of the mutation cache.
    mutationFn: async () => {
      const { currentPassword, newPassword } = form.getValues();
      const result = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      });
      if (result.error)
        throw new CodedError(
          result.error.message ??
            'Could not change your password. Please try again.',
          result.error.code ? `account.${result.error.code}` : undefined,
        );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: accountSessionsQueryOptions.queryKey,
      });
      form.reset();
      toast.success(t('account.password.changed'));
      onClose();
    },
    onSettled: () => {
      submitting.current = false;
      onPendingChange(false);
    },
  });
  // Validation stores catalog keys; translate them on render.
  const inputProps = (field: PasswordField) => {
    const props = form.getInputProps(field);
    return {
      ...props,
      error: props.error ? t(props.error as PlainTranslationKey) : undefined,
    };
  };

  return (
    <form
      onSubmit={(event) => {
        form.onSubmit(() => {
          if (submitting.current) return;
          submitting.current = true;
          onPendingChange(true);
          change.mutate();
        })(event);
      }}
    >
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          {t('account.password.signOutOthers')}
        </Text>
        <PasswordInput
          visibilityToggleButtonProps={{
            'aria-label': t('system.togglePasswordVisibility'),
          }}
          label={t('account.password.current')}
          autoComplete="current-password"
          disabled={change.isPending}
          {...inputProps('currentPassword')}
        />
        <PasswordInput
          visibilityToggleButtonProps={{
            'aria-label': t('system.togglePasswordVisibility'),
          }}
          label={t('account.password.new')}
          description={t('account.password.newDescription')}
          autoComplete="new-password"
          disabled={change.isPending}
          {...inputProps('newPassword')}
        />
        <PasswordInput
          visibilityToggleButtonProps={{
            'aria-label': t('system.togglePasswordVisibility'),
          }}
          label={t('account.password.confirm')}
          autoComplete="new-password"
          disabled={change.isPending}
          {...inputProps('confirmPassword')}
        />
        {change.error && (
          <Alert
            color="red"
            title={t('account.password.changeFailed')}
            role="alert"
          >
            {errorText(change.error, 'account.password.changeFailedBody')}
          </Alert>
        )}
        <Group justify="flex-end">
          <Button
            type="button"
            variant="default"
            disabled={change.isPending}
            onClick={onClose}
          >
            {t('common.cancel')}
          </Button>
          <Button type="submit" loading={change.isPending}>
            {t('account.password.change')}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
