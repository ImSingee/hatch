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
import {
  hasComposerText,
  type ComposerInputPart,
} from '~agent/composer-content';
import type { AppListItem } from '~server/apps';
import type { WorkflowListItem } from '~server/workflows';
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
  workflows?: WorkflowListItem[];
};

const MODE_LABEL = { queue: 'Queued', steer: 'Steer' } as const;
const MODE_HINT = {
  queue: 'Sent as its own message after the current reply finishes.',
  steer: 'Sent into the current reply as soon as its running steps finish.',
} as const;

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
                aria-label="Remove image"
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
                aria-label={`Remove ${attachment.name}`}
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
          workflows={mentions.workflows}
          disabled={saving}
          focusOnMount
          placeholder="Edit message…"
          seedContent={message.content}
          onChange={setContent}
          onMentionLookupPendingChange={setLookupPending}
          onSubmit={save}
          onPasteFiles={() =>
            toast.info('Add new files with a new message instead.')
          }
        />
      </Box>
      <Group gap="xs" justify="flex-end">
        <Button size="xs" variant="subtle" color="gray" onClick={onCancel}>
          Discard changes
        </Button>
        <Button
          size="xs"
          onClick={save}
          loading={saving}
          disabled={empty || lookupPending}
        >
          Save
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
  const [editing, setEditing] = useState(false);
  const update = useMutation({
    mutationFn: (changes: Parameters<typeof updatePendingMessage>[2]) =>
      updatePendingMessage(sessionId, message.id, changes),
    onSuccess: (result) => {
      setEditing(false);
      onResult(result);
    },
    onError: (error) =>
      toast.error(errorText(error, 'Could not save the message.')),
  });
  const cancel = useMutation({
    mutationFn: () => cancelPendingMessage(sessionId, message.id),
    onSuccess: onResult,
    onError: (error) =>
      toast.error(errorText(error, 'Could not cancel the message.')),
  });
  const sendNow = useMutation({
    mutationFn: () => sendPendingMessageNow(sessionId, message.id),
    onSuccess: onResult,
    onError: (error) =>
      toast.error(errorText(error, 'Could not send the message now.')),
  });
  const editable = message.status === 'pending';
  const working = cancel.isPending || sendNow.isPending;
  const files = message.images.length + message.attachments.length;

  return (
    <Box
      className={classes.row}
      data-testid="pending-message"
      data-status={message.status}
    >
      <Group gap="xs" wrap="nowrap" align="flex-start">
        <Tooltip label={MODE_HINT[message.mode]} withArrow multiline w={220}>
          <Badge
            size="xs"
            variant="light"
            color={message.mode === 'steer' ? 'primary' : 'gray'}
            className={classes.mode}
          >
            {MODE_LABEL[message.mode]}
          </Badge>
        </Tooltip>
        {editing ? (
          <Box className={classes.body}>
            <PendingEdit
              message={message}
              mentions={mentions}
              saving={update.isPending}
              onSave={(changes) => update.mutate(changes)}
              onCancel={() => setEditing(false)}
            />
          </Box>
        ) : (
          <>
            <Box className={classes.body}>
              <Text size="sm" lineClamp={2} className={classes.text}>
                {message.text || (files > 0 ? 'Attachments only' : '')}
              </Text>
              {files > 0 ? (
                <Text size="xs" c="dimmed">
                  {files === 1 ? '1 attachment' : `${files} attachments`}
                </Text>
              ) : null}
            </Box>
            {editable ? (
              <Group gap={2} wrap="nowrap" className={classes.actions}>
                <Tooltip label="Edit" withArrow>
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    size={26}
                    radius="md"
                    aria-label="Edit message"
                    disabled={working}
                    onClick={() => setEditing(true)}
                  >
                    <IconPencil size={15} stroke={1.7} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label="Stop the current reply and send now" withArrow>
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    size={26}
                    radius="md"
                    aria-label="Send now"
                    loading={sendNow.isPending}
                    disabled={working}
                    onClick={() => sendNow.mutate()}
                  >
                    <IconSend size={15} stroke={1.7} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label="Cancel" withArrow>
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    size={26}
                    radius="md"
                    aria-label="Cancel message"
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
                  Sending…
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
  workflows,
  onResult,
}: {
  sessionId: string;
  pending: SessionPendingMessages;
  apps?: AppListItem[];
  workflows?: WorkflowListItem[];
  onResult: (result: PendingMessagesResult) => void;
}) {
  const resume = useMutation({
    mutationFn: () => resumePendingMessages(sessionId),
    onSuccess: onResult,
    onError: (error) =>
      toast.error(errorText(error, 'Could not resume the messages.')),
  });
  if (pending.messages.length === 0) return null;
  return (
    <Box
      component="section"
      className={classes.tray}
      aria-label="Pending messages"
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
            <Text size="xs">
              Paused after the last reply stopped. These messages wait until you
              resume.
            </Text>
          </Group>
          <Button
            size="compact-xs"
            variant="light"
            style={{ flex: 'none' }}
            loading={resume.isPending}
            onClick={() => resume.mutate()}
          >
            Resume
          </Button>
        </Group>
      ) : null}
      {pending.messages.map((message) => (
        <PendingRow
          key={message.id}
          sessionId={sessionId}
          message={message}
          mentions={{ apps, workflows }}
          onResult={onResult}
        />
      ))}
    </Box>
  );
}
