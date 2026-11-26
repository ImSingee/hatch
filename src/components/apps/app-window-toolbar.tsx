import { ActionIcon, Box, Button, Tooltip } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import {
  IconExternalLink,
  IconRefresh,
  IconSettings,
} from '@tabler/icons-react';
import { useI18n } from '~i18n';
import { appSurfaceSource } from '~components/desk/app-surface-source';
import classes from './app-window-toolbar.module.css';

/**
 * The controls in an App window's title bar: reload (an "Update available"
 * pill while a newer deployment is live), open in a new tab, and Manage.
 */
export function AppWindowToolbar({
  slug,
  canOpen,
  updateAvailable,
  reloading,
  onReload,
}: {
  slug: string;
  /** Whether the window runs the App's frontend. */
  canOpen: boolean;
  updateAvailable: boolean;
  reloading: boolean;
  onReload: () => void;
}) {
  const { t } = useI18n();
  const reloadLabel = updateAvailable
    ? t('appDetail.updateReload')
    : t('appDetail.reload');
  // Clicking the pill hands off to the plain reload icon, which carries the
  // loading state; the pill only returns if the reload fails.
  const showUpdatePill = updateAvailable && !reloading;

  return (
    <>
      {canOpen || updateAvailable ? (
        <>
          {showUpdatePill ? (
            <Box component="output" className={classes.update}>
              <Tooltip label={t('appDetail.reloadToApply')} withArrow>
                <Button
                  size="compact-sm"
                  variant="light"
                  color="primary"
                  // The light variant's default shade-6 text is ~3.3:1 on
                  // its tint; shade 8 keeps small text above WCAG AA.
                  c="primary.8"
                  radius="xl"
                  fw={600}
                  className={classes.updateButton}
                  aria-label={reloadLabel}
                  onClick={onReload}
                  leftSection={
                    <IconRefresh
                      className={classes.updateIcon}
                      size={15}
                      stroke={2}
                      aria-hidden
                    />
                  }
                >
                  {t('appDetail.updateAvailable')}
                </Button>
              </Tooltip>
            </Box>
          ) : (
            <Tooltip label={reloadLabel} withArrow>
              <ActionIcon
                variant="subtle"
                color="gray"
                aria-label={reloadLabel}
                loading={reloading}
                onClick={onReload}
              >
                <IconRefresh size={18} stroke={1.7} />
              </ActionIcon>
            </Tooltip>
          )}
          {canOpen ? (
            <Tooltip label={t('appDetail.openInNewTab')} withArrow>
              <ActionIcon
                variant="subtle"
                color="gray"
                component="a"
                href={appSurfaceSource(slug)}
                target="_blank"
                rel="noreferrer"
                aria-label={t('appDetail.openInNewTab')}
              >
                <IconExternalLink size={18} stroke={1.7} />
              </ActionIcon>
            </Tooltip>
          ) : null}
        </>
      ) : null}
      <Tooltip label={t('common.manage')} withArrow>
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label={t('common.manage')}
          renderRoot={(props) => (
            <Link
              to="/app/$appSlug/manage"
              params={{ appSlug: slug }}
              {...props}
            />
          )}
        >
          <IconSettings size={18} stroke={1.7} />
        </ActionIcon>
      </Tooltip>
    </>
  );
}
