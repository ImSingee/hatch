import {
  Anchor,
  Badge,
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
  defaultAnswers,
  describeAnswers,
  optionName,
  submitsWithButtons,
  validateAnswers,
  type ReplyAnswers,
  type ReplyField,
  type ReplyForm,
  type ReplyOption,
} from '../../../packages/hatch-platform-api/notification-reply';
import { translateError, useI18n, type PlainTranslationKey } from '~i18n';
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
  /** `message`: the validator's own reason, shown as-is in English. */
  | { type: 'invalid'; message?: string };

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
 * what. Each round of the form takes one answer, from whoever answers first.
 */
export function ReplySection({
  notificationId,
  reply,
  round,
  response,
  recalledAt,
}: {
  notificationId: string;
  reply: ReplyForm;
  /** The round of `reply`, sent with the answer. */
  round: number;
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
  // Keyed so a draft never carries over to another notification or to a
  // new question on this one.
  return (
    <ReplyFormView
      key={`${notificationId}:${round}`}
      notificationId={notificationId}
      reply={reply}
      round={round}
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

/** A reply form being filled in, shared by the form below a notification's
 * content and the inputs a card holds inline. */
export type ReplyFormControl = {
  reply: ReplyForm;
  answers: ReplyAnswers;
  pending: boolean;
  set: (fieldId: string, value: string | string[] | undefined) => void;
  /** Check the answers given so far and send them. */
  submit: () => void;
  /**
   * Whether clicking one of this field's buttons sends the form: the
   * trailing required buttons field replaces the submit button.
   */
  submitsWith: (field: ReplyField) => boolean;
  /**
   * A button of a buttons field: toggles it, or, when the field submits the
   * form, confirms and sends every answer with it.
   */
  pick: (field: ReplyField, optionId: string) => void;
  fieldError: (fieldId: string) => string | undefined;
  /** A problem not tied to one field. */
  formError: string | undefined;
};

/**
 * One round of a reply form: answers start at the form's defaults, are
 * checked against it before they go, and are sent once.
 */
export function useReplyForm({
  notificationId,
  reply,
  round,
}: {
  notificationId: string;
  reply: ReplyForm;
  round: number;
}): ReplyFormControl {
  const { t, locale } = useI18n();
  const [answers, setAnswers] = useState<ReplyAnswers>(() =>
    defaultAnswers(reply),
  );
  const [error, setError] = useState<{
    field: string | null;
    problem: AnswerProblem;
  } | null>(null);
  const respond = useNotificationMutation(
    (input: ReplyAnswers) =>
      respondToNotificationFn({
        data: { id: notificationId, round, answers: input },
      }),
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
        return translateError(
          t,
          locale,
          { message: problem.message },
          'notifications.reply.error.invalid',
        );
    }
  };

  /** The answers checked against the form, or null with the problem shown. */
  const check = (input: ReplyAnswers): ReplyAnswers | null => {
    try {
      const checked = validateAnswers(reply, input);
      setError(null);
      return checked;
    } catch (caught) {
      if (!(caught instanceof ReplyAnswerError)) throw caught;
      // Shown under its field, so the reason alone reads best.
      const problem = answerProblem(reply, caught.field, input);
      if (problem.type === 'invalid') {
        const reason = caught.field
          ? caught.message.slice(`answers.${caught.field}: `.length)
          : caught.message;
        problem.message = `${reason[0]?.toUpperCase() ?? ''}${reason.slice(1)}.`;
      }
      setError({ field: caught.field, problem });
      return null;
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

  const submitsWith = (field: ReplyField) =>
    submitsWithButtons(reply) && reply.fields.at(-1)?.id === field.id;

  return {
    reply,
    answers,
    pending: respond.isPending,
    set,
    submit: () => {
      const checked = check(answers);
      if (checked) respond.mutate(checked);
    },
    submitsWith,
    pick: (field, optionId) => {
      if (!submitsWith(field)) {
        set(
          field.id,
          answerOf(answers, field.id) === optionId ? undefined : optionId,
        );
        return;
      }
      const checked = check({ ...answers, [field.id]: optionId });
      if (!checked) return;
      const option =
        field.type === 'text'
          ? undefined
          : field.options.find((entry) => entry.id === optionId);
      modals.openConfirmModal({
        title: field.label || t('notifications.reply.confirmTitle'),
        children: (
          <Text size="sm">
            {t('notifications.reply.confirmAnswer', {
              answer: option?.label ?? optionId,
            })}
          </Text>
        ),
        labels: {
          confirm: t('notifications.reply.send'),
          cancel: t('common.cancel'),
        },
        onConfirm: () => respond.mutate(checked),
      });
    },
    fieldError: (fieldId) =>
      error?.field === fieldId ? problemText(error.problem) : undefined,
    formError:
      error && error.field === null ? problemText(error.problem) : undefined,
  };
}

function ReplyFormView({
  notificationId,
  reply,
  round,
}: {
  notificationId: string;
  reply: ReplyForm;
  round: number;
}) {
  const { t } = useI18n();
  const form = useReplyForm({ notificationId, reply, round });
  return (
    <Stack
      gap="md"
      component="form"
      onSubmit={(event) => {
        event.preventDefault();
        form.submit();
      }}
    >
      {reply.fields.map((field) => (
        <FieldInput
          key={field.id}
          field={field}
          value={answerOf(form.answers, field.id)}
          error={form.fieldError(field.id)}
          disabled={form.pending}
          submits={form.submitsWith(field)}
          onChange={(value) => form.set(field.id, value)}
          onPick={(optionId) => form.pick(field, optionId)}
        />
      ))}
      {form.formError ? (
        <Text size="sm" c="red.8">
          {form.formError}
        </Text>
      ) : null}
      {submitsWithButtons(reply) ? null : (
        <Group>
          <Button type="submit" loading={form.pending}>
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

/** An option's note and badge, beside its label. */
export function OptionExtras({ option }: { option: ReplyOption }) {
  if (!option.note && !option.badge) return null;
  return (
    <Group gap={8} wrap="nowrap" style={{ flex: 'none' }}>
      {option.note ? (
        <Text span size="xs" c="dimmed">
          {option.note}
        </Text>
      ) : null}
      {option.badge ? (
        <Badge size="sm" radius="xl" variant="light" color="gray">
          {option.badge}
        </Badge>
      ) : null}
    </Group>
  );
}

function OptionLabel({ option }: { option: ReplyOption }) {
  return (
    <Group gap="sm" wrap="nowrap" justify="space-between">
      <span>{option.label}</span>
      <OptionExtras option={option} />
    </Group>
  );
}

/**
 * How a reply button is drawn: the primary action filled, a destructive one
 * outlined in red. While its field only toggles (another control sends the
 * form), the chosen button is the filled one and the primary is tinted.
 */
export function buttonVariant(
  option: ReplyOption,
  state: { selected: boolean; submits: boolean },
): 'filled' | 'light' | 'outline' | 'default' {
  if (state.selected) return 'filled';
  if (option.primary) return state.submits ? 'filled' : 'light';
  return option.destructive ? 'outline' : 'default';
}

/** A choice option's label takes the row, so its note sits at the end. */
const OPTION_STYLES = {
  body: { width: '100%' },
  labelWrapper: { flex: 1 },
} as const;

function FieldInput({
  field,
  value,
  error,
  disabled,
  submits,
  onChange,
  onPick,
}: {
  field: ReplyField;
  value: string | string[] | undefined;
  error: string | undefined;
  disabled: boolean;
  /** Choosing a button sends the form. */
  submits: boolean;
  onChange: (value: string | string[] | undefined) => void;
  onPick: (optionId: string) => void;
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
              label={<OptionLabel option={option} />}
              aria-label={optionName(option)}
              disabled={disabled}
              styles={OPTION_STYLES}
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
              label={<OptionLabel option={option} />}
              aria-label={optionName(option)}
              disabled={disabled}
              styles={OPTION_STYLES}
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
      {label ? (
        <Text size="sm" fw={600}>
          {label}
          {required && !submits ? (
            <Text span c="red.7">
              {' '}
              *
            </Text>
          ) : null}
        </Text>
      ) : null}
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
              variant={buttonVariant(option, { selected, submits })}
              disabled={disabled}
              aria-pressed={submits ? undefined : selected}
              onClick={() => onPick(option.id)}
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
