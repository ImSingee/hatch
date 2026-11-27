import { Text, View, platform, signal } from 'nsh';
import type { JSX } from 'nsh';
import {
  AlertDialog as NativeAlertDialog,
  Dialog as BaseDialog,
  Sheet as BaseSheet,
} from 'nsh/base';
import { Button as BaseButton } from 'nsh/base';
import { byLook, look, mobileLook, phone, touch } from '../core/env';
import { InOverlayContext, StackedActionsContext } from '../core/overlay';
import { BACKDROP, FOCUS_RING } from '../core/styles';
import { SurfaceContext } from '../core/surface';
import { BODY, HeadingText, TITLE } from '../display/Text';
import { IconX } from '../icons/icons.gen';
import { Button, IconButton } from '../input/Button';

type OverlayProps = {
  /** Shown while true. */
  open: boolean;
  /** The user closed it (Escape, the backdrop, a swipe, the close button),
   * or it opened. Set `open` to match. */
  onOpenChange: (open: boolean) => void;
  /** The title, which screen readers read as its name. */
  title: string;
  /** One or two sentences under the title. */
  description?: string;
  children?: JSX.Element;
  /** Buttons at the bottom: the main action last, at most one primary. */
  actions?: JSX.Element;
};

function OverlayHeader(props: {
  title: string;
  description?: string;
  onClose: () => void;
}): JSX.Element {
  return (
    <View class="flex-row items-start gap-3">
      <View class="flex-1 gap-1">
        <HeadingText
          level={2}
          class={`${TITLE.modal} text-foreground text-balance`}
        >
          {props.title}
        </HeadingText>
        {props.description ? (
          <Text class={`${BODY.body} text-muted-foreground text-pretty`}>
            {props.description}
          </Text>
        ) : null}
      </View>
      <View class="-mr-2 -mt-1">
        <IconButton
          icon={IconX}
          label="Close"
          size="sm"
          onPress={props.onClose}
        />
      </View>
    </View>
  );
}

/** The window of a dialog and its footer on each look: the Desk's window
 * with a muted footer; macOS's, its buttons at the end of the content;
 * Fluent's content dialog with its button bar. iOS and Android show sheets
 * on phones and keep the Desk's window elsewhere. */
const WINDOW = byLook({
  web: {
    window:
      'overflow-hidden rounded-(--radius-window) bg-card shadow-window max-sm:m-0 max-sm:h-full max-sm:max-w-none max-sm:rounded-none',
    body: 'gap-4 px-6 pb-6 pt-5 max-sm:flex-1 max-sm:pt-[env(safe-area-inset-top)]',
    footer:
      'border-t border-hairline bg-muted pb-[env(safe-area-inset-bottom)]',
    footerRow: 'flex-row flex-wrap items-center justify-end gap-2 px-6 py-3',
  },
  ios: {
    window:
      'overflow-hidden rounded-(--radius-window) bg-card shadow-window max-sm:m-0 max-sm:h-full max-sm:max-w-none max-sm:rounded-none',
    body: 'gap-4 px-6 pb-6 pt-5 max-sm:flex-1 max-sm:pt-[env(safe-area-inset-top)]',
    footer:
      'border-t border-hairline bg-muted pb-[env(safe-area-inset-bottom)]',
    footerRow: 'flex-row flex-wrap items-center justify-end gap-2 px-6 py-3',
  },
  android: {
    window:
      'overflow-hidden rounded-(--radius-window) bg-card shadow-window max-sm:m-0 max-sm:h-full max-sm:max-w-none max-sm:rounded-none',
    body: 'gap-4 px-6 pb-6 pt-5 max-sm:flex-1 max-sm:pt-[env(safe-area-inset-top)]',
    footer:
      'border-t border-hairline bg-muted pb-[env(safe-area-inset-bottom)]',
    footerRow: 'flex-row flex-wrap items-center justify-end gap-2 px-6 py-3',
  },
  macos: {
    window:
      'overflow-hidden rounded-(--radius-lg) border border-hairline bg-card shadow-window max-sm:m-0 max-sm:h-full max-sm:max-w-none max-sm:rounded-none',
    body: 'gap-3 px-5 pb-4 pt-4 max-sm:flex-1',
    footer: '',
    footerRow: 'flex-row flex-wrap items-center justify-end gap-2 px-5 pb-5',
  },
  windows: {
    window:
      'overflow-hidden rounded-(--radius-sm) border border-hairline bg-card shadow-window max-sm:m-0 max-sm:h-full max-sm:max-w-none max-sm:rounded-none',
    body: 'gap-4 px-6 pb-6 pt-6 max-sm:flex-1',
    footer: 'border-t border-hairline bg-muted',
    footerRow: 'flex-row flex-wrap items-center justify-end gap-2 p-6',
  },
});

function Footer(props: { children?: JSX.Element }): JSX.Element {
  return (
    <View class={WINDOW.footer}>
      <View class={WINDOW.footerRow}>{props.children}</View>
    </View>
  );
}

export type DialogProps = OverlayProps & {
  /** Its width on desktops: `sm` 384, `md` 512 (default), `lg` 672 points. */
  size?: 'sm' | 'md' | 'lg';
};

const DIALOG_WIDTH: Record<NonNullable<DialogProps['size']>, string> = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
};

/**
 * A modal window over the App for a short task: a centred window on
 * desktops, a sheet from the bottom on phones.
 */
export function Dialog(props: DialogProps): JSX.Element {
  if (phone) {
    return (
      <Sheet
        open={props.open}
        onOpenChange={props.onOpenChange}
        title={props.title}
        description={props.description}
        actions={props.actions}
      >
        {props.children}
      </Sheet>
    );
  }
  const close = () => props.onOpenChange(false);
  return (
    <BaseDialog
      open={props.open}
      animation="fade"
      accessibilityLabel={props.title}
      accessibilityDescription={props.description}
      onOpenChange={(event) => props.onOpenChange(event.open)}
      backdropClass={BACKDROP}
      class={`m-auto w-full ${DIALOG_WIDTH[props.size ?? 'md']} ${WINDOW.window}`}
    >
      <InOverlayContext.Provider value>
        <View class={WINDOW.body}>
          <OverlayHeader
            title={props.title}
            description={props.description}
            onClose={close}
          />
          {props.children}
        </View>
        {props.actions ? <Footer>{props.actions}</Footer> : null}
      </InOverlayContext.Provider>
    </BaseDialog>
  );
}

export type SheetProps = OverlayProps;

/** The sheet's title and description on iOS and Android. */
function PlatformSheetHeader(props: {
  title: string;
  description?: string;
}): JSX.Element {
  return (
    <View class="gap-1">
      <HeadingText
        level={2}
        class={`${TITLE.modal} text-foreground text-balance`}
      >
        {props.title}
      </HeadingText>
      {props.description ? (
        <Text
          class={`${look === 'ios' ? 'text-ios-footnote' : 'text-m3-body-md'} font-regular text-muted-foreground text-pretty`}
        >
          {props.description}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * iOS: a sheet on the grouped ground with a grabber and Cancel at the top.
 * Android (Material 3): a bottom sheet with the drag handle, its corners
 * 28 points. Both stack the actions full width at the bottom.
 */
function PlatformSheet(props: SheetProps): JSX.Element {
  const ios = look === 'ios';
  const close = () => props.onOpenChange(false);
  return (
    <BaseSheet
      open={props.open}
      onOpenChange={(event) => props.onOpenChange(event.open)}
      side="bottom"
      closeOnSwipe
      grabber
      grabberClass={
        ios
          ? 'mt-1.5 h-1.25 w-9 self-center rounded-full bg-track'
          : 'mb-1 mt-4 h-1 w-8 self-center rounded-full bg-control-border'
      }
      grabberAccessibilityLabel="Resize"
      accessibilityLabel={props.title}
      backdropClass={BACKDROP}
      popupClass={`max-h-[90%] rounded-t-(--radius-sheet) shadow-window ${ios ? 'bg-background' : 'bg-card'}`}
      footer={
        props.actions ? (
          <InOverlayContext.Provider value>
            <StackedActionsContext.Provider value>
              <View class="px-5 pb-[env(safe-area-inset-bottom)]">
                <View class="flex-col-reverse gap-3 pb-4 pt-2">
                  {props.actions}
                </View>
              </View>
            </StackedActionsContext.Provider>
          </InOverlayContext.Provider>
        ) : undefined
      }
    >
      <InOverlayContext.Provider value>
        <SurfaceContext.Provider value={ios ? 'background' : 'card'}>
          <View class={`flex-1 gap-4 pb-6 ${ios ? 'px-5' : 'px-6 pt-1'}`}>
            {ios ? (
              <View class="h-11 flex-row items-center">
                <BaseButton
                  onPress={close}
                  accessibilityLabel="Cancel"
                  class={`h-11 flex-row items-center rounded-(--radius-sm) active:opacity-50 ${FOCUS_RING}`}
                >
                  <Text class="text-ios-body font-regular text-primary-strong">
                    Cancel
                  </Text>
                </BaseButton>
              </View>
            ) : null}
            <PlatformSheetHeader
              title={props.title}
              description={props.description}
            />
            {props.children}
          </View>
        </SurfaceContext.Provider>
      </InOverlayContext.Provider>
    </BaseSheet>
  );
}

/**
 * A panel for a longer side task: from the bottom on touch screens and in
 * compact panes, from the end edge on desktops.
 */
export function Sheet(props: SheetProps): JSX.Element {
  if (mobileLook && touch) return <PlatformSheet {...props} />;
  const bottom = touch;
  const close = () => props.onOpenChange(false);
  return (
    <BaseSheet
      open={props.open}
      onOpenChange={(event) => props.onOpenChange(event.open)}
      side={bottom ? 'bottom' : 'right'}
      closeOnSwipe
      grabber={bottom}
      grabberClass="mt-2 h-1.5 w-9 self-center rounded-full bg-track"
      grabberAccessibilityLabel="Resize"
      accessibilityLabel={props.title}
      backdropClass={BACKDROP}
      popupClass={
        bottom
          ? 'max-h-[90%] rounded-t-(--radius-window) bg-card shadow-window'
          : 'h-full w-full max-w-md border-l border-hairline bg-card shadow-window'
      }
      footer={
        props.actions ? (
          <InOverlayContext.Provider value>
            <Footer>{props.actions}</Footer>
          </InOverlayContext.Provider>
        ) : undefined
      }
    >
      <InOverlayContext.Provider value>
        <View class="flex-1 gap-4 px-6 pb-6 pt-4">
          <OverlayHeader
            title={props.title}
            description={props.description}
            onClose={close}
          />
          {props.children}
        </View>
      </InOverlayContext.Provider>
    </BaseSheet>
  );
}

type Pending = {
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel: string | null;
  destructive: boolean;
  resolve: (confirmed: boolean) => void;
};

const pending = signal<Pending | null>(null);

/**
 * Whether the platform's own alert asks: on touch screens, except where the
 * web player stands in for iOS or Android (the Mobile app's WebView), whose
 * browser alert is neither; there the library draws the platform's.
 */
const NATIVE_ALERT = touch && (look === 'web' || platform.os !== 'web');

function ask(request: Omit<Pending, 'resolve'>): Promise<boolean> {
  if (NATIVE_ALERT) {
    // Phones and tablets ask with the platform's own alert.
    return NativeAlertDialog.show({
      title: request.title,
      description: request.description,
      actions: [
        ...(request.cancelLabel
          ? [
              {
                label: request.cancelLabel,
                role: 'cancel' as const,
                id: 'cancel',
              },
            ]
          : []),
        {
          label: request.confirmLabel,
          role: request.destructive
            ? ('destructive' as const)
            : ('default' as const),
          id: 'confirm',
        },
      ],
    }).then((result) => result.action === 'confirm');
  }
  return new Promise((resolve) => {
    pending()?.resolve(false);
    pending.set({ ...request, resolve });
  });
}

/**
 * Asks the user to confirm before an action that cannot be undone. Do not
 * ask for actions that can be undone: do them, and offer Undo in a `Toast`.
 */
export const AlertDialog = {
  /** Resolves to true when the user confirms. */
  confirm: (options: {
    title: string;
    description?: string;
    /** The action, as a verb: "Delete", "Leave". */
    confirmLabel: string;
    cancelLabel?: string;
    /** Draws the action in red. */
    destructive?: boolean;
  }): Promise<boolean> =>
    ask({
      title: options.title,
      description: options.description,
      confirmLabel: options.confirmLabel,
      cancelLabel: options.cancelLabel ?? 'Cancel',
      destructive: options.destructive === true,
    }),
  /** Tells the user something they must read before going on. */
  alert: (options: {
    title: string;
    description?: string;
    buttonLabel?: string;
  }): Promise<void> =>
    ask({
      title: options.title,
      description: options.description,
      confirmLabel: options.buttonLabel ?? 'OK',
      cancelLabel: null,
      destructive: false,
    }).then(() => undefined),
};

/** One button of iOS's alert: a cell of the row under the message. */
function IosAlertButton(props: {
  label: string;
  bold?: boolean;
  destructive?: boolean;
  divided?: boolean;
  onPress: () => void;
}): JSX.Element {
  return (
    <BaseButton
      onPress={props.onPress}
      accessibilityLabel={props.label}
      class={`h-11 flex-1 items-center justify-center active:bg-surface-pressed ${props.divided ? 'border-l border-hairline' : ''} ${FOCUS_RING}`}
    >
      <Text
        class={`text-ios-body ${props.bold ? 'font-semibold' : 'font-regular'} ${props.destructive ? 'text-danger-strong' : 'text-primary-strong'}`}
      >
        {props.label}
      </Text>
    </BaseButton>
  );
}

/** iOS's alert: 270 points, the message centred, the buttons in a row. */
function IosAlert(props: {
  answer: (confirmed: boolean) => void;
}): JSX.Element {
  return (
    <BaseDialog
      open={pending() !== null}
      animation="fade"
      role="alertdialog"
      accessibilityLabel={pending()?.title ?? ''}
      accessibilityDescription={pending()?.description}
      onOpenChange={(event) => {
        if (!event.open) props.answer(false);
      }}
      backdropClass={BACKDROP}
      class="m-auto w-67.5 overflow-hidden rounded-(--radius-lg) bg-popover shadow-window"
    >
      <View class="items-center gap-1 px-4 pb-4 pt-5">
        <HeadingText
          level={2}
          class="text-center text-ios-body font-semibold tracking-normal text-foreground"
        >
          {pending()?.title ?? ''}
        </HeadingText>
        {pending()?.description ? (
          <Text class="text-center text-ios-footnote font-regular text-foreground">
            {pending()?.description ?? ''}
          </Text>
        ) : null}
      </View>
      <View class="flex-row border-t border-hairline">
        {pending()?.cancelLabel ? (
          <IosAlertButton
            label={pending()?.cancelLabel ?? 'Cancel'}
            onPress={() => props.answer(false)}
          />
        ) : null}
        <IosAlertButton
          label={pending()?.confirmLabel ?? 'OK'}
          bold
          destructive={pending()?.destructive}
          divided={Boolean(pending()?.cancelLabel)}
          onPress={() => props.answer(true)}
        />
      </View>
    </BaseDialog>
  );
}

/** Material 3's alert dialog: 28-point corners, text buttons at the end. */
function AndroidAlert(props: {
  answer: (confirmed: boolean) => void;
}): JSX.Element {
  return (
    <BaseDialog
      open={pending() !== null}
      animation="fade"
      role="alertdialog"
      accessibilityLabel={pending()?.title ?? ''}
      accessibilityDescription={pending()?.description}
      onOpenChange={(event) => {
        if (!event.open) props.answer(false);
      }}
      backdropClass={BACKDROP}
      class="m-auto w-full max-w-sm gap-4 overflow-hidden rounded-(--radius-sheet) bg-card p-6 shadow-window"
    >
      <HeadingText level={2} class={`${TITLE.modal} text-foreground`}>
        {pending()?.title ?? ''}
      </HeadingText>
      {pending()?.description ? (
        <Text class="text-m3-body-md font-regular text-muted-foreground">
          {pending()?.description ?? ''}
        </Text>
      ) : null}
      <View class="flex-row justify-end gap-2 pt-2">
        {pending()?.cancelLabel ? (
          <Button
            label={pending()?.cancelLabel ?? 'Cancel'}
            kind="subtle"
            size="sm"
            onPress={() => props.answer(false)}
          />
        ) : null}
        <Button
          label={pending()?.confirmLabel ?? 'OK'}
          kind={pending()?.destructive ? 'danger' : 'subtle'}
          size="sm"
          onPress={() => props.answer(true)}
        />
      </View>
    </BaseDialog>
  );
}

/** macOS's alert: 260 points, the message centred, the buttons side by
 * side across its width, the action at the end. */
function MacAlert(props: {
  answer: (confirmed: boolean) => void;
}): JSX.Element {
  return (
    <BaseDialog
      open={pending() !== null}
      animation="fade"
      role="alertdialog"
      accessibilityLabel={pending()?.title ?? ''}
      accessibilityDescription={pending()?.description}
      onOpenChange={(event) => {
        if (!event.open) props.answer(false);
      }}
      backdropClass={BACKDROP}
      class="m-auto w-65 items-stretch gap-3 overflow-hidden rounded-(--radius-lg) border border-hairline bg-popover p-4 shadow-window"
    >
      <View class="items-center gap-1 pt-1">
        <HeadingText
          level={2}
          class="text-center text-mac-body font-bold tracking-normal text-foreground"
        >
          {pending()?.title ?? ''}
        </HeadingText>
        {pending()?.description ? (
          <Text class="text-center text-mac-callout font-regular text-foreground">
            {pending()?.description ?? ''}
          </Text>
        ) : null}
      </View>
      <View class="flex-row gap-2 pt-1">
        {pending()?.cancelLabel ? (
          <View class="flex-1">
            <Button
              label={pending()?.cancelLabel ?? 'Cancel'}
              fullWidth
              onPress={() => props.answer(false)}
            />
          </View>
        ) : null}
        <View class="flex-1">
          <Button
            label={pending()?.confirmLabel ?? 'OK'}
            kind={pending()?.destructive ? 'danger' : 'primary'}
            fullWidth
            onPress={() => props.answer(true)}
          />
        </View>
      </View>
    </BaseDialog>
  );
}

/** Fluent's content dialog: the message on the card, the buttons in the
 * bar under it at equal widths, the action first. */
function WindowsAlert(props: {
  answer: (confirmed: boolean) => void;
}): JSX.Element {
  return (
    <BaseDialog
      open={pending() !== null}
      animation="fade"
      role="alertdialog"
      accessibilityLabel={pending()?.title ?? ''}
      accessibilityDescription={pending()?.description}
      onOpenChange={(event) => {
        if (!event.open) props.answer(false);
      }}
      backdropClass={BACKDROP}
      class="m-auto w-full max-w-sm overflow-hidden rounded-(--radius-sm) border border-hairline bg-card shadow-window"
    >
      <View class="gap-3 p-6">
        <HeadingText level={2} class={`${TITLE.modal} text-foreground`}>
          {pending()?.title ?? ''}
        </HeadingText>
        {pending()?.description ? (
          <Text class="text-win-body font-regular text-foreground text-pretty">
            {pending()?.description ?? ''}
          </Text>
        ) : null}
      </View>
      <View class="flex-row gap-2 border-t border-hairline bg-muted p-6">
        <View class="flex-1">
          <Button
            label={pending()?.confirmLabel ?? 'OK'}
            kind={pending()?.destructive ? 'danger' : 'primary'}
            fullWidth
            onPress={() => props.answer(true)}
          />
        </View>
        {pending()?.cancelLabel ? (
          <View class="flex-1">
            <Button
              label={pending()?.cancelLabel ?? 'Cancel'}
              fullWidth
              onPress={() => props.answer(false)}
            />
          </View>
        ) : null}
      </View>
    </BaseDialog>
  );
}

/** Shows `AlertDialog` on desktops, and in the web player on iOS and
 * Android. `mount` renders it; Apps do not. */
export function AlertDialogHost(): JSX.Element {
  const answer = (confirmed: boolean) => {
    const current = pending();
    pending.set(null);
    current?.resolve(confirmed);
  };
  if (look === 'ios') return <IosAlert answer={answer} />;
  if (look === 'android') return <AndroidAlert answer={answer} />;
  if (look === 'macos') return <MacAlert answer={answer} />;
  if (look === 'windows') return <WindowsAlert answer={answer} />;
  return (
    <BaseDialog
      open={pending() !== null}
      animation="fade"
      role="alertdialog"
      accessibilityLabel={pending()?.title ?? ''}
      accessibilityDescription={pending()?.description}
      onOpenChange={(event) => {
        if (!event.open) answer(false);
      }}
      backdropClass={BACKDROP}
      class="m-auto w-full max-w-sm overflow-hidden rounded-(--radius-window) bg-card shadow-window"
    >
      <View class="gap-2 px-6 pb-5 pt-6">
        <HeadingText level={2} class="text-modal text-foreground text-balance">
          {pending()?.title ?? ''}
        </HeadingText>
        {pending()?.description ? (
          <Text class="text-body text-muted-foreground text-pretty">
            {pending()?.description ?? ''}
          </Text>
        ) : null}
      </View>
      <Footer>
        {pending()?.cancelLabel ? (
          <Button
            label={pending()?.cancelLabel ?? 'Cancel'}
            onPress={() => answer(false)}
          />
        ) : null}
        <Button
          label={pending()?.confirmLabel ?? 'OK'}
          kind={pending()?.destructive ? 'danger' : 'primary'}
          onPress={() => answer(true)}
        />
      </Footer>
    </BaseDialog>
  );
}
