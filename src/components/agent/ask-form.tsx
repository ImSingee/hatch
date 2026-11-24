import {
  Box,
  Button,
  Checkbox,
  Group,
  Paper,
  Radio,
  Stack,
  Text,
  Textarea,
} from '@mantine/core';
import { IconHelpCircle } from '@tabler/icons-react';
import { useState } from 'react';
import type { AskAnswer, AskQuestion } from '~agent/events';
import { useI18n } from '~i18n';
import classes from './chat.module.css';
import { Markdownish } from './markdownish';

const OTHER = '__other__';

type QuestionState = { ids: string[]; other: string };

function initialState(questions: AskQuestion[]): Record<string, QuestionState> {
  return Object.fromEntries(
    questions.map((q) => [q.id, { ids: [], other: '' }]),
  );
}

export function AskForm({
  questions,
  onSubmit,
  disabled,
}: {
  questions: AskQuestion[];
  onSubmit: (answers: AskAnswer[]) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<Record<string, QuestionState>>(() =>
    initialState(questions),
  );

  const setIds = (qid: string, ids: string[]) =>
    setState((s) => ({ ...s, [qid]: { ...s[qid], ids } }));
  const setOther = (qid: string, other: string) =>
    setState((s) => ({ ...s, [qid]: { ...s[qid], other } }));

  const answerFor = (q: AskQuestion): AskAnswer => {
    const st = state[q.id];
    const customText =
      st.ids.includes(OTHER) && st.other.trim() ? st.other.trim() : undefined;
    return {
      questionId: q.id,
      selectedOptionIds: st.ids.filter((id) => id !== OTHER),
      customText,
    };
  };

  const complete = questions.every((q) => {
    const a = answerFor(q);
    if (state[q.id].ids.includes(OTHER) && !a.customText) return false;
    return a.selectedOptionIds.length > 0 || Boolean(a.customText);
  });

  const submit = () => {
    if (!complete || disabled) return;
    onSubmit(questions.map(answerFor));
  };

  return (
    <Paper className={classes.askCard} radius="xl" p="md" withBorder>
      <Group gap={6} mb="xs">
        <IconHelpCircle size={16} className={classes.askIcon} />
        <Text size="xs" fw={700} c="primary" tt="uppercase">
          {t('agent.ask.title')}
        </Text>
      </Group>
      <Stack gap="md">
        {questions.map((q) => {
          const st = state[q.id];
          const showOther = st.ids.includes(OTHER);
          return (
            <Stack key={q.id} gap={8}>
              {/* Markdown, so a question can show what it asks about (for
                  example generated image candidates). */}
              <Box fw={700}>
                <Markdownish text={q.prompt} />
              </Box>
              {q.allowMultiple ? (
                <Checkbox.Group
                  value={st.ids}
                  onChange={(ids) => setIds(q.id, ids)}
                >
                  <Stack gap={8}>
                    {q.options.map((o) => (
                      <Checkbox key={o.id} value={o.id} label={o.label} />
                    ))}
                    <Checkbox value={OTHER} label={t('agent.ask.other')} />
                  </Stack>
                </Checkbox.Group>
              ) : (
                <Radio.Group
                  value={st.ids[0] ?? ''}
                  onChange={(id) => setIds(q.id, [id])}
                >
                  <Stack gap={8}>
                    {q.options.map((o) => (
                      <Radio key={o.id} value={o.id} label={o.label} />
                    ))}
                    <Radio value={OTHER} label={t('agent.ask.other')} />
                  </Stack>
                </Radio.Group>
              )}
              {showOther ? (
                <Textarea
                  size="sm"
                  placeholder={t('agent.ask.otherPlaceholder')}
                  autosize
                  minRows={1}
                  maxRows={6}
                  value={st.other}
                  onChange={(e) => setOther(q.id, e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (
                      e.key === 'Enter' &&
                      !e.shiftKey &&
                      !e.nativeEvent.isComposing
                    ) {
                      e.preventDefault();
                      submit();
                    }
                  }}
                />
              ) : null}
            </Stack>
          );
        })}
        <Group justify="flex-end">
          <Button
            type="button"
            size="sm"
            color="primary"
            disabled={!complete || disabled}
            onClick={submit}
          >
            {t('agent.ask.submit')}
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}
