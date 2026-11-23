import { createFileRoute } from '@tanstack/react-router';
import { AppLibrary } from '~components/apps/app-library';
import { DeskWindow } from '~components/desk/window';
import { workflowsQueryOptions } from '~queries/workflows';
import { listApps } from '~server/apps';

export const Route = createFileRoute('/_app/apps/')({
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(workflowsQueryOptions);
    return listApps();
  },
  component: AppsPage,
});

function AppsPage() {
  const apps = Route.useLoaderData();
  return (
    <DeskWindow title="All apps" fill>
      <AppLibrary apps={apps} />
    </DeskWindow>
  );
}
