/**
 * The Strands Agents (TypeScript) adapter for Welt's wire contract.
 *
 * Welt (https://github.com/iwamot/welt) drives an agent over plain JSON:
 * Converse-shaped `messages` (or `interrupt_responses` answering an
 * interrupted run) in, a stream of renderable events out. Strands speaks
 * nearly the same shapes, but not exactly: JSON cannot carry the raw
 * bytes the SDK's file blocks hold, one video format token differs, and
 * `Agent.stream()` yields event objects Welt does not render. Each
 * function here adapts one piece, keeping the host app a thin loop
 * around `Agent.stream()`.
 */

import { Buffer } from "node:buffer";

/** An image format token of the SDK's image blocks. */
export type ImageFormat = "gif" | "jpeg" | "jpg" | "png" | "webp";

/** A document format token of the SDK's document blocks. */
export type DocumentFormat =
  | "csv"
  | "doc"
  | "docx"
  | "html"
  | "json"
  | "md"
  | "pdf"
  | "txt"
  | "xls"
  | "xlsx"
  | "xml";

/** A video format token of the SDK's video blocks. */
export type VideoFormat =
  | "3gp"
  | "flv"
  | "mkv"
  | "mov"
  | "mp4"
  | "mpeg"
  | "mpg"
  | "webm"
  | "wmv";

/** A text block of a decoded message. */
export interface DecodedTextBlock {
  text: string;
}

/** An image block of a decoded message; the bytes are raw. */
export interface DecodedImageBlock {
  image: { format: ImageFormat; source: { bytes: Uint8Array } };
}

/** A document block of a decoded message; the bytes are raw. */
export interface DecodedDocumentBlock {
  document: {
    name: string;
    format: DocumentFormat;
    source: { bytes: Uint8Array };
  };
}

/** A video block of a decoded message; the bytes are raw. */
export interface DecodedVideoBlock {
  video: { format: VideoFormat; source: { bytes: Uint8Array } };
}

/** A content block of a decoded user message. */
export type DecodedUserBlock =
  | DecodedTextBlock
  | DecodedImageBlock
  | DecodedDocumentBlock
  | DecodedVideoBlock;

/** A Strands message decoded from Welt's Converse-shaped payload. */
export type DecodedMessage =
  | { role: "user"; content: DecodedUserBlock[] }
  | { role: "assistant"; content: DecodedTextBlock[] };

const IMAGE_FORMATS: ReadonlySet<string> = new Set([
  "gif",
  "jpeg",
  "jpg",
  "png",
  "webp",
]);

const DOCUMENT_FORMATS: ReadonlySet<string> = new Set([
  "csv",
  "doc",
  "docx",
  "html",
  "json",
  "md",
  "pdf",
  "txt",
  "xls",
  "xlsx",
  "xml",
]);

const VIDEO_FORMATS: ReadonlySet<string> = new Set([
  "3gp",
  "flv",
  "mkv",
  "mov",
  "mp4",
  "mpeg",
  "mpg",
  "webm",
  "wmv",
]);

/**
 * Decode Welt's Converse-shaped messages into the messages Strands consumes.
 *
 * Strands consumes Welt's messages nearly as they are: the block shapes
 * match, but the image/document/video bytes arrive base64-encoded — JSON
 * cannot carry raw bytes — where the SDK holds a `Uint8Array`, and the
 * wire's `three_gp` video token is `3gp` in the SDK. This walks the
 * payload's `messages` value and rebuilds each message with raw bytes
 * and SDK format tokens. Malformed entries are skipped, since they come
 * from the wire rather than the developer; messages left with no blocks
 * are dropped. The result feeds `new Agent({ messages })`.
 *
 * @param messages - The `messages` value of Welt's payload.
 * @returns Messages for the `Agent` constructor.
 */
export function decodeMessages(messages: unknown): DecodedMessage[] {
  if (!Array.isArray(messages)) {
    return [];
  }
  const decoded: DecodedMessage[] = [];
  for (const message of messages) {
    if (!isRecord(message)) {
      continue;
    }
    if (message.role === "user") {
      const content = userContent(message.content);
      if (content.length > 0) {
        decoded.push({ role: "user", content });
      }
    } else if (message.role === "assistant") {
      const content = assistantContent(message.content);
      if (content.length > 0) {
        decoded.push({ role: "assistant", content });
      }
    }
  }
  return decoded;
}

function userContent(content: unknown): DecodedUserBlock[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const blocks: DecodedUserBlock[] = [];
  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }
    if (typeof block.text === "string") {
      blocks.push({ text: block.text });
      continue;
    }
    const decoded =
      imageBlock(block.image) ??
      documentBlock(block.document) ??
      videoBlock(block.video);
    if (decoded !== null) {
      blocks.push(decoded);
    }
  }
  return blocks;
}

function assistantContent(content: unknown): DecodedTextBlock[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const blocks: DecodedTextBlock[] = [];
  for (const block of content) {
    if (isRecord(block) && typeof block.text === "string") {
      blocks.push({ text: block.text });
    }
  }
  return blocks;
}

function imageBlock(media: unknown): DecodedImageBlock | null {
  if (!isRecord(media)) {
    return null;
  }
  const bytes = decodedSourceBytes(media);
  const format = media.format;
  if (bytes === null || typeof format !== "string") {
    return null;
  }
  if (!IMAGE_FORMATS.has(format)) {
    return null;
  }
  return { image: { format: format as ImageFormat, source: { bytes } } };
}

function documentBlock(media: unknown): DecodedDocumentBlock | null {
  if (!isRecord(media)) {
    return null;
  }
  const bytes = decodedSourceBytes(media);
  const { name, format } = media;
  if (bytes === null || typeof format !== "string") {
    return null;
  }
  if (typeof name !== "string" || name.length === 0) {
    return null;
  }
  if (!DOCUMENT_FORMATS.has(format)) {
    return null;
  }
  return {
    document: { name, format: format as DocumentFormat, source: { bytes } },
  };
}

function videoBlock(media: unknown): DecodedVideoBlock | null {
  if (!isRecord(media)) {
    return null;
  }
  const bytes = decodedSourceBytes(media);
  if (bytes === null || typeof media.format !== "string") {
    return null;
  }
  // The wire carries the Converse token for 3GP; the SDK's is shorter.
  const format = media.format === "three_gp" ? "3gp" : media.format;
  if (!VIDEO_FORMATS.has(format)) {
    return null;
  }
  return { video: { format: format as VideoFormat, source: { bytes } } };
}

function decodedSourceBytes(media: Record<string, unknown>): Uint8Array | null {
  const source = media.source;
  if (!isRecord(source)) {
    return null;
  }
  const bytes = source.bytes;
  if (typeof bytes !== "string" || bytes.length === 0) {
    return null;
  }
  return new Uint8Array(Buffer.from(bytes, "base64"));
}

/** One decoded interrupt answer as a Strands resume content block. */
export interface DecodedInterruptResponse {
  interruptResponse: { interruptId: string; response: string };
}

/**
 * Decode Welt's interrupt answers into Strands' resume input.
 *
 * Welt resumes an interrupted run with a payload mapping each interrupt
 * id to the answer a human chose in the thread. Strands resumes from a
 * list of `interruptResponse` content items; the returned list feeds
 * `Agent.stream()` directly.
 *
 * @param responses - The `interrupt_responses` value of Welt's payload.
 * @returns One `interruptResponse` item per answered interrupt, in
 *   payload order.
 */
export function decodeInterruptResponses(
  responses: unknown,
): DecodedInterruptResponse[] {
  if (!isRecord(responses)) {
    return [];
  }
  const decoded: DecodedInterruptResponse[] = [];
  for (const [interruptId, response] of Object.entries(responses)) {
    if (typeof response === "string") {
      decoded.push({ interruptResponse: { interruptId, response } });
    }
  }
  return decoded;
}

/** A `file` wire event: a filename plus base64 bytes Welt uploads to Slack. */
export interface FileEvent {
  file: { name: string; bytes: string };
}

/**
 * Build a `file` wire event, which Welt uploads to the Slack thread.
 *
 * `renderableEvents` emits these for the files a tool or the model
 * generates; this builds the same event from arbitrary bytes, for agents
 * that attach files of their own alongside the reduced stream — yield it
 * from the host app.
 *
 * @param name - The upload filename, extension included.
 * @param data - The raw file bytes.
 * @returns The `file` event (name plus base64 bytes).
 * @throws TypeError if the name is empty (Welt drops a nameless file).
 */
export function fileEvent(name: string, data: Uint8Array): FileEvent {
  if (name.length === 0) {
    throw new TypeError("name must not be empty");
  }
  return { file: { name, bytes: Buffer.from(data).toString("base64") } };
}

// Type aliases, not interfaces: an alias gets an implicit index
// signature, so a reason fits the SDK's JSONValue as-is.

/** A button of a structured interrupt reason. */
export type InterruptOption = {
  value: string;
  label?: string;
  style?: "primary" | "danger";
};

/** The free-text field of a structured interrupt reason. */
export type InterruptInput = {
  label?: string;
  multiline?: boolean;
};

/** The structured interrupt reason shape Welt renders as widgets. */
export type InterruptReason = {
  message: string;
  options?: InterruptOption[];
  input?: InterruptInput;
};

const OPTION_KEYS = new Set(["value", "label", "style"]);
const INPUT_KEYS = new Set(["label", "multiline"]);

/**
 * Build an interrupt reason that Welt renders as the specified widgets.
 *
 * Welt renders this shape as `message` followed by one button per option
 * (`options`), a free-text field whose submitted text becomes the
 * interrupt's response (`input`), or both — whichever answer comes
 * first, a pressed button or the submitted text, settles the question.
 * Both widget specs are the wire's own shapes; building them through
 * this helper turns a typo into an immediate TypeError instead of a
 * silent fallback to Welt's default rendering.
 *
 * @param message - The text Welt shows above the widgets.
 * @param options - One entry per button: a required `value` (what the
 *   interrupting tool receives as the response when the button is
 *   pressed), an optional `label` (the button text; omitted, Welt shows
 *   the value), and an optional `style` ("primary" or "danger").
 * @param input - The free-text field: an optional `label` (the field's
 *   label) and an optional `multiline` (whether the field accepts
 *   multiple lines) — `{}` takes Welt's defaults for both. Omitted, no
 *   field renders.
 * @returns The reason to pass to `ToolContext.interrupt`.
 * @throws TypeError if the message is empty, neither options nor input
 *   is given, or a widget spec is off — an unknown key, a missing value,
 *   an empty or non-string value/label, a style that is not "primary" or
 *   "danger", or a non-boolean multiline.
 */
export function interruptReason(
  message: string,
  options?: readonly InterruptOption[],
  input?: InterruptInput,
): InterruptReason {
  if (message.length === 0) {
    throw new TypeError("message must not be empty");
  }
  if (options === undefined && input === undefined) {
    throw new TypeError("options or input must be given");
  }
  const reason: InterruptReason = { message };
  if (options !== undefined) {
    reason.options = builtOptions(options);
  }
  if (input !== undefined) {
    reason.input = builtInput(input);
  }
  return reason;
}

function builtOptions(options: readonly InterruptOption[]): InterruptOption[] {
  if (options.length === 0) {
    throw new TypeError("options must not be empty");
  }
  const built: InterruptOption[] = [];
  for (const option of options) {
    const unknownKeys = Object.keys(option).filter(
      (key) => !OPTION_KEYS.has(key),
    );
    if (unknownKeys.length > 0) {
      throw new TypeError(
        `unknown option keys: ${unknownKeys.sort().join(", ")}`,
      );
    }
    const value: unknown = option.value;
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError("option value must be a non-empty string");
    }
    const entry: InterruptOption = { value };
    if ("label" in option) {
      const label: unknown = option.label;
      if (typeof label !== "string" || label.length === 0) {
        throw new TypeError("option label must be a non-empty string");
      }
      entry.label = label;
    }
    if ("style" in option) {
      const style: unknown = option.style;
      if (style !== "primary" && style !== "danger") {
        throw new TypeError(
          `style must be "primary" or "danger": ${JSON.stringify(style)}`,
        );
      }
      entry.style = style;
    }
    built.push(entry);
  }
  return built;
}

function builtInput(input: InterruptInput): InterruptInput {
  const unknownKeys = Object.keys(input).filter((key) => !INPUT_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new TypeError(`unknown input keys: ${unknownKeys.sort().join(", ")}`);
  }
  const built: InterruptInput = {};
  if ("label" in input) {
    const label: unknown = input.label;
    if (typeof label !== "string" || label.length === 0) {
      throw new TypeError("input label must be a non-empty string");
    }
    built.label = label;
  }
  if ("multiline" in input) {
    const multiline: unknown = input.multiline;
    if (typeof multiline !== "boolean") {
      throw new TypeError("input multiline must be a boolean");
    }
    built.multiline = multiline;
  }
  return built;
}

/** A `data` wire event: one text chunk of the reply. */
export interface TextEvent {
  data: string;
}

/** A `current_tool_use` wire event: a tool call started. */
export interface ToolUseEvent {
  current_tool_use: { toolUseId: string | null; name: string | null };
}

/** A `tool_result` wire event: a tool call finished. */
export interface ToolResultEvent {
  tool_result: { toolUseId: string | null; status: "success" | "error" };
}

/** An `interrupt` wire event: the run paused for a human answer. */
export interface InterruptEvent {
  interrupt: { id: string; name: string; reason: unknown };
}

/** An event of the wire's renderable subset. */
export type RenderableEvent =
  | TextEvent
  | ToolUseEvent
  | ToolResultEvent
  | FileEvent
  | InterruptEvent;

/**
 * Reduce Strands `Agent.stream()` events to the subset Welt renders.
 *
 * Iterates the events of `Agent.stream()` and yields the wire's
 * renderable subset: text chunks (`data`), tool-use indicators
 * (`current_tool_use` / `tool_result`, slimmed so tool output stays off
 * the wire), generated files (`file` — one per image, document, or video
 * block a tool result or the assistant message carries, named after the
 * block's name or kind plus the format as extension), and interrupts
 * (`interrupt` — when the run stops for human input, one per pending
 * interrupt from the stream's final result, its id, name, and reason,
 * the reason passed through unmodified since interpreting a reason is
 * the renderer's job). Everything else is dropped.
 *
 * @param events - The events of `Agent.stream()`.
 * @yields The renderable wire events, in stream order.
 */
export async function* renderableEvents(
  events: AsyncIterable<unknown>,
): AsyncGenerator<RenderableEvent, void, undefined> {
  for await (const event of events) {
    if (!isRecord(event)) {
      continue;
    }
    switch (event.type) {
      case "modelStreamUpdateEvent": {
        const rendered = modelStreamEvent(event.event);
        if (rendered !== null) {
          yield rendered;
        }
        break;
      }
      case "toolResultEvent": {
        yield* toolResultEvents(event.result);
        break;
      }
      case "modelMessageEvent": {
        yield* messageFileEvents(event.message);
        break;
      }
      case "agentResultEvent": {
        yield* interruptEvents(event.result);
        break;
      }
      default: {
        break;
      }
    }
  }
}

function modelStreamEvent(event: unknown): TextEvent | ToolUseEvent | null {
  if (!isRecord(event)) {
    return null;
  }
  if (event.type === "modelContentBlockDeltaEvent") {
    const delta = event.delta;
    if (
      isRecord(delta) &&
      delta.type === "textDelta" &&
      typeof delta.text === "string" &&
      delta.text.length > 0
    ) {
      return { data: delta.text };
    }
    return null;
  }
  if (event.type === "modelContentBlockStartEvent") {
    const start = event.start;
    if (isRecord(start) && start.type === "toolUseStart") {
      return {
        current_tool_use: {
          toolUseId: stringOrNull(start.toolUseId),
          name: stringOrNull(start.name),
        },
      };
    }
    return null;
  }
  return null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toolResultEvents(result: unknown): RenderableEvent[] {
  if (!isRecord(result)) {
    return [];
  }
  const events: RenderableEvent[] = [
    {
      tool_result: {
        toolUseId: stringOrNull(result.toolUseId),
        status: result.status === "error" ? "error" : "success",
      },
    },
  ];
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      const event = blockFileEvent(block);
      if (event !== null) {
        events.push(event);
      }
    }
  }
  return events;
}

function messageFileEvents(message: unknown): FileEvent[] {
  if (!isRecord(message) || !Array.isArray(message.content)) {
    return [];
  }
  const events: FileEvent[] = [];
  for (const block of message.content) {
    const event = blockFileEvent(block);
    if (event !== null) {
      events.push(event);
    }
  }
  return events;
}

// The stream carries the SDK's block classes, each tagged with a `type`.
const KIND_BY_BLOCK_TYPE: Readonly<Record<string, string>> = {
  documentBlock: "document",
  imageBlock: "image",
  videoBlock: "video",
};

function blockFileEvent(block: unknown): FileEvent | null {
  if (!isRecord(block) || typeof block.type !== "string") {
    return null;
  }
  const kind = KIND_BY_BLOCK_TYPE[block.type];
  if (kind === undefined) {
    return null;
  }
  const source = block.source;
  if (!isRecord(source) || !(source.bytes instanceof Uint8Array)) {
    return null;
  }
  return fileEvent(blockFileName(kind, block), source.bytes);
}

function blockFileName(kind: string, block: Record<string, unknown>): string {
  const name = block.name;
  const base = typeof name === "string" && name.length > 0 ? name : kind;
  const format = block.format;
  if (typeof format !== "string" || format.length === 0) {
    return base;
  }
  return `${base}.${format}`;
}

function interruptEvents(result: unknown): InterruptEvent[] {
  if (!isRecord(result) || !Array.isArray(result.interrupts)) {
    return [];
  }
  const events: InterruptEvent[] = [];
  for (const interrupt of result.interrupts) {
    if (!isRecord(interrupt)) {
      continue;
    }
    // Welt requires a non-empty id (the resume key) and a string name.
    if (typeof interrupt.id !== "string" || interrupt.id.length === 0) {
      continue;
    }
    events.push({
      interrupt: {
        id: interrupt.id,
        name: typeof interrupt.name === "string" ? interrupt.name : "",
        reason: interrupt.reason,
      },
    });
  }
  return events;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
