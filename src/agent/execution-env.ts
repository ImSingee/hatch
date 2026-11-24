/**
 * Filesystem and shell capability the Agent tools run against.
 *
 * Ported from the `ExecutionEnv` contract of `@earendil-works/pi-agent-core`
 * 0.83.0 (`src/harness/types.ts`, MIT, https://github.com/earendil-works/pi),
 * which pi-agent-core 1.0 removed together with its harness. Operation methods
 * never throw or reject: every expected failure is returned as a `Result`.
 */

/** Result of a fallible operation. */
export type Result<TValue, TError> =
  | { ok: true; value: TValue }
  | { ok: false; error: TError };

export function ok<TValue, TError>(value: TValue): Result<TValue, TError> {
  return { ok: true, value };
}

export function err<TValue, TError>(error: TError): Result<TValue, TError> {
  return { ok: false, error };
}

/** Normalize an unknown thrown value into an Error used as a typed cause. */
export function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === 'string') return new Error(error);
  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error(String(error));
  }
}

/** Kind of filesystem object. Symlinks are not followed automatically. */
export type FileKind = 'file' | 'directory' | 'symlink';

export type FileErrorCode =
  | 'aborted'
  | 'not_found'
  | 'permission_denied'
  | 'not_directory'
  | 'is_directory'
  | 'invalid'
  | 'not_supported'
  | 'unknown';

export class FileError extends Error {
  code: FileErrorCode;
  /** Absolute addressed path associated with the failure, when available. */
  path?: string;

  constructor(
    code: FileErrorCode,
    message: string,
    path?: string,
    cause?: Error,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'FileError';
    this.code = code;
    this.path = path;
  }
}

export type ExecutionErrorCode =
  | 'aborted'
  | 'timeout'
  | 'shell_unavailable'
  | 'spawn_error'
  | 'callback_error'
  | 'unknown';

export class ExecutionError extends Error {
  code: ExecutionErrorCode;

  constructor(code: ExecutionErrorCode, message: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ExecutionError';
    this.code = code;
  }
}

/** Metadata for one filesystem object. */
export type FileInfo = {
  /** Basename of `path`. */
  name: string;
  /** Absolute, syntactically normalized addressed path; symlinks not followed. */
  path: string;
  kind: FileKind;
  size: number;
  /** Modification time as milliseconds since the Unix epoch. */
  mtimeMs: number;
};

export type ShellExecOptions = {
  /** Working directory; relative paths resolve against `ExecutionEnv.cwd`. */
  cwd?: string;
  /** Variables that override the inherited defaults (or replace them). */
  env?: Record<string, string>;
  /** Whether to inherit the environment's default variables. Default true. */
  inheritEnv?: boolean;
  /** Timeout in seconds. Default: none. */
  timeout?: number;
  abortSignal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};

export type ExecResult = { stdout: string; stderr: string; exitCode: number };

/**
 * Paths may be absolute or relative to `cwd`. Returned paths are addressed
 * paths, not canonicalized through symlinks unless from `canonicalPath`.
 */
export interface ExecutionEnv {
  cwd: string;
  /** Absolute addressed path, without requiring it to exist. */
  absolutePath(
    path: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<string, FileError>>;
  joinPath(
    parts: string[],
    abortSignal?: AbortSignal,
  ): Promise<Result<string, FileError>>;
  readTextFile(
    path: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<string, FileError>>;
  readTextLines(
    path: string,
    options?: { maxLines?: number; abortSignal?: AbortSignal },
  ): Promise<Result<string[], FileError>>;
  readBinaryFile(
    path: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<Uint8Array, FileError>>;
  /** Create or overwrite a file, creating parent directories. */
  writeFile(
    path: string,
    content: string | Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>>;
  appendFile(
    path: string,
    content: string | Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>>;
  /** Metadata for the addressed path, without following symlinks. */
  fileInfo(
    path: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<FileInfo, FileError>>;
  /** Direct children of a directory, without following symlinks. */
  listDir(
    path: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<FileInfo[], FileError>>;
  /** Canonical path of an existing path, resolving symlinks. */
  canonicalPath(
    path: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<string, FileError>>;
  /** False for missing paths; other failures are errors. */
  exists(
    path: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<boolean, FileError>>;
  createDir(
    path: string,
    options?: { recursive?: boolean; abortSignal?: AbortSignal },
  ): Promise<Result<void, FileError>>;
  remove(
    path: string,
    options?: {
      recursive?: boolean;
      force?: boolean;
      abortSignal?: AbortSignal;
    },
  ): Promise<Result<void, FileError>>;
  createTempDir(
    prefix?: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<string, FileError>>;
  createTempFile(options?: {
    prefix?: string;
    suffix?: string;
    abortSignal?: AbortSignal;
  }): Promise<Result<string, FileError>>;
  /** Run a shell command in `cwd` unless `options.cwd` is given. */
  exec(
    command: string,
    options?: ShellExecOptions,
  ): Promise<Result<ExecResult, ExecutionError>>;
  /** Release resources (kill running commands). Best effort, never rejects. */
  cleanup(): Promise<void>;
}
