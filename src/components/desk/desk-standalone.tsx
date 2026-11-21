import { Text } from '@mantine/core';
import dayjs from 'dayjs';
import type { ReactNode } from 'react';
import { Brand } from './brand';
import { DeskGround } from './desk-ground';
import bar from './menu-bar.module.css';
import classes from './desk-standalone.module.css';

/**
 * The desk for pages outside the signed-in shell (sign-in, device approval,
 * not found): the ground, a menu bar that carries only the brand, and the
 * page's card in the middle.
 */
export function DeskStandalone({
  children,
  align = 'center',
}: {
  children: ReactNode;
  /** `start` keeps a tall or growing column anchored below the bar. */
  align?: 'center' | 'start';
}) {
  return (
    <DeskGround className={classes.root}>
      <header
        className={`${bar.bar} ${classes.bar}`}
        // In the macOS app this bar sits under the traffic lights and moves
        // the window (Tauri's drag script); inert in a browser.
        data-tauri-drag-region="deep"
      >
        <span className={`${bar.item} ${classes.brand}`}>
          <Brand size="xs" />
        </span>
        <Text component="span" className={classes.date}>
          {dayjs().format('ddd, MMM D')}
        </Text>
      </header>
      <div className={classes.scroll}>
        <main className={classes.stage} data-align={align}>
          {children}
        </main>
      </div>
    </DeskGround>
  );
}
