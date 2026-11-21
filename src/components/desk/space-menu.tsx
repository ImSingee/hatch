import { Menu, UnstyledButton } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  IconChevronDown,
  IconCpu,
  IconServer,
  IconUsers,
} from '@tabler/icons-react';
import { spaceQueryOptions } from '~queries/users';
import classes from './menu-bar.module.css';

/**
 * The space name after the brand. The space is the whole instance, so its
 * menu leads to the settings every user of it shares.
 */
export function SpaceMenu() {
  const { data } = useQuery(spaceQueryOptions);
  if (!data) return null;
  return (
    <Menu position="bottom-start" width={220} shadow="md">
      <Menu.Target>
        <UnstyledButton
          className={`${classes.item} ${classes.space}`}
          aria-label={`${data.name}, space settings`}
        >
          <span className={classes.spaceName}>{data.name}</span>
          <IconChevronDown size={14} stroke={2} aria-hidden />
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>{data.name}</Menu.Label>
        <Menu.Item
          leftSection={<IconCpu size={16} stroke={1.6} />}
          renderRoot={(props) => <Link to="/settings/providers" {...props} />}
        >
          AI providers
        </Menu.Item>
        <Menu.Item
          leftSection={<IconUsers size={16} stroke={1.6} />}
          renderRoot={(props) => <Link to="/settings/users" {...props} />}
        >
          Users
        </Menu.Item>
        <Menu.Item
          leftSection={<IconServer size={16} stroke={1.6} />}
          renderRoot={(props) => (
            <Link to="/settings/agent-runner" {...props} />
          )}
        >
          Agent Runner
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
