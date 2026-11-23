import { Box, Button, ThemeIcon } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  IconBookmark,
  IconCalendarCheck,
  IconChartBar,
  IconPlugConnected,
  IconReceipt,
} from '@tabler/icons-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { EmptyState, Section } from '~components/page/page';
import { appsQueryOptions } from '~queries/apps';
import { sessionsQueryOptions } from '~queries/agent';
import { workflowsQueryOptions } from '~queries/workflows';
import { createDraftSendTracker, uploadDraftFiles } from './draft-send';
import { Composer, type ComposerSubmit } from './composer';
import { useLastSelectedModel } from './model-preference';
import { ModelPicker } from './model-picker';
import { useModelOptions } from './model-options';
import { resolveEffectiveModel, splitModelValue } from './model-value';
import { createEmptyAgentSession } from './new-chat-api';
import { startAgentRunRequest } from './use-agent-stream';
import classes from './chat.module.css';

const EXAMPLE_PROMPTS = [
  {
    text: 'A daily habit tracker',
    color: 'green',
    icon: <IconCalendarCheck size={18} stroke={1.8} />,
  },
  {
    text: 'A personal bookmarks manager',
    color: 'blue',
    icon: <IconBookmark size={18} stroke={1.8} />,
  },
  {
    text: 'A workout log with charts',
    color: 'orange',
    icon: <IconChartBar size={18} stroke={1.8} />,
  },
  {
    text: 'A simple expense tracker',
    color: 'violet',
    icon: <IconReceipt size={18} stroke={1.8} />,
  },
];

/**
 * The prompt-first landing for the Agent: type (or pick an example) and send.
 * Sending creates a session and hands the draft up so the chat streams the
 * first reply immediately — no "create a chat first" dead-end.
 */
export function NewChat({
  onStart,
  initialPrompt,
}: {
  onStart: (sessionId: string) => void;
  initialPrompt?: string;
}) {
  const qc = useQueryClient();
  const appsQuery = useQuery(appsQueryOptions);
  const workflowsQuery = useQuery(workflowsQueryOptions);
  const { groups, first, available } = useModelOptions();
  const [model, setModel] = useLastSelectedModel();
  const [creating, setCreating] = useState(false);
  // Reuse a session created by a failed first attempt so a retry doesn't leave
  // a trail of empty "New chat" shells in the chat list.
  const createdSessionRef = useRef<string | null>(null);
  const [draftSends] = useState(createDraftSendTracker);
  const [seed, setSeed] = useState({
    text: initialPrompt ?? '',
    nonce: initialPrompt ? 1 : 0,
  });

  const effectiveModel = resolveEffectiveModel(model, null, available, first);

  const start = async ({
    content,
    images,
    files,
  }: ComposerSubmit): Promise<boolean> => {
    if (creating) return false;
    const value = effectiveModel;
    if (!value) return false;
    const parsed = splitModelValue(value);
    if (!parsed) return false;
    const { providerId, modelId } = parsed;

    setCreating(true);
    try {
      const id =
        createdSessionRef.current ?? (await createEmptyAgentSession()).id;
      createdSessionRef.current = id;
      const draft = draftSends.begin(id, { content, images, files });
      const attachments = await uploadDraftFiles(id, files, draft);
      await startAgentRunRequest({
        clientMessageId: draft.clientMessageId,
        sessionId: id,
        content,
        images,
        attachmentIds: attachments.map((attachment) => attachment.id),
        providerId,
        modelId,
      });
      draftSends.settle(draft);
      await qc.invalidateQueries({ queryKey: sessionsQueryOptions.queryKey });
      onStart(id);
      return true;
    } catch (error) {
      // Keep the draft (return false) so the user can retry without retyping.
      // The created session id is retained (createdSessionRef) so the retry
      // reuses it instead of creating another empty session.
      toast.error(
        error instanceof Error ? error.message : 'Could not start the chat.',
      );
      setCreating(false);
      return false;
    }
  };

  return (
    <Box className={classes.hero}>
      <Box className={classes.heroInner}>
        <div>
          <h2 className={classes.heroTitle}>What do you want to build?</h2>
          <p className={classes.heroLead}>
            Describe an app in plain language. The Agent writes the code, sets
            up its database and deploys it — then it lives in your dock and on
            your desk.
          </p>
        </div>

        {first === null ? (
          <EmptyState
            variant="dashed"
            icon={<IconPlugConnected size={20} stroke={1.8} />}
            title="Connect an AI provider to start"
            actions={
              <Button
                component={Link}
                to="/settings/providers"
                leftSection={<IconPlugConnected size={16} stroke={1.7} />}
              >
                Go to Settings
              </Button>
            }
          >
            Add a provider and enable a model in Settings, then come back to
            start building.
          </EmptyState>
        ) : (
          <>
            <Composer
              onSubmit={start}
              apps={appsQuery.data}
              appsLoading={appsQuery.isLoading}
              appsError={appsQuery.isError}
              workflows={workflowsQuery.data}
              workflowsLoading={workflowsQuery.isLoading}
              workflowsError={workflowsQuery.isError}
              disabled={creating}
              focusOnMount
              placeholder="Describe the app you want to build…"
              seedText={seed.text}
              seedNonce={seed.nonce}
              modelControl={
                <ModelPicker
                  groups={groups}
                  value={effectiveModel}
                  onChange={setModel}
                  disabled={creating}
                />
              }
            />

            <Section title="Try these">
              <div className={classes.suggestions}>
                {EXAMPLE_PROMPTS.map((prompt) => (
                  <button
                    key={prompt.text}
                    type="button"
                    className={classes.suggestion}
                    onClick={() =>
                      setSeed((s) => ({
                        text: prompt.text,
                        nonce: s.nonce + 1,
                      }))
                    }
                  >
                    <ThemeIcon size={34} radius="md" color={prompt.color}>
                      {prompt.icon}
                    </ThemeIcon>
                    {prompt.text}
                  </button>
                ))}
              </div>
            </Section>
          </>
        )}
      </Box>
    </Box>
  );
}
