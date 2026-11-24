import { Scroll, Text, View, signal } from 'nsh';
import type { JSX } from 'nsh';
import { Each } from '../core/control';
import { WIDE_MIN, paneWidth } from '../core/env';
import { EmptyState, Stat } from '../display/Display';
import type { EmptyStateProps, StatProps } from '../display/Display';
import { List, ListItem } from '../display/List';
import type { ListItemProps } from '../display/List';
import { HeadingText } from '../display/Text';
import { IconChevronLeft, IconSearch } from '../icons/icons.gen';
import { Button, IconButton } from '../input/Button';
import { Form } from '../input/Form';
import type { FormValues } from '../input/Form';
import { TextField } from '../input/TextField';
import { Card } from '../layout/Card';
import { Page } from '../layout/Page';
import { Grid, Row } from '../layout/Stack';
import { PageNavContext } from '../navigation/nav-context';

export type ListDetailPageProps<T> = {
  title: string;
  description?: string;
  /** Buttons at the end of the title row, such as Add. */
  actions?: JSX.Element;
  items: readonly T[];
  /** A stable id of an item. */
  getKey: (item: T) => string;
  /** How an item reads in the list. */
  renderItem: (item: T) => Omit<ListItemProps, 'onPress' | 'selected'>;
  /** The title of the detail of an item. */
  detailTitle: (item: T) => string;
  /** The detail of the selected item: the content of its page. */
  renderDetail: (item: T) => JSX.Element;
  /** The selected item's id, when the App controls it. */
  selectedKey?: string | null;
  onSelect?: (key: string | null) => void;
  /** A search field above the list, labelled by its placeholder (default
   * "Search <title>"). Filtering is the App's. */
  search?: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
  };
  /** What shows when there are no items. */
  empty?: EmptyStateProps;
  loading?: boolean;
};

/**
 * A list of records and the detail of the chosen one: side by side in a
 * wide pane, one after the other with a back button in a narrow one.
 */
export function ListDetailPage<T>(props: ListDetailPageProps<T>): JSX.Element {
  const own = signal<string | null>(null);
  const selectedKey = () =>
    props.selectedKey === undefined ? own() : props.selectedKey;
  const select = (key: string | null) => {
    own.set(key);
    props.onSelect?.(key);
  };
  const selected = () =>
    props.items.find((item) => props.getKey(item) === selectedKey()) ?? null;
  const wide = () => paneWidth() >= WIDE_MIN;
  const nav = PageNavContext();

  const list = (inColumn: boolean) => (
    <>
      {props.search ? (
        <TextField
          label={`Search ${props.title.toLowerCase()}`}
          labelHidden
          kind="search"
          icon={IconSearch}
          value={props.search.value}
          onChange={props.search.onChange}
          placeholder={
            props.search.placeholder ?? `Search ${props.title.toLowerCase()}`
          }
        />
      ) : null}
      {!props.loading && props.items.length === 0 && props.empty ? (
        <EmptyState {...props.empty} />
      ) : (
        <List
          items={props.items}
          getKey={props.getKey}
          loading={props.loading}
          renderItem={(item) => (
            <ListItem
              {...props.renderItem(item())}
              selected={inColumn && selectedKey() === props.getKey(item())}
              onPress={() => select(props.getKey(item()))}
            />
          )}
        />
      )}
    </>
  );

  const detail = (item: T) => (
    <Page title={props.detailTitle(item)}>{props.renderDetail(item)}</Page>
  );

  return (
    <View class="flex-1 self-stretch">
      {wide() ? (
        <View class="flex-1 flex-row">
          <View class="w-90 border-r border-hairline">
            <Scroll class="flex-1" contentClass="pt-[env(safe-area-inset-top)]">
              <View class="gap-4 p-5">
                <Row justify="between" align="start">
                  {nav?.canGoBack() ? (
                    <View class="-ml-2">
                      <IconButton
                        icon={IconChevronLeft}
                        label="Back"
                        onPress={nav.back}
                      />
                    </View>
                  ) : null}
                  <View class="flex-1 gap-1 pt-1">
                    <HeadingText level={1} class="text-section text-foreground">
                      {props.title}
                    </HeadingText>
                    {props.description ? (
                      <Text class="text-body text-muted-foreground">
                        {props.description}
                      </Text>
                    ) : null}
                  </View>
                  {props.actions ?? null}
                </Row>
                {list(true)}
              </View>
            </Scroll>
          </View>
          <View class="flex-1">
            {selected() ? (
              detail(selected() as T)
            ) : (
              <View class="flex-1 items-center justify-center">
                <EmptyState
                  title="Nothing selected"
                  description="Choose an item to see it here."
                  compact
                />
              </View>
            )}
          </View>
        </View>
      ) : selected() ? (
        <PageNavContext.Provider
          value={{ canGoBack: () => true, back: () => select(null) }}
        >
          {detail(selected() as T)}
        </PageNavContext.Provider>
      ) : (
        <Page
          title={props.title}
          description={props.description}
          actions={props.actions}
        >
          {list(false)}
        </Page>
      )}
    </View>
  );
}

export type FormPageProps = {
  title: string;
  description?: string;
  /** The form's id, which names its draft (see `Form`). */
  formId: string;
  /** Runs on submit with the fields' values, as `Form`'s `onSubmit`. */
  onSubmit: (values: FormValues) => unknown;
  /** Values the fields start with, by `name`. */
  initialValues?: FormValues;
  /** Extra checks on submit: an error message by field `name`, or nothing. */
  validate?: (values: FormValues) => Record<string, string> | undefined;
  /** The submit button's label: a verb for the result, "Add plant". */
  submitLabel: string;
  /** A way out without saving. */
  onCancel?: () => void;
  /** Named fields. Group long forms with `Section`s. */
  children?: JSX.Element;
};

/** A page that is one form: creating or editing one record. */
export function FormPage(props: FormPageProps): JSX.Element {
  return (
    <Page title={props.title} description={props.description} width="narrow">
      <Form
        id={props.formId}
        onSubmit={props.onSubmit}
        initialValues={props.initialValues}
        validate={props.validate}
      >
        <Card padding="lg" gap="lg">
          {props.children}
        </Card>
        <Row justify="end" gap="sm">
          {props.onCancel ? (
            <Button label="Cancel" kind="subtle" onPress={props.onCancel} />
          ) : null}
          <Button label={props.submitLabel} type="submit" />
        </Row>
      </Form>
    </Page>
  );
}

export type SettingsPageProps = {
  title: string;
  description?: string;
  /** `Section`s of `List`s whose rows carry `Switch`es, values and links. */
  children?: JSX.Element;
};

/** A page of preferences, grouped and narrow enough to scan. */
export function SettingsPage(props: SettingsPageProps): JSX.Element {
  return (
    <Page
      title={props.title}
      description={props.description}
      width="narrow"
      gap="2xl"
    >
      {props.children}
    </Page>
  );
}

export type DashboardPageProps = {
  title: string;
  description?: string;
  actions?: JSX.Element;
  /** Key figures in a row at the top: two to four read best. */
  stats?: readonly StatProps[];
  /** Cards below the figures, in columns. */
  children?: JSX.Element;
  /** Columns of the cards in a wide pane; default 2. */
  columns?: 1 | 2 | 3;
};

/** An overview: key figures, then cards of detail. */
export function DashboardPage(props: DashboardPageProps): JSX.Element {
  return (
    <Page
      title={props.title}
      description={props.description}
      actions={props.actions}
      width="wide"
    >
      {props.stats && props.stats.length > 0 ? (
        <Grid columns={4} compactColumns={2} gap="md">
          <Each of={props.stats}>{(stat) => <Stat {...stat()} />}</Each>
        </Grid>
      ) : null}
      <Grid columns={props.columns ?? 2}>{props.children}</Grid>
    </Page>
  );
}
