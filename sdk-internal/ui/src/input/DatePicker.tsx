import { Text, View, locale, localeSettings } from 'nsh';
import type { JSX } from 'nsh';
import { DatePicker as BaseDatePicker } from 'nsh/base';
import type { CalendarEntry } from 'nsh/base';
import {
  BACKDROP,
  FOCUS_RING,
  POPUP,
  POPUP_ENDING,
  POPUP_STARTING,
} from '../core/styles';
import { Glyph } from '../icons/Icon';
import {
  IconCalendar,
  IconChevronLeft,
  IconChevronRight,
  IconX,
} from '../icons/icons.gen';
import {
  Field,
  WELL,
  WELL_HEIGHT,
  WELL_TEXT,
  fieldError,
  useFormField,
  wellState,
} from './Field';
import type { FieldProps } from './Field';
import { FormContext, bindField } from './form-context';

export type DatePickerProps = FieldProps & {
  /** The date as ISO 8601: `2026-04-12`, or `2026-04-12T09:30` with
   * `withTime`; `null` for none. */
  value?: string | null;
  onChange?: (value: string | null) => void;
  /** Also picks a time of day. */
  withTime?: boolean;
  placeholder?: string;
  /** Lets the user go back to no date. */
  clearable?: boolean;
};

/** A date as the user's locale writes it. */
function formatDate(value: string, withTime: boolean): string {
  const date = new Date(withTime ? value : `${value}T00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale(), {
    dateStyle: 'medium',
    ...(withTime
      ? { timeStyle: 'short', hourCycle: localeSettings().hourCycle }
      : {}),
  }).format(date);
}

/** A Sunday, from which the weekdays' names are written. */
const A_SUNDAY = { year: 2026, month: 10, day: 22 };

/** The content of a calendar item, in the user's language. */
function CalendarItem(props: { item: CalendarEntry }): JSX.Element {
  const item = props.item;
  if (item.kind === 'previous' || item.kind === 'next') {
    return (
      <Glyph
        icon={item.kind === 'previous' ? IconChevronLeft : IconChevronRight}
        size="md"
        color="foreground"
      />
    );
  }
  const format = (options: Intl.DateTimeFormatOptions, date: Date) =>
    new Intl.DateTimeFormat(locale(), options).format(date);
  if (item.kind === 'weekday') {
    return (
      <Text class="text-caption font-label text-muted-foreground">
        {format(
          { weekday: 'narrow' },
          new Date(A_SUNDAY.year, A_SUNDAY.month, A_SUNDAY.day + item.value),
        )}
      </Text>
    );
  }
  if (item.kind === 'month' || item.kind === 'monthToggle') {
    return (
      <Text class="text-body font-label">
        {format(
          { month: item.kind === 'month' ? 'short' : 'long' },
          new Date(2026, item.value - 1, 1),
        )}
      </Text>
    );
  }
  return <Text class="text-body font-strong">{String(item.value)}</Text>;
}

/** A date, or a date and time, picked from a calendar: a popup on desktops,
 * a sheet on phones. */
export function DatePicker(props: DatePickerProps): JSX.Element {
  const form = FormContext();
  const field = bindField<string | null>(form, props, null);
  const error = fieldError(props);
  useFormField(props);
  const disabled = () => props.disabled === true || (form?.disabled() ?? false);
  const shown = () => {
    const value = field.get();
    return value ? formatDate(value, props.withTime === true) : null;
  };
  return (
    <Field
      label={props.label}
      description={props.description}
      error={error()}
      required={props.required}
    >
      <BaseDatePicker
        value={field.get()}
        onChange={(event) =>
          field.set(typeof event.value === 'string' ? event.value : null)
        }
        timePrecision={props.withTime ? 'minute' : null}
        hourCycle={localeSettings().hourCycle === 'h12' ? 'h12' : 'h23'}
        firstDayOfWeek={localeSettings().firstDayOfWeek % 7}
        cleanable={props.clearable}
        clearButtonAccessibilityLabel={`Clear ${props.label}`}
        clearButton={<Glyph icon={IconX} size="sm" color="muted-foreground" />}
        clearButtonClass="absolute right-9 top-0 bottom-0 w-8 items-center justify-center"
        disabled={disabled()}
        accessibilityLabel={props.label}
        previousAccessibilityLabel="Previous month"
        nextAccessibilityLabel="Next month"
        class="self-stretch"
        offset={4}
        popupClass={`${POPUP} w-80 p-3`}
        popupStartingClass={POPUP_STARTING}
        popupEndingClass={POPUP_ENDING}
        backdropClass={BACKDROP}
        headerClass="flex-row items-center justify-between pb-2 text-body font-label text-popover-foreground"
        rowClass="flex-row justify-between"
        itemClass={`h-9 min-w-9 items-center justify-center rounded-(--radius-sm) px-1.5 text-popover-foreground hover:bg-surface-hover selected:bg-primary selected:text-primary-foreground disabled:opacity-40 data-today:text-primary-strong data-outside:text-muted-foreground ${FOCUS_RING}`}
        renderItem={(item) => <CalendarItem item={item} />}
        timeClass="mt-3 flex-row items-center gap-3"
        timeLabel={
          <Text class="text-body font-label text-field-label">Time</Text>
        }
        timeAccessibilityLabel={`${props.label} time`}
        timeFieldClass="flex-row rounded-(--radius-md) border border-input px-2 py-1"
        segmentClass="text-body font-strong text-foreground focus:bg-primary-tint"
        trigger={
          <View
            class={`${WELL} ${WELL_HEIGHT} ${wellState(error() !== undefined, disabled())} enabled:hover:bg-muted`}
          >
            <Glyph icon={IconCalendar} size="md" color="muted-foreground" />
            <Text
              class={`flex-1 truncate ${WELL_TEXT} ${shown() ? '' : 'text-muted-foreground'}`}
            >
              {shown() ?? props.placeholder ?? 'Pick a date'}
            </Text>
          </View>
        }
      />
    </Field>
  );
}
