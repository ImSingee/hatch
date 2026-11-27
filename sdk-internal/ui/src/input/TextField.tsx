import { Text, View } from 'nsh';
import type { JSX } from 'nsh';
import { Input, NumberInput } from 'nsh/base';
import type { IconData } from '../core/types';
import { Glyph } from '../icons/Icon';
import { IconMinus, IconPlus } from '../icons/icons.gen';
import { look } from '../core/env';
import {
  Field,
  SEARCH_WELL,
  WELL,
  WELL_HEIGHT,
  WELL_TEXT,
  fieldError,
  wellState,
} from './Field';
import type { FieldProps } from './Field';
import { FormContext, bindField } from './form-context';

/** What a text field holds, which sets its keyboard and autofill. */
export type TextFieldKind =
  | 'text'
  | 'email'
  | 'password'
  | 'new-password'
  | 'url'
  | 'tel'
  | 'search'
  | 'name'
  | 'code';

type InputBehaviour = {
  keyboardType?: 'default' | 'email-address' | 'url' | 'phone-pad';
  autoComplete?:
    | 'email'
    | 'current-password'
    | 'new-password'
    | 'url'
    | 'tel'
    | 'name'
    | 'off';
  autoCapitalize?: 'none' | 'sentences' | 'words';
  autoCorrect?: boolean;
  masked?: boolean;
  returnKeyType?: 'default' | 'search';
};

const KIND: Record<TextFieldKind, InputBehaviour> = {
  text: {},
  email: {
    keyboardType: 'email-address',
    autoComplete: 'email',
    autoCapitalize: 'none',
    autoCorrect: false,
  },
  password: {
    masked: true,
    autoComplete: 'current-password',
    autoCapitalize: 'none',
    autoCorrect: false,
  },
  'new-password': {
    masked: true,
    autoComplete: 'new-password',
    autoCapitalize: 'none',
    autoCorrect: false,
  },
  url: {
    keyboardType: 'url',
    autoComplete: 'url',
    autoCapitalize: 'none',
    autoCorrect: false,
  },
  tel: { keyboardType: 'phone-pad', autoComplete: 'tel' },
  search: { returnKeyType: 'search', autoComplete: 'off' },
  name: { autoComplete: 'name', autoCapitalize: 'words', autoCorrect: false },
  code: { autoCapitalize: 'none', autoCorrect: false, autoComplete: 'off' },
};

export type TextFieldProps = FieldProps & {
  /** The text, when the App controls it. */
  value?: string;
  onChange?: (value: string) => void;
  /** Return was pressed. */
  onSubmit?: (value: string) => void;
  /** An example of what to enter, never the only instruction. */
  placeholder?: string;
  kind?: TextFieldKind;
  /** An icon at the start of the well. */
  icon?: IconData;
  maxLength?: number;
  readOnly?: boolean;
  /** Shows no label above the field; screen readers still read it. Only
   * for `kind="search"` at the top of a list, where the magnifier and the
   * placeholder say what the field does. */
  labelHidden?: boolean;
};

/** A one-line text field with its label. */
export function TextField(props: TextFieldProps): JSX.Element {
  const form = FormContext();
  // Read as it changes: an App may switch a field between `password` and
  // `text` to show or hide what was typed.
  const kind = () => props.kind ?? 'text';
  const behaviour = () => KIND[kind()];
  const field = bindField<string>(form, props, '', {
    secret: () => kind() === 'password' || kind() === 'new-password',
  });
  const error = fieldError(props);
  const disabled = () => props.disabled === true || (form?.disabled() ?? false);
  return (
    <Field
      label={props.label}
      description={props.description}
      error={error()}
      required={props.required}
      labelHidden={props.labelHidden}
    >
      <View
        class={
          props.labelHidden && look === 'ios'
            ? SEARCH_WELL
            : `${WELL} ${WELL_HEIGHT} ${wellState(error() !== undefined, disabled())}`
        }
      >
        {props.icon ? (
          <Glyph icon={props.icon} size="md" color="muted-foreground" />
        ) : null}
        <Input
          class={`flex-1 self-stretch ${WELL_TEXT}`}
          value={field.get()}
          onChange={(event) => field.set(event.value)}
          onSubmit={(event) => {
            if (props.onSubmit) props.onSubmit(event.text);
            else form?.submit();
          }}
          placeholder={props.placeholder}
          maxLength={props.maxLength}
          readonly={props.readOnly}
          disabled={disabled()}
          accessibilityLabel={props.label}
          accessibilityHint={props.description}
          accessibilityState={{
            invalid: error() !== undefined,
            disabled: disabled(),
          }}
          keyboardType={behaviour().keyboardType ?? 'default'}
          autoComplete={behaviour().autoComplete}
          autoCapitalize={behaviour().autoCapitalize ?? 'sentences'}
          autoCorrect={behaviour().autoCorrect ?? true}
          masked={behaviour().masked ?? false}
          returnKeyType={behaviour().returnKeyType ?? 'default'}
        />
      </View>
    </Field>
  );
}

export type TextAreaProps = FieldProps & {
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  /** Lines of text it shows before it grows: 3 (default), 5 or 8. */
  rows?: 3 | 5 | 8;
  maxLength?: number;
  readOnly?: boolean;
};

const ROWS: Record<NonNullable<TextAreaProps['rows']>, string> = {
  3: 'min-h-20',
  5: 'min-h-30',
  8: 'min-h-45',
};

/** A multi-line text field with its label. It grows with its text. */
export function TextArea(props: TextAreaProps): JSX.Element {
  const form = FormContext();
  const field = bindField<string>(form, props, '');
  const error = fieldError(props);
  const disabled = () => props.disabled === true || (form?.disabled() ?? false);
  return (
    <Field
      label={props.label}
      description={props.description}
      error={error()}
      required={props.required}
    >
      <View
        class={`${WELL} items-stretch py-2 ${ROWS[props.rows ?? 3]} ${wellState(error() !== undefined, disabled())}`}
      >
        <Input
          multiline
          class={`flex-1 ${WELL_TEXT}`}
          value={field.get()}
          onChange={(event) => field.set(event.value)}
          placeholder={props.placeholder}
          maxLength={props.maxLength}
          readonly={props.readOnly}
          disabled={disabled()}
          accessibilityLabel={props.label}
          accessibilityHint={props.description}
          accessibilityState={{
            invalid: error() !== undefined,
            disabled: disabled(),
          }}
        />
      </View>
      {props.maxLength !== undefined ? (
        <Text class="self-end text-caption text-muted-foreground">
          {`${field.get().length} / ${props.maxLength}`}
        </Text>
      ) : null}
    </Field>
  );
}

export type NumberFieldProps = FieldProps & {
  /** The number, or `null` while empty. */
  value?: number | null;
  onChange?: (value: number | null) => void;
  min?: number;
  max?: number;
  /** The step of the buttons and arrow keys; default 1. */
  step?: number;
  placeholder?: string;
  /** A unit after the number, such as "kg" or "%". */
  unit?: string;
};

const STEPPER =
  'w-9 self-stretch items-center justify-center enabled:hover:bg-surface-hover active:bg-surface-pressed disabled:opacity-40 pointer-coarse:w-11';

/** A number with buttons to step it, and its label. */
export function NumberField(props: NumberFieldProps): JSX.Element {
  const form = FormContext();
  const field = bindField<number | null>(form, props, null);
  const error = fieldError(props);
  const disabled = () => props.disabled === true || (form?.disabled() ?? false);
  return (
    <Field
      label={props.label}
      description={props.description}
      error={error()}
      required={props.required}
    >
      <NumberInput
        value={field.get()}
        onChange={(event) => field.set(event.value)}
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        placeholder={props.placeholder}
        disabled={disabled()}
        accessibilityLabel={props.label}
        class={`${WELL} gap-0 overflow-hidden px-0 ${WELL_HEIGHT} ${wellState(error() !== undefined, disabled())}`}
        inputClass={`flex-1 self-stretch px-3 ${WELL_TEXT}`}
        decrementButtonClass={`${STEPPER} border-r border-input`}
        incrementButtonClass={`${STEPPER} border-l border-input`}
        decrementButton={
          <Glyph icon={IconMinus} size="sm" color="foreground" />
        }
        incrementButton={<Glyph icon={IconPlus} size="sm" color="foreground" />}
        suffix={
          props.unit ? (
            <Text class="pr-3 text-body text-muted-foreground">
              {props.unit}
            </Text>
          ) : undefined
        }
      />
    </Field>
  );
}
