/** The sentinel payload OpenAI-compatible endpoints send to close a stream. */
export const SSE_DONE = "[DONE]";

/**
 * Minimal server-sent-events decoder for chat completion streams.
 *
 * Only the pieces the model endpoints actually use are implemented: `data`
 * fields, blank-line event boundaries, comments, and CRLF. Chunk boundaries fall
 * wherever the network puts them, so a partial line has to survive until the
 * rest of it arrives — that buffering is the whole point of holding state here
 * instead of parsing each chunk on its own.
 */
export class SseDecoder {
  #buffer = "";

  /** Feeds decoded text and returns the payloads of every event it completed. */
  push(text: string): string[] {
    this.#buffer += text;
    const payloads: string[] = [];
    for (;;) {
      const boundary = this.#nextBoundary();
      if (boundary === undefined) return payloads;
      const block = this.#buffer.slice(0, boundary.index);
      this.#buffer = this.#buffer.slice(boundary.index + boundary.length);
      const payload = dataPayload(block);
      if (payload !== undefined) payloads.push(payload);
    }
  }

  /** The earliest blank line, tolerating either line ending. */
  #nextBoundary(): { index: number; length: number } | undefined {
    const candidates = [
      { index: this.#buffer.indexOf("\r\n\r\n"), length: 4 },
      { index: this.#buffer.indexOf("\n\n"), length: 2 },
    ].filter(({ index }) => index !== -1);
    if (candidates.length === 0) return undefined;
    return candidates.reduce((earliest, candidate) =>
      candidate.index < earliest.index ? candidate : earliest,
    );
  }
}

function dataPayload(block: string): string | undefined {
  const lines: string[] = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith("data:")) continue;
    const value = line.slice("data:".length);
    // The spec strips exactly one optional space after the colon; anything
    // beyond that belongs to the payload.
    lines.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  return lines.length === 0 ? undefined : lines.join("\n");
}
