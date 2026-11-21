import { createFileRoute } from '@tanstack/react-router';
import { handleAppIconRequest } from '~server/images/http';

export const Route = createFileRoute('/api/app/$appId/icon')({
  server: { handlers: { GET: handleAppIconRequest } },
});
