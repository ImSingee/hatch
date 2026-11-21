import { Center, Loader, Stack } from '@mantine/core';
import { Brand } from '~components/desk/brand';
import { useInsideDeskShell } from '~components/desk/desk-context';

/**
 * Full-viewport loading state. In SPA mode this is prerendered as the static
 * shell (`_shell.html`) and shown on the initial client load until the router
 * resolves the matched route; it also covers slow route transitions.
 */
export function AppLoading() {
  // On the desk's stage the shell is already there; fill the stage, not the
  // viewport.
  const insideShell = useInsideDeskShell();
  return (
    <Center
      mih={insideShell ? '100%' : '100dvh'}
      h={insideShell ? '100%' : undefined}
      w="100%"
    >
      <Stack align="center" gap="lg">
        <Brand size="lg" withWordmark={false} />
        <Loader size="sm" color="primary" type="dots" />
      </Stack>
    </Center>
  );
}
