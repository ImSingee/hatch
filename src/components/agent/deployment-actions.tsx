import {
  ActionIcon,
  Box,
  Button,
  Group,
  Menu,
  Text,
  Tooltip,
} from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { IconDots, IconExternalLink, IconSettings } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { AppGlyph } from '~components/apps/app-glyph';
import type { AppListItem } from '~server/apps';
import classes from './chat.module.css';

type DeploymentResource = {
  id: string;
  slug: string;
  name: string;
};

type ResolvedDeployment<T extends DeploymentResource> = {
  reference: string;
  resource?: T;
};

type DeploymentActionItem = {
  key: string;
  name: string;
  seed: string;
  subtitle: string;
  action: ReactNode;
};

/** Resolve references by resource contract and deduplicate by canonical id. */
function resolveDeployedResources<T extends DeploymentResource>(
  references: string[],
  resolveResource: (reference: string) => T | undefined,
): ResolvedDeployment<T>[] {
  const seen = new Set<string>();
  const resolved: ResolvedDeployment<T>[] = [];
  for (const reference of references) {
    const resource = resolveResource(reference);
    const key = resource?.id ?? `missing:${reference}`;
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push({ reference, ...(resource ? { resource } : {}) });
  }
  return resolved;
}

function DeploymentActions({
  singularLabel,
  pluralLabel,
  items,
}: {
  singularLabel: string;
  pluralLabel: string;
  items: DeploymentActionItem[];
}) {
  if (items.length === 0) return null;
  const plural = items.length > 1;

  return (
    <Box
      component="section"
      className={classes.deploymentActions}
      aria-label={plural ? pluralLabel : singularLabel}
    >
      <Text className={classes.deploymentActionsTitle}>
        {plural ? `${pluralLabel} · ${items.length}` : singularLabel}
      </Text>
      <Box className={classes.deploymentActionRows}>
        {items.map((item) => (
          <Group
            key={item.key}
            className={classes.deploymentActionRow}
            wrap="nowrap"
          >
            <AppGlyph name={item.name} seed={item.seed} size="lg" />
            <Box className={classes.deploymentActionIdentity}>
              <Text size="sm" fw={700} truncate>
                {item.name}
              </Text>
              <Text size="xs" c="dimmed" truncate>
                {item.subtitle}
              </Text>
            </Box>
            {item.action}
          </Group>
        ))}
      </Box>
    </Box>
  );
}

function unavailableAction() {
  return (
    <Text size="xs" c="dimmed" className={classes.unavailableResource}>
      Unavailable
    </Text>
  );
}

export function AppDeploymentActions({
  ids,
  apps,
}: {
  ids: string[];
  apps: AppListItem[] | undefined;
}) {
  if (!apps) return null;
  const deployedApps = resolveDeployedResources(ids, (reference) =>
    apps.find((app) => app.id === reference || app.slug === reference),
  );

  return (
    <DeploymentActions
      singularLabel="Deployed app"
      pluralLabel="Deployed apps"
      items={deployedApps.map(({ reference, resource: app }) => {
        const name = app?.name ?? reference;
        const canOpen =
          app?.status === 'deployed' && Boolean(app.capabilities?.frontend);
        return {
          key: app?.id ?? reference,
          name,
          seed: app?.id ?? reference,
          subtitle: app ? app.slug : 'No longer available',
          action: app ? (
            <Group
              gap={4}
              wrap="nowrap"
              className={classes.deploymentActionCtas}
            >
              {canOpen ? (
                <Button
                  size="compact-sm"
                  variant="filled"
                  color="primary"
                  leftSection={<IconExternalLink size={14} stroke={1.8} />}
                  renderRoot={(props) => (
                    <Link
                      to="/app/$appSlug"
                      params={{ appSlug: app.slug }}
                      {...props}
                    />
                  )}
                >
                  Open
                </Button>
              ) : (
                <Button
                  size="compact-sm"
                  variant="default"
                  leftSection={<IconSettings size={14} stroke={1.8} />}
                  renderRoot={(props) => (
                    <Link
                      to="/app/$appSlug/manage"
                      params={{ appSlug: app.slug }}
                      {...props}
                    />
                  )}
                >
                  Manage
                </Button>
              )}
              {canOpen ? (
                <Menu position="bottom-end" withinPortal>
                  <Menu.Target>
                    <Tooltip label={`Manage ${name}`} withArrow>
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        size="sm"
                        aria-label={`More actions for ${name}`}
                      >
                        <IconDots size={16} stroke={1.8} />
                      </ActionIcon>
                    </Tooltip>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Item
                      leftSection={<IconSettings size={15} stroke={1.7} />}
                      renderRoot={(props) => (
                        <Link
                          to="/app/$appSlug/manage"
                          params={{ appSlug: app.slug }}
                          {...props}
                        />
                      )}
                    >
                      Manage app
                    </Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              ) : null}
            </Group>
          ) : (
            unavailableAction()
          ),
        };
      })}
    />
  );
}
