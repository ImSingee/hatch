/**
 * `@hatch/ui`: the component library of native-runtime Apps. App code
 * imports its whole UI from here; see
 * `skills/building-apps/references/design-system.md`.
 */

// State and start-up.
export { computed as memo, effect, resource, signal } from 'nsh';
export { Each, If } from './core/control';
export type { EachProps, IfProps } from './core/control';
export { mount } from './core/mount';
export type {
  Action,
  Align,
  ControlSize,
  Justify,
  Space,
  Tone,
} from './core/types';

// Layout.
export { Page } from './layout/Page';
export type { PageProps, PageWidth } from './layout/Page';
export { Card, Divider, Section } from './layout/Card';
export type { CardProps, DividerProps, SectionProps } from './layout/Card';
export { Grid, Row, Stack } from './layout/Stack';
export type { GridProps, RowProps, StackProps } from './layout/Stack';

// Navigation.
export { AppShell } from './navigation/AppShell';
export type { AppSection, AppShellProps } from './navigation/AppShell';
export { NavStack, createNavStack } from './navigation/NavStack';
export type {
  NavRoutes,
  NavStackProps,
  NavStackState,
} from './navigation/NavStack';
export { Tabs } from './navigation/Tabs';
export type { TabItem, TabsProps } from './navigation/Tabs';

// Input.
export { Button, IconButton } from './input/Button';
export { Checkbox, RadioGroup, Slider, Switch } from './input/Choice';
export type {
  CheckboxProps,
  RadioGroupProps,
  RadioOption,
  SliderProps,
  SwitchProps,
} from './input/Choice';
export { DatePicker } from './input/DatePicker';
export type { DatePickerProps } from './input/DatePicker';
export type { ButtonKind, ButtonProps, IconButtonProps } from './input/Button';
export { Field } from './input/Field';
export type { FieldProps } from './input/Field';
export { Form } from './input/Form';
export type { FieldValue, FormProps, FormValues } from './input/Form';
export { Combobox, Select } from './input/Select';
export type { ComboboxProps, SelectOption, SelectProps } from './input/Select';
export { NumberField, TextArea, TextField } from './input/TextField';
export type {
  NumberFieldProps,
  TextAreaProps,
  TextFieldKind,
  TextFieldProps,
} from './input/TextField';

// Display.
export {
  Avatar,
  Badge,
  EmptyState,
  Progress,
  Skeleton,
  Stat,
} from './display/Display';
export type {
  AvatarProps,
  AvatarSize,
  BadgeProps,
  EmptyStateProps,
  ProgressProps,
  SkeletonProps,
  StatProps,
} from './display/Display';
export { List, ListItem } from './display/List';
export type { ListItemProps, ListProps } from './display/List';
export { DataTable } from './display/DataTable';
export type { DataTableColumn, DataTableProps } from './display/DataTable';
export { Heading, Text } from './display/Text';
export type { HeadingProps, TextProps, TextTone } from './display/Text';
export { Icon } from './icons/Icon';
export type { IconProps, IconSize, IconTone } from './icons/Icon';
export type { IconData } from './icons/icon-data';
export * from './icons/icons.gen';

// Feedback.
export { AlertDialog, Dialog, Sheet } from './feedback/Dialog';
export type { DialogProps, SheetProps } from './feedback/Dialog';
export { Menu } from './feedback/Menu';
export type { MenuEntry, MenuProps } from './feedback/Menu';
export { Toast } from './feedback/Toast';
export type { ToastOptions, ToastTone } from './feedback/Toast';
export { Tooltip } from './feedback/Tooltip';
export type { TooltipProps } from './feedback/Tooltip';

// Page patterns.
export {
  DashboardPage,
  FormPage,
  ListDetailPage,
  SettingsPage,
} from './patterns/Patterns';
export type {
  DashboardPageProps,
  FormPageProps,
  ListDetailPageProps,
  SettingsPageProps,
} from './patterns/Patterns';
