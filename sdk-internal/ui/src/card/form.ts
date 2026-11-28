/**
 * A card's questions: the inputs inside it are one form, as a notification's
 * inline inputs are its reply form. Fields register with their card (a
 * markup card brings its compiled form instead); answers are the
 * notification answer shape, checked with the same rules, and reach the App
 * through `onSubmit`.
 */
import { cleanup, computed, context, host, signal } from 'nsh';
import type { Accessor } from 'nsh';
import type { ContentTone } from './content/catalog.gen';
import { parseHatchLink } from './content/deep-link.gen';
import {
  ReplyAnswerError,
  answerOf,
  defaultAnswers,
  submitsWithButtons,
  validateAnswers,
} from './content/reply.gen';
import type { ReplyAnswers, ReplyForm } from './content/reply.gen';
import { normalizeReplyForm } from './content/reply-form.gen';
import type { ReplyFieldInput } from './content/reply-form.gen';

/** What an App passes a card to take its answers and open its links. */
export type CardAnswerProps = {
  /** Called with the answers when the card is submitted: its submit button,
   * or the last row of `Buttons`. A returned promise shows the card busy
   * until it settles; a rejection shows its message on the card. Without
   * it the card's inputs are only shown, with their defaults. */
  onSubmit?: (answers: ReplyAnswers) => void | Promise<void>;
  /** Called with the answers as people change them. */
  onChange?: (answers: ReplyAnswers) => void;
  /** An answer already given: the inputs show it read-only, and the status
   * becomes the chosen option's `thenStatus`. */
  answers?: ReplyAnswers | null;
  /** Shows the card busy, as while `onSubmit`'s promise runs. */
  busy?: boolean;
  /** The submit button's text when the card adds one; default "Submit". */
  submitLabel?: string;
  /** Keeps the card answerable after a submit, with its inputs reset.
   * Without it a submitted card shows its answers read-only. */
  repeatable?: boolean;
  /** Opens a link of the card (`Link`, `Step href`, `Button href`). Without
   * it the card opens links to other Apps (`hatch://app/<slug>#route`) and
   * shows other links as text. */
  onLinkPress?: (href: string) => void;
};

export type CardMode = 'live' | 'answered' | 'preview';

/** A status a chosen option puts on the card. */
export type CardTransition = { label: string; tone: ContentTone };

/** A field as an input registers it. */
export type CardField = {
  field: ReplyFieldInput;
  /** `thenStatus` of its options, by option id. */
  transitions: Record<string, CardTransition>;
};

export type CardScope = {
  mode: Accessor<CardMode>;
  /** What an input shows: the draft, the answer, or the defaults. */
  value(fieldId: string): string | string[] | undefined;
  set(fieldId: string, value: string | string[] | undefined): void;
  /** A button of a `Buttons` row was pressed. */
  pick(fieldId: string, optionId: string): void;
  submit(): void;
  busy: Accessor<boolean>;
  formError: Accessor<string | undefined>;
  fieldError(fieldId: string): string | undefined;
  /** Whether this field's buttons submit the card. */
  submitsWith(fieldId: string): boolean;
  /** Whether the card adds a submit button of its own. */
  needsSubmit: Accessor<boolean>;
  submitLabel: Accessor<string>;
  /** The status the answer put on the card, if any. */
  transition: Accessor<CardTransition | null>;
  register(field: () => CardField): void;
  registerSubmit(): void;
  /** Opens a link, or null when the card cannot open it. */
  linkAction(href: string): (() => void) | null;
};

export const CardContext = context<CardScope | null>(null);

/** Why answers were refused, in words for under the field. */
function problemText(form: ReplyForm, error: ReplyAnswerError): string {
  const field = form.fields.find((entry) => entry.id === error.field);
  const reason = error.field
    ? error.message.slice(`answers.${error.field}: `.length)
    : error.message;
  if (field && reason === 'is required') {
    return field.type === 'text' ? 'Enter an answer.' : 'Choose an answer.';
  }
  if (field?.type === 'multiple' && reason.startsWith('select ')) {
    return field.minSelected === field.maxSelected
      ? `Choose ${field.minSelected}.`
      : `Choose ${field.minSelected} to ${field.maxSelected}.`;
  }
  if (field?.type === 'text' && reason.startsWith('must be at most')) {
    return `Use at most ${field.maxLength} characters.`;
  }
  return `${reason[0]?.toUpperCase() ?? ''}${reason.slice(1)}.`;
}

/**
 * The form of a card: `compiled` for a card from markup or a tree, else the
 * fields its inputs register.
 */
export function createCardScope(
  props: CardAnswerProps,
  compiled: Accessor<{
    form: ReplyForm | null;
    transitions: Map<string, Record<string, CardTransition>>;
  } | null>,
): CardScope {
  const registered = signal<(() => CardField)[]>([]);
  const submits = signal(0);
  const draft = signal<ReplyAnswers>({});
  const touched = signal<ReadonlySet<string>>(new Set());
  const submitted = signal<ReplyAnswers | null>(null);
  const pending = signal(false);
  const error = signal<{ field: string | null; text: string } | null>(null);

  const built = computed(
    (): {
      form: ReplyForm | null;
      transitions: Map<string, Record<string, CardTransition>>;
      issue: string | null;
    } => {
      const given = compiled();
      if (given) {
        return {
          form: given.form,
          transitions: given.transitions,
          issue: null,
        };
      }
      const fields = registered().map((entry) => entry());
      if (fields.length === 0) {
        return { form: null, transitions: new Map(), issue: null };
      }
      const { form, issues } = normalizeReplyForm({
        fields: fields.map((entry) => entry.field),
        submitLabel: props.submitLabel,
      });
      return {
        form: issues.length === 0 ? form : null,
        transitions: new Map(
          fields.map((entry) => [entry.field.id, entry.transitions]),
        ),
        // A mistake in the App's own card: shown where its author sees it.
        issue:
          issues.length > 0
            ? `This card's questions are not valid: ${issues[0]!.path.join('.')}: ${issues[0]!.message}`
            : null,
      };
    },
  );
  const form = () => built().form;

  const answered = (): ReplyAnswers | null =>
    props.answers ?? submitted() ?? null;
  const mode = (): CardMode =>
    answered() ? 'answered' : props.onSubmit && form() ? 'live' : 'preview';

  /** The draft with the defaults of fields nobody touched. */
  const current = (): ReplyAnswers => {
    const reply = form();
    const answers: ReplyAnswers = reply ? defaultAnswers(reply) : {};
    // Only the questions the card asks now: an input taken away keeps no
    // answer.
    const asked = new Set(reply?.fields.map((field) => field.id));
    for (const id of touched()) {
      if (!asked.has(id)) continue;
      const value = answerOf(draft(), id);
      if (value === undefined) delete answers[id];
      else answers[id] = value;
    }
    return answers;
  };

  const check = (input: ReplyAnswers): ReplyAnswers | null => {
    const reply = form();
    if (!reply) return null;
    try {
      const checked = validateAnswers(reply, input);
      error.set(null);
      return checked;
    } catch (caught) {
      if (!(caught instanceof ReplyAnswerError)) throw caught;
      error.set({ field: caught.field, text: problemText(reply, caught) });
      return null;
    }
  };

  const send = (answers: ReplyAnswers) => {
    if (pending() || props.busy || !props.onSubmit) return;
    // The form that took these answers: a submit that settles after the
    // card's questions changed answers nothing on the new ones.
    const asked = form();
    let result: void | Promise<void>;
    try {
      // The App gets its own copy: what it does with it never changes the
      // answer the card shows.
      result = props.onSubmit(copyAnswers(answers));
    } catch (caught) {
      error.set({ field: null, text: messageOf(caught) });
      return;
    }
    const done = () => {
      if (props.repeatable) {
        draft.set({});
        touched.set(new Set());
      } else if (form() === asked) {
        submitted.set(answers);
      }
    };
    if (result && typeof (result as Promise<void>).then === 'function') {
      pending.set(true);
      (result as Promise<void>).then(
        () => {
          pending.set(false);
          done();
        },
        (caught: unknown) => {
          pending.set(false);
          error.set({ field: null, text: messageOf(caught) });
        },
      );
    } else {
      done();
    }
  };

  const submitsWith = (fieldId: string) => {
    const reply = form();
    return Boolean(
      reply && submitsWithButtons(reply) && reply.fields.at(-1)?.id === fieldId,
    );
  };

  const set = (fieldId: string, value: string | string[] | undefined) => {
    const next = { ...draft() };
    if (value === undefined || value === '' || value.length === 0) {
      delete next[fieldId];
    } else {
      next[fieldId] = value;
    }
    draft.set(next);
    touched.set(new Set([...touched(), fieldId]));
    if (error()?.field === fieldId) error.set(null);
    props.onChange?.(current());
  };

  return {
    mode,
    value: (fieldId) => {
      const shown = answered();
      if (shown) return answerOf(shown, fieldId);
      return answerOf(current(), fieldId);
    },
    set,
    pick: (fieldId, optionId) => {
      if (mode() !== 'live' || pending() || props.busy) return;
      if (!submitsWith(fieldId)) {
        set(
          fieldId,
          answerOf(current(), fieldId) === optionId ? undefined : optionId,
        );
        return;
      }
      const checked = check({ ...current(), [fieldId]: optionId });
      if (checked) send(checked);
    },
    submit: () => {
      if (mode() !== 'live') return;
      const checked = check(current());
      if (checked) send(checked);
    },
    busy: () => pending() || props.busy === true,
    formError: () =>
      built().issue ??
      (error() && error()!.field === null ? error()!.text : undefined),
    fieldError: (fieldId) =>
      error()?.field === fieldId ? error()!.text : undefined,
    submitsWith,
    needsSubmit: () => {
      const reply = form();
      return Boolean(reply && submits() === 0 && !submitsWithButtons(reply));
    },
    // The button the card adds: the App's label first. A card's own
    // `Submit` names itself.
    submitLabel: () => props.submitLabel ?? form()?.submitLabel ?? 'Submit',
    transition: () => {
      const shown = answered();
      if (!shown) return null;
      for (const [fieldId, options] of built().transitions) {
        const answer = answerOf(shown, fieldId);
        const chosen = Array.isArray(answer) ? answer : answer ? [answer] : [];
        for (const [optionId, transition] of Object.entries(options)) {
          if (chosen.includes(optionId)) return transition;
        }
      }
      return null;
    },
    register: (field) => {
      registered.set([...registered(), field]);
      cleanup(() => {
        registered.set(registered().filter((entry) => entry !== field));
        // A question taken away takes its draft with it: one that comes
        // back starts again.
        const id = field().field.id;
        if (touched().has(id)) {
          const next = { ...draft() };
          delete next[id];
          draft.set(next);
          touched.set(new Set([...touched()].filter((entry) => entry !== id)));
        }
      });
    },
    registerSubmit: () => {
      submits.set(submits() + 1);
      cleanup(() => submits.set(submits() - 1));
    },
    linkAction: (href) => linkAction(href, props.onLinkPress),
  };
}

function copyAnswers(answers: ReplyAnswers): ReplyAnswers {
  return Object.fromEntries(
    Object.entries(answers).map(([id, value]) => [
      id,
      Array.isArray(value) ? [...value] : value,
    ]),
  );
}

function messageOf(caught: unknown): string {
  if (caught instanceof Error && caught.message) return caught.message;
  if (typeof caught === 'string' && caught) return caught;
  return 'Something went wrong.';
}

/**
 * How a press opens `href`: the App's `onLinkPress`, else the shell for a
 * link to another App on this instance. Native Apps may not open other
 * links themselves, so without `onLinkPress` they are not pressable.
 */
export function linkAction(
  href: string,
  onLinkPress: ((href: string) => void) | undefined,
): (() => void) | null {
  if (onLinkPress) return () => onLinkPress(href);
  const link = parseHatchLink(href);
  const [root, slug, ...rest] = link?.segments ?? [];
  if (
    link &&
    link.instance === null &&
    root === 'app' &&
    slug &&
    rest.length === 0 &&
    host.available()
  ) {
    return () => {
      void host.call('hatch.nav.open', { slug, route: link.hash ?? '' });
    };
  }
  return null;
}

/** The field ids a card's compiled form asks, with their options' statuses. */
export type CompiledForm = {
  form: ReplyForm | null;
  transitions: Map<string, Record<string, CardTransition>>;
};
