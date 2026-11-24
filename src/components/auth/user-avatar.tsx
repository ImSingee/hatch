import { Avatar, type AvatarProps } from '@mantine/core';
import { userAvatarSrc } from '~lib/user-avatar';

/**
 * A user's uploaded avatar, or their initials on the accent when they have
 * none. `image` is `user.image`; only platform avatar paths are shown.
 */
export function UserAvatar({
  userId,
  image,
  name,
  size,
  radius = 'xl',
}: {
  userId: string | undefined;
  image: string | null | undefined;
  name: string;
  size: number;
  radius?: AvatarProps['radius'];
}) {
  const src = userId ? userAvatarSrc(userId, image, size) : null;
  return (
    <Avatar
      size={size}
      radius={radius}
      name={name}
      src={src}
      alt={src ? name : undefined}
      color="primary"
      variant="filled"
    />
  );
}
