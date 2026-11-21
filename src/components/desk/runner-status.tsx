import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { agentRunnerStatusQueryOptions } from '~queries/agent';
import type { AgentRunnerStatusSnapshot } from '~server/agent-runner-status';
import classes from './menu-bar.module.css';

/** The chip's words: which runner is online, or what is wrong. */
export function runnerChipLabel(status: AgentRunnerStatusSnapshot): string {
  if (status.state === 'attention') return 'Runner needs attention';
  const [only, ...rest] = status.runners;
  if (!only) return 'Runner offline';
  return rest.length
    ? `${status.runners.length} runners online`
    : `${only.runnerId} online`;
}

/**
 * Whether the Agent can run right now, at a glance. It leads to the Agent
 * Runner status page, which explains the state in full.
 */
export function RunnerStatus() {
  const { data } = useQuery({
    ...agentRunnerStatusQueryOptions,
    // The status page polls every few seconds; the chip only needs to
    // follow connects and disconnects.
    refetchInterval: 30_000,
  });
  if (!data) return null;
  const label = runnerChipLabel(data);
  return (
    <Link
      to="/settings/agent-runner"
      className={`${classes.item} ${classes.runner}`}
      data-state={data.state}
      aria-label={`${label}. Open Agent Runner status`}
    >
      <span className={classes.runnerDot} aria-hidden />
      <span className={classes.runnerLabel}>{label}</span>
    </Link>
  );
}
