/** Read the external docs an App published with its current deployment. */
import type { AppDocView } from './client';
import {
  invalid,
  openClient,
  PAGE_OPTIONS,
  pageFlags,
  parseCommandArgs,
  type Flags,
  type Page,
} from './command-session';

/** Mirrors the manifest's doc id rule. */
const DOC_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type DocsCommand =
  | { kind: 'list'; app: string; page: Page }
  | { kind: 'get'; app: string; docId: string };

/** Map argv to one command; rejects anything unusable before any RPC. */
export function parseDocsCommand(
  args: readonly string[],
  offset: number,
): { command: DocsCommand; flags: Flags } {
  const operation = args[offset + 2];
  if (operation === 'list') {
    const { flags, positionals } = parseCommandArgs(
      args,
      offset,
      3,
      PAGE_OPTIONS,
    );
    if (positionals.length !== 1 || !positionals[0])
      throw invalid('Supply exactly one App ID or slug to docs list.');
    return {
      command: { kind: 'list', app: positionals[0], page: pageFlags(flags) },
      flags,
    };
  }
  if (operation === 'get') {
    const { flags, positionals } = parseCommandArgs(args, offset, 3, {});
    if (positionals.length !== 2 || !positionals[0])
      throw invalid('Supply an App ID or slug and one doc id to docs get.');
    const docId = positionals[1];
    if (!DOC_ID_RE.test(docId))
      throw invalid(
        'The doc id must be 1-64 lowercase letters, digits or "-"; use hatch app docs list to find it.',
      );
    return { command: { kind: 'get', app: positionals[0], docId }, flags };
  }
  throw invalid('Use hatch app docs list or hatch app docs get.');
}

/** One line per doc with the id `docs get` needs. */
export function docText(doc: AppDocView): string {
  const line = `${doc.id}  ${doc.title}  ${doc.path}  ${doc.bytes} bytes`;
  return doc.description ? `${line}\n  ${doc.description}` : line;
}

export async function runDocs(
  args: readonly string[],
  offset: number,
  signal: AbortSignal,
) {
  const { command, flags } = parseDocsCommand(args, offset);
  const { docs } = (await openClient(flags, signal)).apps;
  if (command.kind === 'list') {
    const page = await docs.list({
      id: command.app,
      limit: command.page.limit || undefined,
      cursor: command.page.cursor,
    });
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(page)}\n`);
      return;
    }
    const { webhook, rpc } = page.endpoints;
    const lines = [
      `${page.appId} version ${page.version} (deployment ${page.deploymentId})`,
      ...(webhook ? [`webhook: ${webhook.url} (auth ${webhook.auth})`] : []),
      ...(rpc ? [`rpc: ${rpc.url} (service ${rpc.service})`] : []),
      ...(page.docs.length
        ? page.docs.map((doc) => docText(doc))
        : ['No docs published.']),
      ...(page.nextCursor === null ? [] : [`next cursor: ${page.nextCursor}`]),
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
    return;
  }
  const result = await docs.get({ id: command.app, docId: command.docId });
  // Text mode prints the Markdown body unchanged so it can be redirected.
  process.stdout.write(
    flags.json ? `${JSON.stringify(result)}\n` : result.content,
  );
}
