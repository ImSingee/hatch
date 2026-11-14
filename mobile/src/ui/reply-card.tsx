import {
  ReplyAnswerError,
  answerOf,
  describeAnswers,
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
import { NativeField, type NativeFieldRef } from './native-field';
import { notificationTime } from './notification-status';
import { Card, Tag } from './primitives';
import { Text, type } from './text';
import { palette as c } from './theme';

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
      <Tag tone="lime" glyph="check" label="Answered" />
      <Text style={type.small}>
        {answer.respondedByName} answered {viaLabels[answer.via] ?? ''} on{' '}
        {notificationTime(answer.respondedAt)}.
      </Text>
      {reply.fields.map((field) => {
        const line = lines.find((entry) => entry.fieldId === field.id);
        return (
          <View key={field.id} style={{ gap: 2 }}>
            <Text style={type.meta}>{field.label}</Text>
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
 * The notification's reply form. A notification takes one answer, from
 * whoever answers first, and it cannot be changed, so a single tap on a
 * buttons form asks first.
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
  const [answers, setAnswers] = useState<ReplyAnswers>({});
  const [error, setError] = useState<{ field: string | null; text: string }>();
  const fields = useRef<Record<string, NativeFieldRef | null>>({});
  const [only] = reply.fields;
  const instant =
    reply.fields.length === 1 && only?.type === 'buttons' && only.required;

  const set = (fieldId: string, value: string | string[] | undefined) =>
    setAnswers((current) => {
      const next = { ...current };
      if (value === undefined || value.length === 0) delete next[fieldId];
      else next[fieldId] = value;
      return next;
    });

  const submit = (input: ReplyAnswers) => {
    try {
      const checked = validateAnswers(reply, input);
      setError(undefined);
      onSubmit(checked);
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
    }
  };

  const confirm = (field: ReplyField, optionId: string) => {
    const label =
      field.type === 'buttons'
        ? field.options.find((option) => option.id === optionId)?.label
        : optionId;
    Alert.alert(field.label, `Answer “${label}”? It cannot be changed.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Send answer',
        onPress: () => submit({ [field.id]: optionId }),
      },
    ]);
  };

  return (
    <Card style={{ borderWidth: 2, borderColor: c.lime, gap: 16 }}>
      <Tag tone="lime" glyph="question" label="Asks for an answer" />
      {reply.fields.map((field) => (
        <View key={field.id} style={{ gap: 10 }}>
          <Text accessibilityRole="header" style={type.heading}>
            {field.label}
            {field.required || instant ? '' : ' (optional)'}
          </Text>
          {field.description ? (
            <Text style={type.small}>{field.description}</Text>
          ) : null}
          {field.type === 'text' ? (
            <NativeField
              ref={(ref) => {
                fields.current[field.id] = ref;
              }}
              label={field.label}
              placeholder={field.placeholder ?? 'Write your answer…'}
              value={
                typeof answerOf(answers, field.id) === 'string'
                  ? String(answerOf(answers, field.id))
                  : ''
              }
              unavailable={busy}
              multiline={field.multiline}
              maxLength={field.maxLength}
              onChange={(text) => set(field.id, text)}
            />
          ) : field.type === 'buttons' ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {field.options.map((option) => {
                const selected = answerOf(answers, field.id) === option.id;
                return (
                  <Button
                    key={option.id}
                    label={option.label}
                    variant={
                      selected
                        ? 'primary'
                        : option.destructive
                          ? 'danger'
                          : 'secondary'
                    }
                    disabled={busy}
                    onPress={() =>
                      instant
                        ? confirm(field, option.id)
                        : set(field.id, selected ? undefined : option.id)
                    }
                  />
                );
              })}
            </View>
          ) : (
            <View
              accessibilityRole={
                field.type === 'single' ? 'radiogroup' : undefined
              }
              style={{ gap: 8 }}
            >
              {field.type === 'multiple' ? (
                <Text style={type.meta}>
                  {field.minSelected === field.maxSelected
                    ? `Choose ${field.minSelected}`
                    : `Choose ${field.minSelected}–${field.maxSelected}`}
                </Text>
              ) : null}
              {field.options.map((option) => {
                const current = answerOf(answers, field.id);
                const selected = Array.isArray(current)
                  ? current.includes(option.id)
                  : current === option.id;
                return (
                  <OptionRow
                    key={option.id}
                    label={option.label}
                    multiple={field.type === 'multiple'}
                    selected={selected}
                    disabled={busy}
                    onPress={() => {
                      if (field.type === 'single') {
                        set(field.id, option.id);
                        return;
                      }
                      const list = Array.isArray(current) ? current : [];
                      set(
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
          {error?.field === field.id ? (
            <Text style={[type.small, { color: c.danger }]}>{error.text}</Text>
          ) : null}
        </View>
      ))}
      {error && error.field === null ? (
        <Text style={[type.small, { color: c.danger }]}>{error.text}</Text>
      ) : null}
      {instant ? null : (
        <Button
          fullWidth
          glyph="send"
          label={busy ? 'Sending answer…' : reply.submitLabel}
          busy={busy}
          onPress={() => {
            // Native text fields can run ahead of their change events.
            const latest = { ...answers };
            for (const field of reply.fields) {
              // Only text fields have refs; ids like `constructor` must not
              // resolve through the prototype.
              if (field.type !== 'text') continue;
              const text = answerOf(fields.current, field.id)?.getText();
              if (text !== undefined) {
                if (text) latest[field.id] = text;
                else delete latest[field.id];
              }
            }
            submit(latest);
          }}
        />
      )}
    </Card>
  );
}
