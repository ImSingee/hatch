import type { ComponentRef, PropsWithChildren, ReactNode, Ref } from 'react';
import { Platform, ScrollView, View, type ScrollViewProps } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ground } from './ground';
import { Text, useType } from './text';
import { usePalette } from './theme-context';

/**
 * Inset ownership for a page's root scroll view. On iOS UIKit adds the status
 * bar, native tab bar and home indicator to the adjusted inset, so content
 * scrolls under the glass bar yet its end stays reachable. Native tabs only
 * find a scroll view that is first in the page's view chain, which also gives
 * scroll-to-top on tab re-tap and tab-bar minimising; keep it there.
 */
export const pageScrollProps = {
  contentInsetAdjustmentBehavior: 'automatic',
  automaticallyAdjustsScrollIndicatorInsets: true,
} as const satisfies ScrollViewProps;

/**
 * A single-column page's content on a wide screen (iPad, an unfolded phone):
 * as wide as the screen up to a comfortable reading width, then centred.
 * Pages that split into columns on a wide screen do not use it. Layout
 * geometry, like the 320-point columns in `columns.tsx`.
 */
export const readable = {
  width: '100%',
  maxWidth: 640,
  alignSelf: 'center',
} as const;

/**
 * Root of a scrolling page. Vertical insets belong to the scroll view on iOS
 * (see `pageScrollProps`) and to the stack header or tab bar on Android, so
 * only a top-level Android page pads its status bar here.
 */
export function PageRoot({
  nested = false,
  children,
}: PropsWithChildren<{ nested?: boolean }>) {
  const c = usePalette();
  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: c.ground }}
      edges={
        Platform.OS === 'ios' || nested
          ? ['left', 'right']
          : ['top', 'left', 'right']
      }
    >
      {children}
      <Ground />
    </SafeAreaView>
  );
}

/** Fixed page with a masthead over a non-scrolling surface (the Dashboard). */
export function Screen({
  eyebrow,
  title,
  actions,
  children,
  nested = false,
}: PropsWithChildren<{
  eyebrow?: string;
  title: string;
  actions?: ReactNode;
  nested?: boolean;
}>) {
  const c = usePalette();
  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: c.ground }}
      edges={nested ? ['left', 'right'] : ['top', 'left', 'right']}
    >
      <Masthead
        eyebrow={eyebrow}
        title={title}
        actions={actions}
        nested={nested}
      />
      {children}
      <Ground />
    </SafeAreaView>
  );
}

/** Scrolling page: the masthead scrolls with content, like a large title. */
export function ScrollScreen({
  eyebrow,
  title,
  actions,
  nested = false,
  readable: narrow = false,
  children,
  contentContainerStyle,
  scrollRef,
  overlay,
  ...scrollProps
}: PropsWithChildren<
  {
    eyebrow?: string;
    title: string;
    actions?: ReactNode;
    nested?: boolean;
    /** Keep the content to the reading width (see `readable`). */
    readable?: boolean;
    /** The page's scroll view, for pages that scroll themselves. */
    scrollRef?: Ref<ComponentRef<typeof ScrollView>>;
    /** Floats over the page, above the scroll view. */
    overlay?: ReactNode;
  } & Omit<ScrollViewProps, 'children'>
>) {
  return (
    <PageRoot nested={nested}>
      <ScrollView
        ref={scrollRef}
        {...pageScrollProps}
        {...scrollProps}
        style={{ flex: 1 }}
        contentContainerStyle={[
          { paddingBottom: 32 },
          narrow && readable,
          contentContainerStyle,
        ]}
      >
        <Masthead
          eyebrow={eyebrow}
          title={title}
          actions={actions}
          nested={nested}
        />
        {children}
      </ScrollView>
      {overlay}
    </PageRoot>
  );
}

export function Masthead({
  eyebrow,
  title,
  actions,
  nested = false,
}: {
  eyebrow?: string;
  title: string;
  actions?: ReactNode;
  nested?: boolean;
}) {
  const type = useType();
  return (
    <View
      style={{
        paddingHorizontal: 20,
        paddingTop: nested ? 4 : 14,
        paddingBottom: 14,
        flexDirection: 'row',
        alignItems: 'flex-end',
        gap: 12,
      }}
    >
      <View style={{ flex: 1, gap: 4 }}>
        {eyebrow ? (
          <Text style={type.small} numberOfLines={2}>
            {eyebrow}
          </Text>
        ) : null}
        <Text
          accessibilityRole="header"
          maxFontSizeMultiplier={1.6}
          numberOfLines={3}
          style={type.display}
        >
          {title}
        </Text>
      </View>
      {actions ? (
        <View style={{ flexDirection: 'row', gap: 4 }}>{actions}</View>
      ) : null}
    </View>
  );
}

/** Group label above a list or grid, with an optional count. */
export function SectionLabel({
  children,
  count,
}: PropsWithChildren<{ count?: number }>) {
  const type = useType();
  return (
    <View
      accessible
      accessibilityRole="header"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        marginTop: 24,
        marginBottom: 10,
        paddingHorizontal: 4,
      }}
    >
      <Text style={[type.meta, { flex: 1 }]}>{children}</Text>
      {count !== undefined ? <Text style={type.caption}>{count}</Text> : null}
    </View>
  );
}
