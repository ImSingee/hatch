import {
  ActionIcon,
  Box,
  Group,
  Menu,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import {
  IconDots,
  IconPencil,
  IconPlus,
  IconSearch,
  IconTrash,
} from '@tabler/icons-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { openTextPromptModal } from '~components/system/text-prompt-modal';
import { useI18n } from '~i18n';
import { sessionQueryOptions, sessionsQueryOptions } from '~queries/agent';
import {
  deleteSession,
  renameSession,
  type SessionSummary,
} from '~server/agent-sessions';
import classes from './chat.module.css';
import { formatSessionGroupLabel, groupSessionsByDate } from './session-groups';
import { useLocalCalendarNow } from './use-local-calendar-now';

function SessionRow({
  session,
  selected,
  onSelect,
  onRename,
  onDelete,
}: {
  session: SessionSummary;
  selected: string | null;
  onSelect: (id: string) => void;
  onRename: (session: SessionSummary) => void;
  onDelete: (id: string, title: string) => void;
}) {
  const { t } = useI18n();
  return (
    <Group
      justify="space-between"
      wrap="nowrap"
      gap="xs"
      className={
        session.id === selected
          ? classes.sessionItemActive
          : classes.sessionItem
      }
    >
      <UnstyledButton
        className={classes.sessionItemLabel}
        onClick={() => onSelect(session.id)}
      >
        <Text component="span" truncate inherit>
          {session.title}
        </Text>
      </UnstyledButton>
      <Menu position="bottom-end" withArrow shadow="md" width={160}>
        <Menu.Target>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            className={classes.sessionAction}
            aria-label={t('agent.sessions.options')}
          >
            <IconDots size={15} stroke={1.7} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item
            leftSection={<IconPencil size={15} stroke={1.7} />}
            onClick={() => onRename(session)}
          >
            {t('common.rename')}
          </Menu.Item>
          <Menu.Item
            color="red"
            leftSection={<IconTrash size={15} stroke={1.7} />}
            onClick={() => onDelete(session.id, session.title)}
          >
            {t('common.delete')}
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </Group>
  );
}

export function SessionsPanel({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const { data: sessions } = useSuspenseQuery(sessionsQueryOptions);
  const calendarNow = useLocalCalendarNow();
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const groups = groupSessionsByDate(
    needle
      ? sessions.filter((s) => s.title.toLowerCase().includes(needle))
      : sessions,
    calendarNow,
  );

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: sessionsQueryOptions.queryKey });

  const remove = useMutation({
    mutationFn: (id: string) => deleteSession({ data: { id } }),
    onSuccess: async (_res, id) => {
      await invalidate();
      // Drop the cached transcript so a browser Back to the deleted thread
      // refetches (and renders empty) instead of replaying the stale messages.
      qc.removeQueries({ queryKey: sessionQueryOptions(id).queryKey });
      if (selected === id) onSelect(null);
      toast.success(t('agent.sessions.deleted'));
    },
  });

  const rename = useMutation({
    mutationFn: (input: { id: string; title: string }) =>
      renameSession({ data: input }),
    onSuccess: async (_res, variables) => {
      await invalidate();
      // The list refresh alone leaves the open chat's detail query stale, so
      // its header keeps the old title until a hard reload — refetch it too.
      await qc.invalidateQueries({
        queryKey: sessionQueryOptions(variables.id).queryKey,
      });
      toast.success(t('agent.sessions.renamed'));
    },
  });

  const openRename = (s: { id: string; title: string }) =>
    openTextPromptModal({
      title: t('agent.sessions.renameTitle'),
      label: t('agent.sessions.renameLabel'),
      initialValue: s.title,
      onSubmit: (title) => rename.mutateAsync({ id: s.id, title }),
    });

  const confirmDelete = (id: string, title: string) =>
    modals.openConfirmModal({
      title: t('agent.sessions.deleteTitle'),
      centered: true,
      children: (
        <Text size="sm">{t('agent.sessions.deleteConfirm', { title })}</Text>
      ),
      labels: { confirm: t('common.delete'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate(id),
    });

  const renderSession = (session: SessionSummary) => (
    <SessionRow
      key={session.id}
      session={session}
      selected={selected}
      onSelect={onSelect}
      onRename={openRename}
      onDelete={confirmDelete}
    />
  );

  return (
    <Box className={classes.sessions}>
      <Box className={classes.sessionsHead}>
        <TextInput
          className={classes.sessionsSearch}
          type="search"
          aria-label={t('agent.sessions.search')}
          placeholder={t('agent.sessions.search')}
          leftSection={<IconSearch size={15} stroke={2} />}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        <Tooltip label={t('agent.sessions.new')} withArrow>
          <ActionIcon
            size={36}
            radius="md"
            aria-label={t('agent.sessions.new')}
            aria-current={selected === null ? 'page' : undefined}
            onClick={() => onSelect(null)}
          >
            <IconPlus size={18} stroke={2.2} />
          </ActionIcon>
        </Tooltip>
      </Box>
      <ScrollArea
        className={classes.sessionsList}
        type="scroll"
        scrollbarSize={6}
      >
        <Stack gap="sm">
          {groups.length === 0 ? (
            <Text className={classes.sessionsEmpty}>
              {sessions.length === 0
                ? t('agent.sessions.empty')
                : t('agent.sessions.noMatch', { query: query.trim() })}
            </Text>
          ) : (
            <>
              {groups.map((group) => (
                <Box component="section" key={group.key}>
                  <Text component="h2" className={classes.sessionGroupTitle}>
                    {formatSessionGroupLabel(group.label, locale, (key) =>
                      t(key),
                    )}
                  </Text>
                  <Stack gap={2}>{group.sessions.map(renderSession)}</Stack>
                </Box>
              ))}
            </>
          )}
        </Stack>
      </ScrollArea>
    </Box>
  );
}
