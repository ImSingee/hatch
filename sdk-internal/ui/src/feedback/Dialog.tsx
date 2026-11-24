import { Text, View, signal } from 'nsh';
import type { JSX } from 'nsh';
import {
  AlertDialog as NativeAlertDialog,
  Dialog as BaseDialog,
  Sheet as BaseSheet,
} from 'nsh/base';
import { phone, touch } from '../core/env';
import { InOverlayContext } from '../core/overlay';
import { BACKDROP } from '../core/styles';
import { HeadingText } from '../display/Text';
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
        <HeadingText level={2} class="text-modal text-foreground text-balance">
          {props.title}
        </HeadingText>
        {props.description ? (
          <Text class="text-body text-muted-foreground text-pretty">
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

function Footer(props: { children?: JSX.Element }): JSX.Element {
  return (
    <View class="border-t border-hairline bg-muted pb-[env(safe-area-inset-bottom)]">
      <View class="flex-row flex-wrap items-center justify-end gap-2 px-6 py-3">
        {props.children}
      </View>
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
      class={`m-auto w-full ${DIALOG_WIDTH[props.size ?? 'md']} overflow-hidden rounded-(--radius-window) bg-card shadow-window max-sm:m-0 max-sm:h-full max-sm:max-w-none max-sm:rounded-none`}
    >
      <InOverlayContext.Provider value>
        <View class="gap-4 px-6 pb-6 pt-5 max-sm:flex-1 max-sm:pt-[env(safe-area-inset-top)]">
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

/**
 * A panel for a longer side task: from the bottom on touch screens and in
 * compact panes, from the end edge on desktops.
 */
export function Sheet(props: SheetProps): JSX.Element {
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

function ask(request: Omit<Pending, 'resolve'>): Promise<boolean> {
  if (touch) {
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

/** Shows `AlertDialog` on desktops. `mount` renders it; Apps do not. */
export function AlertDialogHost(): JSX.Element {
  const answer = (confirmed: boolean) => {
    const current = pending();
    pending.set(null);
    current?.resolve(confirmed);
  };
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
