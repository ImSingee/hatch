/**
 * `If` and `Each`, re-exported so an App imports its whole UI from
 * `@hatch/ui`.
 *
 * NSH's JSX compiler turns the global `<If>` and `<Each>` into its runtime's
 * conditional and keyed-list operations; an imported binding of the same name
 * would be an ordinary component, and the web runtime has no global `If` to
 * call. So these are components of their own that use the globals inside,
 * where the compiler sees them.
 */
/* oxlint-disable react/jsx-no-undef -- `If` and `Each` are NSH globals. */
import type { JSX } from 'nsh';

export type IfProps<T> = {
  /** Shows the children while this is truthy. */
  when: T;
  /** Shown while `when` is falsy. */
  else?: JSX.Element;
  /** The content, or a function of an accessor of `when`'s value. */
  children?: JSX.Element | ((value: () => NonNullable<T>) => JSX.Element);
};

/** Renders its children while `when` is truthy, else `else`. */
function HatchIf<T>(props: IfProps<T>): JSX.Element {
  return (
    <If when={props.when} else={props.else}>
      {(value) => {
        const children = props.children;
        return typeof children === 'function'
          ? (children as (value: () => NonNullable<T>) => JSX.Element)(value)
          : children;
      }}
    </If>
  );
}

export type EachProps<T> = {
  /** The items. */
  of: readonly T[] | null | undefined;
  /** How rows are kept: by a key of each item (default: the item itself), or
   * `"index"` to keep rows by position. */
  key?: 'index' | ((item: T, index: number) => unknown);
  /** One row per item; `item()` and `index()` follow the row. */
  children: (item: () => T, index: () => number) => JSX.Element;
};

/** Renders one row per item of `of`, kept by `key`. */
function HatchEach<T>(props: EachProps<T>): JSX.Element {
  return (
    <Each of={props.of} key={props.key}>
      {(item, index) => props.children(item, index)}
    </Each>
  );
}

export { HatchEach as Each, HatchIf as If };
