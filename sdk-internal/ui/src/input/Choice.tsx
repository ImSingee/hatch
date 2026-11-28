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
import { byLook } from '../core/env';
import { FOCUS_RING } from '../core/styles';
import { Glyph } from '../icons/Icon';
import { IconCheck, IconMinus } from '../icons/icons.gen';
import { FieldErrorLine, PlainField, fieldError } from './Field';
import type { FieldProps } from './Field';
import { FormContext, bindField } from './form-context';

/** The label and description beside a checkbox, switch or radio. */
function ChoiceLabel(props: {
  label: string;
  description?: string;
}): JSX.Element {
  return (
    <View class="flex-1 gap-0.5">
      <Text class={STYLE.label}>{props.label}</Text>
      {props.description ? (
        <Text class={STYLE.description}>{props.description}</Text>
      ) : null}
    </View>
  );
}

const CHOICE_ROW =
  'group flex-row items-start gap-2.5 self-stretch rounded-(--radius-sm) py-0.5 disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:items-center';

/**
 * The controls' classes on each look. iOS: a round check, the 51 by 31
 * switch, a white slider knob; rows 44 points. Android (Material 3): the
 * 18-point box and the radio in a 40-point circle that a press tints, the
 * 52 by 32 switch whose thumb grows when on; rows 48 points. macOS: the
 * 16-point box and radio filled with the accent when on, the 38 by 22
 * switch, a white knob. Windows (Fluent): the 20-point box, the radio's
 * white dot on the accent, the outlined 40 by 20 toggle whose thumb turns
 * white when on, and the slider's accent thumb in a white ring.
 */
export const CHOICE_STYLE = byLook({
  web: {
    row: CHOICE_ROW,
    label: 'text-body font-label text-foreground',
    description: 'text-caption text-muted-foreground text-pretty',
    value: 'text-body font-label text-foreground',
    checkbox:
      'mt-0.5 size-5 items-center justify-center rounded-(--radius-xs) border-2 border-control-border bg-card transition-colors checked:border-primary checked:bg-primary indeterminate:border-primary indeterminate:bg-primary pointer-coarse:mt-0',
    checkboxBox: '',
    radio:
      'mt-0.5 size-5 items-center justify-center rounded-full border-2 border-control-border bg-card group-checked:border-primary pointer-coarse:mt-0',
    radioDot: 'size-2.5 rounded-full group-checked:bg-primary',
    radioRing: '',
    track:
      'mt-0.5 h-5.5 w-9.5 justify-center rounded-full bg-track p-0.5 transition-colors checked:bg-primary pointer-coarse:mt-0',
    thumb:
      'size-4.5 rounded-full bg-card shadow-card transition-transform checked:translate-x-4',
    slider: 'h-6 self-stretch justify-center pointer-coarse:h-11',
    sliderTrack: 'h-1.5 self-stretch rounded-full bg-track disabled:opacity-50',
    sliderThumb: `size-4.5 rounded-full border-2 border-primary bg-card shadow-card transition-transform active:scale-110 motion-reduce:transition-none ${FOCUS_RING}`,
  },
  ios: {
    row: 'group flex-row items-center gap-3 self-stretch rounded-(--radius-sm) min-h-11 disabled:opacity-40',
    label: 'text-ios-body font-regular text-foreground',
    description:
      'text-ios-footnote font-regular text-muted-foreground text-pretty',
    value: 'text-ios-body font-regular text-muted-foreground',
    checkbox:
      'size-5.5 items-center justify-center rounded-full border-2 border-control-border bg-card transition-colors checked:border-primary checked:bg-primary indeterminate:border-primary indeterminate:bg-primary',
    checkboxBox: '',
    radio:
      'size-5.5 items-center justify-center rounded-full border-2 border-control-border bg-card group-checked:border-primary',
    radioDot: 'size-3 rounded-full group-checked:bg-primary',
    radioRing: '',
    track:
      'h-7.75 w-12.75 justify-center rounded-full bg-track p-0.5 transition-colors checked:bg-primary',
    thumb:
      'size-6.75 rounded-full bg-card shadow-card transition-transform checked:translate-x-5',
    slider: 'h-11 self-stretch justify-center',
    sliderTrack: 'h-1 self-stretch rounded-full bg-track disabled:opacity-40',
    sliderThumb: `size-7 rounded-full border border-hairline bg-card shadow-dock transition-transform motion-reduce:transition-none ${FOCUS_RING}`,
  },
  android: {
    row: 'group flex-row items-center gap-3 self-stretch rounded-(--radius-sm) min-h-12 disabled:opacity-40',
    label: 'text-m3-body-lg font-regular text-foreground',
    description:
      'text-m3-body-md font-regular text-muted-foreground text-pretty',
    value: 'text-m3-body-lg font-regular text-muted-foreground',
    checkbox:
      'size-10 items-center justify-center rounded-full transition-colors group-active:bg-surface-pressed',
    checkboxBox:
      'size-4.5 items-center justify-center rounded-sm border-2 border-control-border group-checked:border-primary group-checked:bg-primary group-indeterminate:border-primary group-indeterminate:bg-primary',
    radio:
      'size-10 items-center justify-center rounded-full transition-colors group-active:bg-surface-pressed',
    radioDot: 'size-2.5 rounded-full group-checked:bg-primary',
    radioRing:
      'size-5 items-center justify-center rounded-full border-2 border-control-border group-checked:border-primary',
    track:
      'h-8 w-13 justify-center rounded-full border-2 border-control-border bg-surface-sunken transition-colors checked:border-primary checked:bg-primary',
    thumb:
      'ml-1.5 size-4 rounded-full bg-control-border transition-all checked:ml-0 checked:size-6 checked:translate-x-5.5 checked:bg-primary-foreground',
    slider: 'h-12 self-stretch justify-center',
    sliderTrack:
      'h-1 self-stretch rounded-full bg-primary-tint disabled:opacity-40',
    sliderThumb: `size-5 rounded-full bg-primary transition-transform active:scale-110 motion-reduce:transition-none ${FOCUS_RING}`,
  },
  macos: {
    row: 'group flex-row items-start gap-2 self-stretch rounded-(--radius-xs) py-0.5 disabled:opacity-50',
    label: 'text-mac-body font-regular text-foreground',
    description:
      'text-mac-callout font-regular text-muted-foreground text-pretty',
    value: 'text-mac-body font-medium text-foreground',
    checkbox:
      'mt-px size-4 items-center justify-center rounded-sm border border-control-border bg-card shadow-card transition-colors checked:border-primary checked:bg-primary indeterminate:border-primary indeterminate:bg-primary',
    checkboxBox: '',
    radio:
      'mt-px size-4 items-center justify-center rounded-full border border-control-border bg-card shadow-card group-checked:border-primary group-checked:bg-primary',
    radioDot: 'size-1.5 rounded-full group-checked:bg-primary-foreground',
    radioRing: '',
    track:
      'h-5.5 w-9.5 justify-center rounded-full bg-track p-px transition-colors checked:bg-primary',
    thumb:
      'size-5 rounded-full bg-card shadow-card transition-transform checked:translate-x-4',
    slider: 'h-5 self-stretch justify-center',
    sliderTrack: 'h-1 self-stretch rounded-full bg-track disabled:opacity-50',
    sliderThumb: `size-5 rounded-full border border-hairline bg-card shadow-card transition-transform motion-reduce:transition-none ${FOCUS_RING}`,
  },
  windows: {
    row: 'group flex-row items-start gap-2.5 self-stretch rounded-(--radius-xs) py-1 disabled:opacity-50',
    label: 'text-win-body font-regular text-foreground',
    description:
      'text-win-caption font-regular text-muted-foreground text-pretty',
    value: 'text-win-body font-semibold text-foreground',
    checkbox:
      'size-5 items-center justify-center rounded-sm border border-control-border bg-card transition-colors hover:bg-muted checked:border-primary checked:bg-primary indeterminate:border-primary indeterminate:bg-primary',
    checkboxBox: '',
    radio:
      'size-5 items-center justify-center rounded-full border border-control-border bg-card group-checked:border-primary group-checked:bg-primary',
    radioDot:
      'size-2 rounded-full transition-transform group-hover:scale-110 group-checked:bg-primary-foreground',
    radioRing: '',
    track:
      'h-5 w-10 justify-center rounded-full border border-control-border bg-card px-0.75 transition-colors checked:border-primary checked:bg-primary',
    thumb:
      'size-3 rounded-full bg-control-border transition-all checked:translate-x-5 checked:bg-primary-foreground',
    slider: 'h-8 self-stretch justify-center',
    sliderTrack: 'h-1 self-stretch rounded-full bg-track disabled:opacity-50',
    sliderThumb: `size-5 rounded-full border-4 border-card bg-primary shadow-card transition-transform active:scale-90 motion-reduce:transition-none ${FOCUS_RING}`,
  },
});

const STYLE = CHOICE_STYLE;

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
        class={`${STYLE.row} ${FOCUS_RING}`}
        indicatorClass={STYLE.checkbox}
        indicator={
          STYLE.checkboxBox ? (
            <View class={STYLE.checkboxBox}>
              {marked() ? (
                <Glyph
                  icon={props.indeterminate ? IconMinus : IconCheck}
                  size="sm"
                  color="primary-foreground"
                />
              ) : null}
            </View>
          ) : marked() ? (
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
      <FieldErrorLine error={error()} inset />
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
  const error = fieldError(props);
  return (
    <View class="self-stretch gap-1">
      <BaseSwitch
        checked={field.get()}
        disabled={props.disabled || form?.disabled()}
        onChange={(event) => field.set(event.checked)}
        accessibilityLabel={props.label}
        class={`${STYLE.row} flex-row-reverse gap-3 ${FOCUS_RING}`}
        trackClass={STYLE.track}
        thumbClass={STYLE.thumb}
      >
        {props.labelHidden ? null : (
          <ChoiceLabel label={props.label} description={props.description} />
        )}
      </BaseSwitch>
      <FieldErrorLine error={error()} />
    </View>
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
    <PlainField
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
              class={`${STYLE.row} ${props.direction === 'row' ? 'self-auto' : ''} ${FOCUS_RING}`}
            >
              <View class={STYLE.radio}>
                {STYLE.radioRing ? (
                  <View class={STYLE.radioRing}>
                    <View class={STYLE.radioDot} />
                  </View>
                ) : (
                  <View class={STYLE.radioDot} />
                )}
              </View>
              <ChoiceLabel
                label={option().label}
                description={option().description}
              />
            </Radio>
          )}
        </Each>
      </BaseRadioGroup>
    </PlainField>
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
  const error = fieldError(props);
  const shown = () =>
    props.formatValue ? props.formatValue(field.get()) : String(field.get());
  return (
    <View class="self-stretch gap-2">
      <View class="flex-row items-end justify-between gap-3">
        <ChoiceLabel label={props.label} description={props.description} />
        <Text class={STYLE.value}>{shown()}</Text>
      </View>
      <BaseSlider
        value={field.get()}
        min={min()}
        max={props.max ?? 100}
        step={props.step ?? 1}
        disabled={props.disabled || form?.disabled()}
        accessibilityLabel={props.label}
        onChange={(event) => field.set(event.value as number)}
        class={STYLE.slider}
        trackClass={STYLE.sliderTrack}
        indicatorClass="h-full"
        rangeClass="rounded-full bg-primary"
        thumbClass={STYLE.sliderThumb}
      />
      <FieldErrorLine error={error()} />
    </View>
  );
}
