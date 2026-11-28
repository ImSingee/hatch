/**
 * `@hatch/ui/card`: the cards notifications show, for an App to compose in
 * TSX or to show from markup an Agent or its backend wrote. The names are
 * the markup's tags, so import them as one namespace:
 *
 * ```tsx
 * import * as Card from '@hatch/ui/card';
 *
 * <Card.Card status="Deployed" tone="success">
 *   <Card.Title>v12 is live</Card.Title>
 * </Card.Card>
 * ```
 *
 * See `skills/building-apps/references/design-system.md`.
 */

// The card, and cards from markup or a tree.
export { Card, CardMarkup, CardTree, Markdown, compileCard } from './card';
export type {
  CardMarkupProps,
  CardProps,
  CardTreeProps,
  MarkdownProps,
} from './card';
export type { CardAnswerProps } from './form';

// Layout.
export { Box, Collapse, Column, Divider, Grid, Row, Spacer } from './parts';
export type {
  BoxProps,
  CollapseProps,
  ColumnProps,
  GridProps,
  RowProps,
  SpacerProps,
} from './parts';

// Text and inline marks.
export {
  Bold,
  Caption,
  InlineCode,
  Italic,
  LineBreak,
  Link,
  Strike,
  Text,
  Time,
  Title,
} from './parts';
export type {
  CaptionProps,
  LinkProps,
  TextProps,
  TimeProps,
  TitleProps,
} from './parts';

// Markers and data.
export {
  Badge,
  Callout,
  Code,
  Field,
  Fields,
  Icon,
  Item,
  List,
  Progress,
  Quote,
  Stat,
  Step,
  Steps,
  Table,
  Td,
  Th,
  Tr,
  Trend,
} from './parts';
export type {
  BadgeProps,
  CalloutProps,
  CellProps,
  CodeProps,
  FieldProps,
  FieldsProps,
  IconProps,
  ItemProps,
  ListProps,
  ProgressProps,
  QuoteProps,
  StatProps,
  StepProps,
  StepsProps,
  TrendProps,
} from './parts';

// Questions.
export { Button, Buttons, Choice, Input, Option, Submit } from './inputs';
export type {
  ButtonProps,
  ButtonsProps,
  ChoiceProps,
  InputProps,
  OptionProps,
  SubmitProps,
} from './inputs';

// The render tree and the answers.
export type {
  CardIconName,
  ContentChild,
  ContentNode,
  ContentTone,
  Spacing,
  StepState,
} from './content/catalog.gen';
export type { ContentIssue } from './content/compile.gen';
export type { ReplyAnswers } from './content/reply.gen';
