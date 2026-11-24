import {
  Storage,
  Text,
  View,
  batch,
  cleanup,
  effect,
  lifecycle,
  signal,
  untracked,
} from 'nsh';
import type { JSX } from 'nsh';
import { GAP } from '../core/styles';
import type { Space } from '../core/types';
import { Glyph } from '../icons/Icon';
import { IconAlertCircle, IconHistory } from '../icons/icons.gen';
import { Button } from './Button';
import { FormContext } from './form-context';
import type { FieldValue, FormApi, FormValues } from './form-context';

export type { FieldValue, FormValues };

export type FormProps = {
  /** Names the form's draft: unique in the App and stable across releases,
   * such as `"new-expense"` or `"edit-note"`. */
  id: string;
  /** Runs when the form is submitted and every required field has a value.
   * A promise keeps submit buttons busy; a rejection shows its message above
   * the fields. The draft is deleted once it resolves. */
  onSubmit: (values: FormValues) => void | Promise<void>;
  /** Values the fields start with, by `name`. */
  initialValues?: FormValues;
  /** Extra checks on submit: an error message by field `name`, or nothing. */
  validate?: (values: FormValues) => Record<string, string> | undefined;
  /** Keeps unsent input on the device so it survives the shell stopping a
   * hidden App. Default true. Password fields are never kept. */
  saveDraft?: boolean;
  /** Turns every field and submit button off. */
  disabled?: boolean;
  /** Space between the fields; default `lg` (16 points). */
  gap?: Space;
  /** Fields with a `name`, and a `Button` with `type="submit"`. */
  children?: JSX.Element;
};

const DRAFT_PREFIX = 'hatch.ui.draft.';
const SAVE_DELAY_MS = 400;
const REQUIRED_MESSAGE = 'Fill in this field.';

function isEmpty(value: FieldValue | undefined): boolean {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

function sameValues(a: FormValues, b: FormValues): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A form: keeps its named fields' values, saves them as a draft while the
 * user types, checks required fields and submits.
 */
export function Form(props: FormProps): JSX.Element {
  const initial: FormValues = { ...props.initialValues };
  const values = signal<FormValues>({ ...initial });
  const errors = signal<Record<string, string>>({});
  const submitting = signal(false);
  const failure = signal<string | null>(null);
  const restored = signal(false);
  const fields = new Map<string, { required: () => boolean; keep: boolean }>();
  const draftKey = DRAFT_PREFIX + props.id;
  const saveDraft = () => props.saveDraft !== false;

  // The draft: restored once, then saved a moment after each change and at
  // once when the App goes to the background.
  const draft: { loaded: boolean; timer: number | undefined } = {
    loaded: false,
    timer: undefined,
  };
  const stopTimer = () => {
    clearTimeout(draft.timer);
    draft.timer = undefined;
  };
  const keptValues = (): FormValues =>
    Object.fromEntries(
      Object.entries(values()).filter(
        ([name]) => fields.get(name)?.keep !== false,
      ),
    );
  const writeDraft = () => {
    stopTimer();
    if (!draft.loaded || !saveDraft()) return;
    const kept = untracked(keptValues);
    const changed = Object.entries(kept).some(
      ([name, value]) =>
        !sameValues({ value }, { value: initial[name] ?? null }) &&
        !isEmpty(value),
    );
    const pending = changed
      ? Storage.setItem(draftKey, JSON.stringify(kept))
      : Storage.removeItem(draftKey);
    pending.catch(() => {
      // A full store keeps the previous draft; typing goes on.
    });
  };
  if (saveDraft()) {
    Storage.getItem(draftKey).then(
      (text) => {
        if (text) {
          try {
            const saved = JSON.parse(text) as FormValues;
            batch(() => {
              values.set({ ...untracked(values), ...saved });
              restored.set(true);
            });
          } catch {
            void Storage.removeItem(draftKey);
          }
        }
        draft.loaded = true;
      },
      () => {
        draft.loaded = true;
      },
    );
  } else {
    draft.loaded = true;
  }
  effect(() => {
    values();
    if (!draft.loaded) return;
    stopTimer();
    draft.timer = setTimeout(writeDraft, SAVE_DELAY_MS);
  });
  effect(() => {
    if (lifecycle() === 'background') writeDraft();
  });
  cleanup(() => writeDraft());

  const discardDraft = () => {
    batch(() => {
      values.set({ ...initial });
      errors.set({});
      restored.set(false);
    });
    void Storage.removeItem(draftKey);
  };

  const submit = async () => {
    if (submitting() || props.disabled) return;
    const current = values();
    const found: Record<string, string> = {};
    for (const [name, field] of fields) {
      if (field.required() && isEmpty(current[name]))
        found[name] = REQUIRED_MESSAGE;
    }
    Object.assign(found, props.validate?.(current) ?? {});
    batch(() => {
      errors.set(found);
      failure.set(null);
    });
    if (Object.keys(found).length > 0) return;
    submitting.set(true);
    try {
      await props.onSubmit(current);
      stopTimer();
      restored.set(false);
      await Storage.removeItem(draftKey).catch(() => undefined);
    } catch (error) {
      failure.set(
        error instanceof Error && error.message
          ? error.message
          : 'Could not submit. Try again.',
      );
    } finally {
      submitting.set(false);
    }
  };

  const api: FormApi = {
    value: (name) => values()[name],
    setValue: (name, value) => {
      batch(() => {
        values.set({ ...untracked(values), [name]: value });
        if (untracked(errors)[name]) {
          const { [name]: _cleared, ...rest } = untracked(errors);
          errors.set(rest);
        }
      });
    },
    error: (name) => errors()[name],
    register: (name, field) => {
      fields.set(name, { required: field.required, keep: field.keep ?? true });
      return () => fields.delete(name);
    },
    submit: () => void submit(),
    submitting: () => submitting(),
    disabled: () => props.disabled === true,
  };

  return (
    <FormContext.Provider value={api}>
      <View class={`self-stretch flex-col ${GAP[props.gap ?? 'lg']}`}>
        {restored() ? (
          <View class="flex-row items-center gap-2 self-stretch rounded-(--radius-md) bg-surface-hover px-3 py-1.5">
            <Glyph icon={IconHistory} size="sm" color="muted-foreground" />
            <Text class="flex-1 text-caption font-strong text-muted-foreground">
              Restored your unsent changes.
            </Text>
            <Button
              label="Discard"
              kind="subtle"
              size="sm"
              onPress={discardDraft}
            />
          </View>
        ) : null}
        {failure() ? (
          <View
            role="alert"
            class="flex-row items-start gap-2 self-stretch rounded-(--radius-md) bg-danger-tint px-3 py-2.5"
          >
            <View class="pt-0.5">
              <Glyph
                icon={IconAlertCircle}
                size="md"
                color="danger-tint-foreground"
              />
            </View>
            <Text class="flex-1 text-body font-strong text-danger-tint-foreground">
              {failure() ?? ''}
            </Text>
          </View>
        ) : null}
        {props.children}
      </View>
    </FormContext.Provider>
  );
}
