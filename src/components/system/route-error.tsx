import { Button } from '@mantine/core';
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import { useQueryErrorResetBoundary } from '@tanstack/react-query';
import { type ErrorComponentProps, useRouter } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useInsideDeskShell } from '~components/desk/desk-context';
import { DeskStandalone } from '~components/desk/desk-standalone';
import { DeskWindow } from '~components/desk/window';
import { EmptyState } from '~components/page/page';
import { useInsideWindow } from '~components/page/window-context';
import { StandaloneWindow } from '~components/page/standalone-window';

/**
 * Router-wide error state. Registering it as the default error component gives
 * every route match its own boundary, so a failing page renders here inside
 * the surrounding layout instead of bubbling to the router's global boundary
 * and replacing the whole app shell.
 */
export function RouteError({ error }: ErrorComponentProps) {
  const router = useRouter();
  const queryErrorResetBoundary = useQueryErrorResetBoundary();
  const [retrying, setRetrying] = useState(false);
  const insideShell = useInsideDeskShell();
  const insideWindow = useInsideWindow();

  useEffect(() => {
    // Let suspense queries that failed under this boundary refetch on retry.
    queryErrorResetBoundary.reset();
  }, [queryErrorResetBoundary]);

  const retry = async () => {
    setRetrying(true);
    try {
      // Re-runs the loaders and clears route error state once they succeed.
      await router.invalidate();
    } finally {
      setRetrying(false);
    }
  };

  const content = (
    <EmptyState
      tone="danger"
      icon={<IconAlertTriangle size={26} stroke={1.6} />}
      title="This page couldn’t load"
      actions={
        <Button
          variant="default"
          leftSection={<IconRefresh size={16} stroke={1.7} />}
          loading={retrying}
          onClick={retry}
        >
          Try again
        </Button>
      }
    >
      {error instanceof Error && error.message
        ? error.message
        : 'Something went wrong while loading this page.'}
    </EmptyState>
  );

  // A window on the desk's stage when the shell is there; a shell that
  // itself failed to load leaves the bare desk.
  if (insideWindow) return content;
  return insideShell ? (
    <DeskWindow title="Something went wrong" maxWidth={520}>
      {content}
    </DeskWindow>
  ) : (
    <DeskStandalone>
      <StandaloneWindow title="Something went wrong" width={520}>
        {content}
      </StandaloneWindow>
    </DeskStandalone>
  );
}
