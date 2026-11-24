import { createFileRoute } from '@tanstack/react-router';
import { handleUserAvatarRequest } from '~server/images/http';

export const Route = createFileRoute('/api/users/$userId/avatar')({
  server: { handlers: { GET: handleUserAvatarRequest } },
});
