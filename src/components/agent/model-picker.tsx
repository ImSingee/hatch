import { Box, Group, Menu, Text, UnstyledButton } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import {
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconSettings,
  IconSparkles,
} from '@tabler/icons-react';
import { Fragment, useMemo, useRef, useState } from 'react';
import type { AgentThinkingLevel } from '~/db/schema';
import { ProviderAvatar } from '~components/providers/provider-avatar';
import classes from './chat.module.css';

export type ModelOption = {
  /** `<providerId>:<modelId>` (see `splitModelValue`). */
  value: string;
  label: string;
  /** Empty when the model does not reason. */
  thinkingLevels: AgentThinkingLevel[];
  defaultThinkingLevel: AgentThinkingLevel;
};

export type ModelGroup = {
  id: string;
  group: string;
  catalogProviderId: string | null;
  items: ModelOption[];
};

export const THINKING_LEVEL_LABELS: Record<AgentThinkingLevel, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

function matches(option: ModelOption, terms: string[]): boolean {
  const text = `${option.label} ${option.value}`.toLowerCase();
  return terms.every((term) => text.includes(term));
}

/**
 * Compact model switcher styled as a pill in the composer action bar. One
 * menu picks the model and, for reasoning models, its thinking level: the
 * level list opens beside a model on hover (or the right arrow key, or a tap
 * on touch screens). Clicking a model itself picks its default level.
 */
export function ModelPicker({
  groups,
  value,
  thinkingLevel,
  onChange,
  disabled = false,
}: {
  groups: ModelGroup[];
  value: string | null;
  thinkingLevel: AgentThinkingLevel | null;
  onChange: (value: string, thinkingLevel: AgentThinkingLevel) => void;
  disabled?: boolean;
}) {
  const [opened, setOpened] = useState(false);
  const [search, setSearch] = useState('');
  // A tap opens the level list instead of picking the model: touch screens
  // have no hover to reveal it.
  const pointerType = useRef<string>('mouse');

  const selected = useMemo(() => {
    for (const group of groups)
      for (const item of group.items) if (item.value === value) return item;
    return null;
  }, [groups, value]);

  const visible = useMemo(() => {
    const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return groups;
    return groups
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => matches(item, terms)),
      }))
      .filter((group) => group.items.length > 0);
  }, [groups, search]);

  const empty = groups.length === 0;
  const blocked = disabled || empty;
  const showsLevel =
    selected !== null &&
    selected.thinkingLevels.length > 0 &&
    thinkingLevel !== null;
  const pillLabel = selected
    ? showsLevel
      ? `${selected.label} · ${THINKING_LEVEL_LABELS[thinkingLevel]}`
      : selected.label
    : empty
      ? 'No models'
      : 'Select model';

  const pick = (option: ModelOption, level: AgentThinkingLevel) => {
    onChange(option.value, level);
    setOpened(false);
  };

  const levelFor = (option: ModelOption) =>
    option.value === value &&
    thinkingLevel &&
    option.thinkingLevels.includes(thinkingLevel)
      ? thinkingLevel
      : option.defaultThinkingLevel;

  return (
    <Menu
      opened={opened}
      onChange={setOpened}
      position="top-end"
      shadow="md"
      width={260}
      withArrow
      disabled={blocked}
    >
      <Menu.Target>
        <UnstyledButton
          type="button"
          className={classes.modelPill}
          disabled={blocked}
          data-disabled={blocked || undefined}
        >
          <IconSparkles
            size={14}
            stroke={1.6}
            className={classes.modelPillIcon}
          />
          <Text component="span" className={classes.modelPillLabel}>
            {pillLabel}
          </Text>
          <IconChevronDown
            size={14}
            stroke={1.8}
            className={classes.modelPillIcon}
          />
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Search
          placeholder="Search models"
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
        />
        <Box className={classes.modelMenuScroll}>
          {visible.length === 0 ? (
            <Text size="sm" c="dimmed" px="sm" py="xs">
              No matching models
            </Text>
          ) : null}
          {visible.map((group) => (
            <Fragment key={group.id}>
              <Menu.Label>
                <Group gap={6} wrap="nowrap">
                  <ProviderAvatar
                    catalogProviderId={group.catalogProviderId}
                    size={16}
                  />
                  <span>{group.group}</span>
                </Group>
              </Menu.Label>
              {group.items.map((item) => {
                const current = item.value === value;
                const check = current ? (
                  <IconCheck size={15} stroke={2} />
                ) : null;
                if (!item.thinkingLevels.length)
                  return (
                    <Menu.Item
                      key={item.value}
                      onClick={() => pick(item, 'off')}
                      rightSection={check}
                    >
                      {item.label}
                    </Menu.Item>
                  );
                return (
                  <Menu.Sub
                    key={item.value}
                    openDelay={60}
                    closeDelay={120}
                    // The model list scrolls; a fixed level list is not
                    // clipped by it.
                    floatingStrategy="fixed"
                  >
                    <Menu.Sub.Target>
                      <Menu.Sub.Item
                        onPointerDown={(event) => {
                          pointerType.current = event.pointerType;
                        }}
                        onClick={() => {
                          if (pointerType.current !== 'touch')
                            pick(item, levelFor(item));
                        }}
                        rightSection={
                          <Group gap={4} wrap="nowrap">
                            {check}
                            <IconChevronRight size={14} stroke={1.8} />
                          </Group>
                        }
                      >
                        {item.label}
                      </Menu.Sub.Item>
                    </Menu.Sub.Target>
                    <Menu.Sub.Dropdown>
                      <Menu.Label>Thinking</Menu.Label>
                      {item.thinkingLevels.map((level) => (
                        <Menu.Item
                          key={level}
                          onClick={() => pick(item, level)}
                          rightSection={
                            current && level === thinkingLevel ? (
                              <IconCheck size={15} stroke={2} />
                            ) : level === item.defaultThinkingLevel ? (
                              <Text span size="xs" c="dimmed">
                                Default
                              </Text>
                            ) : null
                          }
                        >
                          {THINKING_LEVEL_LABELS[level]}
                        </Menu.Item>
                      ))}
                    </Menu.Sub.Dropdown>
                  </Menu.Sub>
                );
              })}
            </Fragment>
          ))}
        </Box>
        <Menu.Divider />
        <Menu.Item
          leftSection={<IconSettings size={15} stroke={1.6} />}
          renderRoot={(props) => <Link to="/settings/providers" {...props} />}
        >
          Manage models
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
