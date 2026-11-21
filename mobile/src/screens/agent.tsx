import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import {
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  View,
} from 'react-native';
import { useEffect, useRef } from 'react';
import { useSession } from '../state/session';
import {
  conversationSplit,
  fromConversationList,
  useAgentSelection,
  useConversationScreens,
} from '../state/use-agent-selection';
import { useConversationListRefresh } from '../state/use-conversation-list-refresh';
import { useLifetimeSignal } from '../state/use-lifetime-signal';
import { usePullToRefresh } from '../state/use-pull-to-refresh';
import { FoldContainer, useFoldSplit } from '../ui/columns';
import { Glyph } from '../ui/glyph';
import { Busy, EmptyState, Notice, errorText } from '../ui/primitives';
import { sectionsOf, stamp } from '../ui/session-dates';
import {
  Masthead,
  PageRoot,
  SectionLabel,
  pageScrollProps,
} from '../ui/screen';
import { Text, type } from '../ui/text';
import { useAccent } from '../ui/accent';
import { palette as c, pill, radii, shadows, weights } from '../ui/theme';
import { Conversation } from './conversation';

export function AgentScreen({ nested = false }: { nested?: boolean }) {
  const { api, origin } = useSession();
  const accent = useAccent();
  const focused = useIsFocused();
  const queryClient = useQueryClient();
  const signal = useLifetimeSignal();
  // With room for both, the open conversation sits beside the list, its
  // edge on the fold; otherwise it is pushed over the list.
  const { onLayout, onFolds, split } = useFoldSplit(conversationSplit);
  const [selected, select] = useAgentSelection();
  const onOwnScreen = useConversationScreens();
  const open = (id: string, push = !split) => {
    select(id);
    if (push)
      router.push({
        pathname: '/chat/[id]',
        params: { id, from: fromConversationList },
      });
  };
  // A link names a conversation: open it as a tap on its row would, beside
  // the list or over it. Each delivery carries a new `at`.
  const linked = useLocalSearchParams<{ open?: string; at?: string }>();
  useEffect(() => {
    if (!linked.open || !linked.at) return;
    open(linked.open);
    router.setParams({ open: undefined, at: undefined });
    // Only a new delivery opens it; layout changes are handled below.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [linked.at]);
  // Folding keeps the open conversation open: it moves over the list. The
  // conversation screen returns here when there is room again. A fold while
  // another screen covers this one is kept until the list is shown again,
  // unless there is room for both again first.
  const wide = Boolean(split);
  const wasWide = useRef(wide);
  const folded = useRef(false);
  useEffect(() => {
    if (wasWide.current !== wide) folded.current = !wide;
    wasWide.current = wide;
    if (!folded.current || !focused) return;
    folded.current = false;
    // A conversation that already has its own screen needs no handoff.
    if (selected && !onOwnScreen.includes(selected)) open(selected, true);
    // `open` and `selected` are read when the layout or focus changes.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [wide, focused]);
  const sessions = useQuery({
    queryKey: [origin, 'sessions'],
    queryFn: ({ signal }) => api!.sessions(undefined, signal),
    enabled: Boolean(api),
  });
  const config = useQuery({
    queryKey: [origin, 'config'],
    queryFn: ({ signal }) => api!.config(signal),
    enabled: Boolean(api),
  });
  const create = useMutation({
    mutationFn: () =>
      api!.createSession(config.data?.defaultModel ?? {}, signal()),
    onSuccess: (result) => {
      if (signal().aborted) return;
      void queryClient.invalidateQueries({ queryKey: [origin, 'sessions'] });
      open(result.id);
    },
  });
  // A second tap can land before the pending state renders; one request only.
  const creating = useRef(false);
  const start = () => {
    if (creating.current) return;
    creating.current = true;
    create.mutate(undefined, {
      onSettled: () => {
        creating.current = false;
      },
    });
  };
  const refetchSessions = sessions.refetch;
  useConversationListRefresh(focused, refetchSessions);
  const pull = usePullToRefresh(focused, () => sessions.refetch());
  const list = sessions.data ?? [];
  return (
    <PageRoot nested={nested}>
      <FoldContainer
        onLayout={onLayout}
        onFolds={onFolds}
        style={{ flex: 1, flexDirection: 'row' }}
      >
        <View style={split ? { width: split.leading } : { flex: 1 }}>
          <SectionList
            {...pageScrollProps}
            sections={sectionsOf(list)}
            keyExtractor={(item) => item.id}
            stickySectionHeadersEnabled={false}
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
            refreshControl={
              <RefreshControl
                refreshing={pull.refreshing}
                onRefresh={pull.onRefresh}
                tintColor={accent.fill}
              />
            }
            ListHeaderComponent={
              <View style={{ gap: 12 }}>
                <View style={{ marginHorizontal: -16 }}>
                  <Masthead
                    eyebrow={
                      sessions.data
                        ? `${list.length} conversation${list.length === 1 ? '' : 's'}`
                        : undefined
                    }
                    title="Agent"
                    nested={nested}
                  />
                </View>
                <StartCard busy={create.isPending} onPress={start} />
                {create.error ? (
                  <Notice
                    tone="danger"
                    title="Couldn’t start a conversation"
                    detail={errorText(create.error)}
                  />
                ) : null}
                {sessions.error && sessions.data ? (
                  <Notice
                    tone="danger"
                    title="Couldn’t refresh"
                    detail={errorText(sessions.error)}
                    action={{
                      label: 'Try again',
                      onPress: () => void sessions.refetch(),
                    }}
                  />
                ) : null}
              </View>
            }
            ListEmptyComponent={
              sessions.isPending ? (
                <Busy label="Finding conversations" />
              ) : sessions.error ? (
                <View style={{ paddingTop: 16 }}>
                  <Notice
                    tone="danger"
                    title="Couldn’t load conversations"
                    detail={errorText(sessions.error)}
                    action={{
                      label: 'Try again',
                      onPress: () => void sessions.refetch(),
                    }}
                  />
                </View>
              ) : (
                <EmptyState
                  glyph="agent"
                  title="A quiet notebook"
                  detail="Your conversations with the Agent are kept on your instance. Start one above."
                />
              )
            }
            renderSectionHeader={({ section }) => (
              <SectionLabel count={section.data.length}>
                {section.title}
              </SectionLabel>
            )}
            renderItem={({ item }) => (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${item.title || 'New conversation'}, ${item.messageCount} messages, updated ${stamp(item.updatedAt)}`}
                accessibilityState={{
                  selected: Boolean(split) && item.id === selected,
                }}
                onPress={() => open(item.id)}
                style={({ pressed }) => {
                  const current = Boolean(split) && item.id === selected;
                  return {
                    minHeight: 48,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                    paddingVertical: 10,
                    paddingHorizontal: 12,
                    borderRadius: radii.md,
                    backgroundColor: current
                      ? accent.fill
                      : pressed
                        ? c.hover
                        : 'transparent',
                  };
                }}
              >
                {(() => {
                  const current = Boolean(split) && item.id === selected;
                  return (
                    <>
                      <Text
                        style={[
                          type.callout,
                          {
                            flex: 1,
                            // Heavy enough to sit level with the system CJK face.
                            fontWeight: weights.label,
                            color: current ? accent.onFill : c.ink,
                          },
                        ]}
                        numberOfLines={2}
                      >
                        {item.title || 'New conversation'}
                      </Text>
                      <Text
                        maxFontSizeMultiplier={1.4}
                        numberOfLines={1}
                        style={[
                          type.caption,
                          current && { color: accent.onFill },
                        ]}
                      >
                        {stamp(item.updatedAt)}
                      </Text>
                    </>
                  );
                })()}
              </Pressable>
            )}
          />
        </View>
        {split ? (
          <>
            <View style={{ width: split.gutter, alignItems: 'center' }}>
              <View
                style={{
                  flex: 1,
                  width: StyleSheet.hairlineWidth,
                  backgroundColor: c.hairline,
                }}
              />
            </View>
            <View style={{ width: split.trailing }}>
              {selected && onOwnScreen.includes(selected) ? null : selected ? (
                <Conversation key={selected} id={selected} embedded />
              ) : (
                <View
                  style={{ flex: 1, justifyContent: 'center', padding: 20 }}
                >
                  <EmptyState
                    glyph="agent"
                    title="Pick a conversation"
                    detail="Choose one from the list to read it here, or start a new one."
                  />
                </View>
              )}
            </View>
          </>
        ) : null}
      </FoldContainer>
    </PageRoot>
  );
}

function StartCard({ busy, onPress }: { busy: boolean; onPress: () => void }) {
  const accent = useAccent();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="New conversation"
      accessibilityHint="Creates a conversation and opens it"
      accessibilityState={{ busy, disabled: busy }}
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: pressed ? c.muted : c.card,
        borderRadius: radii.window,
        boxShadow: shadows.dock,
        padding: 18,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 16,
        opacity: busy ? 0.6 : 1,
      })}
    >
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={type.title}>
          {busy ? 'Starting…' : 'What should we make?'}
        </Text>
        <Text style={type.callout}>
          Describe an App, a fix or a half-formed idea.
        </Text>
      </View>
      <View
        style={{
          width: 44,
          height: 44,
          borderRadius: pill,
          backgroundColor: accent.fill,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Glyph name="plus" size={18} color={accent.onFill} />
      </View>
    </Pressable>
  );
}
