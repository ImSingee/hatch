import { AttachmentMenu, Choice } from '../ui/native-controls';
import { NativeField, type NativeFieldRef } from '../ui/native-field';
import {
  skipToken,
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Stack, router, useIsFocused } from 'expo-router';
import * as Crypto from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import * as WebBrowser from 'expo-web-browser';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Alert,
  FlatList,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  View,
  type ScrollViewInstance,
  type LayoutChangeEvent,
  type LayoutRectangle,
  type StyleProp,
  type ViewProps,
  type ViewStyle,
  type ViewInstance,
} from 'react-native';
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import {
  MobileError,
  type AskAnswer,
  type JsonValue,
  type PendingAsk,
  type SessionDetail,
  type StreamState,
} from '../core';
import { useSession } from '../state/session';
import {
  useAskDraft,
  useChatDraft,
  type Picked,
} from '../state/use-chat-draft';
import { useRefreshOnReturn } from '../state/use-refresh-on-return';
import { useRunStream } from '../state/use-run-stream';
import {
  checksSpent,
  placeHeldReplies,
  shownHeldReplies,
  type HeldReply,
} from '../state/settled-run';
import { useHeldReplies } from '../state/use-held-replies';
import { markConversationWorking } from '../state/conversation-follow';
import { useConversationLifetime } from '../state/conversation-lifetime';
import { AskCard } from '../ui/ask-card';
import { Button, IconButton } from '../ui/button';
import { Glyph } from '../ui/glyph';
import { LiveTranscript, TranscriptMessage } from '../ui/transcript';
import { PendingTray } from '../ui/pending-tray';
import { terminalReplyIndexes } from '../ui/transcript-content';
import {
  defaultWorkExpanded,
  toolResultsByCall,
  transcriptRows,
} from '../ui/work-layout';
import { Busy, Notice, errorText } from '../ui/primitives';
import { AppTile, GlyphTile } from '../ui/rows';
import { Text, type } from '../ui/text';
import { useAccent } from '../ui/accent';
import { palette as c, radii, shadows } from '../ui/theme';

const suggestions = [
  'Build a tiny tool that tracks my week',
  'Improve one of my Apps',
  'Think through an idea with me',
];

/**
 * One conversation: transcript, live run, questions and composer. It is the
 * whole chat screen on a compact width, and the trailing pane beside the
 * conversation list where the Agent screen has room for both (`embedded`).
 */
export function Conversation(props: { id: string; embedded?: boolean }) {
  // A provider of its own reports the insets of this view rather than the
  // window's: a vertical bar on one side, a tab bar below an embedded pane,
  // or none at all on the side that meets the conversation list.
  return (
    <SafeAreaProvider style={{ flex: 1 }}>
      <ConversationBody {...props} />
    </SafeAreaProvider>
  );
}

function ConversationBody({
  id,
  embedded = false,
}: {
  id: string;
  embedded?: boolean;
}) {
  const { api, origin } = useSession();
  const accent = useAccent();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const {
    draft,
    setDraft,
    files,
    setFiles,
    model,
    setModel,
    clientMessageIdFor,
    sentUploadId,
    recordUpload,
    settleSend,
  } = useChatDraft(id);
  const [problem, setProblem] = useConversationProblem(origin, id);
  const [optimisticRun, setOptimisticRun] = useState<string | null>(null);
  const [submittedAnswer, setSubmittedAnswer] = useSubmittedAnswer(origin, id);
  // Where the reader is belongs to the conversation: a fold or unfold that
  // moves it to another screen reopens the same place, and follows new
  // messages only if the reader was already at the end.
  const reading = useReadingAnchor(origin, id);
  // Following the end, like the place itself, changes only when the reader
  // scrolls or sends: a restore that briefly lands on the end while text
  // reflows must not start following it.
  const [atBottom, setAtBottom] = useState(reading.initial.atBottom);
  // The reader's place, changed only by the reader's own scrolling: a
  // resize rewraps the text under a fixed offset, which is not a new place.
  const anchor = useRef(reading.initial);
  // While settling, every new layout of the anchored message scrolls back to
  // the place, or to the end for a reader following it; a resize or a
  // handoff lays text out more than once, and the list learns the new end
  // only as its rows report their sizes. The reader's first drag ends it.
  const settle = useRef<number | null>(
    reading.initial.atBottom ? null : Number.POSITIVE_INFINITY,
  );
  const cells = useRef(new Map<number, { y: number; height: number }>());
  // The footer (held replies, the live reply) reads as the message after the
  // last saved one: that is where the live reply lands once it is saved.
  const messageCount = useRef(0);
  const footer = useRef({ height: 0, contentHeight: 0 });
  // Whether the scroll now ending began with the reader's finger. UIKit also
  // ends programmatic scrolls with a momentum event; a restore while text
  // reflows lands mid-way and must not be taken for the reader's place.
  const dragged = useRef(false);
  // The list's latest offset, which a work line toggle saves as the place.
  const scrollTop = useRef<number | null>(null);
  const width = useRef<number | null>(null);
  const list = useRef<FlatList<JsonValue>>(null);
  // The native end: the list's own estimate leaves out the content padding
  // and the bar insets, and lags behind rows still reflowing.
  const toEnd = () =>
    list.current?.getNativeScrollRef()?.scrollToEnd({ animated: false });
  const settleAgain = () => {
    settle.current = Date.now() + SETTLE_MS;
  };
  const apply = useCallback(() => {
    if (settle.current === null) return;
    if (Date.now() > settle.current) {
      settle.current = null;
      return;
    }
    dragged.current = false;
    if (anchor.current.atBottom) {
      toEnd();
      return;
    }
    const { index, fraction } = anchor.current;
    const cell = cells.current.get(index);
    if (!cell) {
      // The footer is placed once it and the content are measured.
      if (index >= messageCount.current) return;
      list.current?.scrollToIndex({ index, viewPosition: 0, animated: false });
      return;
    }
    // The same share of the message: this width wraps it differently.
    list.current?.scrollToOffset({
      offset: cell.y + fraction * cell.height,
      animated: false,
    });
    if (settle.current === Number.POSITIVE_INFINITY)
      settle.current = Date.now() + SETTLE_MS;
  }, []);
  const recordCell = useCallback(
    (index: number, layout: LayoutRectangle) => {
      cells.current.set(index, { y: layout.y, height: layout.height });
      if (anchor.current.atBottom || anchor.current.index === index) apply();
    },
    [apply],
  );
  const recordFooter = () => {
    const { height, contentHeight } = footer.current;
    if (!height || !contentHeight) return;
    recordCell(messageCount.current, {
      x: 0,
      y: contentHeight - transcriptPaddingBottom - height,
      width: 0,
      height,
    });
  };
  const keepPlace = (offset: number, bottom: boolean) => {
    anchor.current = readingAt(cells.current, offset, bottom);
    reading.save(anchor.current);
    setAtBottom(bottom);
  };
  const frame = useRef<ViewInstance>(null);
  const [keyboardOffset, setKeyboardOffset] = useState(0);
  const sending = useRef(false);
  const composer = useRef<NativeFieldRef>(null);
  const composerScroll = useRef<ScrollViewInstance>(null);
  // Work outlives a fold or unfold that moves this conversation to another
  // screen; it stops when no screen shows the conversation any more.
  // A problem from an earlier visit does not greet a fresh one.
  const clearProblem = useCallback(() => setProblem(null), [setProblem]);
  const lifetimeSignal = useConversationLifetime(origin, id, clearProblem);
  // One run request at a time per conversation, across every screen showing it.
  const runKey = [origin, 'conversation-run', id];
  const requesting = useIsMutating({ mutationKey: runKey }) > 0;
  // Likewise one answer at a time: a fold mid-answer must not offer the
  // same question again on the next screen.
  const answerKey = [origin, 'conversation-answer', id];
  const answering = useIsMutating({ mutationKey: answerKey }) > 0;
  const session = useQuery({
    queryKey: [origin, 'session', id],
    queryFn: ({ signal }) => api!.session(id, signal),
    enabled: Boolean(api),
    // The server starts the run that delivers waiting messages on its own
    // once the conversation is idle; follow it until that run shows up.
    refetchInterval: (query) => {
      const data = query.state.data;
      return data &&
        !data.activeRun &&
        data.pending &&
        !data.pending.paused &&
        data.pending.messages.length > 0
        ? 1500
        : false;
    },
  });
  // Another client may add messages or start a run while a pushed screen
  // covers this one. Joining any read in flight keeps background checks whole.
  useRefreshOnReturn(useIsFocused(), () => {
    if (api) void session.refetch({ cancelRefetch: false });
  });
  const config = useQuery({
    queryKey: [origin, 'config'],
    queryFn: ({ signal }) => api!.config(signal),
    enabled: Boolean(api),
  });
  const apps = useQuery({
    queryKey: [origin, 'apps'],
    queryFn: ({ signal }) => api!.apps(signal),
    enabled: Boolean(api),
  });
  const detail = session.data;
  const savedMessages = detail?.messages.length ?? 0;
  useLayoutEffect(() => {
    messageCount.current = savedMessages;
  }, [savedMessages]);
  const refetchSession = session.refetch;
  const selectedModel =
    model ??
    (detail?.providerId && detail.modelId
      ? { providerId: detail.providerId, modelId: detail.modelId }
      : config.data?.defaultModel);
  const choices =
    config.data?.providers.flatMap((provider) =>
      provider.models.map((item) => ({
        ...item,
        providerId: provider.id,
        providerName: provider.name,
      })),
    ) ?? [];

  // The run the composer, questions and environment requests belong to.
  const runId = detail?.activeRun?.id ?? optimisticRun;
  // The stream follows its run until it lets go with the state it showed,
  // even after the conversation stops listing the run as active.
  const [following, setFollowing] = useState<string | null>(null);
  if (runId && runId !== following) setFollowing(runId);
  const streamRunId = runId ?? following;
  const { held, end: holdReply, recheck } = useHeldReplies(id, refetchSession);
  const refresh = useCallback(
    async (ended?: { runId: string; state: StreamState }) => {
      if (lifetimeSignal().aborted) return true;
      const result = await refetchSession();
      if (lifetimeSignal().aborted) return true;
      if (result.error) throw result.error;
      await queryClient.invalidateQueries({ queryKey: [origin, 'sessions'] });
      await queryClient.invalidateQueries({ queryKey: [origin, 'apps'] });
      const data = result.data;
      if (!data) return false;
      if (data.activeRun) {
        setOptimisticRun(null);
        return false;
      }
      // Only the stream lets go of its run, with the exact state it showed.
      // A stop can end the run before its partial reply is saved; that reply
      // is kept and re-checked rather than dropped.
      if (!ended) return false;
      holdReply(id, ended.runId, data, ended.state);
      setOptimisticRun((current) => (current === ended.runId ? null : current));
      setFollowing((current) => (current === ended.runId ? null : current));
      return true;
    },
    [refetchSession, queryClient, origin, lifetimeSignal, holdReply, id],
  );
  const reconcile = useCallback(
    (endedRunId: string, shown: StreamState) =>
      refresh({ runId: endedRunId, state: shown }),
    [refresh],
  );
  const stream = useRunStream(api, streamRunId, reconcile);
  // Images of messages that were in the tray, for the live reply that shows
  // them once the run takes them in (its event carries no image data).
  const steerImagesRef = useRef(
    new Map<string, { data: string; mimeType: string }[]>(),
  );
  // Claimed messages leave the tray before their event reaches the live
  // reply; their images stay cached until a reply shows them.
  const steerAwaitingRef = useRef(new Set<string>());
  const pendingMessages = detail?.pending?.messages;
  const liveSteerIds = [
    stream.state,
    ...held.entries.map((entry) => entry.state),
  ]
    .flatMap((state) =>
      state.blocks.flatMap((block) =>
        block.kind === 'steer' ? [block.id] : [],
      ),
    )
    .join('\n');
  useEffect(() => {
    const cache = steerImagesRef.current;
    const awaiting = steerAwaitingRef.current;
    const keep = new Set(liveSteerIds ? liveSteerIds.split('\n') : []);
    for (const pendingId of keep) awaiting.delete(pendingId);
    for (const message of pendingMessages ?? []) {
      // Always overwrite: an edit can remove every image.
      cache.set(message.id, message.images);
      keep.add(message.id);
      if (message.status === 'claimed') awaiting.add(message.id);
      else awaiting.delete(message.id);
    }
    // Drop images no tray row, live or held reply, or claimed handover still
    // needs, such as those of cancelled messages.
    for (const pendingId of cache.keys()) {
      if (!keep.has(pendingId) && !awaiting.has(pendingId)) {
        cache.delete(pendingId);
      }
    }
  }, [pendingMessages, liveSteerIds]);
  const steerImages = useCallback(
    (pendingId: string) => steerImagesRef.current.get(pendingId) ?? [],
    [],
  );
  const heldShown = placeHeldReplies(
    detail?.messages ?? [],
    shownHeldReplies(held, id, detail),
  );
  // Only the last assistant message of a turn carries its end state;
  // an intermediate `toolUse` is a normal step while tools run.
  const terminalReplies = terminalReplyIndexes(detail?.messages ?? []);
  // Each reply's process folds under its work line, as on the web.
  const rows = useMemo(
    () => transcriptRows(detail?.messages ?? [], detail?.runs ?? []),
    [detail?.messages, detail?.runs],
  );
  const results = useMemo(
    () => toolResultsByCall(detail?.messages ?? []),
    [detail?.messages],
  );
  const [workOpen, setWorkOpen] = useWorkOpen(origin, id);
  // Rows re-render when a hold or a work line's open state changes.
  const listExtra = useMemo(() => ({ held, workOpen }), [held, workOpen]);
  const toggleWork = (key: string, expanded: boolean) => {
    // The reader's own toggle takes over the place, like a drag: the line
    // they tapped stays where it is while the process opens or folds, and a
    // later resize or return restores this place instead of the end.
    settle.current = null;
    if (scrollTop.current === null) setAtBottom(false);
    else keepPlace(scrollTop.current, false);
    setWorkOpen(key, !expanded);
  };
  // Server clock minus this phone's, for the line counting a live run.
  // Taken when a fetched snapshot brings a new server time: a local write
  // (the pending tray) keeps that time but moves `dataUpdatedAt`.
  const [clock, setClock] = useState<{
    serverTime: string;
    offset: number;
  } | null>(null);
  if (detail && clock?.serverTime !== detail.serverTime) {
    setClock({
      serverTime: detail.serverTime,
      offset: Date.parse(detail.serverTime) - session.dataUpdatedAt,
    });
  }
  const clockOffset = clock?.offset ?? 0;
  const runTime = (run: string | null | undefined) => {
    const found = detail?.runs.find((item) => item.id === run);
    const started =
      found?.startedAt ??
      (detail?.activeRun?.id === run
        ? detail?.activeRun?.startedAt
        : undefined);
    return {
      startedAt: started ? Date.parse(started) : null,
      endedAt: found?.completedAt ? Date.parse(found.completedAt) : null,
      runStatus: found?.status,
    };
  };
  const heldReply = (entry: HeldReply) => (
    <LiveTranscript
      key={entry.runId}
      state={entry.state}
      steerImages={steerImages}
      settled
      {...runTime(entry.runId)}
      expanded={workOpen[`held:${entry.runId}`] ?? true}
      onToggle={() =>
        toggleWork(
          `held:${entry.runId}`,
          workOpen[`held:${entry.runId}`] ?? true,
        )
      }
      note={
        checksSpent(entry)
          ? 'This reply isn’t saved on your server yet'
          : 'Checking for the saved reply'
      }
      action={
        checksSpent(entry)
          ? { label: 'Check again', onPress: recheck }
          : undefined
      }
    />
  );
  const ask = stream.state.lastSeq
    ? stream.state.pendingAsk
    : detail?.activeRun?.pendingAsk;
  const answerSubmitted = Boolean(
    ask &&
    runId &&
    ((submittedAnswer?.runId === runId &&
      submittedAnswer.askId === ask.askId) ||
      (detail?.activeRun?.id === runId &&
        detail.activeRun.answeredAskId === ask.askId)),
  );
  const env = stream.state.lastSeq
    ? stream.state.pendingEnv
    : detail?.activeRun?.pendingEnvRequest;

  const sessionKey = [origin, 'session', id];
  const applyPending = (pending: SessionDetail['pending']) =>
    queryClient.setQueryData<SessionDetail>(sessionKey, (old) =>
      old ? { ...old, pending } : old,
    );
  const send = useMutation({
    mutationKey: runKey,
    mutationFn: async () => {
      const signal = lifetimeSignal();
      const text = (composer.current?.getText() ?? draft).trim();
      if (!selectedModel) throw new Error('Choose a configured model first.');
      // Every send of one unchanged draft names the same message, so a
      // resend after a lost response returns the first outcome instead of a
      // second message or run. The id lives with the conversation's draft,
      // so a fold or unfold before resending keeps it.
      const clientMessageId = clientMessageIdFor(
        JSON.stringify([text, files.map((file) => file.id)]),
        Crypto.randomUUID,
      );
      const attachmentIds: string[] = [];
      for (const file of files.filter((item) => !item.image)) {
        const upload = async (attachmentId: string) => {
          await api!.uploadAttachment(
            id,
            attachmentId,
            new File(file.uri),
            file.name,
            file.mimeType,
            signal,
          );
          recordUpload(clientMessageId, file.id, attachmentId);
          return attachmentId;
        };
        const sent = sentUploadId(clientMessageId, file.id);
        let attachmentId = sent ?? file.id;
        try {
          // Uploaded on every attempt, so an upload pruned meanwhile returns.
          await upload(attachmentId);
        } catch (error) {
          if (!(error instanceof MobileError && error.status === 409))
            throw error;
          // In use: attached by this send (the same message, which the
          // server recognizes), or by an earlier version of an edited
          // draft, which needs its own upload.
          if (sent !== attachmentId)
            attachmentId = await upload(Crypto.randomUUID());
        }
        attachmentIds.push(attachmentId);
      }
      const message = {
        ...selectedModel,
        clientMessageId,
        content: text ? [{ type: 'text' as const, text }] : [],
        attachmentIds,
        images: files
          .filter((item) => item.image)
          .map((item) => ({ data: item.image!, mimeType: item.mimeType })),
      };
      // While the Agent works the message waits in the pending tray and is
      // delivered in the user's queue/steer mode.
      if (streamRunId) {
        return {
          clientMessageId,
          kind: 'pending' as const,
          pending: await api!.enqueuePending(id, message, signal),
        };
      }
      // The list follows this conversation even if we leave before the
      // request lands or its result is read.
      markConversationWorking(queryClient, origin!, id);
      return {
        clientMessageId,
        kind: 'run' as const,
        run: await api!.createRun({ sessionId: id, ...message }, signal),
      };
    },
    onSuccess: async (result) => {
      settleSend(result.clientMessageId);
      if (lifetimeSignal().aborted) return;
      if (result.kind === 'run') {
        // A resend the earlier send already put in the tray starts nothing.
        if ('runId' in result.run) setOptimisticRun(result.run.runId);
      } else {
        applyPending(result.pending.pending);
        // The run had just ended: the server delivered the message at once.
        if (result.pending.startedRunId) {
          setOptimisticRun(result.pending.startedRunId);
          markConversationWorking(queryClient, origin!, id);
        }
      }
      setDraft('');
      setFiles([]);
      setProblem(null);
      setAtBottom(true);
      // A sent message is read from the end.
      anchor.current = { ...anchor.current, atBottom: true };
      reading.save(anchor.current);
      await session.refetch();
    },
    onError: async (error) => {
      if (lifetimeSignal().aborted) return;
      // A timed-out POST may have started the run. Never replay it blindly.
      const snapshot = await session.refetch();
      if (lifetimeSignal().aborted) return;
      setProblem(
        snapshot.data?.activeRun
          ? 'Your request reached the server. Following the active run; your draft is kept until you review it.'
          : `${errorText(error)} Your draft is kept. Check the conversation before sending again.`,
      );
    },
    onSettled: () => {
      sending.current = false;
    },
  });
  // Edit, cancel, send now and resume, one at a time per conversation.
  const pendingKey = [origin, 'conversation-pending', id];
  const pendingBusy = useIsMutating({ mutationKey: pendingKey }) > 0;
  const pendingAction = useMutation({
    mutationKey: pendingKey,
    mutationFn: (
      action:
        | { kind: 'save'; messageId: string; text: string }
        | { kind: 'cancel' | 'send-now'; messageId: string }
        | { kind: 'resume' },
    ) => {
      const signal = lifetimeSignal();
      if (action.kind === 'save')
        return api!.updatePendingText(
          id,
          action.messageId,
          action.text,
          signal,
        );
      if (action.kind === 'cancel')
        return api!.cancelPending(id, action.messageId, signal);
      if (action.kind === 'send-now')
        return api!.sendPendingNow(id, action.messageId, signal);
      return api!.resumePending(id, signal);
    },
    onSuccess: async (result) => {
      if (lifetimeSignal().aborted) return;
      applyPending(result.pending);
      if (result.startedRunId) {
        setOptimisticRun(result.startedRunId);
        markConversationWorking(queryClient, origin!, id);
      }
      await session.refetch();
    },
    onError: (error) => {
      if (lifetimeSignal().aborted) return;
      setProblem(errorText(error));
      void session.refetch();
    },
  });
  const answer = useMutation({
    mutationKey: answerKey,
    mutationFn: (submission: {
      runId: string;
      askId: string;
      answers: AskAnswer[];
    }) =>
      api!.answerRun(
        submission.runId,
        submission.askId,
        submission.answers,
        lifetimeSignal(),
      ),
    onSuccess: async (_result, submission) => {
      // The answer is on the server; its unsent copy is no longer needed.
      queryClient.removeQueries({
        queryKey: [origin, 'ask-draft', id, submission.askId],
      });
      if (lifetimeSignal().aborted) return;
      setSubmittedAnswer({ runId: submission.runId, askId: submission.askId });
      await refresh();
    },
    onError: async (error) => {
      if (!lifetimeSignal().aborted) {
        setProblem(errorText(error));
        await session.refetch();
      }
    },
  });
  const cancel = useMutation({
    mutationFn: (targetRunId: string) =>
      api!.cancelRun(targetRunId, lifetimeSignal()),
    // The stream lets go of the stopped run itself, with its final state.
    onSuccess: () => refresh(),
    onError: (error) => {
      if (!lifetimeSignal().aborted) setProblem(errorText(error));
    },
  });
  const retryRun = useMutation({
    mutationKey: runKey,
    mutationFn: () => {
      markConversationWorking(queryClient, origin!, id);
      return api!.createRun(
        {
          sessionId: id,
          providerId: selectedModel!.providerId,
          modelId: selectedModel!.modelId,
          retry: true,
          expectedSessionUpdatedAt: detail!.updatedAt,
        },
        lifetimeSignal(),
      );
    },
    onSuccess: async (result) => {
      if (lifetimeSignal().aborted) return;
      setOptimisticRun(result.runId);
      setProblem(null);
      await session.refetch();
    },
    onError: async (error) => {
      if (lifetimeSignal().aborted) return;
      setProblem(`${errorText(error)} Check the conversation before retrying.`);
      await session.refetch();
    },
  });
  const addFiles = (picked: Picked[]) => {
    if (lifetimeSignal().aborted) return;
    if (picked.some((file) => file.size > 25 * 1024 * 1024 || file.size <= 0))
      throw new Error('Files must be non-empty and no larger than 25 MiB.');
    const combined = [...files, ...picked];
    if (combined.length > 6)
      throw new Error('Attach up to six photos or files per message.');
    if (
      combined.some((file) => (file.image?.length ?? 0) > 8_000_000) ||
      combined.reduce((total, file) => total + (file.image?.length ?? 0), 0) >
        24_000_000
    )
      throw new Error(
        'These photos are too large. Choose fewer or smaller images.',
      );
    setFiles(combined);
  };
  const choose = async (kind: 'photo' | 'file') => {
    try {
      setProblem(null);
      if (kind === 'file') {
        const result = await DocumentPicker.getDocumentAsync({
          multiple: true,
          copyToCacheDirectory: true,
        });
        if (!result.canceled)
          addFiles(
            result.assets.map((item) => ({
              id: Crypto.randomUUID(),
              name: item.name,
              uri: item.uri,
              mimeType: item.mimeType ?? 'application/octet-stream',
              size: item.size ?? new File(item.uri).size,
            })),
          );
      } else {
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'],
          allowsMultipleSelection: true,
          selectionLimit: Math.max(1, 6 - files.length),
          quality: 0.7,
          base64: true,
        });
        if (!result.canceled)
          addFiles(
            result.assets.map((item) => {
              if (!item.base64)
                throw new Error(
                  'This photo could not be read. Try choosing it as a file.',
                );
              // Expo iOS exports JPEG base64 even when the file metadata keeps PNG/HEIC.
              const mimeType = item.base64.startsWith('/9j/')
                ? 'image/jpeg'
                : (item.mimeType ?? 'image/jpeg');
              if (
                ![
                  'image/png',
                  'image/jpeg',
                  'image/webp',
                  'image/gif',
                ].includes(mimeType)
              )
                throw new Error('Choose a JPEG, PNG, WebP, or GIF photo.');
              return {
                id: Crypto.randomUUID(),
                name: item.fileName ?? 'Photo.jpg',
                uri: item.uri,
                mimeType,
                size: item.fileSize ?? Math.floor(item.base64.length * 0.75),
                image: item.base64,
              };
            }),
          );
      }
    } catch (error) {
      setProblem(errorText(error));
    }
  };
  const submit = () => {
    if (sending.current || queryClient.isMutating({ mutationKey: runKey }))
      return;
    sending.current = true;
    setProblem(null);
    send.mutate();
  };
  // The keyboard replaces the home-indicator inset under the composer.
  const [keyboardShown, setKeyboardShown] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardWillShow', () =>
      setKeyboardShown(true),
    );
    const hide = Keyboard.addListener('keyboardWillHide', () =>
      setKeyboardShown(false),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  useEffect(() => {
    if (atBottom) toEnd();
  }, [stream.state.lastSeq, detail?.messages.length, atBottom]);
  const busy = requesting || send.isPending || retryRun.isPending;
  const lastRun = detail?.runs.at(-1);
  const lastMessage = detail?.messages.at(-1);
  // Match the server's retry contract. An interrupted run can end with an
  // aborted assistant message, which is not a retryable provider error.
  const retryable =
    lastMessage !== null &&
    typeof lastMessage === 'object' &&
    !Array.isArray(lastMessage) &&
    lastMessage.role === 'assistant' &&
    lastMessage.stopReason === 'error';
  const note = !runId
    ? 'Stopping…'
    : stream.connection === 'live'
      ? undefined
      : stream.connection === 'paused'
        ? 'Updates paused · still working'
        : 'Reconnecting…';
  const canSend =
    !busy && Boolean(selectedModel) && Boolean(draft.trim() || files.length);
  return (
    <View
      ref={frame}
      style={{
        flex: 1,
        backgroundColor: c.ground,
        // A vertical bar arrives as an inset on one side only.
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}
      onLayout={() =>
        frame.current?.measureInWindow((_x, y) => setKeyboardOffset(y))
      }
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={keyboardOffset}
      >
        {embedded ? (
          <View
            style={{
              paddingTop: insets.top + 14,
              paddingHorizontal: 20,
              paddingBottom: 10,
              gap: 4,
            }}
          >
            <Text
              accessibilityRole="header"
              numberOfLines={2}
              maxFontSizeMultiplier={1.6}
              style={type.title}
            >
              {detail?.title || 'New conversation'}
            </Text>
          </View>
        ) : (
          <Stack.Screen
            options={{
              title: detail?.title || 'Conversation',
              headerTransparent: false,
            }}
          />
        )}
        {session.isPending ? (
          <Busy label="Opening conversation" />
        ) : session.error && !detail ? (
          <View style={{ flex: 1, padding: 16 }}>
            <Notice
              tone="danger"
              title="Couldn’t load this conversation"
              detail={errorText(session.error)}
              action={{
                label: 'Try again',
                onPress: () => void session.refetch(),
              }}
            />
          </View>
        ) : (
          <RecordCell value={recordCell}>
            <FlatList
              style={{ flex: 1 }}
              contentInsetAdjustmentBehavior="automatic"
              ref={list}
              data={detail?.messages ?? []}
              extraData={listExtra}
              keyExtractor={(_, index) => String(index)}
              contentContainerStyle={{
                paddingHorizontal: 16,
                paddingTop: 12,
                paddingBottom: transcriptPaddingBottom,
              }}
              keyboardDismissMode="interactive"
              keyboardShouldPersistTaps="handled"
              scrollEventThrottle={32}
              onScroll={(event) => {
                scrollTop.current = event.nativeEvent.contentOffset.y;
              }}
              onLayout={(event) => {
                const next = event.nativeEvent.layout.width;
                if (width.current !== null && width.current !== next) {
                  settleAgain();
                  apply();
                }
                width.current = next;
              }}
              onScrollBeginDrag={() => {
                dragged.current = true;
                settle.current = null;
                // The reader takes over: new text no longer pulls the
                // transcript down until they let go at the end again.
                setAtBottom(false);
              }}
              onScrollEndDrag={(event) => {
                const {
                  contentOffset,
                  layoutMeasurement,
                  contentSize,
                  velocity,
                } = event.nativeEvent;
                // A flick glides on: following resumes only where the glide
                // stops (onMomentumScrollEnd). Without one, this is the end.
                const gliding = Boolean(velocity?.y);
                if (!gliding) dragged.current = false;
                keepPlace(
                  contentOffset.y,
                  !gliding &&
                    contentOffset.y + layoutMeasurement.height >=
                      contentSize.height - 100,
                );
              }}
              onMomentumScrollEnd={(event) => {
                if (!dragged.current) return;
                dragged.current = false;
                const { contentOffset, layoutMeasurement, contentSize } =
                  event.nativeEvent;
                keepPlace(
                  contentOffset.y,
                  contentOffset.y + layoutMeasurement.height >=
                    contentSize.height - 100,
                );
              }}
              CellRendererComponent={RecordingCell}
              onScrollToIndexFailed={(info) => {
                // Rows above it are not measured yet: get near, then restore.
                list.current?.scrollToOffset({
                  offset: info.averageItemLength * info.index,
                  animated: false,
                });
                // Only while settling: the rough scroll may already have laid
                // out the row and restored the place exactly.
                setTimeout(apply, 50);
              }}
              onContentSizeChange={(_, contentHeight) => {
                footer.current.contentHeight = contentHeight;
                recordFooter();
                if (settle.current !== null) {
                  if (
                    anchor.current.atBottom ||
                    (detail?.messages.length ?? 0) > anchor.current.index
                  )
                    apply();
                  return;
                }
                if (atBottom) toEnd();
              }}
              renderItem={({ item, index }) => {
                const after = heldShown.after.get(index);
                const row = rows[index];
                const work = row?.kind === 'reply' ? row.segment : undefined;
                const expanded = work
                  ? (workOpen[work.key] ?? defaultWorkExpanded(work.phase))
                  : false;
                const message = (
                  <TranscriptMessage
                    value={item}
                    terminal={terminalReplies.has(index)}
                    row={row}
                    first={index === 0}
                    expanded={expanded}
                    onToggle={() => work && toggleWork(work.key, expanded)}
                    results={results}
                  />
                );
                return after ? (
                  <View style={{ gap: 18 }}>
                    {message}
                    {after.map(heldReply)}
                  </View>
                ) : (
                  message
                );
              }}
              ListEmptyComponent={
                !streamRunId && !heldShown.rest.length ? (
                  <View style={{ gap: 14, paddingTop: 24 }}>
                    <Text accessibilityRole="header" style={type.display}>
                      What should we make?
                    </Text>
                    <Text style={type.callout}>
                      Build an App, explore your data or pick up something
                      unfinished. Photos and files can help explain what you
                      mean.
                    </Text>
                    <View style={{ gap: 8, marginTop: 6 }}>
                      {suggestions.map((text) => (
                        <Pressable
                          key={text}
                          accessibilityRole="button"
                          accessibilityHint="Puts this in your message"
                          disabled={busy}
                          onPress={() => setDraft(text)}
                          style={({ pressed }) => ({
                            minHeight: 44,
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 10,
                            paddingHorizontal: 14,
                            paddingVertical: 10,
                            borderRadius: radii.lg,
                            backgroundColor: pressed ? c.muted : c.card,
                          })}
                        >
                          <Glyph name="sparkle" size={13} color={accent.ink} />
                          <Text
                            style={[type.callout, { flex: 1, color: c.ink }]}
                          >
                            {text}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                ) : undefined
              }
              ListFooterComponent={
                <View
                  // Rows space themselves (see `TranscriptMessage`); this is
                  // the space the list's gap used to give the footer.
                  style={{ gap: 16, marginTop: 18 }}
                  onLayout={(event) => {
                    footer.current.height = event.nativeEvent.layout.height;
                    recordFooter();
                  }}
                >
                  {heldShown.rest.map(heldReply)}
                  {streamRunId ? (
                    <LiveTranscript
                      state={stream.state}
                      note={note}
                      steerImages={steerImages}
                      {...runTime(streamRunId)}
                      clockOffset={clockOffset}
                      expanded={workOpen[`live:${streamRunId}`] ?? true}
                      onToggle={() =>
                        toggleWork(
                          `live:${streamRunId}`,
                          workOpen[`live:${streamRunId}`] ?? true,
                        )
                      }
                    />
                  ) : null}
                  {ask && runId ? (
                    answerSubmitted ? (
                      <Notice
                        tone="info"
                        title="Answer sent"
                        detail="Your answer is saved on the server. Waiting for your Agent to continue."
                      />
                    ) : (
                      <PendingAskCard
                        key={ask.askId}
                        conversation={id}
                        ask={ask}
                        busy={answering}
                        onAnswer={(answers) => {
                          if (
                            queryClient.isMutating({ mutationKey: answerKey })
                          )
                            return;
                          answer.mutate({ runId, askId: ask.askId, answers });
                        }}
                      />
                    )
                  ) : null}
                  {env && runId ? (
                    <Notice
                      tone="info"
                      title="Continue in Hatch web"
                      detail={`${env.reason} Open this conversation in your browser to provide environment values securely.`}
                      action={{
                        label: 'Open conversation in browser',
                        onPress: () =>
                          void WebBrowser.openBrowserAsync(
                            `${origin}/agent/${encodeURIComponent(id)}`,
                          ).catch((error: unknown) =>
                            setProblem(errorText(error)),
                          ),
                      }}
                    />
                  ) : null}
                  {!runId &&
                  lastRun &&
                  ['failed', 'interrupted', 'cancelled'].includes(
                    lastRun.status,
                  ) ? (
                    <Notice
                      tone={
                        lastRun.status === 'cancelled' ? 'neutral' : 'danger'
                      }
                      title={
                        lastRun.status === 'cancelled'
                          ? 'Run stopped'
                          : 'The Agent couldn’t finish'
                      }
                      detail={
                        lastRun.error ??
                        'Your conversation is saved. You can continue with another message.'
                      }
                      action={
                        selectedModel &&
                        retryable &&
                        lastRun.status !== 'cancelled'
                          ? {
                              label: retryRun.isPending
                                ? 'Retrying…'
                                : 'Retry this turn',
                              onPress: () => {
                                if (!requesting) retryRun.mutate();
                              },
                            }
                          : undefined
                      }
                    />
                  ) : null}
                  {(detail?.appIds ?? []).map((appId) => {
                    const app = apps.data?.find((item) => item.id === appId);
                    const name = app?.name ?? 'App';
                    return (
                      <Pressable
                        key={appId}
                        accessibilityRole="button"
                        accessibilityLabel={`Open ${name}`}
                        onPress={() =>
                          router.push({
                            pathname: '/apps/[id]',
                            params: { id: appId },
                          })
                        }
                        style={({ pressed }) => ({
                          minHeight: 64,
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 12,
                          padding: 12,
                          paddingRight: 16,
                          borderRadius: radii.xl,
                          backgroundColor: pressed ? c.muted : c.card,
                          boxShadow: shadows.card,
                        })}
                      >
                        <AppTile
                          name={name}
                          seed={appId}
                          iconPath={app?.iconPath}
                          size={44}
                        />
                        <View style={{ flex: 1, gap: 1 }}>
                          <Text style={type.heading} numberOfLines={1}>
                            {name}
                          </Text>
                          <Text style={type.small}>Built here</Text>
                        </View>
                        <Text style={[type.heading, { color: accent.ink }]}>
                          Open
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              }
            />
          </RecordCell>
        )}
        <View
          style={{
            // A floating sheet, clear of the home indicator.
            marginHorizontal: 12,
            marginBottom: keyboardShown ? 10 : Math.max(insets.bottom, 12),
            padding: 12,
            backgroundColor: c.card,
            borderRadius: radii.dock,
            boxShadow: shadows.dock,
            gap: 8,
            flexShrink: 1,
            maxHeight: '75%',
          }}
        >
          <ScrollView
            ref={composerScroll}
            style={{ flexGrow: 0, flexShrink: 1 }}
            contentContainerStyle={{ gap: 10 }}
            keyboardShouldPersistTaps="handled"
            onLayout={() =>
              composerScroll.current?.scrollToEnd({ animated: false })
            }
            onContentSizeChange={() =>
              composerScroll.current?.scrollToEnd({ animated: false })
            }
          >
            {detail?.pending ? (
              <PendingTray
                pending={{
                  ...detail.pending,
                  // The live reply already shows messages the run took in;
                  // the snapshot catches up when the reply ends.
                  messages: detail.pending.messages.filter(
                    (message) =>
                      !stream.state.blocks.some(
                        (block) =>
                          block.kind === 'steer' && block.id === message.id,
                      ),
                  ),
                }}
                busy={pendingBusy}
                onSave={async (messageId, text) => {
                  try {
                    await pendingAction.mutateAsync({
                      kind: 'save',
                      messageId,
                      text,
                    });
                    return true;
                  } catch {
                    return false;
                  }
                }}
                onCancel={(messageId) =>
                  pendingAction.mutate({ kind: 'cancel', messageId })
                }
                onSendNow={(messageId) =>
                  Alert.alert(
                    'Send this message now?',
                    'The current reply stops; work already completed is kept.',
                    [
                      { text: 'Keep waiting', style: 'cancel' },
                      {
                        text: 'Send now',
                        onPress: () =>
                          pendingAction.mutate({ kind: 'send-now', messageId }),
                      },
                    ],
                  )
                }
                onResume={() => pendingAction.mutate({ kind: 'resume' })}
              />
            ) : null}
            {problem ? (
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'flex-start',
                  gap: 8,
                  padding: 12,
                  paddingRight: 4,
                  borderRadius: radii.md,
                  backgroundColor: c.dangerSoft,
                }}
              >
                <Text
                  accessibilityRole="alert"
                  style={[type.small, { flex: 1, color: c.danger }]}
                >
                  {problem}
                </Text>
                <IconButton
                  label="Dismiss message"
                  glyph="close"
                  tone="clear"
                  size={32}
                  onPress={() => setProblem(null)}
                />
              </View>
            ) : null}
            {config.error ? (
              <Notice
                tone="danger"
                title="Couldn’t load models"
                detail={errorText(config.error)}
                action={{
                  label: 'Try again',
                  onPress: () => void config.refetch(),
                }}
              />
            ) : null}
            {files.length ? (
              <ScrollView horizontal contentContainerStyle={{ gap: 8 }}>
                {files.map((file) => (
                  <Pressable
                    key={file.id}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${file.image ? 'photo' : file.name}`}
                    disabled={busy}
                    onPress={() =>
                      setFiles((value) =>
                        value.filter((item) => item.id !== file.id),
                      )
                    }
                    style={({ pressed }) => ({
                      minHeight: 48,
                      maxWidth: 220,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 8,
                      padding: 6,
                      paddingRight: 10,
                      borderRadius: radii.md,
                      backgroundColor: pressed ? c.sunken : c.muted,
                      opacity: busy ? 0.5 : 1,
                    })}
                  >
                    {file.image ? (
                      <Image
                        accessible={false}
                        source={{ uri: file.uri }}
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: radii.sm,
                        }}
                      />
                    ) : (
                      <GlyphTile glyph="file" size={36} />
                    )}
                    <Text
                      style={[type.small, { flexShrink: 1, color: c.ink }]}
                      numberOfLines={1}
                    >
                      {file.name}
                    </Text>
                    <Glyph name="close" size={11} color={c.inkSoft} />
                  </Pressable>
                ))}
              </ScrollView>
            ) : null}
            <NativeField
              ref={composer}
              variant="bare"
              label="Message your Agent"
              maxLength={50000}
              multiline
              value={draft}
              onChange={setDraft}
              unavailable={busy}
              placeholder={
                runId
                  ? 'Message while your Agent works…'
                  : 'What would you like to make?'
              }
            />
          </ScrollView>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <AttachmentMenu
              disabled={busy || files.length >= 6}
              onChoose={(kind) => void choose(kind)}
            />
            {choices.length ? (
              <Choice
                compact
                label="Model"
                glyph="model"
                value={
                  selectedModel
                    ? `${selectedModel.providerId}:${selectedModel.modelId}`
                    : ''
                }
                // The chip names the model; the menu also names its provider.
                options={choices.map((item) => ({
                  label: `${item.providerName} · ${item.name}`,
                  short: item.name,
                  value: `${item.providerId}:${item.modelId}`,
                }))}
                disabled={Boolean(runId) || busy}
                onChange={(value) => {
                  const item = choices.find(
                    (option) =>
                      `${option.providerId}:${option.modelId}` === value,
                  );
                  if (item)
                    setModel({
                      providerId: item.providerId,
                      modelId: item.modelId,
                    });
                }}
              />
            ) : config.data ? (
              <Text
                style={[type.caption, { flex: 1 }]}
                numberOfLines={1}
                accessibilityHint="Configure a provider in Hatch on the web"
              >
                No model
              </Text>
            ) : (
              <View style={{ flex: 1 }} />
            )}
            {files.length ? (
              <Text style={type.caption}>{`${files.length}/6`}</Text>
            ) : null}
            {runId ? (
              <Button
                variant="danger"
                size="small"
                glyph="stop"
                label={cancel.isPending ? 'Stopping…' : 'Stop'}
                busy={cancel.isPending}
                onPress={() =>
                  Alert.alert(
                    'Stop this run?',
                    'Work already completed is kept.',
                    [
                      { text: 'Keep running', style: 'cancel' },
                      {
                        text: 'Stop',
                        style: 'destructive',
                        onPress: () => cancel.mutate(runId),
                      },
                    ],
                  )
                }
              />
            ) : null}
            <IconButton
              label={send.isPending ? 'Sending…' : 'Send'}
              glyph="send"
              tone={canSend ? 'accent' : 'sunken'}
              disabled={!canSend}
              onPress={submit}
            />
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

type SubmittedAnswer = { runId: string; askId: string } | null;

/**
 * The question last answered in this conversation, shared by every screen
 * showing it: a fold after the answer reached the server keeps the question
 * closed until the run reports it answered.
 */
function useSubmittedAnswer(origin: string | null, id: string) {
  const client = useQueryClient();
  const { data = null } = useQuery<SubmittedAnswer>({
    queryKey: [origin, 'conversation-answered', id],
    queryFn: skipToken,
    initialData: null,
    gcTime: Infinity,
    staleTime: Infinity,
  });
  const set = useCallback(
    (answered: SubmittedAnswer) =>
      client.setQueryData<SubmittedAnswer>(
        [origin, 'conversation-answered', id],
        answered,
      ),
    [client, origin, id],
  );
  return [data, set] as const;
}

/**
 * The conversation's latest problem, shared by every screen showing it, so a
 * send that fails after a fold handed the conversation over still says so.
 */
function useConversationProblem(origin: string | null, id: string) {
  const client = useQueryClient();
  const { data = null } = useQuery<string | null>({
    queryKey: [origin, 'conversation-problem', id],
    queryFn: skipToken,
    initialData: null,
    gcTime: Infinity,
    staleTime: Infinity,
  });
  const set = useCallback(
    (problem: string | null) =>
      client.setQueryData<string | null>(
        [origin, 'conversation-problem', id],
        problem,
      ),
    [client, origin, id],
  );
  return [data, set] as const;
}

/** A pending question whose unsent answers belong to the conversation. */
function PendingAskCard({
  conversation,
  ask,
  busy,
  onAnswer,
}: {
  conversation: string;
  ask: PendingAsk;
  busy: boolean;
  onAnswer: (answers: AskAnswer[]) => void;
}) {
  const { saved, save } = useAskDraft(conversation, ask.askId);
  return (
    <AskCard
      ask={ask}
      busy={busy}
      saved={saved}
      onDraft={save}
      onAnswer={onAnswer}
    />
  );
}

/** How long layout passes after a resize or handoff may still move text. */
const SETTLE_MS = 1200;

/** Space below the transcript's footer. */
const transcriptPaddingBottom = 24;

type ReadingAnchor = { atBottom: boolean; index: number; fraction: number };
const atEnd: ReadingAnchor = { atBottom: true, index: 0, fraction: 0 };

/** The message at the top of the view, and how far into it the reader is. */
function readingAt(
  cells: Map<number, { y: number; height: number }>,
  top: number,
  atBottom: boolean,
): ReadingAnchor {
  let next: { index: number; y: number } | null = null;
  let last: { index: number; y: number } | null = null;
  for (const [index, cell] of cells) {
    if (top >= cell.y && top < cell.y + cell.height)
      return {
        atBottom,
        index,
        fraction: Math.round(((top - cell.y) / cell.height) * 100) / 100,
      };
    if (cell.y >= top && (!next || cell.y < next.y))
      next = { index, y: cell.y };
    if (cell.y < top && (!last || cell.y > last.y)) last = { index, y: cell.y };
  }
  // Between rows, the next one; past every row, the end of the last.
  if (next) return { atBottom, index: next.index, fraction: 0 };
  return { atBottom, index: last?.index ?? 0, fraction: last ? 1 : 0 };
}

const RecordCell = createContext<
  (index: number, layout: LayoutRectangle) => void
>(() => {});

/** A transcript row that reports where it sits, for the reading anchor. */
function RecordingCell({
  index,
  onLayout,
  onFocusCapture,
  style,
  children,
}: {
  index: number;
  onLayout?: (event: LayoutChangeEvent) => void;
  onFocusCapture?: ViewProps['onFocusCapture'];
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  const record = useContext(RecordCell);
  return (
    <View
      style={style}
      onFocusCapture={onFocusCapture}
      onLayout={(event) => {
        onLayout?.(event);
        record(index, event.nativeEvent.layout);
      }}
    >
      {children}
    </View>
  );
}

/**
 * Which work lines the reader opened or folded in a conversation. Kept like
 * the reading place, so a fold or unfold that moves the conversation to
 * another screen shows the same lines open before that place is restored.
 */
function useWorkOpen(origin: string | null, id: string) {
  const client = useQueryClient();
  const { data } = useQuery<Record<string, boolean>>({
    queryKey: [origin, 'work-open', id],
    queryFn: skipToken,
    initialData: {},
    gcTime: Infinity,
    staleTime: Infinity,
  });
  const set = useCallback(
    (key: string, open: boolean) =>
      client.setQueryData<Record<string, boolean>>(
        [origin, 'work-open', id],
        (current) => ({ ...current, [key]: open }),
      ),
    [client, origin, id],
  );
  return [data ?? noWorkOpen, set] as const;
}

const noWorkOpen: Record<string, boolean> = {};

/**
 * The transcript position of a conversation, read when a screen showing it
 * mounts and written as the reader scrolls. Kept by message rather than
 * offset: the other screen's width reflows the text.
 */
function useReadingAnchor(origin: string | null, id: string) {
  const client = useQueryClient();
  // Kept as long as the conversation's drafts: a fold after the reader has
  // stayed put for a while still reopens their place. Saving it re-renders
  // nothing; the place is read once, when a screen mounts.
  useQuery<ReadingAnchor | null>({
    queryKey: [origin, 'reading', id],
    queryFn: skipToken,
    gcTime: Infinity,
    staleTime: Infinity,
    notifyOnChangeProps: [],
  });
  const [initial] = useState(
    () => client.getQueryData<ReadingAnchor>([origin, 'reading', id]) ?? atEnd,
  );
  const last = useRef(initial);
  const save = useCallback(
    (anchor: ReadingAnchor) => {
      if (
        anchor.atBottom === last.current.atBottom &&
        anchor.index === last.current.index &&
        anchor.fraction === last.current.fraction
      )
        return;
      last.current = anchor;
      client.setQueryData<ReadingAnchor>([origin, 'reading', id], anchor);
    },
    [client, origin, id],
  );
  return { initial, save };
}
