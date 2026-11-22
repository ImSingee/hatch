/** UI-oriented path pair shared by Agent file tools and chat rendering. */
export type FilePathDetails = {
  /** Path relative to the workspace or read-only root that authorized it. */
  relativePath: string;
  /** Absolute path in the Agent Runner filesystem namespace. */
  absolutePath: string;
};

/** Core tools whose primary identity is a filesystem path. */
export function isFilePathTool(name: string): boolean {
  return (
    name === 'list_files' ||
    name === 'read_file' ||
    name === 'write_file' ||
    name === 'edit_file'
  );
}

/**
 * Short label for a file tool path. A relative path that climbs two or more
 * levels above its root (`../../x`) is harder to read than the absolute path
 * it stands for, so those show the absolute path instead.
 */
export function filePathDisplayLabel(details: FilePathDetails): string {
  const segments = details.relativePath.split('/');
  return segments[0] === '..' && segments[1] === '..'
    ? details.absolutePath
    : details.relativePath;
}

/** Safely recognize streamed or persisted path details from untrusted JSON. */
export function isFilePathDetails(value: unknown): value is FilePathDetails {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const details = value as Record<string, unknown>;
  return (
    typeof details.relativePath === 'string' &&
    details.relativePath.length > 0 &&
    typeof details.absolutePath === 'string' &&
    details.absolutePath.length > 0
  );
}
