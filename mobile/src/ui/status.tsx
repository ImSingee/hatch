import { Tag } from './primitives';

export function StatusTag({ status }: { status: string }) {
  switch (status) {
    case 'deployed':
      return <Tag tone="success" dot label="Live" />;
    case 'building':
      return <Tag tone="warning" dot label="Building" />;
    case 'failed':
      return <Tag tone="danger" dot label="Failed" />;
    default:
      return <Tag tone="quiet" label={statusText(status || 'unknown')} />;
  }
}

export function statusText(status: string) {
  return status === 'deployed'
    ? 'Live'
    : status.charAt(0).toUpperCase() + status.slice(1);
}
