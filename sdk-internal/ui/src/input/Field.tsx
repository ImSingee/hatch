import { Text, View, cleanup } from 'nsh';
import type { JSX } from 'nsh';
import { Glyph } from '../icons/Icon';
import { IconAlertCircle } from '../icons/icons.gen';
import { FormContext } from './form-context';

/** Props every form control shares. */
export type FieldProps = {
  /** The label above the control, in sentence case. Screen readers read it
   * as the control's name. */
  label: string;
  /** One sentence under the label: what to enter, or what it is for. */
  description?: string;
  /** An error under the control. Inside a `Form`, the form's errors for the
   * field's `name` show here as well. */
  error?: string;
  /** Marks the field as required; a `Form` refuses to submit while it is
   * empty. */
  required?: boolean;
  disabled?: boolean;
  /** The key of the value in its `Form`: the form keeps the value, restores
   * it from the draft and passes it to `onSubmit`. */
  name?: string;
};

/** The error a field shows: its own, else its form's for its `name`. */
export function fieldError(props: Pick<FieldProps, 'error' | 'name'>) {
  const form = FormContext();
  return (): string | undefined =>
    props.error ??
    (form && props.name !== undefined ? form.error(props.name) : undefined);
}

/** Registers a named field with its form, so `required` is checked. */
export function useFormField(
  props: Pick<FieldProps, 'name' | 'required'>,
  options: { keep?: boolean } = {},
): void {
  const form = FormContext();
  if (!form || props.name === undefined) return;
  cleanup(
    form.register(props.name, {
      required: () => props.required === true,
      keep: options.keep,
    }),
  );
}

/** A form control's label, description and error around the control. */
export function Field(
  props: Omit<FieldProps, 'name' | 'disabled'> & {
    /** The control. */
    children?: JSX.Element;
    /** Leaves the label to screen readers (the control names itself with
     * it): only for a search field whose icon and placeholder say what it
     * is for. */
    labelHidden?: boolean;
  },
): JSX.Element {
  return (
    <View class="self-stretch gap-1.5">
      {props.labelHidden ? null : (
        <View class="gap-0.5">
          <View class="flex-row gap-1">
            <Text class="text-body font-label text-field-label">
              {props.label}
            </Text>
            {props.required ? (
              <Text
                class="text-body font-label text-danger-strong"
                importantForAccessibility="no"
              >
                *
              </Text>
            ) : null}
          </View>
          {props.description ? (
            <Text class="text-caption text-muted-foreground text-pretty">
              {props.description}
            </Text>
          ) : null}
        </View>
      )}
      {props.children}
      {props.error ? (
        <View class="flex-row items-start gap-1.5" role="alert">
          <View class="pt-0.5">
            <Glyph icon={IconAlertCircle} size="sm" color="danger-strong" />
          </View>
          <Text class="flex-1 text-caption font-strong text-danger-strong">
            {props.error}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** The well a text-like control sits in (DESIGN.md "Field"). */
export const WELL =
  'flex-row items-center gap-2 self-stretch rounded-(--radius-md) border bg-card px-3 transition-colors focus-within:border-ring focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring';

/** 36 points; on touch 46, so the input inside its 1-point border keeps a
 * 44-point target. */
export const WELL_HEIGHT = 'h-9 pointer-coarse:h-11.5';

export function wellState(invalid: boolean, disabled: boolean): string {
  if (disabled) return 'border-input bg-muted';
  return invalid ? 'border-danger' : 'border-input';
}

/** The text inside a well. */
export const WELL_TEXT =
  'text-body font-strong text-foreground placeholder:text-muted-foreground pointer-coarse:text-body-lg disabled:text-muted-foreground';
