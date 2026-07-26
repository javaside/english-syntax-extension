export interface StreamedComponent {
  sentenceId: string;
  component: Record<string, unknown>;
}

interface Frame {
  kind: "object" | "array";
  /** The key this container sits under in its parent, when there is one. */
  key?: string;
  /** Object frames only: the key whose value is being read next. */
  pendingKey?: string;
}

interface SentenceFrame {
  /** Offset in the buffer where this sentence object opened. */
  start: number;
  sentenceId?: string;
  /** Components that arrived before this sentence's id did. */
  buffered: Array<Record<string, unknown>>;
}

const SENTENCE_ID_PATTERN = /"sentenceId"\s*:\s*"((?:[^"\\]|\\.)*)"/u;

/**
 * Pulls whole components out of a core-analysis envelope while it is still
 * streaming, so a paragraph can start rendering before the model has finished
 * the sentence.
 *
 * This is deliberately not a general streaming JSON parser: it tracks only the
 * one shape the core prompt asks for —
 * `{"sentences":[{"sentenceId":…,"components":[{…},…]}]}` — and emits each
 * component object once it closes. A component is recognised only inside an
 * array keyed `components` inside an element of the array keyed `sentences`;
 * objects nested within a component close first and are not mistaken for it.
 *
 * Callers must treat every emitted component as unvalidated model output. The
 * coverage invariant (every non-punctuation token covered exactly once) can only
 * be checked once the whole sentence has arrived, so these are display-only.
 */
export class CoreStreamParser {
  #stack: Frame[] = [];
  #sentences: SentenceFrame[] = [];
  #buffer = "";
  #cursor = 0;
  #inString = false;
  #escaped = false;
  #started = false;
  #stringStart = 0;
  /** Offset where the component object currently open began, if any. */
  #componentStart: number | undefined;

  /** Feeds more of the raw JSON text and returns the components it completed. */
  push(text: string): StreamedComponent[] {
    this.#buffer += text;
    const emitted: StreamedComponent[] = [];
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
    const literal = this.#buffer.slice(this.#stringStart, this.#cursor - 1).trim();
    frame.pendingKey = parseString(literal);
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
    if (parent?.kind !== "array") return;
    if (parent.key === "sentences") {
      this.#sentences.push({ start: index, buffered: [] });
      return;
    }
    if (parent.key === "components" && this.#componentStart === undefined) {
      this.#componentStart = index;
    }
  }

  #closeObject(index: number, emitted: StreamedComponent[]): void {
    if (this.#stack.pop() === undefined) return;
    const enclosing = this.#stack.at(-1);
    if (this.#componentStart !== undefined && enclosing?.key === "components") {
      const component = parseObject(this.#buffer.slice(this.#componentStart, index + 1));
      this.#componentStart = undefined;
      if (component !== undefined) this.#collect(component, emitted);
      return;
    }
    if (enclosing?.key === "sentences") this.#flushBuffered(emitted);
  }

  #collect(component: Record<string, unknown>, emitted: StreamedComponent[]): void {
    const sentence = this.#sentences.at(-1);
    if (sentence === undefined) return;
    sentence.sentenceId ??= this.#readSentenceId(sentence);
    if (sentence.sentenceId === undefined) {
      // The model put components before the id; hold them until it arrives.
      sentence.buffered.push(component);
      return;
    }
    emitted.push({ sentenceId: sentence.sentenceId, component });
  }

  /** Scans only this sentence's own text, so sibling sentences cannot bleed in. */
  #readSentenceId(sentence: SentenceFrame): string | undefined {
    const match = this.#buffer.slice(sentence.start).match(SENTENCE_ID_PATTERN);
    return match === null ? undefined : parseString(`"${match[1]!}"`);
  }

  #flushBuffered(emitted: StreamedComponent[]): void {
    const sentence = this.#sentences.at(-1);
    if (sentence === undefined || sentence.buffered.length === 0) return;
    const sentenceId = sentence.sentenceId ?? this.#readSentenceId(sentence);
    if (sentenceId === undefined) return;
    for (const component of sentence.buffered) emitted.push({ sentenceId, component });
    sentence.buffered = [];
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
