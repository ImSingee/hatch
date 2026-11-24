import { Button, FileButton, Group, Stack, Text } from '@mantine/core';
import { IconPhotoUp, IconTrash } from '@tabler/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { Session } from '~auth/client';
import { UserAvatar } from '~components/auth/user-avatar';
import { userAvatarKey } from '~lib/user-avatar';
import { usersPanelQueryOptions } from '~queries/users';
import { clearMyAvatarFn, uploadMyAvatarFn } from '~server/user-avatars';

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

/** Upload, replace or remove the signed-in user's avatar. */
export function AccountAvatarField({
  user,
  onChanged,
}: {
  user: Session['user'];
  /** Reload the session so every place showing the user picks up the change. */
  onChanged: () => Promise<unknown>;
}) {
  const queryClient = useQueryClient();
  const hasAvatar = Boolean(userAvatarKey(user.id, user.image));
  const refresh = () =>
    Promise.all([
      onChanged(),
      queryClient.invalidateQueries({
        queryKey: usersPanelQueryOptions.queryKey,
      }),
    ]);

  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (file.size > MAX_BYTES) throw new Error('Avatar image exceeds 4 MB.');
      return uploadMyAvatarFn({
        data: { imageBase64: await toBase64(file) },
      });
    },
    onSuccess: async () => {
      await refresh();
      toast.success('Avatar updated');
    },
  });
  const remove = useMutation({
    mutationFn: () => clearMyAvatarFn(),
    onSuccess: async () => {
      await refresh();
      toast.success('Avatar removed');
    },
  });
  const busy = upload.isPending || remove.isPending;

  return (
    <Stack gap={6}>
      <Text size="sm" fw={500}>
        Avatar
      </Text>
      <Group gap="md" align="center" wrap="nowrap">
        <UserAvatar
          userId={user.id}
          image={user.image}
          name={user.name || user.email}
          size={56}
        />
        <Stack gap={6}>
          <Group gap="xs">
            <FileButton
              accept={ACCEPT}
              disabled={busy}
              onChange={(file) => file && upload.mutate(file)}
            >
              {(props) => (
                <Button
                  {...props}
                  type="button"
                  size="xs"
                  variant="default"
                  loading={upload.isPending}
                  leftSection={<IconPhotoUp size={14} stroke={1.8} />}
                >
                  {hasAvatar ? 'Replace image' : 'Upload image'}
                </Button>
              )}
            </FileButton>
            {hasAvatar ? (
              <Button
                type="button"
                size="xs"
                variant="subtle"
                color="gray"
                disabled={upload.isPending}
                loading={remove.isPending}
                leftSection={<IconTrash size={14} stroke={1.8} />}
                onClick={() => remove.mutate()}
              >
                Remove
              </Button>
            ) : null}
          </Group>
          <Text size="xs" c="dimmed">
            PNG, JPEG or WebP up to 4 MB, cropped to a square.
          </Text>
        </Stack>
      </Group>
    </Stack>
  );
}
