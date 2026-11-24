import {
  Alert,
  Button,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useSuspenseQuery } from '@tanstack/react-query';
import copy from 'copy-to-clipboard';
import { toast } from 'sonner';
import { buildInfo } from '~/build-info';
import { serverInfoQueryOptions } from '~queries/server-info';

export function AboutPanel() {
  const { data: server } = useSuspenseQuery(serverInfoQueryOptions);
  const { commit, commitTime } = server;
  // This page's code was bundled from `buildInfo`; the server may have been
  // redeployed since the page loaded.
  const outdated =
    commit !== null && buildInfo.commit !== null && buildInfo.commit !== commit;
  return (
    <Stack gap="xl">
      {outdated && (
        <Alert color="yellow" title="This page is out of date">
          <Stack gap="sm" align="flex-start">
            <Text size="sm">
              The server was updated after this page loaded. The page is still
              running commit{' '}
              <Text span ff="monospace" fz="sm">
                {buildInfo.commit?.slice(0, 12)}
              </Text>
              .
            </Text>
            <Button
              type="button"
              size="xs"
              variant="default"
              onClick={() => window.location.reload()}
            >
              Reload
            </Button>
          </Stack>
        </Alert>
      )}
      <Stack gap="xs">
        <Text size="sm" fw={700}>
          Commit
        </Text>
        {commit ? (
          <Tooltip label="Copy commit SHA" withArrow>
            <UnstyledButton
              type="button"
              aria-label={`Copy commit SHA ${commit}`}
              ff="monospace"
              fz="sm"
              w="fit-content"
              maw="100%"
              style={{ overflowWrap: 'anywhere' }}
              onClick={async () => {
                if (await copy(commit).catch(() => false))
                  toast.success('Commit SHA copied');
                else toast.error('Could not copy commit SHA');
              }}
            >
              {commit}
            </UnstyledButton>
          </Tooltip>
        ) : (
          <Text size="sm" ff="monospace">
            Unknown
          </Text>
        )}
      </Stack>
      <Stack gap="xs">
        <Text size="sm" fw={700}>
          Commit time
        </Text>
        <Text size="sm">
          {commitTime ? (
            <time dateTime={commitTime}>{commitTime}</time>
          ) : (
            'Unknown'
          )}
        </Text>
      </Stack>
    </Stack>
  );
}
