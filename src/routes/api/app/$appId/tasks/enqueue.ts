import { createFileRoute } from '@tanstack/react-router';
import { handleTaskEnqueue } from '~server/apps/tasks/http';

export const Route = createFileRoute('/api/app/$appId/tasks/enqueue')({
  server: {
    handlers: {
      POST: handleTaskEnqueue,
    },
  },
});
