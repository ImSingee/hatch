/**
 * Server-only: a declared, client-facing error for an App manifest the
 * platform rejects. Public APIs pass its message through, so it must name the
 * manifest field to fix without echoing values from the authored source.
 */
import type { z } from 'zod';
import { AppError } from '~server/errors';

export type ManifestIssue = {
  /** Field to fix, such as `keyboard.reserve[0]`; empty for the whole file. */
  path: string;
  /** Schema-authored reason; never contains an authored value. */
  message: string;
};

type PathSegment = PropertyKey;

const MAX_ISSUES = 20;
const MAX_MESSAGE_LENGTH = 300;
// Authored object keys are shown only when they look like a field name, so an
// unknown key can be fixed without reflecting arbitrary text.
const SAFE_KEY = /^[A-Za-z_$][\w$-]{0,63}$/;

function formatSegment(segment: PathSegment, first: boolean): string {
  if (typeof segment === 'number') return `[${segment}]`;
  if (typeof segment === 'string' && SAFE_KEY.test(segment))
    return first ? segment : `.${segment}`;
  return '[…]';
}

/** Render a validation path as `a.b[0].c`, masking non-identifier keys. */
export function formatManifestPath(path: readonly PathSegment[]): string {
  return path
    .map((segment, index) => formatSegment(segment, index === 0))
    .join('');
}

function cleanMessage(message: string): string {
  // Strip control characters (terminal escapes, line breaks) and bound length.
  // oxlint-disable-next-line no-control-regex
  const single = message.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
  return single.length > MAX_MESSAGE_LENGTH
    ? `${single.slice(0, MAX_MESSAGE_LENGTH - 1)}…`
    : single;
}

/**
 * Public issues for a Zod failure. Zod's built-in messages describe the
 * schema (expected type, options, bounds), not the received value; custom
 * messages in the manifest schema are static. Unknown keys are reported one
 * per field so the path itself names what to delete.
 */
export function manifestIssuesFromZod(error: z.ZodError): ManifestIssue[] {
  return error.issues.flatMap((issue): ManifestIssue[] =>
    issue.code === 'unrecognized_keys'
      ? issue.keys.map((key) => ({
          path: formatManifestPath([...issue.path, key]),
          message: 'unknown field; remove it',
        }))
      : [
          {
            path: formatManifestPath(issue.path),
            message: cleanMessage(issue.message),
          },
        ],
  );
}

function describe(file: string, issues: readonly ManifestIssue[]): string {
  const shown = issues
    .slice(0, MAX_ISSUES)
    .map((issue) =>
      issue.path ? `- ${issue.path}: ${issue.message}` : `- ${issue.message}`,
    );
  if (issues.length > MAX_ISSUES)
    shown.push(`- …and ${issues.length - MAX_ISSUES} more`);
  return `${file} is invalid. Fix these fields and deploy again:\n${shown.join('\n')}`;
}

/** The App source manifest does not satisfy the platform contract. */
export class AppManifestValidationError extends AppError {
  readonly issues: readonly ManifestIssue[];
  readonly file: string;

  constructor(issues: readonly ManifestIssue[], file = 'App manifest') {
    const safe = issues.map((issue) => ({
      path: issue.path,
      message: cleanMessage(issue.message),
    }));
    super(describe(file, safe), 400);
    this.name = 'AppManifestValidationError';
    this.issues = safe;
    this.file = file;
  }

  /** The same failure, attributed to the authored manifest file. */
  inFile(file: string): AppManifestValidationError {
    return new AppManifestValidationError(this.issues, file);
  }
}

/** Throw one manifest issue at `path` with a static `message`. */
export function manifestInvalid(
  path: readonly PathSegment[],
  message: string,
): AppManifestValidationError {
  return new AppManifestValidationError([
    { path: formatManifestPath(path), message },
  ]);
}
