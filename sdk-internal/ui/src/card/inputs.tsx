/**
 * The inputs a card holds anywhere in its content: choices, rows of
 * buttons and text answers. Together they are the card's form (`form.ts`):
 * live while the App takes answers (`onSubmit`), read-only showing an
 * answer, or showing the defaults.
 */
import { Text as NshText, View, cleanup, context, signal } from 'nsh';
import type { JSX } from 'nsh';
import {
  Checkbox as BaseCheckbox,
  Radio,
  RadioGroup as BaseRadioGroup,
} from 'nsh/base';
import { byLook } from '../core/env';
import { FOCUS_RING } from '../core/styles';
import { Glyph } from '../icons/Icon';
import { IconArrowUpRight, IconCheck } from '../icons/icons.gen';
import { Button as UiButton } from '../input/Button';
import type { ButtonKind } from '../input/Button';
import { CHOICE_STYLE } from '../input/Choice';
import { FieldErrorLine } from '../input/Field';
import { TextArea, TextField } from '../input/TextField';
import type { ContentTone } from './content/catalog.gen';
import type { ReplyOptionInput } from './content/reply-form.gen';
import { CardContext } from './form';
import type { CardScope, CardTransition } from './form';
import { CardWidthContext, RowContext } from './parts';
import {
  OPTION,
  OPTION_SELECTED,
  TONE_TINT,
  TONE_ON_TINT,
  TYPE,
} from './styles';

/** A multiple choice's box: the library's, round on the web as the Desk
 * card draws it. */
const CHECKBOX = byLook({
  web: CHOICE_STYLE.checkbox.replace('rounded-(--radius-xs)', 'rounded-full'),
  ios: CHOICE_STYLE.checkbox,
  android: CHOICE_STYLE.checkbox,
  macos: CHOICE_STYLE.checkbox,
  windows: CHOICE_STYLE.checkbox,
});

/** An option as it registers with its `Choice` or `Buttons`. */
type OptionEntry = ReplyOptionInput & {
  transition?: CardTransition;
  isDefault?: boolean;
};

type GroupScope = {
  fieldId: () => string;
  multiple: () => boolean;
  add(option: () => OptionEntry): void;
};

const GroupContext = context<GroupScope | null>(null);

/** A card's form, or one that only shows inputs outside a card. */
function useCard(): CardScope | null {
  return CardContext();
}

/** Options as they register, in order. */
function optionList() {
  const list = signal<(() => OptionEntry)[]>([]);
  return {
    options: () => list(),
    add: (option: () => OptionEntry) => {
      list.set([...list(), option]);
      cleanup(() => list.set(list().filter((entry) => entry !== option)));
    },
  };
}

function transitions(options: readonly (() => OptionEntry)[]) {
  return Object.fromEntries(
    options
      .map((option) => option())
      .filter((option) => option.transition)
      .map((option) => [option.id, option.transition!]),
  );
}

function labelLine(props: {
  label?: string;
  description?: string;
  required?: boolean;
  live: boolean;
}): JSX.Element {
  return props.label || props.description ? (
    <View class="gap-0.5">
      {props.label ? (
        <NshText class={`${TYPE.data} ${TYPE.bold} text-foreground`}>
          {props.label}
          {props.required && props.live ? (
            <NshText class="text-danger-strong">{' *'}</NshText>
          ) : (
            ''
          )}
        </NshText>
      ) : null}
      {props.description ? (
        <NshText class={`${TYPE.small} text-muted-foreground text-pretty`}>
          {props.description}
        </NshText>
      ) : null}
    </View>
  ) : null;
}

// ------------------------------------------------------------------ Choice

export type ChoiceProps = {
  /** The options. */
  children?: JSX.Element;
  /** The answer's key in `onSubmit`'s answers. */
  id: string;
  /** The question. */
  label: string;
  /** Help text. */
  description?: string;
  /** Must be answered. */
  required?: boolean;
  /** Several options may be chosen. */
  multiple?: boolean;
  /** With `multiple`: the fewest options. */
  min?: number;
  /** With `multiple`: the most options. */
  max?: number;
};

/** A single or multiple choice question, its options as rows. */
export function Choice(props: ChoiceProps): JSX.Element {
  const card = useCard();
  const { options, add } = optionList();
  card?.register(() => {
    const entries = options().map((option) => option());
    const defaults = entries
      .filter((option) => option.isDefault)
      .map((option) => option.id);
    return {
      field: {
        id: props.id,
        type: props.multiple ? 'multiple' : 'single',
        label: props.label,
        description: props.description,
        required: props.required === true,
        options: entries.map(({ id, label, note, badge }) => ({
          id,
          label,
          note,
          badge,
        })),
        minSelected: props.multiple ? props.min : undefined,
        maxSelected: props.multiple ? props.max : undefined,
        default: props.multiple
          ? defaults.length > 0
            ? defaults
            : undefined
          : defaults.length > 1
            ? defaults
            : defaults[0],
      },
      transitions: transitions(options()),
    };
  });
  // While answering, a multiple choice says how many to pick, as the
  // notification's form does.
  const range = () => {
    if (!props.multiple || card?.mode() !== 'live') return undefined;
    const min = props.min ?? 1;
    const max = props.max ?? options().length;
    return min === max ? `Choose ${min}` : `Choose ${min}–${max}`;
  };
  const description = () =>
    [props.description, range()].filter(Boolean).join(' · ') || undefined;
  const content = (
    <GroupContext.Provider
      value={{
        fieldId: () => props.id,
        multiple: () => props.multiple === true,
        add,
      }}
    >
      <View class="gap-1.5">{props.children}</View>
    </GroupContext.Provider>
  );
  return (
    <View class="min-w-0 gap-1.5">
      {labelLine({
        label: props.label,
        description: description(),
        required: props.required,
        live: card?.mode() === 'live',
      })}
      {props.multiple ? (
        content
      ) : (
        <BaseRadioGroup accessibilityLabel={props.label}>
          {content}
        </BaseRadioGroup>
      )}
      <FieldErrorLine error={card?.fieldError(props.id)} />
    </View>
  );
}

export type OptionProps = {
  /** The option's label. */
  children?: string;
  /** The answer's value. */
  id: string;
  /** Shown beside it, such as "about 1 minute". */
  note?: string;
  /** A tag, such as "breaking". */
  badge?: string;
  /** Chosen to begin with. */
  default?: boolean;
  /** The card's status once this is chosen. */
  thenStatus?: string;
  /** Tone of `thenStatus`. */
  thenTone?: ContentTone;
};

/** One option of a `Choice`. */
export function Option(props: OptionProps): JSX.Element {
  const card = useCard();
  const group = GroupContext();
  group?.add(() => ({
    id: props.id,
    label: props.children ?? '',
    note: props.note,
    badge: props.badge,
    isDefault: props.default === true,
    transition: props.thenStatus
      ? { label: props.thenStatus, tone: props.thenTone ?? 'neutral' }
      : undefined,
  }));
  const fieldId = () => group?.fieldId() ?? '';
  const multiple = () => group?.multiple() ?? false;
  const value = () => card?.value(fieldId());
  const chosen = () => {
    const answer = value();
    if (answer === undefined) return !card && props.default === true;
    return Array.isArray(answer)
      ? answer.includes(props.id)
      : answer === props.id;
  };
  const live = () => card?.mode() === 'live';
  const dimmed = () => card?.mode() === 'answered' && !chosen();
  const toggle = () => {
    if (!card || !live() || card.busy()) return;
    const answer = value();
    if (!multiple()) {
      card.set(fieldId(), props.id);
      return;
    }
    const list = Array.isArray(answer) ? answer : answer ? [answer] : [];
    card.set(
      fieldId(),
      list.includes(props.id)
        ? list.filter((id) => id !== props.id)
        : [...list, props.id],
    );
  };
  const rowClass = () =>
    `${OPTION} ${chosen() ? OPTION_SELECTED : ''} ${dimmed() ? 'opacity-55' : ''} ${FOCUS_RING}`;
  const body = () => (
    <>
      <NshText
        class={`min-w-0 flex-1 ${TYPE.text.md} ${chosen() ? TYPE.bold : TYPE.regular} text-foreground`}
      >
        {props.children ?? ''}
      </NshText>
      {props.badge ? (
        <View
          class={`h-5 flex-row items-center rounded-full px-2 ${TONE_TINT.neutral}`}
        >
          <NshText class={`${TYPE.pill} ${TONE_ON_TINT.neutral}`}>
            {props.badge}
          </NshText>
        </View>
      ) : null}
      {props.note ? (
        <NshText class={`${TYPE.small} text-muted-foreground`}>
          {props.note}
        </NshText>
      ) : null}
    </>
  );
  return multiple() ? (
    <BaseCheckbox
      checked={chosen()}
      disabled={!live() || card?.busy()}
      onChange={toggle}
      accessibilityLabel={props.children}
      class={rowClass()}
      indicatorClass={CHECKBOX}
      indicator={
        // Android draws its box inside a 40-point state circle.
        CHOICE_STYLE.checkboxBox ? (
          <View class={CHOICE_STYLE.checkboxBox}>
            {chosen() ? (
              <Glyph icon={IconCheck} size="sm" color="primary-foreground" />
            ) : null}
          </View>
        ) : chosen() ? (
          <Glyph icon={IconCheck} size="sm" color="primary-foreground" />
        ) : null
      }
    >
      {body()}
    </BaseCheckbox>
  ) : (
    <Radio
      checked={chosen()}
      disabled={!live() || card?.busy()}
      onChange={toggle}
      accessibilityLabel={props.children}
      class={rowClass()}
    >
      <View class={CHOICE_STYLE.radio}>
        {CHOICE_STYLE.radioRing ? (
          <View class={CHOICE_STYLE.radioRing}>
            <View class={CHOICE_STYLE.radioDot} />
          </View>
        ) : (
          <View class={CHOICE_STYLE.radioDot} />
        )}
      </View>
      {body()}
    </Radio>
  );
}

// ----------------------------------------------------------------- Buttons

export type ButtonsProps = {
  /** The buttons. */
  children?: JSX.Element;
  /** The answer's key in `onSubmit`'s answers. */
  id: string;
  /** The question. */
  label?: string;
  /** Help text. */
  description?: string;
};

/** A row of buttons answering one question: pressing one answers it. When
 * the row is the card's last question, a press submits the card. */
export function Buttons(props: ButtonsProps): JSX.Element {
  const card = useCard();
  const { options, add } = optionList();
  card?.register(() => ({
    field: {
      id: props.id,
      type: 'buttons',
      label: props.label,
      description: props.description,
      required: true,
      options: options()
        .map((option) => option())
        .map(({ id, label, primary, destructive }) => ({
          id,
          label,
          primary,
          destructive,
        })),
    },
    transitions: transitions(options()),
  }));
  RowContext()?.holdButtons();
  return (
    <View class="min-w-0 gap-1.5">
      {labelLine({
        label: props.label,
        description: props.description,
        live: false,
      })}
      <GroupContext.Provider
        value={{ fieldId: () => props.id, multiple: () => false, add }}
      >
        <ButtonRow>{props.children}</ButtonRow>
      </GroupContext.Provider>
      <FieldErrorLine error={card?.fieldError(props.id)} />
    </View>
  );
}

/** Buttons side by side, stacked full width on a narrow card. */
function ButtonRow(props: { children?: JSX.Element }): JSX.Element {
  const width = CardWidthContext();
  return (
    <View
      class={
        width() < 400
          ? 'min-w-0 flex-col items-stretch gap-2'
          : 'min-w-0 flex-row flex-wrap gap-2'
      }
    >
      {props.children}
    </View>
  );
}

export type ButtonProps = {
  /** The button's text. */
  children?: string;
  /** Inside `Buttons`: the answer's value. */
  id?: string;
  /** Opens this link instead of answering. */
  href?: string;
  /** The main action. */
  primary?: boolean;
  /** A destructive action. */
  destructive?: boolean;
  /** The card's status once this is chosen. */
  thenStatus?: string;
  /** Tone of `thenStatus`. */
  thenTone?: ContentTone;
  /** An action of the App's own, not an answer (TSX only: card markup has
   * no handlers). */
  onPress?: () => void;
};

/** A button: with `id` inside `Buttons`, an answer; with `href`, a link;
 * with `onPress`, an action of the App's. */
export function Button(props: ButtonProps): JSX.Element {
  const card = useCard();
  const group = GroupContext();
  const width = CardWidthContext();
  // A narrow card stacks its buttons, each the card's width.
  const stacked = () => width() < 400;
  const answer = () => Boolean(group && props.id && !props.href);
  if (group && props.id && !props.href) {
    group.add(() => ({
      id: props.id!,
      label: props.children ?? '',
      primary: props.primary || undefined,
      destructive: props.destructive || undefined,
      transition: props.thenStatus
        ? { label: props.thenStatus, tone: props.thenTone ?? 'neutral' }
        : undefined,
    }));
  } else {
    RowContext()?.holdButtons();
  }
  const fieldId = () => group?.fieldId() ?? '';
  const selected = () => answer() && card?.value(fieldId()) === props.id;
  const submits = () => answer() && (card?.submitsWith(fieldId()) ?? false);
  const mode = () => card?.mode() ?? 'preview';
  const kind = (): ButtonKind => {
    if (selected()) return props.destructive ? 'danger' : 'primary';
    if (props.primary) return submits() || !answer() ? 'primary' : 'tint';
    if (props.destructive) return 'danger-tint';
    return 'default';
  };
  if (props.href) {
    const open = card?.linkAction(props.href) ?? null;
    return (
      <UiButton
        label={props.children ?? props.href}
        kind="default"
        iconEnd={IconArrowUpRight}
        fullWidth={stacked()}
        disabled={!open}
        onPress={() => open?.()}
      />
    );
  }
  if (!answer()) {
    return (
      <UiButton
        label={props.children ?? ''}
        kind={kind()}
        fullWidth={stacked()}
        disabled={!props.onPress}
        onPress={() => props.onPress?.()}
      />
    );
  }
  // Once answered, the chosen button stays as it was pressed and the others
  // fade; a press then does nothing.
  return (
    <View
      class={
        mode() === 'answered' && !selected()
          ? 'opacity-55'
          : mode() === 'preview'
            ? 'opacity-55'
            : ''
      }
    >
      <UiButton
        label={props.children ?? ''}
        kind={kind()}
        fullWidth={stacked()}
        loading={submits() && card?.busy()}
        disabled={
          mode() === 'preview' ||
          (mode() === 'answered' && !selected()) ||
          (mode() === 'live' && card?.busy() && !submits())
        }
        onPress={() => card?.pick(fieldId(), props.id!)}
      />
    </View>
  );
}

// ------------------------------------------------------------------- Input

export type InputProps = {
  /** The answer's key in `onSubmit`'s answers. */
  id: string;
  /** The question. */
  label: string;
  /** Help text. */
  description?: string;
  /** An example of an answer. */
  placeholder?: string;
  /** Several lines. */
  multiline?: boolean;
  /** The longest answer; default 1000. */
  maxLength?: number;
  /** Must be answered. */
  required?: boolean;
};

/** A text answer. */
export function Input(props: InputProps): JSX.Element {
  const card = useCard();
  card?.register(() => ({
    field: {
      id: props.id,
      type: 'text',
      label: props.label,
      description: props.description,
      required: props.required === true,
      placeholder: props.placeholder,
      multiline: props.multiline === true,
      maxLength: props.maxLength,
    },
    transitions: {},
  }));
  const live = () => card?.mode() === 'live';
  const value = () => {
    const answer = card?.value(props.id);
    return typeof answer === 'string' ? answer : '';
  };
  const common = () => ({
    label: props.label,
    description: props.description,
    required: props.required && live(),
    error: card?.fieldError(props.id),
    placeholder: live() ? props.placeholder : undefined,
    maxLength: props.maxLength,
    readOnly: !live(),
    disabled: card?.busy(),
    value: value(),
    onChange: (text: string) => card?.set(props.id, text),
  });
  return props.multiline ? (
    <TextArea {...common()} />
  ) : (
    <TextField {...common()} />
  );
}

// ------------------------------------------------------------------ Submit

export type SubmitProps = {
  /** The button's text; default the card's `submitLabel`. */
  children?: string;
};

/** The card's submit button; the card adds one when it needs one and has
 * none. Gone once the card shows an answer. */
export function Submit(props: SubmitProps): JSX.Element {
  const card = useCard();
  card?.registerSubmit();
  return card && card.mode() === 'live' ? (
    <SubmitButton card={card} label={props.children} />
  ) : null;
}

/** The submit button itself. Internal: the card draws one when needed. */
export function SubmitButton(props: {
  card: CardScope;
  label?: string;
}): JSX.Element {
  RowContext()?.holdButtons();
  const width = CardWidthContext();
  return (
    <UiButton
      label={props.label || props.card.submitLabel()}
      kind="primary"
      fullWidth={width() < 400}
      loading={props.card.busy()}
      onPress={() => props.card.submit()}
    />
  );
}
