import { Button, FileButton, Group, Stack, Text } from '@mantine/core';
import { IconPhotoUp, IconTrash } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AppGlyph } from '~components/apps/app-glyph';
import { appIconsQueryOptions } from '~components/apps/use-app-icon';
import { clearAppIconFn, uploadAppIconFn } from '~server/app-icons';

const MAX_BYTES = 4 * 1024 * 1024;
const ACCEPT = 'image/png,image/jpeg,image/webp';

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error('Could not read the file.'));
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
  const queryClient = useQueryClient();
  const { data: icons } = useQuery(appIconsQueryOptions);
  const hasIcon = Boolean(icons?.[appId]);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: appIconsQueryOptions.queryKey });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (file.size > MAX_BYTES) throw new Error('Icon image exceeds 4 MB.');
      return uploadAppIconFn({
        data: { id: appId, imageBase64: await toBase64(file) },
      });
    },
    onSuccess: async () => {
      await refresh();
      toast.success('Icon updated');
    },
  });
  const remove = useMutation({
    mutationFn: () => clearAppIconFn({ data: appId }),
    onSuccess: async () => {
      await refresh();
      toast.success('Icon removed');
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
                Upload image
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
              Remove
            </Button>
          ) : null}
        </Group>
        <Text size="xs" c="dimmed">
          PNG, JPEG or WebP up to 4 MB, cropped to a square. Or ask the Agent to
          design an icon for this app.
        </Text>
      </Stack>
    </Group>
  );
}
