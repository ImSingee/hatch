/** A token count the way model docs write it: 1M, 1.5M, 200K, 8,192. */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000)
    return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (tokens >= 10_000) return `${Math.round(tokens / 1000)}K`;
  return tokens.toLocaleString('en-US');
}
