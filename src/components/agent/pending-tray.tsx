/** Messages sent while the Agent works, waiting above the composer. */
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  CloseButton,
  Group,
  Image,
  Loader,
  Text,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import {
  IconFile,
  IconPencil,
  IconPlayerPause,
  IconSend,
  IconX,
} from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import type { AgentMessageMode } from '~/db/schema';
import {
  hasComposerText,
  type ComposerInputPart,
} from '~agent/composer-content';
import { useI18n, type PlainTranslationKey } from '~i18n';
import type { AppListItem } from '~server/apps';
import { ComposerEditor, type ComposerEditorHandle } from './composer-editor';
import {
  cancelPendingMessage,
  resumePendingMessages,
  sendPendingMessageNow,
  updatePendingMessage,
  type AgentPendingMessage,
  type PendingMessagesResult,
  type SessionPendingMessages,
} from './pending-api';
import classes from './pending-tray.module.css';

type Mentions = {
  apps?: AppListItem[];
};

const MODE_LABEL: Record<AgentMessageMode, PlainTranslationKey> = {
  queue: 'agent.pending.mode.queue',
  steer: 'agent.pending.mode.steer',
};
const MODE_HINT: Record<AgentMessageMode, PlainTranslationKey> = {
  queue: 'agent.pending.mode.queueHint',
  steer: 'agent.pending.mode.steerHint',
};
/** The hint on a message that can still switch, naming the click. */
const MODE_SWITCH_HINT: Record<AgentMessageMode, PlainTranslationKey> = {
  queue: 'agent.pending.mode.queueSwitchHint',
  steer: 'agent.pending.mode.steerSwitchHint',
};
const MODE_SWITCH_LABEL: Record<AgentMessageMode, PlainTranslationKey> = {
  queue: 'agent.pending.mode.queueSwitchLabel',
  steer: 'agent.pending.mode.steerSwitchLabel',
};

function otherMode(mode: AgentMessageMode): AgentMessageMode {
  return mode === 'steer' ? 'queue' : 'steer';
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function imageSrc(image: { data: string; mimeType: string }): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

function PendingEdit({
  message,
  mentions,
  saving,
  onSave,
  onCancel,
}: {
  message: AgentPendingMessage;
  mentions: Mentions;
  saving: boolean;
  onSave: (changes: {
    content: ComposerInputPart[];
    images: AgentPendingMessage['images'];
    attachmentIds: string[];
  }) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const editorRef = useRef<ComposerEditorHandle>(null);
  const [content, setContent] = useState(message.content);
  const [images, setImages] = useState(message.images);
  const [attachments, setAttachments] = useState(message.attachments);
  const [lookupPending, setLookupPending] = useState(false);
  const empty =
    !hasComposerText(content) &&
    images.length === 0 &&
    attachments.length === 0;

  const save = () => {
    if (saving || lookupPending || empty) return;
    const snapshot = editorRef.current?.getSnapshot();
    onSave({
      content: snapshot?.content ?? content,
      images,
      attachmentIds: attachments.map((attachment) => attachment.id),
    });
  };

  return (
    <Box className={classes.edit}>
      {images.length + attachments.length > 0 ? (
        <Group gap={6}>
          {images.map((image, index) => (
            <Box key={`image-${index}`} className={classes.thumb}>
              <Image
                src={imageSrc(image)}
                alt=""
                className={classes.thumbImg}
              />
              <CloseButton
                size="xs"
                radius="xl"
                variant="filled"
                className={classes.thumbRemove}
                aria-label={t('agent.pending.removeImage')}
                onClick={() =>
                  setImages((current) => current.filter((_, i) => i !== index))
                }
              />
            </Box>
          ))}
          {attachments.map((attachment) => (
            <Group key={attachment.id} gap={4} className={classes.file}>
              <IconFile size={14} stroke={1.7} />
              <Text size="xs" truncate maw={140}>
                {attachment.name}
              </Text>
              <CloseButton
                size="xs"
                aria-label={t('agent.composer.removeFile', {
                  name: attachment.name,
                })}
                onClick={() =>
                  setAttachments((current) =>
                    current.filter((item) => item.id !== attachment.id),
                  )
                }
              />
            </Group>
          ))}
        </Group>
      ) : null}
      <Box className={classes.editor}>
        <ComposerEditor
          ref={editorRef}
          apps={mentions.apps}
          disabled={saving}
          focusOnMount
          placeholder={t('agent.pending.editPlaceholder')}
          seedContent={message.content}
          onChange={setContent}
          onMentionLookupPendingChange={setLookupPending}
          onSubmit={save}
          onPasteFiles={() => toast.info(t('agent.pending.editPasteFiles'))}
        />
      </Box>
      <Group gap="xs" justify="flex-end">
        <Button size="xs" variant="subtle" color="gray" onClick={onCancel}>
          {t('agent.pending.discard')}
        </Button>
        <Button
          size="xs"
          onClick={save}
          loading={saving}
          disabled={empty || lookupPending}
        >
          {t('common.save')}
        </Button>
      </Group>
    </Box>
  );
}

function PendingRow({
  sessionId,
  message,
  mentions,
  onResult,
}: {
  sessionId: string;
  message: AgentPendingMessage;
  mentions: Mentions;
  onResult: (result: PendingMessagesResult) => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const update = useMutation({
    mutationFn: (changes: Parameters<typeof updatePendingMessage>[2]) =>
      updatePendingMessage(sessionId, message.id, changes),
    onSuccess: (result) => {
      setEditing(false);
      onResult(result);
    },
    onError: (error) =>
      toast.error(errorText(error, t('agent.pending.saveFailed'))),
  });
  const cancel = useMutation({
    mutationFn: () => cancelPendingMessage(sessionId, message.id),
    onSuccess: onResult,
    onError: (error) =>
      toast.error(errorText(error, t('agent.pending.cancelFailed'))),
  });
  const sendNow = useMutation({
    mutationFn: () => sendPendingMessageNow(sessionId, message.id),
    onSuccess: onResult,
    onError: (error) =>
      toast.error(errorText(error, t('agent.pending.sendNowFailed'))),
  });
  const switchMode = useMutation({
    mutationFn: (mode: AgentMessageMode) =>
      updatePendingMessage(sessionId, message.id, { mode }),
    onSuccess: onResult,
    onError: (error) =>
      toast.error(errorText(error, t('agent.pending.switchFailed'))),
  });
  const editable = message.status === 'pending';
  // A run taking the message in ends any edit: it can no longer change.
  const [wasEditable, setWasEditable] = useState(editable);
  if (wasEditable !== editable) {
    setWasEditable(editable);
    if (!editable) setEditing(false);
  }
  // A save still in flight would close an edit reopened meanwhile.
  const working =
    cancel.isPending ||
    sendNow.isPending ||
    update.isPending ||
    switchMode.isPending;
  const files = message.images.length + message.attachments.length;
  // Show the switch at once; the result (or a failure) settles it.
  const mode =
    switchMode.isPending && switchMode.variables
      ? switchMode.variables
      : message.mode;
  const badge = (
    <Badge
      size="xs"
      variant="light"
      color={mode === 'steer' ? 'primary' : 'gray'}
    >
      {t(MODE_LABEL[mode])}
    </Badge>
  );

  return (
    <Box
      className={classes.row}
      data-testid="pending-message"
      data-status={message.status}
    >
      <Group gap="xs" wrap="nowrap" align="flex-start">
        <Tooltip
          label={t(editable ? MODE_SWITCH_HINT[mode] : MODE_HINT[mode])}
          withArrow
          multiline
          w={220}
        >
          {editable ? (
            <UnstyledButton
              className={classes.mode}
              aria-label={t(MODE_SWITCH_LABEL[mode])}
              disabled={working}
              onClick={() => switchMode.mutate(otherMode(mode))}
            >
              {badge}
            </UnstyledButton>
          ) : (
            <Box className={classes.mode}>{badge}</Box>
          )}
        </Tooltip>
        {editing && editable ? (
          <Box className={classes.body}>
            <PendingEdit
              message={message}
              mentions={mentions}
              saving={update.isPending}
              onSave={(changes) => {
                if (editable) update.mutate(changes);
              }}
              onCancel={() => setEditing(false)}
            />
          </Box>
        ) : (
          <>
            <Box className={classes.body}>
              <Text size="sm" lineClamp={2} className={classes.text}>
                {message.text ||
                  (files > 0 ? t('agent.pending.attachmentsOnly') : '')}
              </Text>
              {files > 0 ? (
                <Text size="xs" c="dimmed">
                  {t('agent.pending.attachments', { count: files })}
                </Text>
              ) : null}
            </Box>
            {editable ? (
              <Group gap={2} wrap="nowrap" className={classes.actions}>
                <Tooltip label={t('agent.pending.edit')} withArrow>
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    size={26}
                    radius="md"
                    aria-label={t('agent.pending.editLabel')}
                    disabled={working}
                    onClick={() => setEditing(true)}
                  >
                    <IconPencil size={15} stroke={1.7} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label={t('agent.pending.sendNowHint')} withArrow>
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    size={26}
                    radius="md"
                    aria-label={t('agent.pending.sendNow')}
                    loading={sendNow.isPending}
                    disabled={working}
                    onClick={() => sendNow.mutate()}
                  >
                    <IconSend size={15} stroke={1.7} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label={t('agent.pending.cancel')} withArrow>
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    size={26}
                    radius="md"
                    aria-label={t('agent.pending.cancelLabel')}
                    loading={cancel.isPending}
                    disabled={working}
                    onClick={() => cancel.mutate()}
                  >
                    <IconX size={15} stroke={1.7} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            ) : (
              <Group gap={6} wrap="nowrap" c="dimmed">
                <Loader size={12} color="gray" />
                <Text size="xs" c="dimmed">
                  {t('agent.pending.sending')}
                </Text>
              </Group>
            )}
          </>
        )}
      </Group>
    </Box>
  );
}

/**
 * Undelivered messages in send order. Each stays editable until the run
 * takes it in; Send now stops the current reply first.
 */
export function PendingTray({
  sessionId,
  pending,
  apps,
  onResult,
}: {
  sessionId: string;
  pending: SessionPendingMessages;
  apps?: AppListItem[];
  onResult: (result: PendingMessagesResult) => void;
}) {
  const { t } = useI18n();
  const resume = useMutation({
    mutationFn: () => resumePendingMessages(sessionId),
    onSuccess: onResult,
    onError: (error) =>
      toast.error(errorText(error, t('agent.pending.resumeFailed'))),
  });
  if (pending.messages.length === 0) return null;
  return (
    <Box
      component="section"
      className={classes.tray}
      aria-label={t('agent.pending.label')}
    >
      {pending.paused ? (
        <Group
          gap="xs"
          justify="space-between"
          wrap="nowrap"
          className={classes.paused}
        >
          <Group gap={6} wrap="nowrap">
            <IconPlayerPause size={14} stroke={1.7} />
            <Text size="xs">{t('agent.pending.paused')}</Text>
          </Group>
          <Button
            size="compact-xs"
            variant="light"
            style={{ flex: 'none' }}
            loading={resume.isPending}
            onClick={() => resume.mutate()}
          >
            {t('agent.pending.resume')}
          </Button>
        </Group>
      ) : null}
      {pending.messages.map((message) => (
        <PendingRow
          key={message.id}
          sessionId={sessionId}
          message={message}
          mentions={{ apps }}
          onResult={onResult}
        />
      ))}
    </Box>
  );
}
