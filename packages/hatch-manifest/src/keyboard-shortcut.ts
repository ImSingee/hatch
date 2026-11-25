/**
 * Keyboard chords shared by App manifests and the platform shell.
 *
 * A chord is written as modifiers and one key joined by `+`, for example
 * `mod+K` or `mod+shift+P`. `mod` is Command on Apple platforms and Control
 * elsewhere. Manifest validation and the shell's runtime matcher use this one
 * vocabulary, so a chord an App reserves is exactly the chord the shell
 * compares against. Dependency-free so it runs in the browser and the server.
 */

const MODIFIERS = ['mod', 'ctrl', 'meta', 'alt', 'shift'] as const;
type Modifier = (typeof MODIFIERS)[number];

const MODIFIER_ALIASES: Record<string, Modifier> = {
  mod: 'mod',
  ctrl: 'ctrl',
  control: 'ctrl',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
};

/** `KeyboardEvent.code` of every non-letter, non-digit key a chord may name. */
const CODE_KEYS: Record<string, string> = {
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Space: 'space',
  Enter: 'enter',
  Escape: 'escape',
  Tab: 'tab',
  Backspace: 'backspace',
  Delete: 'delete',
  ArrowUp: 'arrowup',
  ArrowDown: 'arrowdown',
  ArrowLeft: 'arrowleft',
  ArrowRight: 'arrowright',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
};

const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  return: 'enter',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
};

const NAMED_KEYS = new Set([
  ...Object.values(CODE_KEYS),
  ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
]);

/** A chord in canonical form: lowercase, modifiers in a fixed order. */
export type KeyboardChord = {
  modifiers: ReadonlySet<Modifier>;
  key: string;
};

/**
 * Parse a chord, accepting any letter case, spacing around `+` and the common
 * modifier aliases (`cmd`, `option`, `control`). Returns an error message when
 * the text is not a chord a platform shortcut could use: it needs one key
 * and at least one of `mod`, `ctrl`, `meta` or `alt` (Shift alone only
 * changes what is typed).
 */
export function parseKeyboardChord(
  text: string,
): { ok: true; chord: KeyboardChord } | { ok: false; error: string } {
  const parts = text.split('+').map((part) => part.trim().toLowerCase());
  if (parts.some((part) => part === '')) {
    return {
      ok: false,
      error: `"${text}" is not a chord: join modifiers and one key with "+", e.g. "mod+K"`,
    };
  }
  const modifiers = new Set<Modifier>();
  for (const part of parts.slice(0, -1)) {
    const modifier = MODIFIER_ALIASES[part];
    if (!modifier) {
      return {
        ok: false,
        error: `"${part}" in "${text}" is not a modifier (use mod, ctrl, meta, alt or shift)`,
      };
    }
    if (modifiers.has(modifier)) {
      return { ok: false, error: `"${text}" repeats the modifier "${part}"` };
    }
    modifiers.add(modifier);
  }
  const last = parts.at(-1) ?? '';
  if (MODIFIER_ALIASES[last]) {
    return { ok: false, error: `"${text}" names no key after its modifiers` };
  }
  const key = KEY_ALIASES[last] ?? last;
  if (!/^[a-z0-9]$/.test(key) && !NAMED_KEYS.has(key)) {
    return {
      ok: false,
      error: `"${last}" in "${text}" is not a supported key`,
    };
  }
  if (
    !['mod', 'ctrl', 'meta', 'alt'].some((m) => modifiers.has(m as Modifier))
  ) {
    return {
      ok: false,
      error: `"${text}" needs at least one of mod, ctrl, meta or alt`,
    };
  }
  return { ok: true, chord: { modifiers, key } };
}

/** Canonical spelling, e.g. `mod+shift+k`. */
export function formatKeyboardChord(chord: KeyboardChord): string {
  return [
    ...MODIFIERS.filter((modifier) => chord.modifiers.has(modifier)),
    chord.key,
  ].join('+');
}

/** Canonical spelling of `text`, or null when it is not a valid chord. */
export function canonicalKeyboardChord(text: string): string | null {
  const parsed = parseKeyboardChord(text);
  return parsed.ok ? formatKeyboardChord(parsed.chord) : null;
}

/**
 * The physical chord `text` means on this platform: `mod` becomes `meta` on
 * Apple platforms and `ctrl` elsewhere. Two chords match when these agree.
 */
export function resolveKeyboardChord(
  text: string,
  apple: boolean,
): string | null {
  const parsed = parseKeyboardChord(text);
  if (!parsed.ok) return null;
  const modifiers = new Set(parsed.chord.modifiers);
  if (modifiers.delete('mod')) modifiers.add(apple ? 'meta' : 'ctrl');
  return formatKeyboardChord({ modifiers, key: parsed.chord.key });
}

/** The fields of a `KeyboardEvent` the matcher reads. */
export type KeyboardChordEvent = Pick<
  KeyboardEvent,
  'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'
>;

/**
 * The physical chord a key press produced, in the form `resolveKeyboardChord`
 * returns, or null for a key no chord can name. Letters and digits follow the
 * typed character so other keyboard layouts match the key labelled K; when a
 * modifier changes the character (Option on macOS, Shift on digits) the
 * physical key decides. Punctuation and named keys always use the physical key.
 */
export function keyboardEventChord(event: KeyboardChordEvent): string | null {
  let key: string | undefined;
  if (/^[a-z0-9]$/i.test(event.key)) key = event.key.toLowerCase();
  else if (/^Key[A-Z]$/.test(event.code))
    key = event.code.slice(3).toLowerCase();
  else if (/^Digit[0-9]$/.test(event.code)) key = event.code.slice(5);
  else if (/^F([1-9]|1[0-2])$/.test(event.code)) key = event.code.toLowerCase();
  else key = CODE_KEYS[event.code];
  if (!key) return null;
  const modifiers = new Set<Modifier>();
  if (event.ctrlKey) modifiers.add('ctrl');
  if (event.metaKey) modifiers.add('meta');
  if (event.altKey) modifiers.add('alt');
  if (event.shiftKey) modifiers.add('shift');
  return formatKeyboardChord({ modifiers, key });
}
