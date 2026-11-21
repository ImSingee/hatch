import { Menu, UnstyledButton } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  IconCheck,
  IconChevronDown,
  IconLayoutDashboard,
} from '@tabler/icons-react';
import { dashboardsQueryOptions } from '~queries/dashboards';
import classes from './dashboard-switcher.module.css';

/**
 * The desk's title: the dashboard on the desk, as a menu of every dashboard
 * and the way into managing them.
 */
export function DashboardSwitcher({
  current,
}: {
  current: { id: string; name: string } | undefined;
}) {
  const { data: dashboards } = useQuery(dashboardsQueryOptions);

  return (
    <Menu position="bottom-start" shadow="md" width={260}>
      <Menu.Target>
        <UnstyledButton
          className={classes.target}
          aria-label={`${current?.name ?? 'Dashboard'}, switch dashboard`}
        >
          <span className={classes.name}>{current?.name ?? 'Dashboard'}</span>
          <IconChevronDown size={20} stroke={2.4} aria-hidden />
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Dashboards</Menu.Label>
        {(dashboards ?? []).map((dashboard) => (
          <Menu.Item
            key={dashboard.id}
            rightSection={
              dashboard.id === current?.id ? (
                <IconCheck size={15} stroke={2} aria-hidden />
              ) : null
            }
            aria-current={dashboard.id === current?.id ? 'page' : undefined}
            renderRoot={(props) => (
              <Link
                to="/dashboard/$dashboardId"
                params={{ dashboardId: dashboard.id }}
                {...props}
              />
            )}
          >
            {dashboard.name}
          </Menu.Item>
        ))}
        <Menu.Divider />
        <Menu.Item
          leftSection={<IconLayoutDashboard size={16} stroke={1.6} />}
          renderRoot={(props) => <Link to="/dashboards" {...props} />}
        >
          Manage dashboards
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
