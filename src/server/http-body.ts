/**
 * Read a request body as UTF-8 text, returning null once `max` bytes are
 * exceeded (by the declared Content-Length or the streamed bytes) so callers
 * can reject oversized payloads instead of buffering them whole.
 */
export async function readCappedText(
  request: Request,
  max: number,
): Promise<string | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  const body = request.body;
  if (!body) {
    const text = await request.text();
    return new TextEncoder().encode(text).byteLength > max ? null : text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * Read at most `max` bytes of a stream as UTF-8 text. Past the limit the
 * stream is canceled instead of buffered, so a body that never ends or is
 * huge cannot grow memory beyond `max`.
 */
export async function readTextPrefix(
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!body) return { text: '', truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const room = max - total;
    if (value.byteLength > room) {
      chunks.push(value.subarray(0, room));
      total += room;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(merged), truncated };
}
