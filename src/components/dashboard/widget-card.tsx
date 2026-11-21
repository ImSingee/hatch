import {
  ActionIcon,
  Button,
  Skeleton,
  Text,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconChevronRight,
  IconGripVertical,
  IconRefresh,
  IconX,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { AppGlyph } from '~components/apps/app-glyph';
import { EmptyState } from '~components/page/page';
import { useEventCallback } from '~hooks/use-latest-committed';
import type { DashboardLayoutItem } from '~/lib/dashboard-layout';
import type { GridSize } from '~server/apps/manifest';
import type { DashboardItem } from '~server/dashboards';
import {
  WIDGET_CHANNEL,
  toModuleDataUrl,
  widgetFrameHtml,
} from './widget-frame';
import classes from './widget-card.module.css';

export function WidgetCard({
  item,
  geometry,
  editing,
  removeDisabled = false,
  onRemove,
  refreshSignal = 0,
  nativeHost = false,
  sizes = [],
  onSizeChange,
  onMove,
}: {
  item: DashboardItem;
  geometry: DashboardLayoutItem;
  editing: boolean;
  removeDisabled?: boolean;
  onRemove: () => void;
  /**
   * Monotonic counter bumped by dashboard-wide manual and automatic refreshes.
   * Each new value posts a `refresh` message to a ready widget; the initial
   * value is ignored so a freshly mounted widget isn't refreshed redundantly.
   */
  refreshSignal?: number;
  /**
   * Rendered inside the native app's WebView. The host owns refresh controls,
   * and Open app is a document link that the host intercepts before it loads,
   * so the embedded router and history never change.
   */
  nativeHost?: boolean;
  /**
   * Footprints offered as buttons while editing, for the breakpoint being
   * edited. Fewer than two means the widget is resized with the handle.
   */
  sizes?: GridSize[];
  onSizeChange?: (size: GridSize) => void;
  /** Move by whole grid cells, for keyboard users of the drag handle. */
  onMove?: (dx: number, dy: number) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const frameFocused = useFrameFocused(frameRef);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [refreshSupported, setRefreshSupported] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshSupportedRef = useRef(false);
  const refreshingRef = useRef(false);
  const activeRefreshRequestRef = useRef<string | null>(null);
  const refreshSequenceRef = useRef(0);
  const frameGenerationRef = useRef<string | null>(null);
  // Bumped by "Try again" so the frame loads the bundle afresh.
  const [attempt, setAttempt] = useState(0);

  // Read the latest grid units inside the (url-keyed) load effect without
  // rebuilding the frame when only the size changes — those go down as `units`
  // messages instead, so a resize never reloads the widget.
  const getUnits = useEventCallback(() => ({ w: geometry.w, h: geometry.h }));

  // Fetch the (authenticated, same-origin) bundle in the host, then hand it to
  // the iframe as an inlined `data:` module. Fetching here keeps the request
  // out of the dev module pipeline (which intercepts a direct import of the
  // served URL); the widget still executes inside its own iframe document.
  // useQuery dedupes concurrent mounts of the same widget and paints instantly
  // from cache, while the default staleTime (0) still revalidates on every
  // mount — the URL is stable across redeploys, so a longer staleTime would
  // serve a stale bundle right after a deploy. The reload effect below keys on
  // the code string itself, so a revalidation that returns unchanged code
  // never reloads the frame (string deps compare by value); only a genuinely
  // new bundle does. Focus refetches stay off so a mounted widget is not
  // reloaded just by switching windows.
  const bundle = useQuery({
    queryKey: ['widget-bundle', item.url],
    queryFn: async () => {
      const res = await fetch(item.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    },
    refetchOnWindowFocus: false,
  });
  const code = bundle.data;

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const generation = crypto.randomUUID();
    frameGenerationRef.current = generation;
    setStatus('loading');
    refreshSupportedRef.current = false;
    refreshingRef.current = false;
    activeRefreshRequestRef.current = null;
    setRefreshSupported(false);
    setRefreshing(false);
    if (code === undefined) {
      return () => {
        if (frameGenerationRef.current === generation) {
          frameGenerationRef.current = null;
        }
      };
    }

    let cancelled = false;

    // Only accept lifecycle messages from this frame's current srcdoc load.
    const onMessage = (event: MessageEvent) => {
      if (cancelled || event.source !== frame.contentWindow) return;
      const data = event.data as {
        [WIDGET_CHANNEL]?: string;
        generation?: string;
        requestId?: string;
        supported?: boolean;
      } | null;
      if (!data || typeof data !== 'object' || data.generation !== generation) {
        return;
      }
      if (data[WIDGET_CHANNEL] === 'ready') {
        setStatus('ready');
        // Re-sync grid units after every mount. This also covers a bundle
        // replacement that remounts the iframe after the placement was resized.
        frame.contentWindow?.postMessage(
          {
            [WIDGET_CHANNEL]: 'units',
            generation,
            ...getUnits(),
          },
          '*',
        );
      } else if (data[WIDGET_CHANNEL] === 'refresh-capability') {
        const supported = data.supported === true;
        refreshSupportedRef.current = supported;
        setRefreshSupported(supported);
      } else if (
        data[WIDGET_CHANNEL] === 'refresh-complete' &&
        data.requestId === activeRefreshRequestRef.current
      ) {
        activeRefreshRequestRef.current = null;
        refreshingRef.current = false;
        setRefreshing(false);
      } else if (data[WIDGET_CHANNEL] === 'error') {
        activeRefreshRequestRef.current = null;
        refreshingRef.current = false;
        setRefreshing(false);
        setStatus('error');
      }
    };
    window.addEventListener('message', onMessage);
    frame.srcdoc = widgetFrameHtml(
      toModuleDataUrl(code),
      getUnits(),
      generation,
    );

    return () => {
      cancelled = true;
      if (frameGenerationRef.current === generation) {
        frameGenerationRef.current = null;
      }
      refreshSupportedRef.current = false;
      refreshingRef.current = false;
      activeRefreshRequestRef.current = null;
      window.removeEventListener('message', onMessage);
      frame.srcdoc = '';
    };
  }, [attempt, code, getUnits]);

  const effectiveStatus = bundle.isError ? 'error' : status;

  // Push grid-unit changes (a resize that lands new w/h) to the running widget
  // without reloading it. Pixel size is measured inside the frame, so it needs
  // no host message. Re-sends on ready too, in case w/h changed mid-load.
  useEffect(() => {
    if (status !== 'ready') return;
    const generation = frameGenerationRef.current;
    if (!generation) return;
    frameRef.current?.contentWindow?.postMessage(
      {
        [WIDGET_CHANNEL]: 'units',
        generation,
        w: geometry.w,
        h: geometry.h,
      },
      '*',
    );
  }, [geometry.h, geometry.w, status]);

  // Ask a refresh-capable widget to refetch in place. The request id ties the
  // loading state to this exact refresh, and the ref prevents manual, global,
  // and automatic triggers from overlapping for the same widget.
  const requestRefresh = useEventCallback(() => {
    if (
      status !== 'ready' ||
      !refreshSupportedRef.current ||
      refreshingRef.current
    ) {
      return;
    }

    const target = frameRef.current?.contentWindow;
    const generation = frameGenerationRef.current;
    if (!target || !generation) return;

    refreshSequenceRef.current += 1;
    const requestId = `${item.id}:${refreshSequenceRef.current}`;
    activeRefreshRequestRef.current = requestId;
    refreshingRef.current = true;
    setRefreshing(true);
    target.postMessage(
      { [WIDGET_CHANNEL]: 'refresh', generation, requestId },
      '*',
    );
  });

  // Fan a dashboard-wide manual or automatic refresh out to this widget. Skip
  // the first run so a freshly mounted card isn't refreshed immediately.
  // requestRefresh reads the live status/capability refs, so unsupported or
  // busy widgets are skipped.
  const refreshMounted = useRef(false);
  useEffect(() => {
    if (!refreshMounted.current) {
      refreshMounted.current = true;
      return;
    }
    requestRefresh();
  }, [refreshSignal, requestRefresh]);

  const retry = () => {
    if (bundle.isError) void bundle.refetch();
    else setAttempt((value) => value + 1);
  };

  const sizeLabel = (size: GridSize) => `${size.w}×${size.h}`;
  const moveKeys: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };

  return (
    <article
      className={classes.card}
      data-editing={editing || undefined}
      data-status={effectiveStatus}
      aria-label={item.name}
      aria-busy={effectiveStatus === 'loading' || undefined}
    >
      {editing ? (
        <>
          <Tooltip label="Remove from dashboard" withArrow>
            <ActionIcon
              variant="filled"
              color="dark"
              radius="xl"
              size={30}
              aria-label="Remove widget"
              className={`widget-no-drag ${classes.remove}`}
              disabled={removeDisabled}
              onClick={onRemove}
            >
              <IconX size={15} stroke={2.4} />
            </ActionIcon>
          </Tooltip>
          <div className={`widget-drag-handle ${classes.editBar}`}>
            <UnstyledButton
              className={classes.grip}
              aria-label={`Move ${item.name}`}
              aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown"
              onKeyDown={(event) => {
                const delta = moveKeys[event.key];
                if (!delta || !onMove) return;
                event.preventDefault();
                onMove(...delta);
              }}
            >
              <IconGripVertical size={15} stroke={2} aria-hidden />
              Drag
            </UnstyledButton>
            {sizes.length > 1 ? (
              <fieldset
                aria-label={`${item.name} size`}
                className={`widget-no-drag ${classes.sizes}`}
              >
                {sizes.map((size) => {
                  const current =
                    size.w === geometry.w && size.h === geometry.h;
                  return (
                    <UnstyledButton
                      key={sizeLabel(size)}
                      className={classes.size}
                      aria-pressed={current}
                      disabled={removeDisabled}
                      onClick={() => {
                        if (!current) onSizeChange?.(size);
                      }}
                    >
                      {sizeLabel(size)}
                    </UnstyledButton>
                  );
                })}
              </fieldset>
            ) : (
              <span className={classes.sizeReadout}>{sizeLabel(geometry)}</span>
            )}
          </div>
        </>
      ) : null}

      <header className={classes.header}>
        <AppGlyph name={item.appName} seed={item.appId} size="widget" />
        <h2 className={classes.title}>{item.name}</h2>
        {effectiveStatus === 'loading' ? (
          <Text component="span" className={classes.meta}>
            Loading…
          </Text>
        ) : null}
        {!editing ? (
          <div className={`widget-no-drag ${classes.actions}`}>
            {!nativeHost && (refreshSupported || refreshing) ? (
              <Tooltip label={refreshing ? 'Refreshing' : 'Refresh'} withArrow>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  size="sm"
                  aria-label="Refresh widget"
                  aria-busy={refreshing}
                  loading={refreshing}
                  disabled={effectiveStatus !== 'ready'}
                  onClick={requestRefresh}
                  className={classes.refresh}
                >
                  <IconRefresh size={15} />
                </ActionIcon>
              </Tooltip>
            ) : null}
            {nativeHost ? (
              <a
                href={`/app/${encodeURIComponent(item.appSlug)}`}
                className={classes.appLink}
                aria-label={`Open ${item.appName}`}
              >
                <span className={classes.appName}>{item.appName}</span>
                <IconChevronRight size={13} stroke={2.4} aria-hidden />
              </a>
            ) : (
              <Link
                to="/app/$appSlug"
                params={{ appSlug: item.appSlug }}
                className={classes.appLink}
                aria-label={`Open ${item.appName}`}
              >
                <span className={classes.appName}>{item.appName}</span>
                <IconChevronRight size={13} stroke={2.4} aria-hidden />
              </Link>
            )}
          </div>
        ) : null}
      </header>

      {/* The iframe stays laid out under any loading/error overlay so the
          widget's in-frame ResizeObserver measures its real pixel size from the
          first mount (a display:none frame would report 0x0 until shown). */}
      <div
        className={classes.frameContainer}
        data-focused={frameFocused || undefined}
      >
        <iframe
          ref={frameRef}
          // Several Apps can offer a widget of the same name.
          title={`${item.name} from ${item.appName}`}
          // allow-scripts + allow-same-origin: scripts run and the widget keeps
          // the same-origin session its Connect client needs, while the
          // omitted tokens still block top-navigation and popups. See
          // widgetFrameHtml for why this is a robustness — not hard-security —
          // boundary.
          sandbox="allow-scripts allow-same-origin"
          className={classes.frame}
          data-editing={editing || undefined}
          style={{
            visibility: effectiveStatus === 'ready' ? 'visible' : 'hidden',
          }}
        />
        {effectiveStatus === 'loading' ? (
          <div className={classes.overlay} aria-hidden>
            <div className={classes.skeletonRow}>
              <Skeleton circle height={64} />
              <div className={classes.skeletonLines}>
                <Skeleton height={12} width="70%" radius="sm" />
                <Skeleton height={12} width="45%" radius="sm" />
              </div>
            </div>
            <Skeleton height={10} radius="sm" />
            <Skeleton height={10} width="82%" radius="sm" />
          </div>
        ) : null}
        {effectiveStatus === 'error' ? (
          <div className={classes.overlay} role="alert">
            <EmptyState
              variant="dashed"
              compact
              tone="danger"
              icon={<IconAlertTriangle size={17} stroke={1.8} />}
              title="This widget didn’t load"
              actions={
                editing ? null : (
                  <Button
                    type="button"
                    size="compact-sm"
                    variant="default"
                    leftSection={<IconRefresh size={14} stroke={2} />}
                    className="widget-no-drag"
                    onClick={retry}
                  >
                    Try again
                  </Button>
                )
              }
            >
              Try again, or redeploy {item.appName} if it keeps failing.
            </EmptyState>
          </div>
        ) : null}
      </div>
    </article>
  );
}

/**
 * Whether keyboard focus is inside the frame. The parent document matches no
 * focus pseudo-class on a frame whose content has focus, so this follows the
 * document's active element: focus entering a frame blurs this window, and
 * focus coming back raises `focusin` here.
 */
function useFrameFocused(frameRef: RefObject<HTMLIFrameElement | null>) {
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () =>
      setFocused(
        frameRef.current !== null &&
          document.activeElement === frameRef.current,
      );
    // The active element changes just after the window's blur event.
    const onBlur = () => {
      clearTimeout(timer);
      timer = setTimeout(update, 0);
    };
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', update);
    document.addEventListener('focusin', update);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', update);
      document.removeEventListener('focusin', update);
    };
  }, [frameRef]);
  return focused;
}
