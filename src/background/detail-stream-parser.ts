export type StreamedStructure = Record<string, unknown>;

interface Frame {
  kind: "object" | "array";
  /** The key this container sits under in its parent, when there is one. */
  key?: string;
  /** Object frames only: the key whose value is being read next. */
  pendingKey?: string;
}

/**
 * Pulls whole `structures` entries out of a detail-analysis envelope while it is
 * still streaming, so the explanation panel fills in instead of sitting on
 * "正在加载详细解析…" for the whole request (measured 12s against a local 9B).
 *
 * Shaped like {@link CoreStreamParser} but deliberately not merged with it: the
 * core envelope nests components inside `sentences[]` and has to attribute each
 * one to its sentence, while this envelope is flat. Sharing the scanner would
 * mean threading grouping concerns through both.
 *
 * Key-aware rather than depth-counting: the envelope also contains a `focus`
 * object *before* `structures`, and a structure may contain nested objects —
 * counting brace depth mistakes both for structures.
 *
 * Emitted structures are unvalidated model output; the caller checks them.
 */
export class DetailStreamParser {
  #stack: Frame[] = [];
  #buffer = "";
  #cursor = 0;
  #inString = false;
  #escaped = false;
  #started = false;
  #stringStart = 0;
  /** Offset where the structure object currently open began, if any. */
  #structureStart: number | undefined;

  /** Feeds more of the raw JSON text and returns the structures it completed. */
  push(text: string): StreamedStructure[] {
    this.#buffer += text;
    const emitted: StreamedStructure[] = [];
    while (this.#cursor < this.#buffer.length) {
      const index = this.#cursor;
      const character = this.#buffer[index]!;
      this.#cursor += 1;

      if (this.#inString) {
        if (this.#escaped) this.#escaped = false;
        else if (character === "\\") this.#escaped = true;
        else if (character === '"') this.#inString = false;
        continue;
      }

      if (!this.#started) {
        // Tolerate a Markdown fence or any prose the model emits first.
        if (character !== "{") continue;
        this.#started = true;
      }

      switch (character) {
        case '"':
          this.#inString = true;
          this.#stringStart = index;
          break;
        case ":":
          this.#assignPendingKey();
          break;
        case "{":
          this.#openObject(index);
          break;
        case "[":
          this.#stack.push({ kind: "array", key: this.#consumeKey() });
          break;
        case "}":
          this.#closeObject(index, emitted);
          break;
        case "]":
          this.#stack.pop();
          break;
        default:
          break;
      }
    }
    return emitted;
  }

  /** A colon always follows a key literal, so the last closed string is it. */
  #assignPendingKey(): void {
    const frame = this.#stack.at(-1);
    if (frame?.kind !== "object") return;
    frame.pendingKey = parseString(this.#buffer.slice(this.#stringStart, this.#cursor - 1).trim());
  }

  #consumeKey(): string | undefined {
    const frame = this.#stack.at(-1);
    if (frame?.kind !== "object") return undefined;
    const key = frame.pendingKey;
    frame.pendingKey = undefined;
    return key;
  }

  #openObject(index: number): void {
    const key = this.#consumeKey();
    const parent = this.#stack.at(-1);
    this.#stack.push({ kind: "object", key });
    if (
      parent?.kind === "array" &&
      parent.key === "structures" &&
      this.#structureStart === undefined
    ) {
      this.#structureStart = index;
    }
  }

  #closeObject(index: number, emitted: StreamedStructure[]): void {
    if (this.#stack.pop() === undefined) return;
    // Only the object whose start offset we recorded is a structure; anything
    // nested inside it closes first and must not be mistaken for it.
    if (this.#structureStart === undefined || this.#stack.at(-1)?.key !== "structures") return;
    const structure = parseObject(this.#buffer.slice(this.#structureStart, index + 1));
    this.#structureStart = undefined;
    if (structure !== undefined) emitted.push(structure);
  }
}

function parseString(literal: string): string | undefined {
  if (!literal.startsWith('"') || !literal.endsWith('"') || literal.length < 2) return undefined;
  try {
    const value: unknown = JSON.parse(literal);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
