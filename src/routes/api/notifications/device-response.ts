import { createFileRoute } from '@tanstack/react-router';
import { handleDeviceResponse } from '~server/notifications/responses';

/** Answers a phone sends straight from a push, signed with its push key. */
export const Route = createFileRoute('/api/notifications/device-response')({
  server: {
    handlers: {
      POST: ({ request }) => handleDeviceResponse(request),
    },
  },
});
