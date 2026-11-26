import {
  ReplyAnswerError,
  answerOf,
  defaultAnswers,
  describeAnswers,
  submitsWithButtons,
  validateAnswers,
  type ReplyAnswers,
  type ReplyField,
  type ReplyForm,
} from '@hatch/platform-api';
import { useRef, useState } from 'react';
import { Alert, View } from 'react-native';
import type { NotificationAnswer } from '../core';
import { OptionRow } from './ask-card';
import { Button } from './button';
import type { GlyphName } from './glyph.types';
import { NativeField, type NativeFieldRef } from './native-field';
import { notificationTime } from './notification-status';
import { Card, Tag } from './primitives';
import { Text, type } from './text';
import { palette as c, radii, status, weights } from './theme';

const viaLabels: Record<string, string> = {
  push: 'from the notification',
  mobile: 'in the app',
  web: 'on the web',
  cli: 'from the CLI',
};

/** Who answered the notification's reply form, and what. */
export function AnswerCard({
  reply,
  answer,
}: {
  reply: ReplyForm;
  answer: NotificationAnswer;
}) {
  const lines = describeAnswers(reply, answer.answers);
  return (
    <Card style={{ gap: 12 }}>
      <Tag tone="success" glyph="check" label="Answered" />
      <Text style={type.small}>
        {answer.respondedByName} answered {viaLabels[answer.via] ?? ''} on{' '}
        {notificationTime(answer.respondedAt)}.
      </Text>
      {reply.fields.map((field) => {
        const line = lines.find((entry) => entry.fieldId === field.id);
        return (
          <View key={field.id} style={{ gap: 2 }}>
            {field.label ? <Text style={type.small}>{field.label}</Text> : null}
            <Text selectable style={type.body}>
              {line?.value ?? 'No answer'}
            </Text>
          </View>
        );
      })}
    </Card>
  );
}

/**
 * The platform's own "✓ who answered what" line. It is drawn in the same
 * place under every notification, outside what the sender wrote, so a card
 * cannot imitate it.
 */
export function AnswerLine({
  reply,
  answer,
}: {
  reply: ReplyForm;
  answer: NotificationAnswer;
}) {
  const what = describeAnswers(reply, answer.answers)
    .map((line) => line.value)
    .join(' · ');
  return (
    <Text
      style={[
        type.small,
        { fontWeight: weights.strong, color: status.success.ink },
      ]}
    >
      ✓ {answer.respondedByName} answered
      {what ? ` “${what}”` : ''} {viaLabels[answer.via] ?? ''}
    </Text>
  );
}

/** A form being filled in, shared by the form card and inline card inputs. */
export type ReplyFormState = {
  reply: ReplyForm;
  answers: ReplyAnswers;
  busy: boolean;
  error: { field: string | null; text: string } | undefined;
  set: (fieldId: string, value: string | string[] | undefined) => void;
  /** Binds a text field's native snapshot, read when the form is sent. */
  register: (fieldId: string) => (ref: NativeFieldRef | null) => void;
  /** The submit button. */
  submit: () => void;
  /** A button of a buttons field: chooses it, or sends the form with it. */
  press: (field: ReplyField, optionId: string) => void;
  /** Whether this buttons field sends the form, in place of a submit button. */
  sends: (field: ReplyField) => boolean;
};

/**
 * The answers to a reply form, starting from its defaults. A notification
 * takes one answer per round, from whoever answers first, and it cannot be
 * changed, so a button that sends the form asks first.
 */
export function useReplyForm(
  reply: ReplyForm,
  options: { busy: boolean; onSubmit: (answers: ReplyAnswers) => void },
): ReplyFormState {
  const [answers, setAnswers] = useState<ReplyAnswers>(() =>
    defaultAnswers(reply),
  );
  const [error, setError] = useState<ReplyFormState['error']>();
  const fields = useRef<Record<string, NativeFieldRef | null>>({});
  const last = reply.fields.at(-1);
  const sends = (field: ReplyField) =>
    field === last && submitsWithButtons(reply);

  const set: ReplyFormState['set'] = (fieldId, value) =>
    setAnswers((current) => {
      const next = { ...current };
      if (value === undefined || value.length === 0) delete next[fieldId];
      else next[fieldId] = value;
      return next;
    });

  // Native text fields can run ahead of their change events.
  const latest = () => {
    const input = { ...answers };
    for (const field of reply.fields) {
      // Only text fields have refs; ids like `constructor` must not resolve
      // through the prototype.
      if (field.type !== 'text') continue;
      const text = answerOf(fields.current, field.id)?.getText();
      if (text !== undefined) {
        if (text) input[field.id] = text;
        else delete input[field.id];
      }
    }
    return input;
  };

  const check = (input: ReplyAnswers): ReplyAnswers | null => {
    try {
      const checked = validateAnswers(reply, input);
      setError(undefined);
      return checked;
    } catch (caught) {
      if (!(caught instanceof ReplyAnswerError)) throw caught;
      const reason = caught.field
        ? caught.message.slice(`answers.${caught.field}: `.length)
        : caught.message;
      setError({
        field: caught.field,
        text:
          reason === 'is required'
            ? 'Answer this question.'
            : `${reason[0]?.toUpperCase() ?? ''}${reason.slice(1)}.`,
      });
      return null;
    }
  };

  return {
    reply,
    answers,
    busy: options.busy,
    error,
    set,
    register: (fieldId) => (ref) => {
      fields.current[fieldId] = ref;
    },
    submit: () => {
      const checked = check(latest());
      if (checked) options.onSubmit(checked);
    },
    press: (field, optionId) => {
      if (!sends(field)) {
        set(
          field.id,
          answerOf(answers, field.id) === optionId ? undefined : optionId,
        );
        return;
      }
      const checked = check({ ...latest(), [field.id]: optionId });
      if (!checked) return;
      const label =
        field.type === 'buttons'
          ? (field.options.find((option) => option.id === optionId)?.label ??
            optionId)
          : optionId;
      Alert.alert(
        field.label || 'Send answer?',
        `Answer “${label}”? It cannot be changed.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Send answer', onPress: () => options.onSubmit(checked) },
        ],
      );
    },
    sends,
  };
}

export type StackedButton = {
  key: string;
  label: string;
  variant: 'primary' | 'secondary' | 'danger' | 'muted';
  onPress: () => void;
  disabled?: boolean;
  /** Read-only and not dimmed: an answer already given. */
  readOnly?: boolean;
  selected?: boolean;
  glyph?: GlyphName;
  trailingGlyph?: GlyphName;
};

/**
 * Buttons on the phone: one full-width button per line, at least 44 points,
 * in the order given (the caller puts the main action first and links last).
 */
export function ButtonStack({ buttons }: { buttons: StackedButton[] }) {
  return (
    <View style={{ gap: 8, alignSelf: 'stretch' }}>
      {buttons.map((button) => (
        <Button
          key={button.key}
          fullWidth
          label={button.label}
          variant={button.variant}
          glyph={button.glyph}
          trailingGlyph={button.trailingGlyph}
          selected={button.selected}
          disabled={button.disabled}
          readOnly={button.readOnly}
          onPress={button.onPress}
        />
      ))}
    </View>
  );
}

/**
 * The buttons of a buttons field, main action first. Live, a tap chooses or
 * sends; answered, the chosen one stays marked and the others are put away.
 */
export function answerButtons(
  field: ReplyField,
  form: ReplyFormState | null,
  chosen: ReplyAnswers | null,
): StackedButton[] {
  if (field.type !== 'buttons') return [];
  const picked = form
    ? answerOf(form.answers, field.id)
    : chosen
      ? answerOf(chosen, field.id)
      : undefined;
  const sends = form?.sends(field) ?? false;
  return [...field.options]
    .sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)))
    .map((option) => {
      const selected = !sends && picked === option.id;
      return {
        key: option.id,
        label: option.label,
        variant:
          selected || (option.primary && picked === undefined)
            ? 'primary'
            : option.destructive
              ? 'danger'
              : 'secondary',
        glyph: selected ? 'check' : undefined,
        selected: form ? selected : picked === option.id,
        disabled: form ? form.busy : picked !== option.id,
        readOnly: !form && picked === option.id,
        onPress: () => form?.press(field, option.id),
      };
    });
}

/**
 * One question of a reply form: its label, help and control, live when
 * `form` is given, otherwise read-only showing `chosen`.
 */
export function ReplyFieldInput({
  field,
  form,
  chosen,
  buttons = true,
  markOptional = true,
}: {
  field: ReplyField;
  form: ReplyFormState | null;
  chosen: ReplyAnswers | null;
  /** Draw a buttons field's buttons; off when a stack around it does. */
  buttons?: boolean;
  /**
   * Add "(optional)" to an optional question's label. Off inside a card,
   * whose sender wrote the label as it should read.
   */
  markOptional?: boolean;
}) {
  const answers = form?.answers ?? chosen ?? {};
  const current = answerOf(answers, field.id);
  const unavailable = !form || form.busy;
  const sends = form?.sends(field) ?? false;
  return (
    <View style={{ gap: 10 }}>
      {field.label ? (
        <Text accessibilityRole="header" style={type.heading}>
          {field.label}
          {field.required || sends || !markOptional ? '' : ' (optional)'}
        </Text>
      ) : null}
      {field.description ? (
        <Text style={type.small}>{field.description}</Text>
      ) : null}
      {field.type === 'text' ? (
        form ? (
          <NativeField
            ref={form.register(field.id)}
            label={field.label || 'Answer'}
            placeholder={field.placeholder ?? 'Write your answer…'}
            value={typeof current === 'string' ? current : ''}
            unavailable={form.busy}
            multiline={field.multiline}
            maxLength={field.maxLength}
            onChange={(text) => form.set(field.id, text)}
          />
        ) : (
          <View
            style={{
              minHeight: 44,
              justifyContent: 'center',
              paddingHorizontal: 16,
              paddingVertical: 11,
              borderRadius: radii.md,
              backgroundColor: c.muted,
            }}
          >
            <Text
              selectable
              style={[
                type.body,
                typeof current === 'string' ? null : { color: c.inkSoft },
              ]}
            >
              {typeof current === 'string' ? current : 'No answer'}
            </Text>
          </View>
        )
      ) : field.type === 'buttons' ? (
        buttons ? (
          <ButtonStack buttons={answerButtons(field, form, chosen)} />
        ) : null
      ) : (
        <View
          accessibilityRole={field.type === 'single' ? 'radiogroup' : undefined}
          style={{ gap: 8 }}
        >
          {field.type === 'multiple' && form ? (
            <Text style={type.small}>
              {field.minSelected === field.maxSelected
                ? `Choose ${field.minSelected}`
                : `Choose ${field.minSelected}–${field.maxSelected}`}
            </Text>
          ) : null}
          {field.options.map((option) => {
            const selected = Array.isArray(current)
              ? current.includes(option.id)
              : current === option.id;
            return (
              <OptionRow
                key={option.id}
                label={option.label}
                note={option.note}
                badge={option.badge}
                multiple={field.type === 'multiple'}
                selected={selected}
                disabled={unavailable}
                readOnly={!form}
                onPress={() => {
                  if (!form) return;
                  if (field.type === 'single') {
                    // Tapping the chosen option of an optional question
                    // leaves it unanswered again.
                    form.set(
                      field.id,
                      selected && !field.required ? undefined : option.id,
                    );
                    return;
                  }
                  const list = Array.isArray(current) ? current : [];
                  form.set(
                    field.id,
                    selected
                      ? list.filter((id) => id !== option.id)
                      : [...list, option.id],
                  );
                }}
              />
            );
          })}
        </View>
      )}
      {form?.error?.field === field.id ? (
        <Text style={[type.small, { color: c.danger }]}>{form.error.text}</Text>
      ) : null}
    </View>
  );
}

/** A form error that names no field. */
export function FormError({ form }: { form: ReplyFormState | null }) {
  return form?.error && form.error.field === null ? (
    <Text style={[type.small, { color: c.danger }]}>{form.error.text}</Text>
  ) : null;
}

/** The submit button, when the form has one. */
export function SubmitButton({
  form,
  label,
}: {
  form: ReplyFormState;
  label: string;
}) {
  return (
    <Button
      fullWidth
      glyph="send"
      label={form.busy ? 'Sending answer…' : label}
      busy={form.busy}
      onPress={form.submit}
    />
  );
}

/**
 * The notification's reply form, below its content in every format. A
 * trailing required buttons field sends the form in place of a submit
 * button.
 */
export function ReplyFormCard({
  reply,
  busy,
  onSubmit,
}: {
  reply: ReplyForm;
  busy: boolean;
  onSubmit: (answers: ReplyAnswers) => void;
}) {
  const form = useReplyForm(reply, { busy, onSubmit });
  return (
    <Card style={{ gap: 16 }}>
      <Tag tone="accent" glyph="question" label="Asks for an answer" />
      {reply.fields.map((field) => (
        <ReplyFieldInput
          key={field.id}
          field={field}
          form={form}
          chosen={null}
        />
      ))}
      <FormError form={form} />
      {submitsWithButtons(reply) ? null : (
        <SubmitButton form={form} label={reply.submitLabel} />
      )}
    </Card>
  );
}
