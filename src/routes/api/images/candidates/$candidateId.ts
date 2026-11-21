import { createFileRoute } from '@tanstack/react-router';
import { handleImageCandidateRequest } from '~server/images/http';

export const Route = createFileRoute('/api/images/candidates/$candidateId')({
  server: { handlers: { GET: handleImageCandidateRequest } },
});
