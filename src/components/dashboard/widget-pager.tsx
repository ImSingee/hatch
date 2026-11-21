import { UnstyledButton } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
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

  return (
    <div className={classes.root}>
      <div ref={track} className={classes.track}>
        {order.map(({ item, geometry }) => (
          <div
            key={item.id}
            className={classes.page}
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
                className={classes.dot}
                aria-label={`Show ${item.name}`}
                aria-current={index === page || undefined}
                onClick={() => goTo(index)}
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
