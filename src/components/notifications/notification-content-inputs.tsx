/**
 * The inputs a card holds inline: choices, buttons and text answers placed
 * anywhere in its content. The platform compiled them, in document order,
 * into the notification's reply form, so the whole card is one form bound
 * to it by field id. Once answered (or when only shown, as in the version
 * history) they stay in place read-only, showing what was chosen.
 */
import {
  Anchor,
  Button,
  Checkbox,
  Radio,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { IconArrowUpRight } from '@tabler/icons-react';
import { createContext, useContext, type ReactNode } from 'react';
import {
  inlineText,
  isNode,
  nodeChildren,
  propBool,
  propNumber,
  propString,
  walkContent,
  type ContentNode,
} from '../../../packages/hatch-platform-api/notification-content';
import {
  answerOf,
  submitsWithButtons,
  type ReplyAnswers,
  type ReplyField,
  type ReplyForm,
  type ReplyOption,
} from '../../../packages/hatch-platform-api/notification-reply';
import { useI18n } from '~i18n';
import { notificationLinkTarget } from './notification-link';
import {
  OptionExtras,
  buttonVariant,
  useReplyForm,
  type ReplyFormControl,
} from './reply-section';
import classes from './notification-content-view.module.css';

type InlineForm = {
  /** Answering here; null while the inputs are only shown. */
  control: ReplyFormControl | null;
  /** What read-only inputs show: the round's answer, or null for none. */
  answers: ReplyAnswers | null;
  reply: ReplyForm | null;
};

const InlineFormContext = createContext<InlineForm>({
  control: null,
  answers: null,
  reply: null,
});

export const InlineFormProvider = InlineFormContext.Provider;

/** The card's form: answers its inline inputs with one submission. */
export function LiveInlineForm({
  notificationId,
  reply,
  round,
  content,
  children,
}: {
  notificationId: string;
  reply: ReplyForm;
  round: number;
  content: ContentNode;
  children: ReactNode;
}) {
  const control = useReplyForm({ notificationId, reply, round });
  // Without its own Submit, a card gets one, unless its last question is a
  // row of buttons that sends it.
  const ownSubmit = [...walkContent(content)].some(
    ({ node }) => node.type === 'Submit',
  );
  return (
    <InlineFormProvider value={{ control, answers: null, reply }}>
      <form
        className={classes.form}
        onSubmit={(event) => {
          event.preventDefault();
          control.submit();
        }}
      >
        {children}
        {control.formError ? (
          <Text size="sm" c="red.8">
            {control.formError}
          </Text>
        ) : null}
        {ownSubmit || submitsWithButtons(reply) ? null : (
          <Button
            type="submit"
            className={classes.autoSubmit}
            loading={control.pending}
          >
            {reply.submitLabel}
          </Button>
        )}
      </form>
    </InlineFormProvider>
  );
}

/** The field an input answers, when the form has one of a fitting type. */
function useField<T extends ReplyField['type']>(
  node: ContentNode,
  types: readonly T[],
) {
  const form = useContext(InlineFormContext);
  const id = propString(node, 'id');
  const field = form.control?.reply.fields.find(
    (entry): entry is Extract<ReplyField, { type: T }> =>
      entry.id === id && (types as readonly string[]).includes(entry.type),
  );
  const live = Boolean(form.control && field);
  // What it shows: the draft while answering, else the round's answer.
  const value = id
    ? form.control
      ? answerOf(form.control.answers, id)
      : form.answers
        ? answerOf(form.answers, id)
        : undefined
    : undefined;
  return {
    id,
    field,
    control: live ? form.control : null,
    value,
    /** Read-only and showing an answer: the rest is dimmed. */
    answered: !form.control && form.answers !== null,
    /** Shown only, with no answer: inputs show the sender's defaults. */
    preview: !form.control && form.answers === null,
    readOnly: !live,
  };
}

type OptionView = ReplyOption & { chosenFirst: boolean };

function optionsOf(node: ContentNode, type: 'Option' | 'Button') {
  return nodeChildren(node)
    .filter(isNode)
    .filter((child) => child.type === type && propString(child, 'id'))
    .map((child): OptionView => ({
      id: propString(child, 'id')!,
      label: inlineText(nodeChildren(child)),
      note: propString(child, 'note'),
      badge: propString(child, 'badge'),
      ...(propBool(child, 'primary') ? { primary: true } : {}),
      ...(propBool(child, 'destructive') ? { destructive: true } : {}),
      chosenFirst: propBool(child, 'default'),
    }));
}

/** A single or multiple choice, its options as selectable rows. */
export function ChoiceInput({ node }: { node: ContentNode }) {
  const { t } = useI18n();
  const { id, field, control, value, answered, preview, readOnly } = useField(
    node,
    ['single', 'multiple'] as const,
  );
  if (!id) return null;
  const options = optionsOf(node, 'Option');
  const multiple = field
    ? field.type === 'multiple'
    : propBool(node, 'multiple');
  // A draft starts at the defaults (the form's own) and may be emptied.
  const chosen: string[] =
    value === undefined
      ? preview
        ? options.filter((option) => option.chosenFirst).map((o) => o.id)
        : []
      : Array.isArray(value)
        ? value
        : [value];
  const label = propString(node, 'label');
  const required = field?.required ?? propBool(node, 'required');
  const range =
    field?.type === 'multiple'
      ? field.minSelected === field.maxSelected
        ? t('notifications.reply.chooseExactly', { number: field.minSelected })
        : t('notifications.reply.chooseRange', {
            min: field.minSelected,
            max: field.maxSelected,
          })
      : undefined;
  const description =
    [propString(node, 'description'), range].filter(Boolean).join(' · ') ||
    undefined;
  const disabled = readOnly || Boolean(control?.pending);
  const rows = options.map((option) => {
    const selected = chosen.includes(option.id);
    const Card = multiple ? Checkbox.Card : Radio.Card;
    const Indicator = multiple ? Checkbox.Indicator : Radio.Indicator;
    return (
      <Card
        key={option.id}
        value={option.id}
        radius="md"
        className={classes.option}
        disabled={disabled}
        data-selected={selected || undefined}
        data-dimmed={(answered && !selected) || undefined}
      >
        <span className={classes.optionRow}>
          <Indicator checked={selected} disabled={disabled && !selected} />
          <span className={classes.optionLabel}>{option.label}</span>
          <OptionExtras option={option} />
        </span>
      </Card>
    );
  });
  const common = {
    label,
    description,
    withAsterisk: required && !readOnly,
    error: control?.fieldError(id),
    className: classes.choice,
  };
  return multiple ? (
    <Checkbox.Group
      {...common}
      value={chosen}
      onChange={(next) => control?.set(id, next)}
    >
      <div className={classes.options}>{rows}</div>
    </Checkbox.Group>
  ) : (
    <Radio.Group
      {...common}
      value={chosen[0] ?? null}
      onChange={(next) => control?.set(id, next)}
    >
      <div className={classes.options}>{rows}</div>
      {control && !required && chosen.length > 0 ? (
        <Anchor
          component="button"
          type="button"
          size="xs"
          c="dimmed"
          mt={6}
          disabled={disabled}
          onClick={() => control.set(id, undefined)}
        >
          {t('notifications.reply.clear')}
        </Anchor>
      ) : null}
    </Radio.Group>
  );
}

/**
 * A row of buttons answering one question. The trailing required one sends
 * the whole form; any other only records its choice.
 */
export function ButtonsInput({ node }: { node: ContentNode }) {
  const { id, field, control, value, answered, readOnly } = useField(node, [
    'buttons',
  ] as const);
  if (!id) return null;
  const label = propString(node, 'label');
  const description = propString(node, 'description');
  const submits = Boolean(field && control?.submitsWith(field));
  const error = control?.fieldError(id);
  return (
    <div className={classes.buttonsField}>
      {label ? (
        <Text size="sm" fw={600}>
          {label}
        </Text>
      ) : null}
      {description ? (
        <Text size="xs" c="dimmed">
          {description}
        </Text>
      ) : null}
      <div className={classes.buttons} data-stack>
        {nodeChildren(node)
          .filter(isNode)
          .map((child, index) => {
            if (child.type !== 'Button') return null;
            if (propString(child, 'href')) {
              return <LinkButton key={index} node={child} />;
            }
            const optionId = propString(child, 'id');
            if (!optionId) return null;
            const [option] = optionsOf(
              { type: 'Buttons', children: [child] },
              'Button',
            );
            const selected = value === optionId;
            return (
              <Button
                key={index}
                type="button"
                className={classes.button}
                color={option!.destructive ? 'red' : undefined}
                variant={buttonVariant(option!, { selected, submits })}
                disabled={Boolean(control?.pending)}
                aria-disabled={readOnly || undefined}
                aria-pressed={submits || readOnly ? undefined : selected}
                data-primary={option!.primary || undefined}
                data-inert={readOnly || undefined}
                data-dimmed={
                  (readOnly && (answered ? !selected : true)) || undefined
                }
                onClick={() => {
                  if (control && field) control.pick(field, optionId);
                }}
              >
                {option!.label}
              </Button>
            );
          })}
      </div>
      {error ? (
        <Text size="xs" c="red.8">
          {error}
        </Text>
      ) : null}
    </div>
  );
}

/** A written answer. */
export function TextAnswerInput({ node }: { node: ContentNode }) {
  const { id, field, control, value, readOnly } = useField(node, [
    'text',
  ] as const);
  if (!id) return null;
  const common = {
    label: propString(node, 'label'),
    description: propString(node, 'description'),
    placeholder: readOnly ? undefined : propString(node, 'placeholder'),
    withAsterisk: (field?.required ?? propBool(node, 'required')) && !readOnly,
    error: control?.fieldError(id),
    readOnly,
    disabled: Boolean(control?.pending),
    maxLength: field?.maxLength ?? propNumber(node, 'max-length'),
    value: typeof value === 'string' ? value : '',
    onChange: (event: { currentTarget: { value: string } }) =>
      control?.set(id, event.currentTarget.value),
  };
  return propBool(node, 'multiline') ? (
    <Textarea {...common} autosize minRows={2} maxRows={10} />
  ) : (
    <TextInput {...common} />
  );
}

/** The sender's submit button; gone once the form is read-only. */
export function SubmitInput({ node }: { node: ContentNode }) {
  const form = useContext(InlineFormContext);
  if (!form.control) return null;
  return (
    <Button
      type="submit"
      className={classes.button}
      data-primary
      loading={form.control.pending}
    >
      {inlineText(nodeChildren(node)) || form.control.reply.submitLabel}
    </Button>
  );
}

/** A button that only opens a link; it never answers. */
export function LinkButton({ node }: { node: ContentNode }) {
  const href = propString(node, 'href');
  const target = href ? notificationLinkTarget(href) : null;
  const label = inlineText(nodeChildren(node)) || href;
  const common = {
    variant: 'light',
    color: 'gray',
    className: classes.button,
    'data-link': true,
    rightSection: <IconArrowUpRight size={14} stroke={2.4} aria-hidden />,
  } as const;
  if (!target) {
    return (
      <Button {...common} disabled>
        {label}
      </Button>
    );
  }
  return (
    <Button {...common} component="a" {...target}>
      {label}
    </Button>
  );
}
