/**
 * Server-only: short-lived generated images awaiting the user's choice.
 *
 * Candidates are process output, not platform state: they live as files with
 * an unguessable id, expire after a day, and never get a database row.
 */
import { randomBytes } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { IMAGE_CANDIDATES_DIR } from '~agent/paths';

export const CANDIDATE_TTL_MS = 24 * 60 * 60 * 1000;
const ID_RE = /^[a-f0-9]{32}$/;

export function isCandidateId(value: string): boolean {
  return ID_RE.test(value);
}

export function candidatePath(id: string): string {
  return `/api/images/candidates/${id}`;
}

const file = (id: string) => path.join(IMAGE_CANDIDATES_DIR, `${id}.png`);

/** Delete expired candidates; safe to run at any time. */
export async function sweepExpiredCandidates(now = Date.now()): Promise<void> {
  const names = await readdir(IMAGE_CANDIDATES_DIR).catch(() => []);
  await Promise.all(
    names.map(async (name) => {
      const target = path.join(IMAGE_CANDIDATES_DIR, name);
      const info = await stat(target).catch(() => null);
      if (info && now - info.mtimeMs > CANDIDATE_TTL_MS)
        await rm(target, { force: true });
    }),
  );
}

export async function saveCandidate(png: Buffer): Promise<string> {
  await mkdir(IMAGE_CANDIDATES_DIR, { recursive: true });
  await sweepExpiredCandidates();
  const id = randomBytes(16).toString('hex');
  await writeFile(file(id), png, { flag: 'wx' });
  return id;
}

export async function readCandidate(id: string): Promise<Buffer | null> {
  if (!isCandidateId(id)) return null;
  const info = await stat(file(id)).catch(() => null);
  if (!info || Date.now() - info.mtimeMs > CANDIDATE_TTL_MS) return null;
  return readFile(file(id)).catch(() => null);
}
