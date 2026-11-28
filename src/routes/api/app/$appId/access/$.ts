import { createFileRoute } from '@tanstack/react-router';
import { handleAppAccessRequest } from '~server/apps/runtime-api/access';

const handle = handleAppAccessRequest;

// Every verb a relayed webhook may use; RPC, Data and tasks use GET and POST.
export const Route = createFileRoute('/api/app/$appId/access/$')({
  server: {
    handlers: {
      GET: handle,
      POST: handle,
      PUT: handle,
      PATCH: handle,
      DELETE: handle,
      HEAD: handle,
      OPTIONS: handle,
    },
  },
});
