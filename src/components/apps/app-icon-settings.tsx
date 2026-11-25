import { Button, FileButton, Group, Stack, Text } from '@mantine/core';
import { IconPhotoUp, IconTrash } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AppGlyph } from '~components/apps/app-glyph';
import { appIconsQueryOptions } from '~components/apps/use-app-icon';
import { useI18n } from '~i18n';
import { CodedError } from '~lib/error-codes';
import { clearAppIconFn, uploadAppIconFn } from '~server/app-icons';

const MAX_BYTES = 4 * 1024 * 1024;
const ACCEPT = 'image/png,image/jpeg,image/webp';

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () =>
      reject(new CodedError('Could not read the file.', 'app.icon.readFailed'));
    reader.readAsDataURL(file);
  });
}

/** Upload or remove an App's icon. Generating one is the Agent's job. */
export function AppIconSettings({
  appId,
  appName,
}: {
  appId: string;
  appName: string;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data: icons } = useQuery(appIconsQueryOptions);
  const hasIcon = Boolean(icons?.[appId]);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: appIconsQueryOptions.queryKey });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (file.size > MAX_BYTES) {
        throw new CodedError('Icon image exceeds 4 MB.', 'app.icon.tooLarge');
      }
      return uploadAppIconFn({
        data: { id: appId, imageBase64: await toBase64(file) },
      });
    },
    onSuccess: async () => {
      await refresh();
      toast.success(t('appIcon.updated'));
    },
  });
  const remove = useMutation({
    mutationFn: () => clearAppIconFn({ data: appId }),
    onSuccess: async () => {
      await refresh();
      toast.success(t('appIcon.removed'));
    },
  });

  return (
    <Group gap="md" align="center" wrap="nowrap">
      <AppGlyph name={appName} seed={appId} size="lg" />
      <Stack gap={6}>
        <Group gap="xs">
          <FileButton
            accept={ACCEPT}
            onChange={(file) => file && upload.mutate(file)}
          >
            {(props) => (
              <Button
                {...props}
                size="xs"
                variant="default"
                loading={upload.isPending}
                leftSection={<IconPhotoUp size={14} stroke={1.8} />}
              >
                {t('appIcon.upload')}
              </Button>
            )}
          </FileButton>
          {hasIcon ? (
            <Button
              size="xs"
              variant="subtle"
              color="gray"
              loading={remove.isPending}
              leftSection={<IconTrash size={14} stroke={1.8} />}
              onClick={() => remove.mutate()}
            >
              {t('common.remove')}
            </Button>
          ) : null}
        </Group>
        <Text size="xs" c="dimmed">
          {t('appIcon.hint')}
        </Text>
      </Stack>
    </Group>
  );
}
