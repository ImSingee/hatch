import { createFileRoute } from '@tanstack/react-router';
import { handleNotificationRequest } from '~server/apps/runtime-api/notifications';

/** `update` and `recall`; the handler rejects any other action. */
export const Route = createFileRoute('/api/app/$appId/notifications/$action')({
  server: {
    handlers: {
      POST: handleNotificationRequest,
    },
  },
});
