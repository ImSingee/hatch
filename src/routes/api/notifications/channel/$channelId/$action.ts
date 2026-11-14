import { createFileRoute } from '@tanstack/react-router';
import { handleChannelPush } from '~server/notifications/channel-ingress';

export const Route = createFileRoute(
  '/api/notifications/channel/$channelId/$action',
)({
  server: {
    handlers: {
      POST: ({ request, params }) =>
        params.action === 'update' || params.action === 'recall'
          ? handleChannelPush(request, params.channelId, params.action)
          : new Response('Not found', { status: 404 }),
    },
  },
});
