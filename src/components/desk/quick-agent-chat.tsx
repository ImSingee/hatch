import { ActionIcon, Anchor, Button, Skeleton, Text } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  IconArrowUpRight,
  IconPlugConnected,
  IconSparkles,
} from '@tabler/icons-react';
import dayjs from 'dayjs';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  createDraftSendTracker,
  uploadDraftFiles,
} from '~components/agent/draft-send';
import { Composer, type ComposerSubmit } from '~components/agent/composer';
import { useLastSelectedModel } from '~components/agent/model-preference';
import { ModelPicker } from '~components/agent/model-picker';
import { useModelOptions } from '~components/agent/model-options';
import {
  resolveEffectiveModel,
  splitModelValue,
} from '~components/agent/model-value';
import { createEmptyAgentSession } from '~components/agent/new-chat-api';
import { startAgentRunRequest } from '~components/agent/use-agent-stream';
import { appsQueryOptions } from '~queries/apps';
import { sessionsQueryOptions } from '~queries/agent';
import { workflowsQueryOptions } from '~queries/workflows';
import classes from './quick-agent-chat.module.css';

/**
 * The ultrawide desk's companion column: recent Agent sessions and a
 * composer. Sending starts a session the same way the Agent window does and
 * opens it there, so the conversation continues in the Agent.
 */
export function QuickAgentChat() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const sessions = useQuery(sessionsQueryOptions);
  const apps = useQuery(appsQueryOptions);
  const workflows = useQuery(workflowsQueryOptions);
  const { groups, first, available } = useModelOptions();
  const [model, setModel] = useLastSelectedModel();
  const [starting, setStarting] = useState(false);
  // A failed first send keeps its session so a retry does not leave empty
  // sessions behind.
  const createdSession = useRef<string | null>(null);
  const [draftSends] = useState(createDraftSendTracker);
  const effectiveModel = resolveEffectiveModel(model, null, available, first);
  const recent = (sessions.data ?? []).slice(0, 3);

  const start = async ({
    content,
    images,
    files,
  }: ComposerSubmit): Promise<boolean> => {
    if (starting || !effectiveModel) return false;
    const parsed = splitModelValue(effectiveModel);
    if (!parsed) return false;
    setStarting(true);
    try {
      const id = createdSession.current ?? (await createEmptyAgentSession()).id;
      createdSession.current = id;
      const draft = draftSends.begin(id, { content, images, files });
      const attachments = await uploadDraftFiles(id, files);
      await startAgentRunRequest({
        clientMessageId: draft.clientMessageId,
        sessionId: id,
        content,
        images,
        attachmentIds: attachments.map((attachment) => attachment.id),
        providerId: parsed.providerId,
        modelId: parsed.modelId,
      });
      draftSends.settle(draft);
      await queryClient.invalidateQueries({
        queryKey: sessionsQueryOptions.queryKey,
      });
      await navigate({ to: '/agent/$threadId', params: { threadId: id } });
      return true;
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Could not start the chat.',
      );
      setStarting(false);
      return false;
    }
  };

  return (
    <section aria-labelledby="quick-chat-title" className={classes.panel}>
      <div className={classes.titleBar}>
        <span className={classes.titleTile} aria-hidden>
          <IconSparkles size={14} stroke={2} />
        </span>
        <h2 id="quick-chat-title" className={classes.title}>
          Agent quick chat
        </h2>
        <ActionIcon
          component={Link}
          to="/agent"
          variant="light"
          color="gray"
          size={30}
          radius="md"
          aria-label="Open the Agent in a window"
        >
          <IconArrowUpRight size={15} stroke={2} />
        </ActionIcon>
      </div>

      <nav aria-labelledby="quick-chat-recent" className={classes.recent}>
        <div className={classes.recentHead}>
          <span id="quick-chat-recent" className={classes.label}>
            Recent sessions
          </span>
          <Anchor component={Link} to="/agent" size="xs" fw={700}>
            All sessions ›
          </Anchor>
        </div>
        {sessions.isPending ? (
          [0, 1, 2].map((index) => (
            <Skeleton key={index} height={44} radius="md" />
          ))
        ) : recent.length === 0 ? (
          <Text size="sm" c="dimmed" px="sm" py={6}>
            No sessions yet.
          </Text>
        ) : (
          recent.map((session) => (
            <Link
              key={session.id}
              to="/agent/$threadId"
              params={{ threadId: session.id }}
              className={classes.session}
            >
              <strong>{session.title || 'New chat'}</strong>
              <span>{dayjs(session.updatedAt).format('MMM D, HH:mm')}</span>
            </Link>
          ))
        )}
      </nav>

      <div className={classes.prompt}>
        <span className={classes.promptTile} aria-hidden>
          <IconSparkles size={28} stroke={1.6} />
        </span>
        <h3 className={classes.promptTitle}>What do you want to make?</h3>
        <Text size="sm" c="dimmed" fw={600} maw={300}>
          Describe it in a sentence and the Agent builds it as an App, without
          leaving the desk.
        </Text>
      </div>

      <div className={classes.composer}>
        {first === null ? (
          <div className={classes.guard}>
            <IconPlugConnected size={18} stroke={1.8} aria-hidden />
            <Text size="sm" fw={700}>
              Connect an AI provider to start
            </Text>
            <Button
              component={Link}
              to="/settings/providers"
              size="compact-sm"
              variant="default"
            >
              Go to Settings
            </Button>
          </div>
        ) : (
          <Composer
            onSubmit={start}
            apps={apps.data}
            appsLoading={apps.isLoading}
            appsError={apps.isError}
            workflows={workflows.data}
            workflowsLoading={workflows.isLoading}
            workflowsError={workflows.isError}
            disabled={starting}
            placeholder="Describe the app or workflow you want…"
            modelControl={
              <ModelPicker
                groups={groups}
                value={effectiveModel}
                onChange={setModel}
                disabled={starting}
              />
            }
          />
        )}
      </div>
    </section>
  );
}
