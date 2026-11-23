import type { ReactNode } from 'react';
import classes from './desk-ground.module.css';

/**
 * The desk itself: the warm ground with its three soft shapes. Everything the
 * platform shows sits on it, signed in or not.
 */
export function DeskGround({
  children,
  className,
  ...rest
}: {
  children: ReactNode;
  className?: string;
} & Record<`data-${string}`, string | undefined>) {
  return (
    <div
      className={className ? `${classes.ground} ${className}` : classes.ground}
      {...rest}
    >
      <div aria-hidden className={classes.shapes}>
        <span className={classes.shapeAccent} />
        <span className={classes.shapeWarm} />
        <span className={classes.shapeFresh} />
      </div>
      {children}
    </div>
  );
}
