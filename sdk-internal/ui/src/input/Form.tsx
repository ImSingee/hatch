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

type FormField = {
  required: () => boolean;
  secret: () => boolean;
  initial: FieldValue;
  controlled: () => FieldValue | undefined;
};

export type { FieldValue, FormValues };

export type FormProps = {
  /** Names the form's draft: unique in the App and stable across releases,
   * such as `"new-expense"` or `"edit-note"`. */
  id: string;
  /** Runs when the form is submitted and every required field has a value.
   * A promise keeps submit buttons busy; a rejection shows its message above
   * the fields. The draft is deleted once it resolves. */
  onSubmit: (values: FormValues) => unknown;
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

/** The newest `Form` made for each draft key, by a number each form takes
 * when it is made. The newest form owns the draft, mounted or not: an older
 * one that went away never touches the key again once a newer one exists. */
const newestForm = new Map<string, number>();
const formCount: { made: number } = { made: 0 };
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

/** Whether `value` is an unsent change from `base`: any difference,
 * including clearing a value, but not one empty spelling for another. */
function changedFrom(
  value: FieldValue | undefined,
  base: FieldValue | undefined,
): boolean {
  if (isEmpty(value) || isEmpty(base)) return isEmpty(value) !== isEmpty(base);
  return JSON.stringify(value) !== JSON.stringify(base);
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
  const fields = new Map<string, FormField>();
  // Names never kept in a draft (passwords), remembered after their field
  // goes so its value cannot reach a later draft.
  const secrets = new Set<string>();
  // Names the user changed before the draft finished loading: the draft
  // does not overwrite them.
  const changedWhileLoading = new Set<string>();
  const draftKey = DRAFT_PREFIX + props.id;
  const saveDraft = () => props.saveDraft !== false;

  // The draft: restored once, then saved a moment after each change and at
  // once when the App goes to the background. `sent` is what the fields held
  // when last sent (else `initialValues`): only changes from it are a draft.
  const draft: {
    loaded: boolean;
    timer: number | undefined;
    sent: FormValues;
    gone: boolean;
  } = {
    loaded: false,
    timer: undefined,
    sent: initial,
    gone: false,
  };
  // Resolves once the stored draft has been read and merged.
  let markLoaded = (): void => undefined;
  const loading = new Promise<void>((resolve) => {
    markLoaded = resolve;
  });
  const stopTimer = () => {
    clearTimeout(draft.timer);
    draft.timer = undefined;
  };
  // The newest form made with this id owns the draft: only it reads it back
  // into its own fields' storage, writes it or removes it. An older form,
  // open or closed, leaves the key alone once a newer one exists.
  formCount.made += 1;
  const generation = formCount.made;
  newestForm.set(draftKey, generation);
  const ownsDraft = () => newestForm.get(draftKey) === generation;

  // What the form sends: what each field shows. That is the App's `value`
  // for a controlled field, else the form's value, else the field's starting
  // value (a slider's minimum, an unchecked box).
  const effectiveValues = (): FormValues => {
    const current = { ...values() };
    for (const [name, field] of fields) {
      const controlled = field.controlled();
      if (controlled !== undefined) current[name] = controlled;
      else if (current[name] === undefined) current[name] = field.initial;
    }
    return current;
  };
  // A draft leaves out passwords and controlled fields: the App keeps the
  // latter itself, and the field shows the App's value, not a restored one.
  // A field that was a password once stays out for the form's lifetime.
  const keptValues = (): FormValues => {
    for (const [name, field] of fields) if (field.secret()) secrets.add(name);
    return Object.fromEntries(
      Object.entries(values()).filter(
        ([name]) =>
          !secrets.has(name) && fields.get(name)?.controlled() === undefined,
      ),
    );
  };
  const writeDraft = async (): Promise<void> => {
    stopTimer();
    if (!draft.loaded || !saveDraft() || !ownsDraft()) return;
    const kept = untracked(keptValues);
    const changed = Object.entries(kept).some(([name, value]) =>
      changedFrom(value, draft.sent[name]),
    );
    await (
      changed
        ? Storage.setItem(draftKey, JSON.stringify(kept))
        : Storage.removeItem(draftKey)
    ).catch(() => {
      // A full store keeps the previous draft; typing goes on.
    });
  };
  // Input typed while the draft loaded is saved once it has.
  const finishLoading = () => {
    draft.loaded = true;
    markLoaded();
    if (changedWhileLoading.size > 0) void writeDraft();
  };
  if (saveDraft()) {
    Storage.getItem(draftKey).then((text) => {
      if (text) {
        try {
          const saved = Object.fromEntries(
            Object.entries(JSON.parse(text) as FormValues).filter(
              ([name]) => !changedWhileLoading.has(name),
            ),
          );
          if (Object.keys(saved).length > 0) {
            batch(() => {
              values.set({ ...untracked(values), ...saved });
              restored.set(true);
            });
          }
        } catch {
          // Unreadable: removed, unless a newer form with this id already
          // owns the key and may have saved its own input there.
          if (ownsDraft()) void Storage.removeItem(draftKey);
        }
      }
      finishLoading();
    }, finishLoading);
  } else {
    draft.loaded = true;
    markLoaded();
  }
  effect(() => {
    values();
    if (!draft.loaded) return;
    stopTimer();
    draft.timer = setTimeout(() => void writeDraft(), SAVE_DELAY_MS);
  });
  effect(() => {
    if (lifecycle() === 'background') void writeDraft();
  });
  cleanup(() => {
    void writeDraft();
    draft.gone = true;
  });

  const discardDraft = () => {
    batch(() => {
      values.set({ ...draft.sent });
      errors.set({});
      restored.set(false);
    });
    if (ownsDraft()) void Storage.removeItem(draftKey);
  };

  // After the form went away. Once a newer form with the same id exists
  // (open or closed since), the draft is its own: left alone, whatever it
  // holds. Otherwise nothing else has written the key, and the stored draft
  // (this form's last input) is removed only when it holds nothing but what
  // was just sent; input made after the send stays a draft. Ownership is
  // checked again right before removing, as a newer form may be made while
  // the draft is read.
  const forgetSentDraft = async (sent: FormValues) => {
    if (!saveDraft() || !ownsDraft()) return;
    const stored = await Storage.getItem(draftKey).catch(() => null);
    if (stored === null) return;
    let values: FormValues;
    try {
      values = JSON.parse(stored) as FormValues;
    } catch {
      return;
    }
    const unsent = Object.entries(values).some(([name, value]) =>
      changedFrom(value, sent[name]),
    );
    if (!unsent && ownsDraft())
      await Storage.removeItem(draftKey).catch(() => undefined);
  };

  const submit = async () => {
    if (submitting() || props.disabled) return;
    submitting.set(true);
    try {
      // Values are read once the stored draft is in, so what is sent is
      // what the fields show.
      await loading;
      // Closed while the draft loaded: its fields are gone, so nothing
      // is sent.
      if (draft.gone) return;
      const current = untracked(effectiveValues);
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
      await props.onSubmit(current);
      // Sent: these values are no longer a draft. Input typed while sending
      // still is, so the draft is rewritten rather than deleted.
      draft.sent = current;
      restored.set(false);
      await (draft.gone ? forgetSentDraft(current) : writeDraft());
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
      if (!draft.loaded) changedWhileLoading.add(name);
      batch(() => {
        values.set({ ...untracked(values), [name]: value });
        if (untracked(errors)[name]) {
          const { [name]: _cleared, ...rest } = untracked(errors);
          errors.set(rest);
        }
      });
    },
    move: (from, to) => {
      const current = untracked(values);
      if (current[from] === undefined) return;
      // The old name leaves the form; its value moves unless the new name
      // already has one, which is kept.
      const { [from]: moved, ...rest } = current;
      // A password stays one under its new name, shown as text or not.
      if (secrets.has(from) || fields.get(from)?.secret()) {
        secrets.add(from);
        secrets.add(to);
      }
      values.set(
        current[to] === undefined
          ? { ...rest, [to]: moved as FieldValue }
          : rest,
      );
    },
    error: (name) => errors()[name],
    register: (name, field) => {
      const secret = field.secret ?? (() => false);
      // A password is remembered as one as soon as the field is one (when
      // it registers, or when it becomes one), so its value never reaches a
      // draft, even after the field is gone or shown as text. A value the
      // draft already holds is taken out at once.
      effect(() => {
        if (!secret()) return;
        untracked(() => {
          if (secrets.has(name)) return;
          secrets.add(name);
          if (draft.loaded && values()[name] !== undefined) void writeDraft();
        });
      });
      fields.set(name, {
        required: field.required,
        secret,
        initial: field.initial,
        controlled: field.controlled,
      });
      return () => {
        if (untracked(secret)) secrets.add(name);
        fields.delete(name);
      };
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
