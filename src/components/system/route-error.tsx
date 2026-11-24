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
import { type PlainTranslationKey, useI18n } from '~i18n';

/**
 * Router-wide error state. Registering it as the default error component gives
 * every route match its own boundary, so a failing page renders here inside
 * the surrounding layout instead of bubbling to the router's global boundary
 * and replacing the whole app shell.
 */
/**
 * What the page says about a failure. The server's own text is written for
 * logs, not for the person using the page, so it is never shown; a request
 * that never reached the server gets its own line because the fix differs.
 */
export function routeErrorKey(error: unknown): PlainTranslationKey {
  const offline =
    (typeof navigator !== 'undefined' && navigator.onLine === false) ||
    (error instanceof TypeError && /fetch|network/i.test(error.message));
  return offline ? 'system.routeError.offline' : 'system.routeError.failed';
}

export function RouteError({ error }: ErrorComponentProps) {
  const { t } = useI18n();
  const router = useRouter();
  const queryErrorResetBoundary = useQueryErrorResetBoundary();
  const [retrying, setRetrying] = useState(false);
  const insideShell = useInsideDeskShell();
  const insideWindow = useInsideWindow();

  useEffect(() => {
    // The details stay available to whoever debugs it.
    console.error(error);
  }, [error]);

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
      title={t('system.routeError.heading')}
      actions={
        <Button
          variant="default"
          leftSection={<IconRefresh size={16} stroke={1.7} />}
          loading={retrying}
          onClick={retry}
        >
          {t('common.tryAgain')}
        </Button>
      }
    >
      {t(routeErrorKey(error))}
    </EmptyState>
  );

  // A window on the desk's stage when the shell is there; a shell that
  // itself failed to load leaves the bare desk.
  if (insideWindow) return content;
  return insideShell ? (
    <DeskWindow title={t('system.routeError.title')} maxWidth={520}>
      {content}
    </DeskWindow>
  ) : (
    <DeskStandalone>
      <StandaloneWindow title={t('system.routeError.title')} width={520}>
        {content}
      </StandaloneWindow>
    </DeskStandalone>
  );
}
