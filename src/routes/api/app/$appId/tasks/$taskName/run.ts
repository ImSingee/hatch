import { createFileRoute } from '@tanstack/react-router';
import { handleTaskWebhook } from '~server/apps/tasks/http';

export const Route = createFileRoute('/api/app/$appId/tasks/$taskName/run')({
  server: {
    handlers: {
      GET: handleTaskWebhook,
      POST: handleTaskWebhook,
    },
  },
});
