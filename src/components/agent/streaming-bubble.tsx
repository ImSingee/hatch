/** Live assistant turn: streams blocks in arrival order plus pending asks. */
import { Box, Group, Loader, Text } from '@mantine/core';
import { Fragment, type ReactNode } from 'react';
import type { AskAnswer } from '~agent/events';
import {
  AgentErrorNotice,
  EndedEarlyNotice,
  type RetryControls,
} from './agent-error-notice';
import { AskForm } from './ask-form';
import { finalTextIndex, replySegments, segmentTimings } from './chat-turns';
import { Markdownish } from './markdownish';
import { UserMessage } from './message-view';
import { EnvForm, type EnvEntry } from './env-form';
import {
  CompactionStep,
  StreamingThinkingStep,
  StreamingToolStep,
} from './steps';
import type {
  SendImage,
  StreamBlock,
  StreamState,
  StreamSteerBlock,
} from './use-agent-stream';
import { type WorkFrame, WorkProcess, type WorkTiming } from './work-process';
import classes from './chat.module.css';

function streamText(block: StreamBlock): string | undefined {
  return block.kind === 'text' ? block.text : undefined;
}

export function StreamingBubble({
  state,
  onAnswer,
  onSubmitEnv,
  work,
  earlierWork,
  retry,
  steerImages,
}: {
  state: StreamState;
  /** Images of a pending message, known from the tray before injection. */
  steerImages?: (pendingId: string) => SendImage[] | undefined;
  onAnswer: (askId: string, answers: AskAnswer[]) => void;
  onSubmitEnv: (requestId: string, entries: EnvEntry[]) => Promise<boolean>;
  /**
   * Frames the process in the Working/Worked container. While the run is
   * going everything is process; once it settles the final answer moves out.
   * The chat always provides it.
   */
  work?: WorkFrame;
  /**
   * Frames the finished work before a steered message, one per message in
   * injection order; `work` frames the work after the last one.
   */
  earlierWork?: (segment: number, timing: WorkTiming) => WorkFrame;
  /**
   * Retry actions when the settled run failed. A failed turn can stay live
   * while its transcript never arrives (an interrupted Runner).
   */
  retry?: RetryControls;
}) {
  const ask = state.pendingAsk;
  const envRequest = state.pendingEnvRequest;

  // The last thinking block is the only one that may still be streaming.
  let lastThinkingIndex = -1;
  for (let i = state.blocks.length - 1; i >= 0; i -= 1) {
    if (state.blocks[i].kind === 'thinking') {
      lastThinkingIndex = i;
      break;
    }
  }

  // Walk blocks in arrival order, grouping consecutive thinking/tool steps into
  // one connected timeline and flushing on prose — so a multi-step reply (and
  // each distinct reasoning segment) reads identically live and afterwards.
  const renderBlocks = (start: number, end: number): ReactNode[] => {
    const out: ReactNode[] = [];
    let steps: ReactNode[] = [];
    const flush = () => {
      if (steps.length === 0) return;
      out.push(
        <Box key={`steps-${start}-${out.length}`} className={classes.steps}>
          {steps}
        </Box>,
      );
      steps = [];
    };

    for (let index = start; index < end; index += 1) {
      const block = state.blocks[index];
      if (block.kind === 'text') {
        flush();
        if (block.text) out.push(<Markdownish key={index} text={block.text} />);
      } else if (block.kind === 'thinking') {
        // Some providers (OpenAI reasoning summaries via the relay) stream
        // only empty "\n\n" separator deltas while reasoning and deliver the
        // real summary at the end; skip whitespace-only segments so they don't
        // render as blank rows (the "Thinking…" loader covers that phase).
        if (!block.text.trim()) continue;
        steps.push(
          <StreamingThinkingStep
            key={index}
            text={block.text}
            active={index === lastThinkingIndex && state.thinkingActive}
          />,
        );
      } else if (block.kind === 'steer') {
        // Rendered between segments (see below).
      } else if (block.kind === 'compact') {
        steps.push(
          <CompactionStep
            key={index}
            status={
              block.compact.phase === 'start'
                ? 'running'
                : block.compact.phase === 'failed'
                  ? 'error'
                  : 'done'
            }
            tokensBefore={block.compact.tokensBefore}
            tokensAfter={block.compact.tokensAfter}
          />,
        );
      } else {
        steps.push(<StreamingToolStep key={index} tool={block.tool} />);
      }
    }
    flush();
    return out;
  };

  // While the turn is live, whenever nothing else is visibly in flight —
  // before the first token, between tool calls, or during whitespace-only
  // reasoning — show a loading row so the agent never looks stalled. A running
  // tool, an actively streaming thinking block, streaming answer text, or a
  // pending human-input request carry their own progress signal. Earlier prose
  // must not hide later waiting phases.
  const anyToolRunning = state.blocks.some(
    (b) => b.kind === 'tool' && !b.tool.done,
  );
  const anyCompactRunning = state.blocks.some(
    (b) => b.kind === 'compact' && b.compact.phase === 'start',
  );
  const lastThinkingBlock = state.blocks[lastThinkingIndex];
  const thinkingVisible =
    state.thinkingActive &&
    lastThinkingBlock?.kind === 'thinking' &&
    Boolean(lastThinkingBlock.text.trim());
  const working =
    state.active &&
    !state.terminalError &&
    !ask &&
    !envRequest &&
    !state.textActive &&
    !thinkingVisible &&
    !anyToolRunning &&
    !anyCompactRunning;
  const workingIndicator = working ? (
    <Group gap={8} c="dimmed">
      <Loader size="xs" type="dots" />
      <Text size="sm" c="dimmed">
        Thinking…
      </Text>
    </Group>
  ) : null;

  // Each steered message is a message of its own: the work before it is
  // finished and framed apart, and the reply goes on after it.
  const segments = replySegments(
    state.blocks,
    (block) => block.kind === 'steer',
  );
  const steers = segments.flatMap((segment) =>
    segment.steer === undefined
      ? []
      : [state.blocks[segment.steer] as StreamSteerBlock],
  );
  const timings = segmentTimings(
    work?.timing ?? null,
    steers.map((block) => block.injectedAt),
  );
  const renderSteer = (block: StreamSteerBlock, index: number) => {
    // An event without images shows none, even if a stale cache has some.
    const images =
      block.imageCount > 0 ? (steerImages?.(block.pendingId) ?? []) : [];
    return (
      <Fragment key={`steer-${index}`}>
        <UserMessage
          message={{
            role: 'user',
            content: [
              { type: 'text', text: block.text },
              ...images.map((image) => ({ type: 'image', ...image })),
            ],
            ...(block.composerContent
              ? { composerContent: block.composerContent }
              : {}),
            ...(block.attachments ? { attachments: block.attachments } : {}),
            steered: true,
          }}
        />
        {images.length === 0 && block.imageCount > 0 ? (
          // Without the image data, say the message had images. Kept apart
          // from the bubble, whose text may come from composer content.
          <Text size="xs" c="dimmed" ta="right">
            {block.imageCount === 1 ? '1 image' : `${block.imageCount} images`}
          </Text>
        ) : null}
      </Fragment>
    );
  };

  return (
    <>
      {segments.map((segment, index) => {
        const last = index === segments.length - 1;
        const frame = !work
          ? undefined
          : last
            ? { ...work, timing: timings[index] }
            : earlierWork?.(index, timings[index]);
        // A finished segment moves its answer out of the process; the last
        // one does once the run settles.
        const settled = last ? Boolean(state.outcome) : true;
        const split =
          frame && settled
            ? finalTextIndex(
                state.blocks.slice(segment.start, segment.end),
                streamText,
              )
            : -1;
        const processEnd = split === -1 ? segment.end : segment.start + split;
        const process = renderBlocks(segment.start, processEnd);
        const final = renderBlocks(processEnd, segment.end);
        const indicator = last ? workingIndicator : null;
        return (
          <Fragment key={`segment-${segment.start}`}>
            {last || process.length > 0 || final.length > 0 ? (
              <Box className={classes.assistantRow}>
                {frame ? (
                  <WorkProcess
                    frame={frame}
                    hasProcess={process.length > 0 || indicator !== null}
                  >
                    {process}
                    {indicator}
                  </WorkProcess>
                ) : (
                  process
                )}
                {final}
                {last ? (
                  <>
                    {/* Human input and the failure stay outside the process. */}
                    {ask ? (
                      <AskForm
                        key={ask.askId}
                        questions={ask.questions}
                        onSubmit={(answers) => onAnswer(ask.askId, answers)}
                      />
                    ) : null}
                    {envRequest ? (
                      <EnvForm
                        key={`${state.runId ?? 'pending'}:${envRequest.requestId}`}
                        reason={envRequest.reason}
                        variables={envRequest.variables}
                        onSubmit={(entries) =>
                          onSubmitEnv(envRequest.requestId, entries)
                        }
                      />
                    ) : null}
                    {state.terminalError ? (
                      <AgentErrorNotice
                        message={state.terminalError}
                        live
                        {...retry}
                      />
                    ) : null}
                    {state.outcome === 'incomplete' ? (
                      <EndedEarlyNotice stopReason={state.stopReason} live />
                    ) : null}
                    {frame ? null : indicator}
                  </>
                ) : null}
              </Box>
            ) : null}
            {segment.steer === undefined
              ? null
              : renderSteer(
                  state.blocks[segment.steer] as StreamSteerBlock,
                  segment.steer,
                )}
          </Fragment>
        );
      })}
    </>
  );
}
