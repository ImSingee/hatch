/** A web-runtime (React) frontend: the template's backend with a React SPA. */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import { z } from 'zod';
import { CounterService } from '../gen/service_pb.ts';

declare const __RPC_BASE_URL__: string;

const client = createClient(
  CounterService,
  createConnectTransport({ baseUrl: __RPC_BASE_URL__ }),
);

const countSchema = z.object({ count: z.number().int() });
const queryKey = ['count'] as const;

function Home() {
  const queryClient = useQueryClient();
  const { data, isPending } = useQuery({
    queryKey,
    queryFn: async () => countSchema.parse(await client.getCount({})).count,
  });
  const increment = useMutation({
    mutationFn: async () =>
      countSchema.parse(await client.increment({ amount: 1 })).count,
    onSuccess: (next) => queryClient.setQueryData(queryKey, next),
  });
  return (
    <div className="card">
      <div className="count">{isPending ? '—' : data}</div>
      <button
        type="button"
        disabled={isPending || increment.isPending}
        onClick={() => increment.mutate()}
      >
        Increment
      </button>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={new QueryClient()}>
      <Home />
    </QueryClientProvider>
  </StrictMode>,
);
