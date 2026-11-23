/**
 * The collapsible "Working / Worked" line over an Agent reply's process:
 * reasoning, tool calls and intermediate prose. Shared by the live stream and
 * the persisted transcript so a reply keeps one shape from start to history.
 */
import { Box, Collapse, UnstyledButton } from '@mantine/core';
import { useReducedMotion } from '@mantine/hooks';
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconChevronRight,
  IconPlayerStopFilled,
} from '@tabler/icons-react';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useState,
} from 'react';
import type { StreamOutcome } from './use-agent-stream';
import classes from './chat.module.css';

export type WorkPhase = 'running' | StreamOutcome;

/** Run timestamps on the server clock (ms). */
export type WorkTiming = {
  startedAt: number;
  /** Absent while the run is going, or when its end is unknown. */
  endedAt?: number;
} | null;

export type WorkFrame = {
  phase: WorkPhase;
  /** Null when the reply has no reliable run binding (legacy history). */
  timing: WorkTiming;
  expanded: boolean;
  onToggle: () => void;
};

/**
 * A finished reply folds its process away; a running, failed or stopped one
 * stays open so its progress or failure context remains visible.
 */
export function defaultWorkExpanded(phase: WorkPhase): boolean {
  return phase !== 'completed';
}

/** Server clock minus browser clock, for timers counting a live run. */
export const WorkClockOffset = createContext(0);

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** Current server-clock time, re-rendered on each whole second since `anchor`. */
function useServerNow(anchor: number | null): number {
  const offset = useContext(WorkClockOffset);
  const [now, setNow] = useState(() => Date.now() + offset);
  useEffect(() => {
    if (anchor === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const current = Date.now() + offset;
      setNow(current);
      const intoSecond = (((current - anchor) % 1000) + 1000) % 1000;
      timer = setTimeout(tick, 1000 - intoSecond);
    };
    tick();
    return () => clearTimeout(timer);
  }, [anchor, offset]);
  return now;
}

/** What the work line says about the process inside it. */
export type WorkSummary = {
  /** Tool calls and context compactions inside the process. */
  steps: number;
  /** What a running reply is doing now, such as a tool's label. */
  current?: string;
};

/**
 * The words that open the line: what happened, then how long it took. A
 * running reply counts up; an ended one says how it ended.
 */
const PHASE_WORDS: Record<WorkPhase, { lead: string; span: string }> = {
  running: { lead: 'Working', span: 'for' },
  completed: { lead: 'Worked', span: 'for' },
  failed: { lead: 'Failed', span: 'after' },
  cancelled: { lead: 'Stopped', span: 'after' },
  incomplete: { lead: 'Ended early', span: 'after' },
};

function WorkDuration({
  timing,
  running,
  span,
}: {
  timing: WorkTiming;
  running: boolean;
  span: string;
}) {
  const ticking = running && timing !== null && timing.endedAt === undefined;
  const now = useServerNow(ticking ? timing.startedAt : null);
  if (!timing) return null;
  const end = timing.endedAt ?? (ticking ? now : undefined);
  if (end === undefined) return null;
  return (
    <>
      {` ${span} `}
      <span className={classes.workDuration}>
        {formatElapsed(end - timing.startedAt)}
      </span>
    </>
  );
}

/** The mark before the words: a live dot while working, else how it ended. */
function WorkMark({ phase }: { phase: WorkPhase }) {
  switch (phase) {
    case 'running':
      return <span className={classes.workLive} />;
    case 'failed':
      return <IconAlertTriangle size={12} stroke={2} />;
    case 'cancelled':
      return <IconPlayerStopFilled size={10} />;
    case 'incomplete':
      return <IconAlertCircle size={12} stroke={2} />;
    case 'completed':
      return null;
  }
}

function stepCountLabel(steps: number): string {
  return steps === 1 ? '1 step' : `${steps} steps`;
}

/**
 * A reply's process as one quiet line in the Agent's column: no surface of
 * its own, so it reads as part of the turn rather than another message.
 * Expanded, the steps hang off a hairline rail under the line's mark.
 */
export function WorkProcess({
  frame,
  hasProcess,
  summary,
  children,
}: {
  frame: WorkFrame;
  /** False when nothing precedes the final answer; the line is then static. */
  hasProcess: boolean;
  summary: WorkSummary;
  children?: ReactNode;
}) {
  const bodyId = useId();
  const reduceMotion = useReducedMotion();
  const running = frame.phase === 'running';
  const words = PHASE_WORDS[frame.phase];
  // A finished reply with nothing before its answer and no known duration
  // (legacy history) has nothing to show here.
  if (!hasProcess && frame.timing === null && frame.phase === 'completed') {
    return null;
  }
  // A running line names its current step; an ended one counts its steps.
  const detail = running
    ? summary.current
    : summary.steps > 0
      ? stepCountLabel(summary.steps)
      : undefined;
  // Spaces between the parts keep the copied text and accessible name
  // readable ("Worked for 1m 12s · 6 steps").
  const line = (
    <>
      <span className={classes.workMark} aria-hidden>
        <WorkMark phase={frame.phase} />
      </span>
      <span className={classes.workText}>
        <span className={classes.workLead}>{words.lead}</span>
        <WorkDuration
          timing={frame.timing}
          running={running}
          span={words.span}
        />
        {detail ? (
          <>
            {' '}
            <span className={classes.workDetail}>· {detail}</span>
          </>
        ) : null}
      </span>
      {hasProcess ? (
        <IconChevronRight
          size={14}
          stroke={2}
          aria-hidden
          className={classes.workChevron}
        />
      ) : null}
    </>
  );

  return (
    <Box className={classes.work} data-phase={frame.phase}>
      {hasProcess ? (
        <UnstyledButton
          className={classes.workLine}
          aria-expanded={frame.expanded}
          aria-controls={bodyId}
          onClick={frame.onToggle}
        >
          {line}
        </UnstyledButton>
      ) : (
        <Box className={classes.workLine}>{line}</Box>
      )}
      {hasProcess ? (
        <Collapse
          id={bodyId}
          expanded={frame.expanded}
          transitionDuration={reduceMotion ? 0 : 200}
        >
          <Box className={classes.workBody}>{children}</Box>
        </Collapse>
      ) : null}
    </Box>
  );
}
