import {
  Button,
  Checkbox,
  Group,
  Paper,
  Radio,
  Stack,
  Text,
  TextInput,
  Textarea,
  Tooltip,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { useState } from 'react';
import {
  ReplyAnswerError,
  describeAnswers,
  validateAnswers,
  type ReplyAnswers,
  type ReplyField,
  type ReplyForm,
} from '../../../packages/hatch-platform-api/notification-reply';
import { formatExact, formatRelative } from '~lib/format';
import {
  respondToNotificationFn,
  type NotificationResponseView,
} from '~server/notifications';
import { useNotificationMutation } from './use-notification-mutation';

const VIA_LABEL: Record<NotificationResponseView['via'], string> = {
  push: 'from the phone notification',
  mobile: 'in the phone app',
  web: 'on the web',
  cli: 'from the CLI',
};

/**
 * The notification's reply form: answer it here, or see who answered and
 * what. A notification takes one answer, from whoever answers first.
 */
export function ReplySection({
  notificationId,
  reply,
  response,
  recalledAt,
}: {
  notificationId: string;
  reply: ReplyForm;
  response: NotificationResponseView | null;
  recalledAt: string | null;
}) {
  if (response) return <AnswerSummary reply={reply} response={response} />;
  if (recalledAt) {
    return (
      <Text size="sm" c="dimmed">
        Recalled before anyone answered, so it no longer takes an answer.
      </Text>
    );
  }
  return <ReplyFormView notificationId={notificationId} reply={reply} />;
}

function AnswerSummary({
  reply,
  response,
}: {
  reply: ReplyForm;
  response: NotificationResponseView;
}) {
  const lines = describeAnswers(reply, response.answers);
  return (
    <Paper withBorder radius="md" p="md">
      <Text size="sm" mb="sm">
        Answered by <b>{response.respondedBy.name}</b> {VIA_LABEL[response.via]}{' '}
        ·{' '}
        <Tooltip label={formatExact(response.respondedAt)} withArrow>
          <Text span size="sm" c="dimmed">
            {formatRelative(response.respondedAt)}
          </Text>
        </Tooltip>
      </Text>
      <Stack gap={6}>
        {reply.fields.map((field) => {
          const line = lines.find((entry) => entry.fieldId === field.id);
          return (
            <Group key={field.id} gap="md" wrap="nowrap" align="baseline">
              <Text size="sm" c="dimmed" style={{ width: 160, flex: 'none' }}>
                {field.label}
              </Text>
              <Text
                size="sm"
                c={line ? undefined : 'dimmed'}
                style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
              >
                {line?.value ?? 'No answer'}
              </Text>
            </Group>
          );
        })}
      </Stack>
    </Paper>
  );
}

function ReplyFormView({
  notificationId,
  reply,
}: {
  notificationId: string;
  reply: ReplyForm;
}) {
  const [answers, setAnswers] = useState<ReplyAnswers>({});
  const [error, setError] = useState<{
    field: string | null;
    message: string;
  } | null>(null);
  const respond = useNotificationMutation(
    (input: ReplyAnswers) =>
      respondToNotificationFn({ data: { id: notificationId, answers: input } }),
    { success: 'Answer sent' },
  );
  // One required buttons field answers with a single click, like on the phone.
  const [only] = reply.fields;
  const instant =
    reply.fields.length === 1 && only?.type === 'buttons' && only.required;

  const submit = (input: ReplyAnswers) => {
    try {
      const checked = validateAnswers(reply, input);
      setError(null);
      respond.mutate(checked);
    } catch (caught) {
      if (!(caught instanceof ReplyAnswerError)) throw caught;
      // Shown under its field, so the reason alone reads best.
      const reason = caught.field
        ? caught.message.slice(`answers.${caught.field}: `.length)
        : caught.message;
      setError({
        field: caught.field,
        message:
          reason === 'is required'
            ? 'Answer this question.'
            : `${reason[0]?.toUpperCase() ?? ''}${reason.slice(1)}.`,
      });
    }
  };

  const set = (fieldId: string, value: string | string[] | undefined) => {
    setAnswers((current) => {
      const next = { ...current };
      if (value === undefined || value === '' || value.length === 0) {
        delete next[fieldId];
      } else {
        next[fieldId] = value;
      }
      return next;
    });
  };

  return (
    <Stack
      gap="md"
      component="form"
      onSubmit={(event) => {
        event.preventDefault();
        submit(answers);
      }}
    >
      {reply.fields.map((field) => (
        <FieldInput
          key={field.id}
          field={field}
          value={answers[field.id]}
          error={error?.field === field.id ? error.message : undefined}
          disabled={respond.isPending}
          onChange={(value) => set(field.id, value)}
          onPick={
            instant
              ? (optionId) =>
                  modals.openConfirmModal({
                    title: field.label,
                    children: (
                      <Text size="sm">
                        Answer “
                        {field.type === 'buttons'
                          ? field.options.find((o) => o.id === optionId)?.label
                          : optionId}
                        ”? A notification takes one answer, and it cannot be
                        changed.
                      </Text>
                    ),
                    labels: { confirm: 'Send answer', cancel: 'Cancel' },
                    onConfirm: () => submit({ [field.id]: optionId }),
                  })
              : undefined
          }
        />
      ))}
      {error && error.field === null ? (
        <Text size="sm" c="red.8">
          {error.message}
        </Text>
      ) : null}
      {instant ? null : (
        <Group>
          <Button type="submit" loading={respond.isPending}>
            {reply.submitLabel}
          </Button>
          <Text size="xs" c="dimmed">
            One answer is accepted, and it cannot be changed.
          </Text>
        </Group>
      )}
    </Stack>
  );
}

function FieldInput({
  field,
  value,
  error,
  disabled,
  onChange,
  onPick,
}: {
  field: ReplyField;
  value: string | string[] | undefined;
  error: string | undefined;
  disabled: boolean;
  onChange: (value: string | string[] | undefined) => void;
  /** Set when choosing a button submits the form at once. */
  onPick?: (optionId: string) => void;
}) {
  const label = field.label;
  const description = field.description;
  const required = field.required;

  if (field.type === 'text') {
    const common = {
      label,
      description,
      required,
      error,
      disabled,
      placeholder: field.placeholder,
      maxLength: field.maxLength,
      value: typeof value === 'string' ? value : '',
      onChange: (event: { currentTarget: { value: string } }) =>
        onChange(event.currentTarget.value),
    };
    return field.multiline ? (
      <Textarea {...common} autosize minRows={3} maxRows={10} />
    ) : (
      <TextInput {...common} />
    );
  }

  if (field.type === 'multiple') {
    const range =
      field.minSelected === field.maxSelected
        ? `Choose ${field.minSelected}`
        : `Choose ${field.minSelected}–${field.maxSelected}`;
    return (
      <Checkbox.Group
        label={label}
        description={[description, range].filter(Boolean).join(' · ')}
        withAsterisk={required}
        error={error}
        value={Array.isArray(value) ? value : []}
        onChange={onChange}
      >
        <Stack gap={8} mt={6}>
          {field.options.map((option) => (
            <Checkbox
              key={option.id}
              value={option.id}
              label={option.label}
              disabled={disabled}
            />
          ))}
        </Stack>
      </Checkbox.Group>
    );
  }

  if (field.type === 'single') {
    return (
      <Radio.Group
        label={label}
        description={description}
        withAsterisk={required}
        error={error}
        value={typeof value === 'string' ? value : null}
        onChange={onChange}
      >
        <Stack gap={8} mt={6}>
          {field.options.map((option) => (
            <Radio
              key={option.id}
              value={option.id}
              label={option.label}
              disabled={disabled}
            />
          ))}
        </Stack>
      </Radio.Group>
    );
  }

  return (
    <Stack gap={6}>
      <Text size="sm" fw={500}>
        {label}
        {required && !onPick ? (
          <Text span c="red.7">
            {' '}
            *
          </Text>
        ) : null}
      </Text>
      {description ? (
        <Text size="xs" c="dimmed">
          {description}
        </Text>
      ) : null}
      <Group gap="xs">
        {field.options.map((option) => {
          const selected = value === option.id;
          return (
            <Button
              key={option.id}
              type="button"
              color={option.destructive ? 'red' : undefined}
              variant={
                selected ? 'filled' : option.destructive ? 'light' : 'default'
              }
              disabled={disabled}
              aria-pressed={onPick ? undefined : selected}
              onClick={() =>
                onPick
                  ? onPick(option.id)
                  : onChange(selected ? undefined : option.id)
              }
            >
              {option.label}
            </Button>
          );
        })}
      </Group>
      {error ? (
        <Text size="xs" c="red.8">
          {error}
        </Text>
      ) : null}
    </Stack>
  );
}
