import { ActionIcon, Anchor, Button, Skeleton, Text } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  IconArrowUpRight,
  IconPlugConnected,
  IconSparkles,
} from '@tabler/icons-react';
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
import { translateError, useI18n } from '~i18n';
import { appsQueryOptions } from '~queries/apps';
import { sessionsQueryOptions } from '~queries/agent';
import classes from './quick-agent-chat.module.css';
import { displaySessionTitle } from '~components/agent/session-title';

/**
 * The ultrawide desk's companion column: recent Agent sessions and a
 * composer. Sending starts a session the same way the Agent window does and
 * opens it there, so the conversation continues in the Agent.
 */
export function QuickAgentChat() {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const sessions = useQuery(sessionsQueryOptions);
  const apps = useQuery(appsQueryOptions);
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
      const attachments = await uploadDraftFiles(id, files, draft);
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
      toast.error(translateError(t, locale, error, 'quickChat.startFailed'));
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
          {t('quickChat.title')}
        </h2>
        <ActionIcon
          component={Link}
          to="/agent"
          variant="light"
          color="gray"
          size={30}
          radius="md"
          aria-label={t('quickChat.openWindow')}
        >
          <IconArrowUpRight size={15} stroke={2} />
        </ActionIcon>
      </div>

      <nav aria-labelledby="quick-chat-recent" className={classes.recent}>
        <div className={classes.recentHead}>
          <span id="quick-chat-recent" className={classes.label}>
            {t('quickChat.recent')}
          </span>
          <Anchor component={Link} to="/agent" size="xs" fw={700}>
            {t('quickChat.allSessions')}
          </Anchor>
        </div>
        {sessions.isPending ? (
          [0, 1, 2].map((index) => (
            <Skeleton key={index} height={44} radius="md" />
          ))
        ) : recent.length === 0 ? (
          <Text size="sm" c="dimmed" px="sm" py={6}>
            {t('quickChat.noSessions')}
          </Text>
        ) : (
          recent.map((session) => (
            <Link
              key={session.id}
              to="/agent/$threadId"
              params={{ threadId: session.id }}
              className={classes.session}
            >
              <strong>
                {session.title
                  ? displaySessionTitle(session.title, t)
                  : t('quickChat.newChat')}
              </strong>
              <span>
                {new Intl.DateTimeFormat(locale, {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                  hourCycle: 'h23',
                }).format(new Date(session.updatedAt))}
              </span>
            </Link>
          ))
        )}
      </nav>

      <div className={classes.prompt}>
        <span className={classes.promptTile} aria-hidden>
          <IconSparkles size={28} stroke={1.6} />
        </span>
        <h3 className={classes.promptTitle}>{t('quickChat.promptTitle')}</h3>
        <Text size="sm" c="dimmed" fw={600} maw={300}>
          {t('quickChat.promptBody')}
        </Text>
      </div>

      <div className={classes.composer}>
        {first === null ? (
          <div className={classes.guard}>
            <IconPlugConnected size={18} stroke={1.8} aria-hidden />
            <Text size="sm" fw={700}>
              {t('quickChat.connectProvider')}
            </Text>
            <Button
              component={Link}
              to="/settings/providers"
              size="compact-sm"
              variant="default"
            >
              {t('quickChat.goToSettings')}
            </Button>
          </div>
        ) : (
          <Composer
            onSubmit={start}
            apps={apps.data}
            appsLoading={apps.isLoading}
            appsError={apps.isError}
            disabled={starting}
            placeholder={t('quickChat.placeholder')}
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
