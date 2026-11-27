import { Text, View } from 'nsh';
import type { JSX } from 'nsh';
import { Combobox as BaseCombobox, Select as BaseSelect } from 'nsh/base';
import {
  BACKDROP,
  POPUP,
  POPUP_ENDING,
  POPUP_GROUP,
  POPUP_ITEM,
  POPUP_ITEM_TEXT,
  POPUP_STARTING,
} from '../core/styles';
import { Glyph } from '../icons/Icon';
import { IconCheck, IconSearch, IconSelector, IconX } from '../icons/icons.gen';
import { byLook } from '../core/env';
import {
  Field,
  SEARCH_WELL,
  WELL,
  WELL_HEIGHT,
  TRIGGER_STATE,
  WELL_TEXT,
  fieldError,
  wellState,
} from './Field';
import type { FieldProps } from './Field';
import { FormContext, bindField } from './form-context';

/** One choice of a `Select` or `Combobox`. */
export type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
  /** Options with the same group are listed under it. */
  group?: string;
};

function items(options: readonly SelectOption[]) {
  return options.map((option) => ({
    value: option.value,
    title: option.label,
    disabled: option.disabled,
    group: option.group ?? null,
  }));
}

function OptionRow(props: { title: string }): JSX.Element {
  return (
    <View class="flex-1 flex-row items-center gap-2">
      <Text class={`flex-1 ${POPUP_ITEM_TEXT} text-popover-foreground`}>
        {props.title}
      </Text>
      <View class="opacity-0 group-selected:opacity-100">
        <Glyph icon={IconCheck} size="md" color="primary-strong" />
      </View>
    </View>
  );
}

/** The search field above a long list of options. */
const SEARCH_FIELD = byLook({
  web: `mb-1.5 ${WELL} ${WELL_HEIGHT} border-input ${WELL_TEXT}`,
  ios: `mb-1.5 ${SEARCH_WELL} ${WELL_TEXT}`,
  android: `mb-1.5 ${WELL} ${WELL_HEIGHT} border-control-border ${WELL_TEXT}`,
});

export type SelectProps = FieldProps & {
  options: readonly SelectOption[];
  /** The chosen option's value, or `null` for none. */
  value?: string | null;
  onChange?: (value: string | null) => void;
  /** Shown while nothing is chosen. */
  placeholder?: string;
  /** Adds a search field above long lists. */
  searchable?: boolean;
  /** Lets the user go back to no choice. */
  clearable?: boolean;
};

/** One value chosen from a list: a popup on desktops, a sheet on phones. */
export function Select(props: SelectProps): JSX.Element {
  const form = FormContext();
  const field = bindField<string | null>(form, props, null);
  const error = fieldError(props);
  const disabled = () => props.disabled === true || (form?.disabled() ?? false);
  const chosen = () =>
    props.options.find((option) => option.value === field.get())?.label;
  return (
    <Field
      label={props.label}
      description={props.description}
      error={error()}
      required={props.required}
    >
      <BaseSelect
        items={items(props.options)}
        value={field.get()}
        onChange={(event) => field.set(event.value)}
        placeholder={props.placeholder}
        searchable={props.searchable}
        searchPlaceholder="Search"
        searchAccessibilityLabel={`Search ${props.label}`}
        cleanable={props.clearable}
        clearButtonAccessibilityLabel={`Clear ${props.label}`}
        clearButtonClass="absolute right-9 top-0 bottom-0 w-8 items-center justify-center pointer-coarse:right-10"
        clearButton={<Glyph icon={IconX} size="sm" color="muted-foreground" />}
        disabled={disabled()}
        accessibilityLabel={props.label}
        class="self-stretch"
        offset={4}
        popupClass={`${POPUP} max-h-80`}
        popupStartingClass={POPUP_STARTING}
        popupEndingClass={POPUP_ENDING}
        backdropClass={BACKDROP}
        listClass="gap-0.5"
        itemClass={POPUP_ITEM}
        groupClass={POPUP_GROUP}
        searchClass={SEARCH_FIELD}
        empty={
          <Text class="px-2.5 py-6 text-center text-body text-muted-foreground">
            No matches
          </Text>
        }
        renderItem={(item) => <OptionRow title={item.title} />}
        trigger={
          <View
            class={`${WELL} ${WELL_HEIGHT} justify-between ${wellState(error() !== undefined, disabled())} ${TRIGGER_STATE}`}
          >
            <Text
              class={`flex-1 truncate ${WELL_TEXT} ${chosen() ? '' : 'text-muted-foreground'}`}
            >
              {chosen() ?? props.placeholder ?? 'Choose'}
            </Text>
            <Glyph icon={IconSelector} size="md" color="muted-foreground" />
          </View>
        }
      />
    </Field>
  );
}

export type ComboboxProps = FieldProps & {
  options: readonly SelectOption[];
  /** The chosen values; one at most unless `multiple`. */
  value?: readonly string[];
  onChange?: (value: readonly string[]) => void;
  /** Lets the user choose several values. */
  multiple?: boolean;
  placeholder?: string;
};

/** Values chosen from a list filtered by typing. */
export function Combobox(props: ComboboxProps): JSX.Element {
  const form = FormContext();
  const field = bindField<readonly string[]>(form, props, []);
  const error = fieldError(props);
  const disabled = () => props.disabled === true || (form?.disabled() ?? false);
  return (
    <Field
      label={props.label}
      description={props.description}
      error={error()}
      required={props.required}
    >
      <BaseCombobox
        items={items(props.options)}
        multiple={props.multiple}
        value={[...field.get()]}
        onChange={(event) => field.set(event.value)}
        placeholder={props.placeholder ?? 'Search'}
        cleanable
        clearButtonAccessibilityLabel={`Clear ${props.label}`}
        clearButton={<Glyph icon={IconX} size="sm" color="muted-foreground" />}
        clearButtonClass="w-8 self-stretch items-center justify-center"
        disabled={disabled()}
        accessibilityLabel={props.label}
        class={`${WELL} ${WELL_HEIGHT} ${wellState(error() !== undefined, disabled())}`}
        inputClass={`flex-1 self-stretch ${WELL_TEXT}`}
        prefix={<Glyph icon={IconSearch} size="md" color="muted-foreground" />}
        offset={4}
        popupClass={`${POPUP} max-h-80`}
        popupStartingClass={POPUP_STARTING}
        popupEndingClass={POPUP_ENDING}
        backdropClass={BACKDROP}
        listClass="gap-0.5"
        itemClass={POPUP_ITEM}
        groupClass={POPUP_GROUP}
        empty={
          <Text class="px-2.5 py-6 text-center text-body text-muted-foreground">
            No matches
          </Text>
        }
        renderItem={(item) => <OptionRow title={item.title} />}
      />
    </Field>
  );
}
