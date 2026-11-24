/** Server-only: capture an App's declared external docs at build time. */
import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import {
  APP_DOCS_ARTIFACT_DIR,
  appDocArtifactPath,
  type PublishedAppDoc,
  type SourceManifest,
} from './manifest';

/** Largest single published doc body. */
export const APP_DOC_MAX_BYTES = 256 * 1024;
/** Largest combined size of every doc one deployment publishes. */
export const APP_DOCS_MAX_TOTAL_BYTES = 1024 * 1024;

export type CapturedAppDoc = {
  doc: PublishedAppDoc;
  body: Buffer;
};

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Read and validate every doc the manifest declares. Runs before the build
 * replaces its output, so an invalid doc fails the deploy without side effects.
 * The build copies source into a symlink-free temp tree first; opening with
 * O_NOFOLLOW keeps this reader safe on its own as well.
 */
export async function captureAppDocs(
  src: string,
  declared: SourceManifest['docs'],
  manifestFile: string,
): Promise<CapturedAppDoc[]> {
  const captured: CapturedAppDoc[] = [];
  let total = 0;
  for (const entry of declared) {
    const subject = `Doc "${entry.id}" declared by ${manifestFile} (${entry.path})`;
    const body = await readRegularFile(path.join(src, entry.path), subject);
    if (body.length === 0) throw new Error(`${subject} is empty.`);
    if (body.length > APP_DOC_MAX_BYTES) {
      throw new Error(
        `${subject} is ${body.length} bytes; the limit is ${APP_DOC_MAX_BYTES} bytes.`,
      );
    }
    try {
      utf8.decode(body);
    } catch {
      throw new Error(`${subject} is not valid UTF-8 text.`);
    }
    total += body.length;
    if (total > APP_DOCS_MAX_TOTAL_BYTES) {
      throw new Error(
        `Docs declared by ${manifestFile} exceed ${APP_DOCS_MAX_TOTAL_BYTES} bytes in total.`,
      );
    }
    captured.push({
      doc: {
        id: entry.id,
        title: entry.title,
        ...(entry.description ? { description: entry.description } : {}),
        path: entry.path,
        bytes: body.length,
        sha256: createHash('sha256').update(body).digest('hex'),
      },
      body,
    });
  }
  return captured;
}

/** Write captured doc bodies into the deployment artifact. */
export async function writeAppDocs(
  out: string,
  captured: CapturedAppDoc[],
): Promise<void> {
  if (captured.length === 0) return;
  await fs.mkdir(path.join(out, APP_DOCS_ARTIFACT_DIR), { recursive: true });
  for (const { doc, body } of captured) {
    await fs.writeFile(path.join(out, appDocArtifactPath(doc.id)), body);
  }
}

async function readRegularFile(file: string, subject: string): Promise<Buffer> {
  const handle = await fs
    .open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw new Error(`${subject} was not found.`);
      if (error.code === 'ELOOP')
        throw new Error(`${subject} must not be a symbolic link.`);
      throw error;
    });
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${subject} must be a regular file.`);
    if (info.size > APP_DOC_MAX_BYTES) {
      throw new Error(
        `${subject} is ${info.size} bytes; the limit is ${APP_DOC_MAX_BYTES} bytes.`,
      );
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
