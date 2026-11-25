import { cleanup, context, effect, signal, untracked } from 'nsh';

/** A value a form field holds. */
export type FieldValue = string | number | boolean | readonly string[] | null;

/** The values of a form, by field `name`. */
export type FormValues = Record<string, FieldValue>;

/** What a field inside a `Form` reads and writes. */
export type FormApi = {
  /** The field's current value (reactive), `undefined` before any. */
  value: (name: string) => FieldValue | undefined;
  setValue: (name: string, value: FieldValue) => void;
  /** A field renamed from `from` to `to`: `from` leaves the form, and its
   * value moves to `to` unless `to` already has one. */
  move: (from: string, to: string) => void;
  /** The field's error from the last submit (reactive). */
  error: (name: string) => string | undefined;
  /** Registers a field so the form checks `required` on submit and sends
   * `controlled()` when the App controls the field's value, else the value
   * the field shows (`initial` until the user changes it); while `secret()`
   * holds (a password) its value is left out of the draft, and stays out for
   * the form's lifetime once it has. */
  register: (
    name: string,
    field: {
      required: () => boolean;
      secret?: () => boolean;
      initial: FieldValue;
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
 * the App's `value` when it controls the field. While `secret()` holds
 * (passwords) the value is left out of the form's draft.
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
  options: { secret?: () => boolean } = {},
): { get: () => T; set: (value: T) => void } {
  const own = signal<T>(initial);
  if (form) {
    // Registered under the current `name`, again whenever it changes; the
    // value typed under the old name moves to the new one.
    const registered: { name: string | undefined } = { name: undefined };
    effect(() => {
      const name = props.name;
      if (name === undefined) return;
      untracked(() => {
        const previous = registered.name;
        if (previous !== undefined && previous !== name)
          form.move(previous, name);
        registered.name = name;
        cleanup(
          form.register(name, {
            required: () => props.required === true,
            secret: options.secret,
            initial,
            controlled: () => props.value,
          }),
        );
      });
    });
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
