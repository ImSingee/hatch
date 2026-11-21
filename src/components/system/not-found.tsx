import { Button } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { IconCompassOff } from '@tabler/icons-react';
import { useInsideDeskShell } from '~components/desk/desk-context';
import { DeskStandalone } from '~components/desk/desk-standalone';
import { DeskWindow } from '~components/desk/window';
import { EmptyState } from '~components/page/page';
import { useInsideWindow } from '~components/page/window-context';
import { StandaloneWindow } from '~components/page/standalone-window';

/**
 * Not found, as a window on the desk: inside the signed-in shell it takes
 * the stage like any page; on its own it brings the desk ground with it.
 */
export function NotFoundElement(_props: {}) {
  const insideShell = useInsideDeskShell();
  const insideWindow = useInsideWindow();
  const content = (
    <EmptyState
      icon={<IconCompassOff size={26} stroke={1.6} />}
      title="Nothing lives at this address"
      actions={
        <Button component={Link} to="/">
          Back to the desk
        </Button>
      }
    >
      The address may be mistyped, or the page was moved, renamed or deleted.
    </EmptyState>
  );
  if (insideWindow) return content;
  return insideShell ? (
    <DeskWindow title="Page not found" maxWidth={520}>
      {content}
    </DeskWindow>
  ) : (
    <DeskStandalone>
      <StandaloneWindow title="Page not found" width={520}>
        {content}
      </StandaloneWindow>
    </DeskStandalone>
  );
}
