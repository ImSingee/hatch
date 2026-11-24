import {
  Alert,
  Button,
  Group,
  Skeleton,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { authClient, type Session } from '~auth/client';
import { type PlainTranslationKey, useErrorText, useI18n } from '~i18n';
import { CodedError } from '~lib/error-codes';
import { usersPanelQueryOptions } from '~queries/users';
import { AccountAvatarField } from './account-avatar-field';

const nicknameSchema = z
  .string()
  .trim()
  .min(1, 'account.profile.nicknameRequired' satisfies PlainTranslationKey);

export function AccountProfilePanel() {
  const { t } = useI18n();
  const { data, isPending, error, refetch } = authClient.useSession();

  if (isPending) {
    return (
      <Stack gap="md">
        <Skeleton height={24} width={100} />
        <Skeleton height={64} />
      </Stack>
    );
  }
  if (error || !data) {
    return (
      <Alert color="red" title={t('account.profile.loadFailed')}>
        <Button type="button" variant="subtle" onClick={() => void refetch()}>
          {t('common.tryAgain')}
        </Button>
      </Alert>
    );
  }

  return (
    <Stack gap="md">
      <Stack gap={2}>
        <Text fw={700}>{t('account.profile.title')}</Text>
        <Text size="sm" c="dimmed">
          {t('account.profile.description')}
        </Text>
      </Stack>
      <AccountAvatarField user={data.user} onChanged={refetch} />
      <ProfileForm key={`${data.user.id}:${data.user.name}`} user={data.user} />
    </Stack>
  );
}

function ProfileForm({ user }: { user: Session['user'] }) {
  const { t } = useI18n();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const submitting = useRef(false);
  const form = useForm({
    initialValues: { name: user.name },
    validate: {
      name: (value) => {
        const result = nicknameSchema.safeParse(value);
        return result.success ? null : result.error.issues[0].message;
      },
    },
  });
  const save = useMutation({
    meta: { errorToast: false },
    networkMode: 'always',
    retry: false,
    mutationFn: async (name: string) => {
      const result = await authClient.updateUser({ name });
      if (result.error)
        throw new CodedError(
          result.error.message ??
            'Could not save your nickname. Please try again.',
          result.error.code ? `account.${result.error.code}` : undefined,
        );
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: usersPanelQueryOptions.queryKey });
      toast.success(t('account.profile.saved'));
    },
    onSettled: () => {
      submitting.current = false;
    },
  });

  return (
    <form
      onSubmit={(event) => {
        form.onSubmit(({ name }) => {
          if (submitting.current || name.trim() === user.name) return;
          submitting.current = true;
          save.mutate(nicknameSchema.parse(name));
        })(event);
      }}
    >
      <Stack gap="md">
        <TextInput
          label={t('account.profile.email')}
          value={user.email}
          disabled
          autoComplete="email"
        />
        <TextInput
          label={t('account.profile.nickname')}
          autoComplete="nickname"
          disabled={save.isPending}
          {...form.getInputProps('name')}
          // Validation stores a catalog key; translate it on render.
          error={
            form.errors.name
              ? t(form.errors.name as PlainTranslationKey)
              : undefined
          }
        />
        {save.error && (
          <Alert
            color="red"
            title={t('account.profile.saveFailed')}
            role="alert"
          >
            {errorText(save.error, 'account.profile.saveFailedBody')}
          </Alert>
        )}
        <Group justify="flex-start">
          <Button
            type="submit"
            loading={save.isPending}
            disabled={form.values.name.trim() === user.name}
          >
            {t('account.profile.save')}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
