/**
 * Isomorphic App task run shapes shared by the run list, inspector and form.
 */

export type RunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled';

export type RunStepStatus = 'running' | 'succeeded' | 'failed';

/** JSON values a run records (input, output, step output). */
export type RunJson =
  | string
  | number
  | boolean
  | null
  | RunJson[]
  | { [key: string]: RunJson };

/** One row of a run list. */
export type RunListItem = {
  id: string;
  trigger: string;
  status: RunStatus;
  createdAt: string;
  startedAt: string | null;
  durationMs: number | null;
  stepCount: number;
};

/** One recorded attempt of one step. */
export type RunStepView = {
  seq: number;
  name: string;
  status: RunStepStatus;
  attempt: number;
  output: RunJson | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
};

/** Everything the run inspector shows. */
export type RunDetailView = Omit<RunListItem, 'stepCount'> & {
  version: number | null;
  input: RunJson | null;
  output: RunJson | null;
  error: string | null;
  log: string | null;
  finishedAt: string | null;
  steps: RunStepView[];
};

export function isActiveRun(status: RunStatus): boolean {
  return status === 'queued' || status === 'running';
}

/** Pretty-print a recorded value for a code block. */
export function prettyRunValue(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Milliseconds between two ISO timestamps, when both exist. */
export function runDurationMs(
  startedAt: Date | null,
  finishedAt: Date | null,
): number | null {
  return startedAt && finishedAt
    ? finishedAt.getTime() - startedAt.getTime()
    : null;
}
