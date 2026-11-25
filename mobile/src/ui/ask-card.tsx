import { NativeField, type NativeFieldRef } from './native-field';
import { useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import type { AskAnswer, PendingAsk } from '../core';
import { updateAskAnswer } from '../core/ask-answer';
import { Button } from './button';
import { Glyph } from './glyph';
import { Card, Tag } from './primitives';
import { Text, type } from './text';
import { useAccent } from './accent';
import { palette as c, pill, radii } from './theme';

export function OptionRow({
  label,
  multiple,
  selected,
  disabled,
  onPress,
  note,
  badge,
  readOnly,
}: {
  label: string;
  multiple: boolean;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
  /** Shown at the end, such as "about 1 minute". */
  note?: string;
  /** A small tag, such as "breaking". */
  badge?: string;
  /** Cannot be changed, but not dimmed: an answer already given. */
  readOnly?: boolean;
}) {
  const accent = useAccent();
  return (
    <Pressable
      accessibilityRole={multiple ? 'checkbox' : 'radio'}
      accessibilityState={{ checked: selected, disabled: disabled || readOnly }}
      disabled={disabled || readOnly}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 48,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: selected ? accent.fill : c.input,
        backgroundColor: selected ? accent.tint : pressed ? c.muted : c.card,
        opacity: disabled && !readOnly ? 0.5 : 1,
      })}
    >
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: multiple ? radii.xs : pill,
          borderWidth: selected ? 0 : 1.5,
          borderColor: c.outline,
          backgroundColor: selected ? accent.fill : 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {selected ? (
          multiple ? (
            <Glyph name="check" size={12} color={accent.onFill} />
          ) : (
            <View
              style={{
                width: 8,
                height: 8,
                borderRadius: pill,
                backgroundColor: accent.onFill,
              }}
            />
          )
        ) : null}
      </View>
      <Text style={[type.body, { flex: 1 }]}>{label}</Text>
      {note ? (
        <Text style={[type.caption, { flexShrink: 1 }]}>{note}</Text>
      ) : null}
      {badge ? <Tag label={badge} tone="quiet" /> : null}
    </Pressable>
  );
}

export function AskCard({
  ask,
  onAnswer,
  busy,
  saved,
  onDraft,
}: {
  ask: PendingAsk;
  onAnswer: (answers: AskAnswer[]) => void;
  busy: boolean;
  /** Answers kept from an earlier screen of this conversation. */
  saved: Record<string, AskAnswer>;
  /** Keeps every change for the conversation's next screen. */
  onDraft: (answers: Record<string, AskAnswer>) => void;
}) {
  // Local and synchronous, so the native answer field never gets a delayed
  // echo of its own text; read from the conversation once and written back
  // with every change (also a field's last keystrokes as it unmounts).
  const [answers, setLocalAnswers] = useState(saved);
  const latest = useRef(saved);
  const setAnswers = (
    update: (value: Record<string, AskAnswer>) => Record<string, AskAnswer>,
  ) => {
    latest.current = update(latest.current);
    setLocalAnswers(latest.current);
    onDraft(latest.current);
  };
  const fields = useRef<Record<string, NativeFieldRef | null>>({});
  const get = (id: string): AskAnswer =>
    answers[id] ?? { questionId: id, selectedOptionIds: [], customText: '' };
  return (
    <Card style={{ gap: 16 }}>
      <Tag tone="accent" glyph="question" label="Your Agent asks" />
      {ask.questions.map((question) => (
        <View key={question.id} style={{ gap: 10 }}>
          <Text accessibilityRole="header" style={type.heading}>
            {question.prompt}
          </Text>
          {question.allowMultiple ? (
            <Text style={type.small}>Choose any that apply</Text>
          ) : null}
          <View
            accessibilityRole={
              question.allowMultiple ? undefined : 'radiogroup'
            }
            style={{ gap: 8 }}
          >
            {question.options.map((option) => {
              const selected = get(question.id).selectedOptionIds.includes(
                option.id,
              );
              return (
                <OptionRow
                  key={option.id}
                  label={option.label}
                  multiple={question.allowMultiple}
                  selected={selected}
                  disabled={busy}
                  onPress={() => {
                    // A radio stays selected when tapped again.
                    if (selected && !question.allowMultiple) return;
                    setAnswers((value) => ({
                      ...value,
                      [question.id]: updateAskAnswer(
                        question,
                        value[question.id],
                        { optionId: option.id },
                      ),
                    }));
                  }}
                />
              );
            })}
          </View>
          <NativeField
            ref={(field) => {
              fields.current[question.id] = field;
            }}
            label={`Other answer: ${question.prompt}`}
            placeholder={
              question.options.length
                ? 'Or write your own answer…'
                : 'Write your answer…'
            }
            value={get(question.id).customText ?? ''}
            unavailable={busy}
            multiline
            onChange={(customText) =>
              setAnswers((value) => ({
                ...value,
                [question.id]: updateAskAnswer(question, value[question.id], {
                  customText,
                }),
              }))
            }
          />
        </View>
      ))}
      <Button
        fullWidth
        glyph="send"
        label={busy ? 'Sending answer…' : 'Send answer'}
        busy={busy}
        disabled={ask.questions.some(
          (question) =>
            !get(question.id).selectedOptionIds.length &&
            !get(question.id).customText?.trim(),
        )}
        onPress={() =>
          onAnswer(
            ask.questions.map((question) =>
              updateAskAnswer(question, get(question.id), {
                customText:
                  fields.current[question.id]?.getText() ??
                  get(question.id).customText ??
                  '',
              }),
            ),
          )
        }
      />
    </Card>
  );
}
