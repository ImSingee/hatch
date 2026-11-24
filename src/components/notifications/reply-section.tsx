import {
  Anchor,
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
import { Trans } from 'react-i18next';
import {
  ReplyAnswerError,
  answerOf,
  describeAnswers,
  validateAnswers,
  type ReplyAnswers,
  type ReplyField,
  type ReplyForm,
} from '../../../packages/hatch-platform-api/notification-reply';
import { useI18n, type PlainTranslationKey } from '~i18n';
import { formatExact, formatRelativeTime } from '~lib/format';
import {
  respondToNotificationFn,
  type NotificationResponseView,
} from '~server/notifications';
import { useNotificationMutation } from './use-notification-mutation';

/** "Answered by <name/> … · <time/>", one sentence per channel. */
const ANSWERED_BY = {
  push: 'notifications.reply.answeredBy.push',
  mobile: 'notifications.reply.answeredBy.mobile',
  web: 'notifications.reply.answeredBy.web',
  cli: 'notifications.reply.answeredBy.cli',
} as const satisfies Record<
  NotificationResponseView['via'],
  PlainTranslationKey
>;

/**
 * Why an answer was rejected, worked out from the form and the submitted
 * value, so the message can be translated and shown under its field.
 */
type AnswerProblem =
  | { type: 'required' }
  | { type: 'tooLong'; max: number }
  | { type: 'selectExactly'; count: number }
  | { type: 'selectRange'; min: number; max: number }
  | { type: 'invalid' };

function answerProblem(
  reply: ReplyForm,
  fieldId: string | null,
  answers: ReplyAnswers,
): AnswerProblem {
  const field = reply.fields.find((entry) => entry.id === fieldId);
  if (!field) return { type: 'invalid' };
  const value = answerOf(answers, field.id);
  if (field.type === 'text') {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return { type: 'required' };
    if (Array.from(text).length > field.maxLength) {
      return { type: 'tooLong', max: field.maxLength };
    }
    return { type: 'invalid' };
  }
  if (field.type === 'multiple') {
    const ids = Array.isArray(value) ? value : value ? [value] : [];
    if (ids.length === 0) return { type: 'required' };
    if (ids.length < field.minSelected || ids.length > field.maxSelected) {
      return field.minSelected === field.maxSelected
        ? { type: 'selectExactly', count: field.minSelected }
        : {
            type: 'selectRange',
            min: field.minSelected,
            max: field.maxSelected,
          };
    }
    return { type: 'invalid' };
  }
  if (value === undefined || value === '') return { type: 'required' };
  return { type: 'invalid' };
}

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
  const { t } = useI18n();
  if (response) return <AnswerSummary reply={reply} response={response} />;
  if (recalledAt) {
    return (
      <Text size="sm" c="dimmed">
        {t('notifications.reply.recalled')}
      </Text>
    );
  }
  // Keyed so a draft never carries over to another notification.
  return (
    <ReplyFormView
      key={notificationId}
      notificationId={notificationId}
      reply={reply}
    />
  );
}

function AnswerSummary({
  reply,
  response,
}: {
  reply: ReplyForm;
  response: NotificationResponseView;
}) {
  const { t, locale } = useI18n();
  const lines = describeAnswers(reply, response.answers);
  return (
    <Paper withBorder radius="md" p="md">
      <Text size="sm" mb="sm">
        <Trans
          t={t}
          i18nKey={ANSWERED_BY[response.via]}
          components={{
            name: <b>{response.respondedBy.name}</b>,
            time: (
              <Tooltip label={formatExact(response.respondedAt)} withArrow>
                <Text span size="sm" c="dimmed">
                  {formatRelativeTime(response.respondedAt, locale)}
                </Text>
              </Tooltip>
            ),
          }}
        />
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
                {line?.value ?? t('notifications.reply.noAnswer')}
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
  const { t } = useI18n();
  const [answers, setAnswers] = useState<ReplyAnswers>({});
  const [error, setError] = useState<{
    field: string | null;
    problem: AnswerProblem;
  } | null>(null);
  const respond = useNotificationMutation(
    (input: ReplyAnswers) =>
      respondToNotificationFn({ data: { id: notificationId, answers: input } }),
    { success: t('notifications.reply.sent') },
  );
  const problemText = (problem: AnswerProblem) => {
    switch (problem.type) {
      case 'required':
        return t('notifications.reply.error.required');
      case 'tooLong':
        return t('notifications.reply.error.tooLong', { max: problem.max });
      case 'selectExactly':
        return t('notifications.reply.error.selectExactly', {
          count: problem.count,
        });
      case 'selectRange':
        return t('notifications.reply.error.selectRange', {
          min: problem.min,
          max: problem.max,
        });
      case 'invalid':
        return t('notifications.reply.error.invalid');
    }
  };
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
      setError({
        field: caught.field,
        problem: answerProblem(reply, caught.field, input),
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
          value={answerOf(answers, field.id)}
          error={
            error?.field === field.id ? problemText(error.problem) : undefined
          }
          disabled={respond.isPending}
          onChange={(value) => set(field.id, value)}
          onPick={
            instant
              ? (optionId) =>
                  modals.openConfirmModal({
                    title: field.label,
                    children: (
                      <Text size="sm">
                        {t('notifications.reply.confirmAnswer', {
                          answer:
                            field.type === 'buttons'
                              ? (field.options.find((o) => o.id === optionId)
                                  ?.label ?? '')
                              : optionId,
                        })}
                      </Text>
                    ),
                    labels: {
                      confirm: t('notifications.reply.send'),
                      cancel: t('common.cancel'),
                    },
                    onConfirm: () => submit({ [field.id]: optionId }),
                  })
              : undefined
          }
        />
      ))}
      {error && error.field === null ? (
        <Text size="sm" c="red.8">
          {problemText(error.problem)}
        </Text>
      ) : null}
      {instant ? null : (
        <Group>
          <Button type="submit" loading={respond.isPending}>
            {reply.submitLabel}
          </Button>
          <Text size="xs" c="dimmed">
            {t('notifications.reply.oneAnswer')}
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
  const { t } = useI18n();
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
        ? t('notifications.reply.chooseExactly', { number: field.minSelected })
        : t('notifications.reply.chooseRange', {
            min: field.minSelected,
            max: field.maxSelected,
          });
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
          {!required && typeof value === 'string' ? (
            <Anchor
              component="button"
              type="button"
              size="xs"
              c="dimmed"
              w="fit-content"
              disabled={disabled}
              onClick={() => onChange(undefined)}
            >
              {t('notifications.reply.clear')}
            </Anchor>
          ) : null}
        </Stack>
      </Radio.Group>
    );
  }

  return (
    <Stack gap={6}>
      <Text size="sm" fw={600}>
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
