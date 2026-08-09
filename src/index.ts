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
 * What Welt sends is taken as correct. Welt builds the payload and checks
 * its own output against the wire contract before releasing it, so a
 * payload that departs from the contract is a bug on the sending side, not
 * an input to validate against runtime errors — the inbound parameter
 * types say what arrives, and a value that is not it surfaces as an
 * ordinary error from whatever touches it first. The one thing
 * `decodeMessages` does refuse is a content block of a kind Welt never
 * sends: a `toolUse` or `toolResult` is not a shape error but a forged
 * conversation turn, and rebuilt as history it would let whoever reached
 * the runtime put words the model treats as its own past actions into the
 * run. What this adapter checks beyond that is the values its own caller
 * passes to `interruptReason`, since Welt renders a reason it cannot match
 * as its default buttons, silently.
 *
 * The reply stream is read as what the SDK's types say it is:
 * `Agent.stream()` yields a closed union of event objects, so each one is
 * read for what it is rather than guarded against shapes the SDK does not
 * produce. Only what Welt reads goes on the wire — an event carrying more
 * than that costs bandwidth for something the renderer discards, and an
 * event with nothing to render is not sent at all.
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
  JSONValue,
  MessageData,
  ModelStreamEvent,
  ToolResultBlock,
  ToolResultContent,
  VideoFormat,
} from "@strands-agents/sdk";

// The `type` of the warnings this package emits, which a
// `process.on("warning", ...)` listener reads as the warning's `name`.
const WARNING_TYPE = "WeltWarning";

// The inbound shapes, as far as the decoding below reads them. The format
// tokens are the SDK's own, which is what the wire carries — except for
// 3GP, where the wire carries the Converse token and the SDK's is shorter.
type WireVideoFormat = Exclude<VideoFormat, "3gp"> | "three_gp";

interface WireSource {
  bytes: string;
}

type WireBlock =
  | { text: string }
  | { image: { format: ImageFormat; source: WireSource } }
  | { document: { name: string; format: DocumentFormat; source: WireSource } }
  | { video: { format: WireVideoFormat; source: WireSource } };

/** One Converse-shaped message of Welt's payload. */
export interface WireMessage {
  role: "user" | "assistant";
  content: WireBlock[];
}

/**
 * Decode Welt's Converse-shaped messages into the messages Strands consumes.
 *
 * Strands consumes Welt's messages nearly as they are: the block shapes
 * match, but the image/document/video bytes arrive base64-encoded — JSON
 * cannot carry raw bytes — where the SDK holds a `Uint8Array`, and the
 * wire's `three_gp` video token is `3gp` in the SDK. Each message is
 * rebuilt with raw bytes and SDK format tokens. The result feeds
 * `Agent.stream()`.
 *
 * @param messages - The `messages` value of Welt's payload.
 * @returns A decoded copy of the messages; the input is left untouched.
 * @throws {DOMException} If a file block's bytes are not valid base64.
 */
export function decodeMessages(
  messages: readonly WireMessage[],
): MessageData[] {
  return messages.map(decodedMessage);
}

function decodedMessage(message: WireMessage): MessageData {
  return { role: message.role, content: message.content.map(decodedBlock) };
}

// The content block kinds Welt sends. A block of any other kind — a toolUse
// or toolResult in particular — is a forged conversation turn, not something
// Welt builds, and rebuilt as history it would let a caller put words the
// model treats as its own past actions into the run. It is refused, not
// rebuilt.
const ALLOWED_BLOCK_KEYS = new Set(["text", "image", "document", "video"]);

function decodedBlock(block: WireBlock): ContentBlockData {
  if (!Object.keys(block).every((key) => ALLOWED_BLOCK_KEYS.has(key))) {
    throw new Error(
      `unexpected content block: ${Object.keys(block).sort().join(", ")}`,
    );
  }
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

/** One answer of Welt's resume payload: what it was, and where from. */
export interface InterruptAnswer {
  value: JSONValue;
  source: "option" | "input";
}

/**
 * Decode Welt's interrupt answers into Strands' resume input.
 *
 * Welt resumes an interrupted run with a payload mapping each interrupt
 * id to the answer a human chose in the thread and the widget it came
 * from. Strands resumes from a list of `interruptResponse` content items;
 * the returned list feeds `Agent.stream()` directly.
 *
 * The answer travels on as the value it was given, since what it means is
 * for the interrupting tool to decide. The widget it came from is Welt's
 * own vocabulary, and a tool that reads its own option values already
 * knows which of them it declared.
 *
 * @param responses - The `interrupt_responses` value of Welt's payload.
 * @returns One `interruptResponse` item per answered interrupt, in
 *   payload order.
 */
export function decodeInterruptResponses(
  responses: Readonly<Record<string, InterruptAnswer>>,
): InterruptResponseContentData[] {
  return Object.entries(responses).map(([interruptId, answer]) => ({
    interruptResponse: { interruptId, response: answer.value },
  }));
}

/** A `file` wire event: a filename plus base64 bytes Welt uploads to Slack. */
export interface FileEvent {
  file: { name: string; bytes: string };
}

// Type aliases, not interfaces: an alias gets an implicit index
// signature, so a reason fits the SDK's JSONValue as-is.

/** One button of a structured interrupt reason. */
export type OptionSpec = {
  value: JSONValue;
  label?: string;
  style?: "primary" | "danger";
};

/** The free-text field of a structured interrupt reason. */
export type InputSpec = {
  label?: string;
  multiline?: boolean;
};

/** The structured interrupt reason shape Welt renders as widgets. */
type InterruptReason = {
  message: string;
  options?: OptionSpec[];
  input?: InputSpec;
};

const OPTION_KEYS = ["value", "label", "style"];
const INPUT_KEYS = ["label", "multiline"];

/**
 * Build an interrupt reason that Welt renders as the specified widgets.
 *
 * Welt renders this shape as `message` followed by one button per option
 * (`options`), a free-text field whose submitted text becomes the
 * interrupt's response (`input`), or both — whichever answer comes
 * first, a pressed button or the submitted text, settles the question.
 * With neither, the message renders as itself and Welt's default
 * Approve / Deny buttons answer it.
 *
 * Building the reason through this helper is what makes a typo an error.
 * `ToolContext.interrupt` takes its reason as `JSONValue`, so an object
 * literal handed to it directly is checked for being JSON and nothing
 * more, and Welt's reaction to a reason it cannot match is its default
 * Approve / Deny buttons — no error, no log, just widgets the author did
 * not ask for. The typed
 * parameters here catch a misspelled key before the run, and the checks
 * below catch it in the runs the types miss: TypeScript's excess-property
 * check fires on an object literal written at the call site, and not on
 * one that reached it through a variable.
 *
 * What is checked is the shape, not the size: Welt's own rendering caps
 * (how many buttons one Slack block holds, how long a button value may
 * be) are Welt's to enforce, and a copy of them here would be four copies
 * to keep in step with a number only Welt knows.
 *
 * @param message - The text Welt shows above the widgets.
 * @param options - One entry per button: a required `value` (any JSON
 *   value, which the interrupting tool receives as the response when the
 *   button is pressed), an optional `label` (the button text; omitted,
 *   Welt shows the value), and an optional `style` ("primary" or
 *   "danger"). Omitted, no buttons render.
 * @param input - The free-text field: an optional `label` (the field's
 *   label) and an optional `multiline` (whether the field accepts
 *   multiple lines) — `{}` takes Welt's defaults for both. Omitted, no
 *   field renders.
 * @returns The reason to pass to `ToolContext.interrupt`.
 * @throws {TypeError} If a value is of the wrong type.
 * @throws {Error} If a key is unknown or a required string is empty.
 */
export function interruptReason(
  message: string,
  options?: readonly OptionSpec[],
  input?: InputSpec,
): InterruptReason {
  const reason: InterruptReason = { message: checkedMessage(message) };
  if (options !== undefined) {
    reason.options = checkedOptions(options);
  }
  if (input !== undefined) {
    reason.input = checkedInput(input);
  }
  return reason;
}

/** Check a reason's message. */
function checkedMessage(message: unknown): string {
  if (typeof message !== "string") {
    throw new TypeError(`message must be a string, not ${typeName(message)}`);
  }
  if (message.length === 0) {
    throw new Error("message must not be empty");
  }
  return message;
}

/** Check a reason's options. */
function checkedOptions(options: unknown): OptionSpec[] {
  if (!Array.isArray(options)) {
    throw new TypeError(`options must be an array, not ${typeName(options)}`);
  }
  if (options.length === 0) {
    throw new Error("options must not be empty; omit it to show no buttons");
  }
  return options.map(checkedOption);
}

/** Check one option of a reason. */
function checkedOption(option: unknown): OptionSpec {
  if (!isRecord(option)) {
    throw new TypeError(`an option must be an object, not ${typeName(option)}`);
  }
  refuseUnknownKeys(option, OPTION_KEYS, "an option");
  const { value, label, style } = option;
  // An option's value is whatever JSON value the interrupting tool wants
  // back, so nothing about it is a typo to catch beyond its being JSON at
  // all — what a reason carries has to survive the wire.
  if (value === undefined) {
    throw new Error("an option needs a value");
  }
  if (!isJsonValue(value)) {
    throw new TypeError(
      `an option's value must be JSON, not ${typeName(value)}`,
    );
  }
  const checked: OptionSpec = { value };
  if (label !== undefined) {
    checked.label = checkedLabel(label, "an option's label");
  }
  if (style !== undefined) {
    if (style !== "primary" && style !== "danger") {
      throw new Error(`an option's style must be "primary" or "danger"`);
    }
    checked.style = style;
  }
  return checked;
}

/** Check a reason's free-text field. */
function checkedInput(input: unknown): InputSpec {
  if (!isRecord(input)) {
    throw new TypeError(`input must be an object, not ${typeName(input)}`);
  }
  refuseUnknownKeys(input, INPUT_KEYS, "input");
  const { label, multiline } = input;
  const checked: InputSpec = {};
  if (label !== undefined) {
    checked.label = checkedLabel(label, "input's label");
  }
  if (multiline !== undefined) {
    if (typeof multiline !== "boolean") {
      throw new TypeError(
        `input's multiline must be a boolean, not ${typeName(multiline)}`,
      );
    }
    checked.multiline = multiline;
  }
  return checked;
}

/** Check a widget label, which Welt shows in place of nothing. */
function checkedLabel(label: unknown, subject: string): string {
  if (typeof label !== "string") {
    throw new TypeError(`${subject} must be a string, not ${typeName(label)}`);
  }
  if (label.length === 0) {
    throw new Error(`${subject} must not be empty`);
  }
  return label;
}

/**
 * Refuse keys the wire contract does not name.
 *
 * A misspelled key is the mistake worth catching: Welt drops the whole
 * reason to its default rendering rather than ignoring the stray key.
 */
function refuseUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  subject: string,
): void {
  const unknownKeys = Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .sort();
  if (unknownKeys.length > 0) {
    throw new Error(
      `${subject} carries unknown key(s): ${unknownKeys.join(", ")}` +
        ` (known: ${allowed.join(", ")})`,
    );
  }
}

/** Name a value's type, for the error that refuses it. */
function typeName(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return "an array";
  }
  const type = typeof value;
  return type === "object" ? "an object" : `a ${type}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a value is one JSON can carry, nested values included. */
function isJsonValue(value: unknown): value is JSONValue {
  if (value === null) {
    return true;
  }
  const kind = typeof value;
  if (kind === "string" || kind === "number" || kind === "boolean") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (isRecord(value)) {
    return Object.values(value).every(isJsonValue);
  }
  return false;
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
 * An event with nothing to render is dropped too: a text chunk the model
 * left empty, a block whose file lives elsewhere — in S3, behind a URL, or
 * as text of its own — rather than in bytes the block carries, and a file
 * whose bytes are empty, which Slack refuses, failing the whole reply with
 * it. The empty file leaves a process warning behind, naming what returned
 * it; a block with no bytes to upload in the first place is nothing to
 * report.
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
        yield* fileEvents(event.message.content, "the model");
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
    // A delta the model left empty carries nothing to render.
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
  events.push(...fileEvents(result.content, name));
  return events;
}

function fileEvents(
  blocks: readonly (ContentBlock | ToolResultContent)[],
  origin: string,
): FileEvent[] {
  const events: FileEvent[] = [];
  for (const block of blocks) {
    const event = blockFileEvent(block, origin);
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
 * @param origin - What returned the block, for the warning an empty file
 *   leaves behind.
 * @returns The `file` event, or null if the block carries no file bytes.
 */
function blockFileEvent(
  block: ContentBlock | ToolResultContent,
  origin: string,
): FileEvent | null {
  switch (block.type) {
    case "imageBlock": {
      return block.source.type === "imageSourceBytes"
        ? fileEvent(`image.${block.format}`, block.source.bytes, origin)
        : null;
    }
    case "documentBlock": {
      // The document's own name, which is what the model was handed it
      // under; a tool that left it empty gets the kind instead, since Welt
      // drops a nameless file.
      const base = block.name.length > 0 ? block.name : "document";
      return block.source.type === "documentSourceBytes"
        ? fileEvent(`${base}.${block.format}`, block.source.bytes, origin)
        : null;
    }
    case "videoBlock": {
      return block.source.type === "videoSourceBytes"
        ? fileEvent(`video.${block.format}`, block.source.bytes, origin)
        : null;
    }
    default: {
      return null;
    }
  }
}

/**
 * Build a `file` wire event, which Welt uploads to the Slack thread.
 *
 * @param name - The upload filename, extension included.
 * @param data - The raw file bytes.
 * @param origin - What returned the file, for the warning an empty one
 *   leaves behind.
 * @returns The `file` event (name plus base64 bytes), or null for a file
 *   with no bytes.
 */
function fileEvent(
  name: string,
  data: Uint8Array,
  origin: string,
): FileEvent | null {
  if (data.length === 0) {
    // Slack refuses a zero-byte upload, and the whole reply fails with it,
    // so an empty file does not go on the wire.
    process.emitWarning(
      `Skipped an empty file from ${origin}: ${name}`,
      WARNING_TYPE,
    );
    return null;
  }
  return { file: { name, bytes: Buffer.from(data).toString("base64") } };
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
