import { Text, View } from 'nsh';
import type { JSX } from 'nsh';
import {
  Checkbox as BaseCheckbox,
  Radio,
  RadioGroup as BaseRadioGroup,
  Slider as BaseSlider,
  Switch as BaseSwitch,
} from 'nsh/base';
import { Each } from '../core/control';
import { FOCUS_RING } from '../core/styles';
import { Glyph } from '../icons/Icon';
import { IconCheck, IconMinus } from '../icons/icons.gen';
import { Field, fieldError } from './Field';
import type { FieldProps } from './Field';
import { FormContext, bindField } from './form-context';

/** The label and description beside a checkbox, switch or radio. */
function ChoiceLabel(props: {
  label: string;
  description?: string;
}): JSX.Element {
  return (
    <View class="flex-1 gap-0.5">
      <Text class="text-body font-label text-foreground">{props.label}</Text>
      {props.description ? (
        <Text class="text-caption text-muted-foreground text-pretty">
          {props.description}
        </Text>
      ) : null}
    </View>
  );
}

const CHOICE_ROW =
  'group flex-row items-start gap-2.5 self-stretch rounded-(--radius-sm) py-0.5 disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:items-center';

export type CheckboxProps = Omit<FieldProps, 'required'> & {
  /** Checked, when the App controls it. */
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  /** Neither checked nor unchecked: some of the items it stands for are. */
  indeterminate?: boolean;
};

/** An option that is on or off, set with others on submit. */
export function Checkbox(props: CheckboxProps): JSX.Element {
  const form = FormContext();
  const field = bindField<boolean>(
    form,
    {
      get name() {
        return props.name;
      },
      get value() {
        return props.checked;
      },
      onChange: (value) => props.onChange?.(value),
    },
    false,
  );
  const error = fieldError(props);
  const marked = () => field.get() || props.indeterminate === true;
  return (
    <View class="self-stretch gap-1">
      <BaseCheckbox
        checked={field.get()}
        indeterminate={props.indeterminate}
        disabled={props.disabled || form?.disabled()}
        onChange={(event) => field.set(event.checked)}
        accessibilityLabel={props.label}
        class={`${CHOICE_ROW} ${FOCUS_RING}`}
        indicatorClass="mt-0.5 size-5 items-center justify-center rounded-(--radius-xs) border-2 border-control-border bg-card transition-colors checked:border-primary checked:bg-primary indeterminate:border-primary indeterminate:bg-primary pointer-coarse:mt-0"
        indicator={
          marked() ? (
            <Glyph
              icon={props.indeterminate ? IconMinus : IconCheck}
              size="sm"
              color="primary-foreground"
            />
          ) : null
        }
      >
        <ChoiceLabel label={props.label} description={props.description} />
      </BaseCheckbox>
      {error() ? (
        <Text class="pl-7.5 text-caption font-strong text-danger-strong">
          {error() ?? ''}
        </Text>
      ) : null}
    </View>
  );
}

export type SwitchProps = Omit<FieldProps, 'required'> & {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  /** Shows the switch alone, as a `ListItem`'s control whose title already
   * says what it turns on. Screen readers still read the label. */
  labelHidden?: boolean;
};

/** A setting that takes effect at once when turned on or off. */
export function Switch(props: SwitchProps): JSX.Element {
  const form = FormContext();
  const field = bindField<boolean>(
    form,
    {
      get name() {
        return props.name;
      },
      get value() {
        return props.checked;
      },
      onChange: (value) => props.onChange?.(value),
    },
    false,
  );
  return (
    <BaseSwitch
      checked={field.get()}
      disabled={props.disabled || form?.disabled()}
      onChange={(event) => field.set(event.checked)}
      accessibilityLabel={props.label}
      class={`${CHOICE_ROW} flex-row-reverse gap-3 ${FOCUS_RING}`}
      trackClass="mt-0.5 h-5.5 w-9.5 justify-center rounded-full bg-track p-0.5 transition-colors checked:bg-primary pointer-coarse:mt-0"
      thumbClass="size-4.5 rounded-full bg-card shadow-card transition-transform checked:translate-x-4"
    >
      {props.labelHidden ? null : (
        <ChoiceLabel label={props.label} description={props.description} />
      )}
    </BaseSwitch>
  );
}

/** One option of a `RadioGroup`. */
export type RadioOption = {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
};

export type RadioGroupProps = FieldProps & {
  options: readonly RadioOption[];
  /** The chosen value, when the App controls it. */
  value?: string | null;
  onChange?: (value: string) => void;
  /** `row` lays short options side by side; default `column`. */
  direction?: 'column' | 'row';
};

/** Exactly one of a few options, all visible at once. */
export function RadioGroup(props: RadioGroupProps): JSX.Element {
  const form = FormContext();
  const field = bindField<string | null>(
    form,
    {
      get name() {
        return props.name;
      },
      get required() {
        return props.required;
      },
      get value() {
        return props.value;
      },
      onChange: (value) => {
        if (value !== null) props.onChange?.(value);
      },
    },
    null,
  );
  const error = fieldError(props);
  return (
    <Field
      label={props.label}
      description={props.description}
      error={error()}
      required={props.required}
    >
      <BaseRadioGroup
        accessibilityLabel={props.label}
        class={
          props.direction === 'row'
            ? 'flex-row flex-wrap gap-x-5 gap-y-2'
            : 'gap-2'
        }
      >
        <Each of={props.options} key={(option) => option.value}>
          {(option) => (
            <Radio
              checked={field.get() === option().value}
              disabled={props.disabled || option().disabled || form?.disabled()}
              onChange={() => field.set(option().value)}
              accessibilityLabel={option().label}
              class={`${CHOICE_ROW} ${props.direction === 'row' ? 'self-auto' : ''} ${FOCUS_RING}`}
            >
              <View class="mt-0.5 size-5 items-center justify-center rounded-full border-2 border-control-border bg-card group-checked:border-primary pointer-coarse:mt-0">
                <View class="size-2.5 rounded-full group-checked:bg-primary" />
              </View>
              <ChoiceLabel
                label={option().label}
                description={option().description}
              />
            </Radio>
          )}
        </Each>
      </BaseRadioGroup>
    </Field>
  );
}

export type SliderProps = Omit<FieldProps, 'required'> & {
  value?: number;
  onChange?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Writes the value beside the label: `(value) => \`${value} %\``. */
  formatValue?: (value: number) => string;
};

/** A number picked along a track, for values where the exact number
 * matters less than the position: volume, brightness, a target. */
export function Slider(props: SliderProps): JSX.Element {
  const form = FormContext();
  const min = () => props.min ?? 0;
  const field = bindField<number>(form, props, props.min ?? 0);
  const shown = () =>
    props.formatValue ? props.formatValue(field.get()) : String(field.get());
  return (
    <View class="self-stretch gap-2">
      <View class="flex-row items-end justify-between gap-3">
        <ChoiceLabel label={props.label} description={props.description} />
        <Text class="text-body font-label text-foreground">{shown()}</Text>
      </View>
      <BaseSlider
        value={field.get()}
        min={min()}
        max={props.max ?? 100}
        step={props.step ?? 1}
        disabled={props.disabled || form?.disabled()}
        accessibilityLabel={props.label}
        onChange={(event) => field.set(event.value as number)}
        class="h-6 self-stretch justify-center pointer-coarse:h-11"
        trackClass="h-1.5 self-stretch rounded-full bg-track disabled:opacity-50"
        indicatorClass="h-full"
        rangeClass="rounded-full bg-primary"
        thumbClass={`size-4.5 rounded-full border-2 border-primary bg-card shadow-card transition-transform active:scale-110 motion-reduce:transition-none ${FOCUS_RING}`}
      />
    </View>
  );
}
