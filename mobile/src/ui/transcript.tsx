import { Fragment, type PropsWithChildren, type ReactNode } from 'react';
import { Image, View } from 'react-native';
import type { JsonValue, RunStatus, StreamBlock, StreamState } from '../core';
import { Button } from './button';
import { Glyph } from './glyph';
import { Text, type } from './text';
import { messageBlocks } from './transcript-content';
import { useAccent } from './accent';
import { palette as c, radii, status as hue } from './theme';
import {
  StepRow,
  StepSlip,
  toolStepDetail,
  toolStepLabel,
  WorkLine,
  WorkRail,
} from './work';
import { livePhase, type TranscriptRow } from './work-layout';

function record(
  value: JsonValue | undefined,
): Record<string, JsonValue> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

/**
 * A reply that completed without a clean `stop`: truncated output or a turn
 * cut off mid-work. Returns null for normal and failed ends — failures show
 * their own notice already.
 */
function endedEarlyNote(stopReason: unknown): string | null {
  switch (stopReason) {
    case 'length':
      return 'Ended early · the model reached its output limit';
    case 'toolUse':
      return 'Ended early · the reply stopped before its tools finished';
    case 'pending':
      return 'Ended early · the reply stopped before it finished';
    default:
      return null;
  }
}

/** The Agent's words: a white sheet with its tail at the leading edge. */
function Bubble({ children }: PropsWithChildren) {
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        maxWidth: '94%',
        backgroundColor: c.card,
        borderRadius: radii.xl,
        borderBottomLeftRadius: radii.xs,
        paddingHorizontal: 16,
        paddingVertical: 12,
      }}
    >
      {children}
    </View>
  );
}

/** The space above a row: a new speaker or reply, or the next step. */
const SPEAKER_GAP = 18;
const ANSWER_GAP = 10;

function resultText(message: Record<string, JsonValue>): string {
  const content = Array.isArray(message.content) ? message.content : [];
  return content
    .map((part) => record(part)?.text)
    .filter((part): part is string => typeof part === 'string')
    .join('\n');
}

/** A stored process block on the rail; null when it shows nothing. */
function ProcessBlock({
  block,
  results,
  running,
}: {
  block: JsonValue;
  results: ToolResults;
  running: boolean;
}) {
  const part = record(block);
  if (!part) return null;
  if (part.type === 'text' && typeof part.text === 'string') {
    return part.text.trim() ? (
      <Text
        selectable
        style={[type.callout, { color: c.ink, paddingVertical: 4 }]}
      >
        {part.text.trim()}
      </Text>
    ) : null;
  }
  if (part.type === 'thinking' && typeof part.thinking === 'string') {
    return part.thinking.trim() ? (
      <StepRow
        state="thinking"
        label="Thinking"
        body={<StepSlip output={part.thinking.trim()} />}
      />
    ) : null;
  }
  if (part.type === 'toolCall' && typeof part.name === 'string') {
    const result =
      typeof part.id === 'string' ? results.get(part.id) : undefined;
    const failed = result?.isError === true;
    return (
      <StepRow
        state={
          result ? (failed ? 'failed' : 'done') : running ? 'running' : 'done'
        }
        label={toolStepLabel(part.name, part.arguments)}
        detail={toolStepDetail(part.arguments)}
        body={
          <StepSlip
            request={part.arguments ?? {}}
            output={result ? resultText(result) : undefined}
            error={failed}
          />
        }
      />
    );
  }
  return null;
}

/** Stored tool results by the call they answer (see `toolResultsByCall`). */
export type ToolResults = ReadonlyMap<string, Record<string, JsonValue>>;

export function TranscriptMessage({
  value,
  terminal = false,
  row,
  first = false,
  expanded = false,
  onToggle,
  results = new Map(),
}: {
  value: JsonValue;
  /** Whether this message ends its turn — only its stopReason counts. */
  terminal?: boolean;
  /** Where the row sits in its reply (see `transcriptRows`). */
  row?: TranscriptRow;
  /** The list's first row has no space above it. */
  first?: boolean;
  /** Whether its reply's process is open. */
  expanded?: boolean;
  onToggle?: () => void;
  results?: ToolResults;
}) {
  const accent = useAccent();
  const message = record(value);
  if (!message || typeof message.role !== 'string') return null;
  const role = message.role;
  const reply = row?.kind === 'reply' ? row : null;
  const segment = reply?.segment;
  const open = expanded || !segment?.hasProcess;
  const line =
    reply?.leads && segment ? (
      <WorkLine
        phase={segment.phase}
        startedAt={segment.startedAt}
        endedAt={segment.endedAt}
        steps={segment.steps}
        hasProcess={segment.hasProcess}
        expanded={expanded}
        onToggle={() => onToggle?.()}
      />
    ) : null;
  const space = (railFirst: boolean) =>
    first
      ? 0
      : !reply || reply.leads
        ? SPEAKER_GAP
        : railFirst
          ? 0
          : ANSWER_GAP;

  if (role === 'toolResult' || role === 'compactionSummary') {
    // A result shows on its call's step; one without a call, and a
    // compaction, are steps of their own.
    const paired =
      role === 'toolResult' &&
      typeof message.toolCallId === 'string' &&
      results.get(message.toolCallId) === message;
    const step =
      paired || !open ? null : role === 'toolResult' ? (
        <StepRow
          state={message.isError === true ? 'failed' : 'done'}
          label={
            typeof message.toolName === 'string'
              ? toolStepLabel(message.toolName, undefined)
              : 'Tool result'
          }
          body={
            <StepSlip
              output={resultText(message)}
              error={message.isError === true}
            />
          }
        />
      ) : (
        <StepRow
          state="done"
          label="Compacted context"
          body={
            typeof message.summary === 'string' ? (
              <StepSlip output={message.summary} />
            ) : undefined
          }
        />
      );
    if (!line && !step) return null;
    return (
      <View style={{ marginTop: space(Boolean(step)) }}>
        {line}
        {step ? <WorkRail>{step}</WorkRail> : null}
      </View>
    );
  }
  if (role !== 'user' && role !== 'assistant') return null;
  const mine = role === 'user';
  const displayContent = messageBlocks(message);
  const answerFrom = reply?.answerFrom ?? 0;
  const processBlocks = mine ? [] : displayContent.slice(0, answerFrom);
  const answerBlocks = mine ? displayContent : displayContent.slice(answerFrom);
  const process =
    open && processBlocks.length
      ? processBlocks
          .map((block, index) => (
            <ProcessBlock
              key={index}
              block={block}
              results={results}
              running={segment?.phase === 'running'}
            />
          ))
          .filter(Boolean)
      : [];
  const ink = mine ? accent.onFill : c.ink;
  const answer = answerBlocks.map((part, index) => {
    const block = record(part);
    if (!block) return null;
    if (block.type === 'text' && typeof block.text === 'string') {
      const text =
        mine && Array.isArray(message.attachments)
          ? block.text.replace(
              /\n*<hatch_attachments>[\s\S]*?<\/hatch_attachments>\s*$/,
              '',
            )
          : block.text;
      if (!text.trim()) return null;
      const words = (
        <Text
          key={index}
          selectable
          style={[type.body, { color: ink, lineHeight: 24 }]}
        >
          {text}
        </Text>
      );
      return mine ? words : <Bubble key={index}>{words}</Bubble>;
    }
    if (block.type === 'image' && typeof block.data === 'string')
      return (
        <Image
          key={index}
          accessibilityLabel="Attached image"
          source={{
            uri: `data:${typeof block.mimeType === 'string' ? block.mimeType : 'image/jpeg'};base64,${block.data}`,
          }}
          style={{ width: 200, height: 160, borderRadius: radii.md }}
          resizeMode="cover"
        />
      );
    if (block.type === 'app' || block.type === 'workflow')
      return (
        <View
          key={index}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
        >
          <Glyph
            name={block.type === 'app' ? 'apps' : 'workflows'}
            size={13}
            color={mine ? accent.onFill : accent.ink}
          />
          <Text
            style={[type.callout, { color: mine ? accent.onFill : accent.ink }]}
          >
            {typeof block.name === 'string'
              ? block.name
              : 'Referenced resource'}
          </Text>
        </View>
      );
    // Without a reply row (a steered message's preview), a reply's own
    // process blocks still show on a rail.
    return mine ? null : (
      <WorkRail key={index}>
        <ProcessBlock block={part} results={results} running={false} />
      </WorkRail>
    );
  });
  const attachments = Array.isArray(message.attachments)
    ? message.attachments.map((attachment, index) => (
        <View
          key={`attachment-${index}`}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
        >
          <Glyph
            name="attach"
            size={12}
            color={mine ? accent.onFill : c.inkSoft}
          />
          <Text
            style={[type.small, { color: mine ? accent.onFill : c.inkSoft }]}
            numberOfLines={1}
          >
            {String(record(attachment)?.name ?? 'Attachment')}
          </Text>
        </View>
      ))
    : [];
  const notes = [
    typeof message.errorMessage === 'string' ? (
      <Text
        key="error"
        style={[type.small, { color: mine ? accent.onFill : hue.danger.ink }]}
      >
        {message.errorMessage}
      </Text>
    ) : null,
    !mine && terminal && endedEarlyNote(message.stopReason) ? (
      <Text key="ended" style={[type.small, { color: c.inkSoft }]}>
        {endedEarlyNote(message.stopReason)}
      </Text>
    ) : null,
  ];
  if (mine) {
    return (
      <View
        style={{
          marginTop: space(false),
          alignSelf: 'flex-end',
          maxWidth: '88%',
          backgroundColor: accent.fill,
          borderRadius: radii.xl,
          borderBottomRightRadius: radii.xs,
          paddingHorizontal: 16,
          paddingVertical: 12,
          gap: 8,
        }}
      >
        {answer}
        {attachments}
        {notes}
      </View>
    );
  }
  const rest = [...answer, ...attachments, ...notes].filter(Boolean);
  if (!line && !process.length && !rest.length) return null;
  return (
    <View style={{ marginTop: space(!line && process.length > 0) }}>
      {line}
      {process.length ? <WorkRail>{process}</WorkRail> : null}
      {rest.length ? (
        <View
          style={{
            gap: ANSWER_GAP,
            marginTop: line || process.length ? ANSWER_GAP : 0,
          }}
        >
          {rest}
        </View>
      ) : null}
    </View>
  );
}

/** What a running reply is doing now, for its work line. */
function currentStep(state: StreamState): string {
  if (state.pendingAsk || state.pendingEnv) return 'Waiting for you';
  const running = state.tools.findLast((tool) => !tool.done);
  if (running) return toolStepLabel(running.name, running.args, running.label);
  const last = state.blocks.at(-1);
  if (!last) return 'Starting';
  if (last.kind === 'compact' && last.status === 'running')
    return 'Compacting context';
  return last.kind === 'text' ? 'Writing' : 'Thinking';
}

export function LiveTranscript({
  state,
  note,
  settled = false,
  action,
  steerImages,
  startedAt,
  endedAt = null,
  clockOffset = 0,
  runStatus,
  expanded,
  onToggle,
}: {
  state: StreamState;
  /** Images of a pending message, known from the tray before injection. */
  steerImages?: (pendingId: string) => { data: string; mimeType: string }[];
  /** A connection or saving note under the line, announced when it changes. */
  note?: string;
  /** A stopped run's frozen output: nothing is still working. */
  settled?: boolean;
  action?: { label: string; onPress: () => void };
  /** Server-clock milliseconds the run started and ended, when known. */
  startedAt: number | null;
  endedAt?: number | null;
  clockOffset?: number;
  /** The run's status, for how a held reply ended. */
  runStatus?: RunStatus;
  expanded: boolean;
  onToggle: () => void;
}) {
  const phase = livePhase(state, settled, runStatus);
  const steps = state.blocks.filter(
    (block) => block.kind === 'tool' || block.kind === 'compact',
  ).length;
  // Once the reply has ended, its last text since the latest steered message
  // is the answer: it stays out of the fold, as in the saved transcript.
  let answerFrom = state.blocks.length;
  if (phase !== 'running') {
    for (let index = state.blocks.length - 1; index >= 0; index -= 1) {
      const block = state.blocks[index];
      if (block.kind === 'steer') break;
      if (block.kind === 'text' && block.text.trim()) {
        answerFrom = index;
        break;
      }
    }
  }
  const hasProcess = state.blocks
    .slice(0, answerFrom)
    .some(
      (block) =>
        block.kind === 'tool' ||
        block.kind === 'compact' ||
        ((block.kind === 'text' || block.kind === 'thinking') &&
          Boolean(block.text.trim())),
    );
  const stepOf = (block: StreamBlock, index: number): ReactNode => {
    if (block.kind === 'text') {
      return block.text.trim() ? (
        <Text
          key={index}
          selectable
          style={[type.callout, { color: c.ink, paddingVertical: 4 }]}
        >
          {block.text.trim()}
        </Text>
      ) : null;
    }
    if (block.kind === 'thinking') {
      return block.text.trim() ? (
        <StepRow
          key={index}
          state="thinking"
          label="Thinking"
          body={<StepSlip output={block.text.trim()} />}
        />
      ) : null;
    }
    if (block.kind === 'compact') {
      return (
        <StepRow
          key={index}
          state={block.status}
          label={
            block.status === 'running'
              ? 'Compacting context'
              : block.status === 'failed'
                ? 'Context compaction failed'
                : 'Compacted context'
          }
        />
      );
    }
    if (block.kind !== 'tool') return null;
    const tool = state.tools.find((item) => item.id === block.id);
    return tool ? (
      <StepRow
        key={index}
        state={!tool.done ? 'running' : tool.isError ? 'failed' : 'done'}
        label={toolStepLabel(tool.name, tool.args, tool.label)}
        detail={toolStepDetail(tool.args)}
        body={
          <StepSlip
            request={tool.args ?? {}}
            output={tool.output ?? tool.summary}
            error={tool.isError}
          />
        }
      />
    ) : null;
  };
  // Consecutive process blocks share one rail; a steered message breaks it.
  const groups: {
    steer?: Extract<StreamBlock, { kind: 'steer' }>;
    blocks: ReactNode[];
  }[] = [{ blocks: [] }];
  state.blocks.slice(0, answerFrom).forEach((block, index) => {
    if (block.kind === 'steer') {
      groups.push({ steer: block, blocks: [] });
      return;
    }
    if (!expanded) return;
    const step = stepOf(block, index);
    if (step) groups.at(-1)!.blocks.push(step);
  });
  // The answer, and anything the reply did after it, stays visible.
  const answer = state.blocks.slice(answerFrom).map((block, offset) => {
    const index = answerFrom + offset;
    if (block.kind === 'text') {
      return block.text.trim() ? (
        <Bubble key={index}>
          <Text selectable style={[type.body, { lineHeight: 24 }]}>
            {block.text.trim()}
          </Text>
        </Bubble>
      ) : null;
    }
    const step = stepOf(block, index);
    return step ? <WorkRail key={index}>{step}</WorkRail> : null;
  });
  const steer = (block: Extract<StreamBlock, { kind: 'steer' }>) => {
    // An event without images shows none, even if a stale cache has some.
    const images = block.imageCount ? (steerImages?.(block.id) ?? []) : [];
    // Without the image data, say the message had images.
    const text =
      !images.length && block.imageCount
        ? [
            block.text,
            block.imageCount === 1 ? '1 image' : `${block.imageCount} images`,
          ]
            .filter(Boolean)
            .join('\n')
        : block.text;
    return (
      <TranscriptMessage
        value={{
          role: 'user',
          content: [
            { type: 'text', text },
            ...images.map((image) => ({ type: 'image', ...image })),
          ],
          ...(block.attachments.length
            ? { attachments: block.attachments }
            : {}),
          steered: true,
        }}
      />
    );
  };
  return (
    <View style={{ gap: ANSWER_GAP, paddingVertical: 4 }}>
      <WorkLine
        phase={phase}
        startedAt={startedAt}
        endedAt={endedAt}
        clockOffset={clockOffset}
        steps={steps}
        current={currentStep(state)}
        hasProcess={hasProcess}
        expanded={expanded}
        onToggle={onToggle}
      />
      {note ? (
        <Text
          style={[type.caption, { marginLeft: 16 }]}
          accessibilityLiveRegion="polite"
        >
          {note}
        </Text>
      ) : null}
      {action ? (
        <View style={{ alignSelf: 'flex-start', marginLeft: 8 }}>
          <Button
            label={action.label}
            variant="quiet"
            size="small"
            glyph="refresh"
            onPress={action.onPress}
          />
        </View>
      ) : null}
      {groups.map((group, index) => (
        <Fragment key={index}>
          {group.steer ? steer(group.steer) : null}
          {group.blocks.length ? <WorkRail>{group.blocks}</WorkRail> : null}
        </Fragment>
      ))}
      {answer}
      {state.error ? (
        <Text style={[type.small, { color: hue.danger.ink }]}>
          {state.error}
        </Text>
      ) : null}
      {endedEarlyNote(state.stopReason) ? (
        <Text style={[type.small, { color: c.inkSoft }]}>
          {endedEarlyNote(state.stopReason)}
        </Text>
      ) : null}
    </View>
  );
}
