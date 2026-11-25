import { VisuallyHidden } from '@mantine/core';
import { useEffect, useRef, type ReactNode } from 'react';
import { Brand } from '~components/desk/brand';
import { useI18n } from '~i18n';
import { DeskStandalone } from '~components/desk/desk-standalone';
import {
  StandaloneWindow,
  WindowHero,
} from '~components/page/standalone-window';
import { USER_CODE_LENGTH } from './device-api';
import classes from './device-approval.module.css';

export function DeviceLayout({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return (
    <DeskStandalone align="start">
      <StandaloneWindow title={t('cliAuth.windowTitle')}>
        {children}
      </StandaloneWindow>
    </DeskStandalone>
  );
}

/**
 * Page title for one step. When a step replaces another, focus moves to its
 * title so keyboard and screen reader users start at the new content.
 */
export function ViewHeader({
  title,
  focus = false,
  children,
}: {
  title: ReactNode;
  focus?: boolean;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focus) ref.current?.focus();
  }, [focus]);
  return (
    <WindowHero
      tile={<Brand size="lg" withWordmark={false} />}
      title={title}
      titleRef={ref}
    >
      {children}
    </WindowHero>
  );
}

/** The user code as the device prints it, spelled out for screen readers. */
export function DeviceCode({ code }: { code: string }) {
  const half = USER_CODE_LENGTH / 2;
  return (
    <p className={classes.code}>
      <VisuallyHidden>{code.split('').join(' ')}</VisuallyHidden>
      <span aria-hidden>{code.slice(0, half)}</span>
      <span aria-hidden className={classes.codeDash}>
        -
      </span>
      <span aria-hidden>{code.slice(half)}</span>
    </p>
  );
}
