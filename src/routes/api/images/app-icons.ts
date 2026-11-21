import { createFileRoute } from '@tanstack/react-router';
import { handleAppIconIndexRequest } from '~server/images/http';

export const Route = createFileRoute('/api/images/app-icons')({
  server: { handlers: { GET: handleAppIconIndexRequest } },
});
