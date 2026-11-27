import { Text, View } from 'nsh';
import type { JSX } from 'nsh';
import { byLook, look } from '../core/env';
import { SURFACE_FILL, SurfaceContext } from '../core/surface';
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
  if (look === 'ios') return <IosField {...props} />;
  if (look === 'android') return <AndroidField {...props} />;
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
      <FieldErrorLine error={props.error} />
    </View>
  );
}

type FieldFrameProps = Omit<FieldProps, 'name' | 'disabled'> & {
  children?: JSX.Element;
  labelHidden?: boolean;
};

/**
 * iOS: an inset grouped row, the label above the value on the card, the
 * description and the error under the row.
 */
function IosField(props: FieldFrameProps): JSX.Element {
  if (props.labelHidden) {
    return (
      <View class="self-stretch gap-1.5">
        {props.children}
        <FieldErrorLine error={props.error} />
      </View>
    );
  }
  // On the page's ground the row is a card of its own; inside a card or a
  // sheet's group it is one of its rows, a hairline under it.
  const surface = SurfaceContext();
  const row =
    surface === 'card'
      ? 'self-stretch border-b border-hairline pt-1.5'
      : 'self-stretch rounded-(--radius-md) bg-card px-4 pt-1.5';
  const inset = surface === 'card' ? '' : 'px-4';
  return (
    <View class="self-stretch gap-1.5">
      <View class={row}>
        <View class="flex-row gap-1">
          <Text
            class={`text-ios-footnote font-regular ${props.error ? 'text-danger-strong' : 'text-muted-foreground'}`}
          >
            {props.label}
          </Text>
          {props.required ? (
            <Text
              class="text-ios-footnote font-regular text-danger-strong"
              importantForAccessibility="no"
            >
              *
            </Text>
          ) : null}
        </View>
        {props.children}
      </View>
      {props.description ? (
        <Text
          class={`${inset} text-ios-footnote font-regular text-muted-foreground text-pretty`}
        >
          {props.description}
        </Text>
      ) : null}
      <FieldErrorLine error={props.error} />
    </View>
  );
}

/**
 * Android (Material 3): an outlined field with its label on the border and
 * the supporting text under it.
 */
function AndroidField(props: FieldFrameProps): JSX.Element {
  const surface = SurfaceContext();
  return (
    <View class="self-stretch gap-1">
      <View class="group self-stretch pt-2">
        {props.children}
        {props.labelHidden ? null : (
          <View
            class={`pointer-events-none absolute left-3 top-0 flex-row px-1 ${SURFACE_FILL[surface]}`}
            importantForAccessibility="no-hide-descendants"
          >
            <Text
              class={`text-m3-body-sm font-regular ${props.error ? 'text-danger-strong' : 'text-muted-foreground group-focus-within:text-primary-strong'}`}
            >
              {props.required ? `${props.label} *` : props.label}
            </Text>
          </View>
        )}
      </View>
      {props.description ? (
        <Text class="px-4 text-m3-body-sm font-regular text-muted-foreground text-pretty">
          {props.description}
        </Text>
      ) : null}
      <FieldErrorLine error={props.error} />
    </View>
  );
}

/**
 * `Field` around controls without an outline of their own (radio buttons):
 * on Android the label stands above them instead of on a border. Internal.
 */
export function PlainField(props: FieldFrameProps): JSX.Element {
  return look === 'android' ? (
    <AndroidPlainField {...props} />
  ) : (
    <Field {...props} />
  );
}

/** Android: a group of controls without an outline, its label above. */
function AndroidPlainField(props: FieldFrameProps): JSX.Element {
  return (
    <View class="self-stretch gap-1">
      <Text class="text-m3-title-sm font-medium text-muted-foreground">
        {props.required ? `${props.label} *` : props.label}
      </Text>
      {props.description ? (
        <Text class="text-m3-body-sm font-regular text-muted-foreground text-pretty">
          {props.description}
        </Text>
      ) : null}
      {props.children}
      <FieldErrorLine error={props.error} />
    </View>
  );
}

/** A field's error under its control, announced when it appears; nothing
 * without one. `inset` lines it up with the label of a checkbox. */
export function FieldErrorLine(props: {
  error?: string;
  inset?: boolean;
}): JSX.Element {
  return (
    <>
      {props.error ? (
        <View
          class={`flex-row items-start gap-1.5 ${props.inset ? 'pl-7.5' : ''}`}
          role="alert"
        >
          <View class="pt-0.5">
            <Glyph icon={IconAlertCircle} size="sm" color="danger-strong" />
          </View>
          <Text class={`flex-1 ${ERROR_TEXT}`}>{props.error}</Text>
        </View>
      ) : null}
    </>
  );
}

const ERROR_TEXT = byLook({
  web: 'text-caption font-strong text-danger-strong',
  ios: 'text-ios-footnote font-regular text-danger-strong',
  android: 'text-m3-body-sm font-regular text-danger-strong',
});

/**
 * The well a text-like control sits in (DESIGN.md "Field"). On iOS the
 * field's row is the well, so the control has none of its own; on Android
 * it is Material's outlined field, its border 2 points of the accent while
 * it has the focus.
 */
export const WELL = byLook({
  web: 'flex-row items-center gap-2 self-stretch rounded-(--radius-md) border bg-card px-3 transition-colors focus-within:border-ring focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring',
  ios: 'flex-row items-center gap-2 self-stretch',
  android:
    'flex-row items-center gap-3 self-stretch rounded-(--radius-xs) border px-4 transition-colors focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-primary',
});

/** 36 points; on touch 46, so the input inside its 1-point border keeps a
 * 44-point target. iOS: the 44-point line under the label; Android: 56
 * points. */
export const WELL_HEIGHT = byLook({
  web: 'h-9 pointer-coarse:h-11.5',
  ios: 'h-11',
  android: 'h-14',
});

export function wellState(invalid: boolean, disabled: boolean): string {
  if (look === 'ios') return disabled ? 'opacity-60' : '';
  if (look === 'android') {
    if (disabled) return 'border-input opacity-60';
    return invalid
      ? 'border-danger focus-within:outline-danger'
      : 'border-control-border';
  }
  if (disabled) return 'border-input bg-muted';
  return invalid ? 'border-danger' : 'border-input';
}

/** The text inside a well. */
export const WELL_TEXT = byLook({
  web: 'text-body font-strong text-foreground placeholder:text-muted-foreground pointer-coarse:text-body-lg disabled:text-muted-foreground',
  ios: 'text-ios-body font-regular text-foreground placeholder:text-muted-foreground disabled:text-muted-foreground',
  android:
    'text-m3-body-lg font-regular text-foreground placeholder:text-muted-foreground disabled:text-muted-foreground',
});

/** How a well that opens a popup (a select, a date) answers the pointer
 * and a press. */
export const TRIGGER_STATE = byLook({
  web: 'enabled:hover:bg-muted',
  ios: 'active:opacity-60',
  android: 'active:bg-surface-pressed',
});

/** A search field at the top of a list or a popup, without a label: a
 * filled capsule on iOS, the outlined field on Android. */
export const SEARCH_WELL = byLook({
  web: '',
  ios: 'flex-row items-center gap-1.5 self-stretch h-9 rounded-(--radius-sm) bg-surface-hover px-2',
  android: '',
});
