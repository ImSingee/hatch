import { createFileRoute } from '@tanstack/react-router';
import { handleAiRequest } from '~server/apps/runtime-api/ai';

/** `chat` and `image`; the handler rejects any other action. */
export const Route = createFileRoute('/api/app/$appId/ai/$action')({
  server: {
    handlers: {
      POST: handleAiRequest,
    },
  },
});
