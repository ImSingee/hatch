import { UnstyledButton } from '@mantine/core';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import type { DashboardItem } from '~server/dashboards';
import type { DashboardLayouts } from '~/lib/dashboard-layout';
import { WIDGET_ROW_HEIGHT, WIDGET_ROW_GAP } from './dashboard-grid';
import { WidgetCard } from './widget-card';
import classes from './widget-pager.module.css';

/**
 * The phone-width desk: one widget per page, swiped sideways, with page dots
 * and a way to see every widget stacked. Pages follow the mobile layout's
 * reading order and take its height for each widget.
 */
export function WidgetPager({
  items,
  layouts,
  refreshSignal,
  onShowAll,
}: {
  items: DashboardItem[];
  layouts: DashboardLayouts;
  refreshSignal: number;
  onShowAll: () => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(0);
  const order = layouts.mobile.flatMap((geometry) => {
    const item = items.find((candidate) => candidate.id === geometry.id);
    return item ? [{ item, geometry }] : [];
  });

  useEffect(() => {
    const element = track.current;
    if (!element) return;
    const onScroll = () => {
      const width = element.clientWidth || 1;
      setPage(Math.round(element.scrollLeft / width));
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
  }, []);

  const goTo = (index: number) => {
    const element = track.current;
    if (!element) return;
    element.scrollTo({ left: index * element.clientWidth, behavior: 'smooth' });
  };

  // Left and right arrows move between the dots, as in a tab list.
  const dots = useRef<(HTMLButtonElement | null)[]>([]);
  const onDotKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step =
      event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    const target =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? order.length - 1
          : step
            ? Math.min(order.length - 1, Math.max(0, page + step))
            : null;
    if (target === null) return;
    event.preventDefault();
    goTo(target);
    dots.current[target]?.focus();
  };

  return (
    <div className={classes.root}>
      <div ref={track} className={classes.track}>
        {order.map(({ item, geometry }, index) => (
          <div
            key={item.id}
            className={classes.page}
            // Tabbing into a widget off to the side brings its page in view.
            onFocus={() => {
              if (index !== page) goTo(index);
            }}
            style={{
              height: Math.max(
                240,
                geometry.h * WIDGET_ROW_HEIGHT +
                  (geometry.h - 1) * WIDGET_ROW_GAP,
              ),
            }}
          >
            <WidgetCard
              item={item}
              geometry={geometry}
              editing={false}
              onRemove={() => {}}
              refreshSignal={refreshSignal}
            />
          </div>
        ))}
      </div>
      <div className={classes.footer}>
        {order.length > 1 ? (
          <div className={classes.dots}>
            {order.map(({ item }, index) => (
              <UnstyledButton
                key={item.id}
                ref={(element) => {
                  dots.current[index] = element;
                }}
                className={classes.dot}
                aria-label={`Widget ${index + 1} of ${order.length}: ${item.name} from ${item.appName}`}
                aria-current={index === page || undefined}
                // One stop in the tab order; the arrows reach the others.
                tabIndex={index === page ? 0 : -1}
                onClick={() => goTo(index)}
                onKeyDown={onDotKey}
              />
            ))}
          </div>
        ) : null}
        <UnstyledButton className={classes.showAll} onClick={onShowAll}>
          All widgets ›
        </UnstyledButton>
      </div>
    </div>
  );
}
