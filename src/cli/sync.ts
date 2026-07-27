/** How long ago, in human terms — "never" when there is no date at all. */
export function relativeAgo(at: Date | null, now: Date): string {
  if (at === null) {
    return "never";
  }

  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

/** "synced 3h ago", or "never synced" when the connection has no `lastUpdatedAt` at all. */
export function describeSync(lastUpdatedAt: Date | null, now: Date): string {
  if (lastUpdatedAt === null) {
    return "never synced";
  }
  return `synced ${relativeAgo(lastUpdatedAt, now)}`;
}
