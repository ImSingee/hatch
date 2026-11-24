import { Button } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { IconCompassOff } from '@tabler/icons-react';
import { useInsideDeskShell } from '~components/desk/desk-context';
import { DeskStandalone } from '~components/desk/desk-standalone';
import { DeskWindow } from '~components/desk/window';
import { EmptyState } from '~components/page/page';
import { useInsideWindow } from '~components/page/window-context';
import { StandaloneWindow } from '~components/page/standalone-window';
import { useI18n } from '~i18n';

/**
 * Not found, as a window on the desk: inside the signed-in shell it takes
 * the stage like any page; on its own it brings the desk ground with it.
 */
export function NotFoundElement(_props: {}) {
  const { t } = useI18n();
  const insideShell = useInsideDeskShell();
  const insideWindow = useInsideWindow();
  const content = (
    <EmptyState
      icon={<IconCompassOff size={26} stroke={1.6} />}
      title={t('system.notFound.heading')}
      actions={
        <Button component={Link} to="/">
          {t('system.notFound.backToDesk')}
        </Button>
      }
    >
      {t('system.notFound.body')}
    </EmptyState>
  );
  if (insideWindow) return content;
  return insideShell ? (
    <DeskWindow title={t('system.notFound.title')} maxWidth={520}>
      {content}
    </DeskWindow>
  ) : (
    <DeskStandalone>
      <StandaloneWindow title={t('system.notFound.title')} width={520}>
        {content}
      </StandaloneWindow>
    </DeskStandalone>
  );
}
