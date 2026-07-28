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
 *
 * `renderableEvents` reduces the stream to the events Welt renders, with
 * the files of the tools the agent names base64-encoded. `fileEvent`
 * builds the same `file` event from a name and raw bytes, for the files
 * the host app attaches itself.
 *
 * Neither direction is restated here. What arrives is checked against
 * Welt's published schemas, vendored as `schema/` and compiled into
 * `_schema.ts`, and what the builders produce is checked against them
 * before it is returned. The reply stream is read as what the SDK's types
 * say it is: `Agent.stream()` yields a closed union of event objects, so
 * each one is read for what it is rather than guarded against shapes the
 * SDK does not produce.
 */

import { Buffer } from "node:buffer";
import type {
  AgentStreamEvent,
  ContentBlock,
  ContentBlockData,
  DocumentFormat,
  ImageFormat,
  Interrupt,
  InterruptResponseContentData,
  MessageData,
  ModelStreamEvent,
  ToolResultBlock,
  ToolResultContent,
  VideoFormat,
} from "@strands-agents/sdk";
import type { ErrorObject, ValidateFunction } from "ajv/dist/2020.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { REPLY_EVENTS, REQUEST_PAYLOAD } from "./_schema.ts";

// strict: false — the schemas are Welt's, written to the specification
// rather than to Ajv's stricter reading of it.
const ajv = new Ajv2020({ strict: false });

/**
 * Build a validator for one definition of a wire schema.
 *
 * `decodeMessages` and `decodeInterruptResponses` each take one value out
 * of Welt's envelope rather than the envelope itself, and the builders
 * produce one reply shape each, so each validator points at the definition
 * for its own value.
 *
 * @param defs - The `$defs` of the schema carrying the definition.
 * @param definition - The name under those `$defs`.
 * @returns The validator.
 */
function validator(defs: object, definition: string): ValidateFunction {
  return ajv.compile({ $ref: `#/$defs/${definition}`, $defs: defs });
}

// Inbound: the two envelope values, each taken on its own.
const MESSAGES = validator(REQUEST_PAYLOAD.$defs, "messages");
const INTERRUPT_RESPONSES = validator(
  REQUEST_PAYLOAD.$defs,
  "interruptResponses",
);

// Outbound: what the builders below must produce for Welt to render it.
const FILE = validator(REPLY_EVENTS.$defs, "file");
const STRUCTURED_REASON = validator(REPLY_EVENTS.$defs, "structuredReason");

/**
 * Thrown when a value does not match the shape Welt's wire contract gives
 * it: a payload Welt sent, or an event one of the builders below built.
 *
 * A payload that violates the contract is a bug on the sending side rather
 * than an input to interpret, and an event that violates it would reach the
 * Slack thread as Welt's fallback rendering instead of what was meant.
 */
export class WireContractError extends Error {
  /** Where it broke, as a path into the value (`$.content[0].text`). */
  readonly path: string;

  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = "WireContractError";
    this.path = path;
  }
}

/**
 * Check a value against one wire schema, raising where it broke.
 *
 * A message is checked against one definition per role, and a content
 * block against one per kind, so a violation inside one fails the whole
 * group and is reported against the block as a whole as well. The error
 * that says which value, and why, is the deepest one.
 *
 * @param validate - The validator for this value.
 * @param value - The value to check.
 * @throws {WireContractError} If the value violates the contract.
 */
function checked(validate: ValidateFunction, value: unknown): void {
  if (validate(value)) {
    return;
  }
  // Ajv fills these in whenever validation fails; the cast says so.
  const errors = validate.errors as ErrorObject[];
  const deepest = errors.reduce((worst, error) =>
    error.instancePath.length > worst.instancePath.length ? error : worst,
  );
  throw new WireContractError(
    shownPath(deepest.instancePath),
    deepest.message as string,
  );
}

/**
 * Show an Ajv instance path as a path into the value.
 *
 * @param instancePath - The JSON Pointer Ajv reports (`/1/content/0`).
 * @returns The path as a caller would write it (`$[1].content[0]`).
 */
function shownPath(instancePath: string): string {
  return instancePath
    .split("/")
    .slice(1)
    .reduce(
      (shown, segment) =>
        /^\d+$/.test(segment) ? `${shown}[${segment}]` : `${shown}.${segment}`,
      "$",
    );
}

// The payload shapes the schema has vouched for, as far as the decoding
// below reads them. The format tokens are the SDK's own, which is what the
// wire carries — except for 3GP, where the wire carries the Converse token
// and the SDK's is shorter.
type WireVideoFormat = Exclude<VideoFormat, "3gp"> | "three_gp";

interface WireSource {
  bytes: string;
}

type WireBlock =
  | { text: string }
  | { image: { format: ImageFormat; source: WireSource } }
  | { document: { name: string; format: DocumentFormat; source: WireSource } }
  | { video: { format: WireVideoFormat; source: WireSource } };

interface WireMessage {
  role: "user" | "assistant";
  content: WireBlock[];
}

/**
 * Decode Welt's Converse-shaped messages into the messages Strands consumes.
 *
 * Strands consumes Welt's messages nearly as they are: the block shapes
 * match, but the image/document/video bytes arrive base64-encoded — JSON
 * cannot carry raw bytes — where the SDK holds a `Uint8Array`, and the
 * wire's `three_gp` video token is `3gp` in the SDK. This checks the
 * payload against Welt's published schema and rebuilds each message with
 * raw bytes and SDK format tokens. The result feeds `Agent.stream()`.
 *
 * A payload that departs from the wire contract throws: it is a bug on the
 * sending side, and decoding what is left of it would hand the agent a
 * conversation with a turn missing.
 *
 * @param messages - The `messages` value of Welt's payload.
 * @returns A decoded copy of the messages; the input is left untouched.
 * @throws {WireContractError} If the payload violates the wire contract.
 *   The error names the offending path.
 * @throws {DOMException} If a file block's bytes are not valid base64,
 *   which the schema annotates but does not assert.
 */
export function decodeMessages(messages: unknown): MessageData[] {
  checked(MESSAGES, messages);
  // The schema has vouched for the shape; the cast tells the type checker.
  return (messages as WireMessage[]).map(decodedMessage);
}

function decodedMessage(message: WireMessage): MessageData {
  return { role: message.role, content: message.content.map(decodedBlock) };
}

function decodedBlock(block: WireBlock): ContentBlockData {
  if ("text" in block) {
    return { text: block.text };
  }
  if ("image" in block) {
    const { format, source } = block.image;
    return { image: { format, source: { bytes: decodedBytes(source.bytes) } } };
  }
  if ("document" in block) {
    const { name, format, source } = block.document;
    return {
      document: { name, format, source: { bytes: decodedBytes(source.bytes) } },
    };
  }
  const { format, source } = block.video;
  return {
    video: {
      // The wire carries the Converse token for 3GP; the SDK's is shorter.
      format: format === "three_gp" ? "3gp" : format,
      source: { bytes: decodedBytes(source.bytes) },
    },
  };
}

/**
 * Decode one block's base64 bytes.
 *
 * Whether the string decodes is the one thing the schema annotates without
 * asserting, so this is where a payload that lied about it is found out.
 *
 * @param bytes - The base64 the payload carried.
 * @returns The raw bytes.
 * @throws {DOMException} If the string is not valid base64.
 */
function decodedBytes(bytes: string): Uint8Array {
  // atob rather than Buffer.from: Buffer.from discards what is not base64
  // and returns bytes that were never encoded, where atob refuses. It
  // decodes to a latin1 string, one character per byte.
  const binary = atob(bytes);
  const decoded = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    decoded[i] = binary.charCodeAt(i);
  }
  return decoded;
}

/**
 * Decode Welt's interrupt answers into Strands' resume input.
 *
 * Welt resumes an interrupted run with a payload mapping each interrupt
 * id to the answer a human chose in the thread. Strands resumes from a
 * list of `interruptResponse` content items; the returned list feeds
 * `Agent.stream()` directly.
 *
 * A payload that departs from the wire contract throws: resuming a run
 * with an answer short is worse than not resuming it at all.
 *
 * @param responses - The `interrupt_responses` value of Welt's payload.
 * @returns One `interruptResponse` item per answered interrupt, in
 *   payload order.
 * @throws {WireContractError} If the payload violates the wire contract.
 *   The error names the offending path.
 */
export function decodeInterruptResponses(
  responses: unknown,
): InterruptResponseContentData[] {
  checked(INTERRUPT_RESPONSES, responses);
  // The schema has vouched for the shape; the cast tells the type checker.
  return Object.entries(responses as Record<string, string>).map(
    ([interruptId, response]) => ({
      interruptResponse: { interruptId, response },
    }),
  );
}

/** A `file` wire event: a filename plus base64 bytes Welt uploads to Slack. */
export interface FileEvent {
  file: { name: string; bytes: string };
}

/**
 * Build a `file` wire event, which Welt uploads to the Slack thread.
 *
 * `renderableEvents` emits these for the files the model returns and the
 * files of the tools the agent names; this builds the same event from
 * arbitrary bytes, for the files the host app attaches itself.
 *
 * @param name - The upload filename, extension included.
 * @param data - The raw file bytes.
 * @returns The `file` event (name plus base64 bytes).
 * @throws {WireContractError} If the event would not be one Welt renders —
 *   a nameless file, which it drops.
 */
export function fileEvent(name: string, data: Uint8Array): FileEvent {
  const event = { file: { name, bytes: Buffer.from(data).toString("base64") } };
  checked(FILE, event.file);
  return event;
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

/**
 * Build an interrupt reason that Welt renders as the specified widgets.
 *
 * Welt renders this shape as `message` followed by one button per option
 * (`options`), a free-text field whose submitted text becomes the
 * interrupt's response (`input`), or both — whichever answer comes
 * first, a pressed button or the submitted text, settles the question.
 * Both widget specs are the wire's own shapes; building them through this
 * helper checks the result against Welt's published schema, so a typo
 * throws here instead of reaching the thread as Welt's default rendering —
 * which is what a reason it cannot match falls back to, silently.
 *
 * @param message - The text Welt shows above the widgets.
 * @param options - One entry per button: a required `value` (what the
 *   interrupting tool receives as the response when the button is
 *   pressed), an optional `label` (the button text; omitted, Welt shows
 *   the value), and an optional `style` ("primary" or "danger"). At most
 *   25, which is what one Slack actions block holds.
 * @param input - The free-text field: an optional `label` (the field's
 *   label) and an optional `multiline` (whether the field accepts
 *   multiple lines) — `{}` takes Welt's defaults for both. Omitted, no
 *   field renders.
 * @returns The reason to pass to `ToolContext.interrupt`.
 * @throws {WireContractError} If the reason would not be one Welt renders
 *   as widgets.
 */
export function interruptReason(
  message: string,
  options?: readonly InterruptOption[],
  input?: InterruptInput,
): InterruptReason {
  const reason: InterruptReason = { message };
  if (options !== undefined) {
    reason.options = [...options];
  }
  if (input !== undefined) {
    reason.input = input;
  }
  checked(STRUCTURED_REASON, reason);
  return reason;
}

/** A `data` wire event: one text chunk of the reply. */
export interface TextEvent {
  data: string;
}

/** A `current_tool_use` wire event: a tool call started. */
export interface ToolUseEvent {
  current_tool_use: { toolUseId: string; name: string };
}

/** A `tool_result` wire event: a tool call finished. */
export interface ToolResultEvent {
  tool_result: { toolUseId: string; status: "success" | "error" };
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

/** Options for `renderableEvents`. */
export interface RenderableEventsOptions {
  /**
   * The names of the tools whose files become `file` events. Omitted, no
   * tool's files reach the thread.
   */
  filesFrom?: Iterable<string>;
}

/**
 * Reduce Strands `Agent.stream()` events to the subset Welt renders.
 *
 * Iterates the events of `Agent.stream()` and yields the wire's
 * renderable subset: text chunks (`data`), tool-use indicators
 * (`current_tool_use` / `tool_result`, slimmed so tool output stays off
 * the wire), files (`file` — one per image, document, or video block the
 * assistant message carries or a tool named in `filesFrom` returned,
 * named after the block's name or kind plus the format as extension),
 * and interrupts (`interrupt` — when the run stops for human input, one
 * per pending interrupt from the stream's final result, its id, name, and
 * reason, the reason passed through unmodified since interpreting a
 * reason is the renderer's job). Everything else is dropped.
 *
 * Which of the agent's files belong in the reply is the agent's call, so
 * a tool's files become `file` events only when the tool is named in
 * `filesFrom` — a tool that hands the model a file to read stays off the
 * wire unless it is listed. Files the model itself returns are its reply,
 * and always go.
 *
 * Naming the tool behind a result takes the stream's own announcement of
 * the call, kept as it goes by: the agent's messages gain the request only
 * once the tool has succeeded, too late to name the tool that a result
 * belongs to. A resumed run re-executes its interrupted tool, so the
 * announcement comes again with it.
 *
 * @param events - The events of `Agent.stream()`.
 * @param options - `filesFrom`: the names of the tools whose files become
 *   `file` events.
 * @yields The renderable wire events, in stream order.
 */
export async function* renderableEvents(
  events: AsyncIterable<AgentStreamEvent>,
  options?: RenderableEventsOptions,
): AsyncGenerator<RenderableEvent, void, undefined> {
  const filesFrom = new Set(options?.filesFrom ?? []);
  // Tool names by tool use id, learned as the stream announces each call:
  // the agent's messages gain the request only once the tool has succeeded,
  // which is too late to name the tool behind the result.
  const toolNames = new Map<string, string>();
  for await (const event of events) {
    switch (event.type) {
      case "beforeToolCallEvent": {
        toolNames.set(event.toolUse.toolUseId, event.toolUse.name);
        break;
      }
      case "modelStreamUpdateEvent": {
        const rendered = modelStreamEvent(event.event);
        if (rendered !== null) {
          yield rendered;
        }
        break;
      }
      case "toolResultEvent": {
        yield* toolResultEvents(event.result, filesFrom, toolNames);
        break;
      }
      case "modelMessageEvent": {
        yield* fileEvents(event.message.content);
        break;
      }
      case "agentResultEvent": {
        yield* interruptEvents(event.result.interrupts);
        break;
      }
      default: {
        break;
      }
    }
  }
}

function modelStreamEvent(
  event: ModelStreamEvent,
): TextEvent | ToolUseEvent | null {
  if (event.type === "modelContentBlockDeltaEvent") {
    // A delta the model left empty would be an event Welt cannot render.
    if (event.delta.type === "textDelta" && event.delta.text.length > 0) {
      return { data: event.delta.text };
    }
    return null;
  }
  // A content block announces itself only when it is a tool use starting.
  if (
    event.type === "modelContentBlockStartEvent" &&
    event.start !== undefined
  ) {
    const { toolUseId, name } = event.start;
    return { current_tool_use: { toolUseId, name } };
  }
  return null;
}

function toolResultEvents(
  result: ToolResultBlock,
  filesFrom: ReadonlySet<string>,
  toolNames: ReadonlyMap<string, string>,
): RenderableEvent[] {
  const events: RenderableEvent[] = [
    { tool_result: { toolUseId: result.toolUseId, status: result.status } },
  ];
  const name = toolNames.get(result.toolUseId);
  if (name === undefined || !filesFrom.has(name)) {
    return events;
  }
  events.push(...fileEvents(result.content));
  return events;
}

function fileEvents(
  blocks: readonly (ContentBlock | ToolResultContent)[],
): FileEvent[] {
  const events: FileEvent[] = [];
  for (const block of blocks) {
    const event = blockFileEvent(block);
    if (event !== null) {
      events.push(event);
    }
  }
  return events;
}

/**
 * Build the `file` event for one content block, if it holds a file.
 *
 * A block whose source is an S3 location or a URL holds no bytes to
 * upload, and one whose document source is text or nested blocks is not a
 * file either; the file lives elsewhere, so nothing goes to the thread.
 *
 * @param block - A block of an assistant message or a tool result.
 * @returns The `file` event, or null if the block carries no file bytes.
 */
function blockFileEvent(
  block: ContentBlock | ToolResultContent,
): FileEvent | null {
  switch (block.type) {
    case "imageBlock": {
      return block.source.type === "imageSourceBytes"
        ? fileEvent(`image.${block.format}`, block.source.bytes)
        : null;
    }
    case "documentBlock": {
      // The document's own name, which is what the model was handed it
      // under; a tool that left it empty gets the kind instead, since Welt
      // drops a nameless file.
      const base = block.name.length > 0 ? block.name : "document";
      return block.source.type === "documentSourceBytes"
        ? fileEvent(`${base}.${block.format}`, block.source.bytes)
        : null;
    }
    case "videoBlock": {
      return block.source.type === "videoSourceBytes"
        ? fileEvent(`video.${block.format}`, block.source.bytes)
        : null;
    }
    default: {
      return null;
    }
  }
}

function interruptEvents(
  interrupts: readonly Interrupt[] | undefined,
): InterruptEvent[] {
  // The result carries interrupts only when the run stopped for a human.
  if (interrupts === undefined) {
    return [];
  }
  return interrupts.map(({ id, name, reason }) => ({
    interrupt: { id, name, reason },
  }));
}
