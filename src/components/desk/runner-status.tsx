import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { agentRunnerStatusQueryOptions } from '~queries/agent';
import classes from './menu-bar.module.css';

/**
 * A warning in the menu bar while no Agent Runner is connected, so the Agent
 * cannot run. Nothing shows while a runner is online. It leads to the Agent
 * Runner status page, which explains the state in full.
 */
export function RunnerStatus() {
  const { data } = useQuery({
    ...agentRunnerStatusQueryOptions,
    // The status page polls every few seconds; the warning only needs to
    // follow connects and disconnects.
    refetchInterval: 30_000,
  });
  if (data?.state !== 'offline') return null;
  return (
    <Link
      to="/settings/agent-runner"
      className={`${classes.item} ${classes.runner}`}
      aria-label="Runner offline. Open Agent Runner status"
    >
      <span className={classes.runnerDot} aria-hidden />
      <span className={classes.runnerLabel}>Runner offline</span>
    </Link>
  );
}
