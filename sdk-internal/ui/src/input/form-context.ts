import { cleanup, context, signal } from 'nsh';

/** A value a form field holds. */
export type FieldValue = string | number | boolean | readonly string[] | null;

/** The values of a form, by field `name`. */
export type FormValues = Record<string, FieldValue>;

/** What a field inside a `Form` reads and writes. */
export type FormApi = {
  /** The field's current value (reactive), `undefined` before any. */
  value: (name: string) => FieldValue | undefined;
  setValue: (name: string, value: FieldValue) => void;
  /** The field's error from the last submit (reactive). */
  error: (name: string) => string | undefined;
  /** Registers a field so the form checks `required` on submit and sends
   * `controlled()` when the App controls the field's value; `keep: false`
   * leaves its value out of the draft (passwords). */
  register: (
    name: string,
    field: {
      required: () => boolean;
      keep?: boolean;
      controlled: () => FieldValue | undefined;
    },
  ) => () => void;
  /** Submits the form, as a `Button` with `type="submit"` does. */
  submit: () => void;
  /** True while `onSubmit`'s promise runs (reactive). */
  submitting: () => boolean;
  disabled: () => boolean;
};

export const FormContext = context<FormApi | null>(null);

/**
 * A field's value and setter. The value is `value` when the App controls it,
 * else the form's when the field has a `name` inside a `Form`, else the
 * field's own, starting at `initial`. A named field inside a `Form` is
 * registered with it: the form checks `required` and sends the field's value,
 * the App's `value` when it controls the field. `keep: false` leaves the value
 * out of the form's draft (passwords).
 */
export function bindField<T extends FieldValue>(
  form: FormApi | null,
  props: {
    name?: string;
    value?: T;
    required?: boolean;
    onChange?: (value: T) => void;
  },
  initial: T,
  options: { keep?: boolean } = {},
): { get: () => T; set: (value: T) => void } {
  const own = signal<T>(initial);
  if (form && props.name !== undefined) {
    cleanup(
      form.register(props.name, {
        required: () => props.required === true,
        keep: options.keep,
        controlled: () => props.value,
      }),
    );
  }
  return {
    get: () => {
      if (props.value !== undefined) return props.value;
      if (form && props.name !== undefined) {
        const value = form.value(props.name);
        return value === undefined ? initial : (value as T);
      }
      return own();
    },
    set: (value: T) => {
      own.set(value);
      if (form && props.name !== undefined) form.setValue(props.name, value);
      props.onChange?.(value);
    },
  };
}
