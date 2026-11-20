import { createFileRoute } from '@tanstack/react-router';
import { handleGitHttpRequest } from '~server/source-git-http';

export const Route = createFileRoute('/api/git/$')({
  server: {
    handlers: { ANY: ({ request }) => handleGitHttpRequest(request) },
  },
});
