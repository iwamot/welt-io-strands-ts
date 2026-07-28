import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  AgentStreamEvent,
  ContentBlock,
  Interrupt,
  JSONValue,
  ModelStreamEvent,
  ToolResultContent,
} from "@strands-agents/sdk";
import {
  AgentResult,
  DocumentBlock,
  ImageBlock,
  JsonBlock,
  Message,
  TextBlock,
  ToolResultBlock,
  VideoBlock,
} from "@strands-agents/sdk";
import type { RenderableEventsOptions } from "../src/index.ts";
import { renderableEvents } from "../src/index.ts";

const HI = new Uint8Array([104, 105]); // "aGk=" encoded

/**
 * Stand in for one event of `Agent.stream()`.
 *
 * The SDK builds each event around the Agent itself, which nothing outside
 * the SDK can build; these carry the fields `renderableEvents` reads, and
 * the blocks inside them are the SDK's own.
 */
function streamEvent(event: object): AgentStreamEvent {
  return event as AgentStreamEvent;
}

async function* stream(
  events: readonly AgentStreamEvent[],
): AsyncGenerator<AgentStreamEvent, void, undefined> {
  for (const event of events) {
    yield event;
  }
}

function rendered(
  events: readonly AgentStreamEvent[],
  options?: RenderableEventsOptions,
) {
  return Array.fromAsync(renderableEvents(stream(events), options));
}

/** The stream's announcement of a tool call, which names it. */
const toolCallStart = (toolUseId: string, name: string) =>
  streamEvent({
    type: "beforeToolCallEvent",
    toolUse: { toolUseId, name, input: {} },
  });

const modelStreamUpdate = (event: ModelStreamEvent) =>
  streamEvent({ type: "modelStreamUpdateEvent", event });

const textDelta = (text: string) =>
  modelStreamUpdate({
    type: "modelContentBlockDeltaEvent",
    delta: { type: "textDelta", text },
  });

const toolResult = (
  toolUseId: string,
  content: ToolResultContent[],
  status: "success" | "error" = "success",
) =>
  streamEvent({
    type: "toolResultEvent",
    result: new ToolResultBlock({ toolUseId, status, content }),
  });

const modelMessage = (content: ContentBlock[]) =>
  streamEvent({
    type: "modelMessageEvent",
    message: new Message({ role: "assistant", content }),
    stopReason: "endTurn",
  });

const interrupt = (id: string, name: string, reason: JSONValue) =>
  ({ id, name, reason, source: "tool" }) as Interrupt;

const agentResult = (interrupts?: Interrupt[]) =>
  streamEvent({
    type: "agentResultEvent",
    result: new AgentResult({
      stopReason: interrupts === undefined ? "endTurn" : "interrupt",
      lastMessage: new Message({ role: "assistant", content: [] }),
      invocationState: {},
      ...(interrupts === undefined ? {} : { interrupts }),
    }),
  });

const image = () => new ImageBlock({ format: "png", source: { bytes: HI } });

describe("renderableEvents", () => {
  test("drops the events Welt does not render", async () => {
    const events = [
      streamEvent({ type: "beforeInvocationEvent" }),
      streamEvent({ type: "contentBlockEvent", contentBlock: image() }),
      streamEvent({
        type: "messageAddedEvent",
        message: new Message({ role: "assistant", content: [image()] }),
      }),
      modelStreamUpdate({ type: "modelMessageStartEvent", role: "assistant" }),
      modelStreamUpdate({ type: "modelContentBlockStopEvent" }),
      modelStreamUpdate({ type: "modelContentBlockStartEvent" }),
      modelStreamUpdate({
        type: "modelMessageStopEvent",
        stopReason: "endTurn",
      }),
      modelStreamUpdate({
        type: "modelContentBlockDeltaEvent",
        delta: { type: "toolUseInputDelta", input: '{"a":' },
      }),
    ];
    assert.deepEqual(await rendered(events), []);
  });

  test("yields text deltas", async () => {
    assert.deepEqual(await rendered([textDelta("Hello")]), [{ data: "Hello" }]);
  });

  test("drops a delta the model left empty", async () => {
    // Welt renders nothing for it, and the wire has no event for nothing.
    assert.deepEqual(await rendered([textDelta("")]), []);
  });

  test("turns a tool-use start into the tool-use indicator", async () => {
    const events = [
      modelStreamUpdate({
        type: "modelContentBlockStartEvent",
        start: { type: "toolUseStart", name: "my_tool", toolUseId: "t1" },
      }),
    ];
    assert.deepEqual(await rendered(events), [
      { current_tool_use: { toolUseId: "t1", name: "my_tool" } },
    ]);
  });

  test("slims tool results to the toolUseId and status", async () => {
    const events = [
      toolResult("t1", [new TextBlock("big output")]),
      toolResult("t2", [], "error"),
    ];
    assert.deepEqual(await rendered(events), [
      { tool_result: { toolUseId: "t1", status: "success" } },
      { tool_result: { toolUseId: "t2", status: "error" } },
    ]);
  });

  test("keeps the files of a tool left out of filesFrom off the wire", async () => {
    const events = [
      toolCallStart("t1", "file_read"),
      toolResult("t1", [
        new DocumentBlock({
          name: "manual",
          format: "pdf",
          source: { bytes: HI },
        }),
      ]),
    ];
    const only = {
      tool_result: { toolUseId: "t1", status: "success" },
    } as const;
    assert.deepEqual(await rendered(events, { filesFrom: ["maker"] }), [only]);
    assert.deepEqual(await rendered(events, { filesFrom: new Set<string>() }), [
      only,
    ]);
    assert.deepEqual(await rendered(events, {}), [only]);
    assert.deepEqual(await rendered(events), [only]);
  });

  test("keeps files off the wire when the tool behind them is unknown", async () => {
    const result = toolResult("t1", [
      new DocumentBlock({
        name: "report",
        format: "md",
        source: { bytes: HI },
      }),
    ]);
    // No announcement at all, and one that named a different call.
    for (const announcements of [[], [toolCallStart("t2", "maker")]]) {
      assert.deepEqual(
        await rendered([...announcements, result], { filesFrom: ["maker"] }),
        [{ tool_result: { toolUseId: "t1", status: "success" } }],
      );
    }
  });

  test("emits a file event per file block a tool named in filesFrom returned", async () => {
    const events = [
      toolCallStart("t1", "create_sample_file"),
      toolResult("t1", [
        image(),
        new DocumentBlock({
          name: "Report",
          format: "pdf",
          source: { bytes: HI },
        }),
        new VideoBlock({ format: "3gp", source: { bytes: HI } }),
      ]),
    ];
    assert.deepEqual(
      await rendered(events, { filesFrom: ["create_sample_file"] }),
      [
        { tool_result: { toolUseId: "t1", status: "success" } },
        { file: { name: "image.png", bytes: "aGk=" } },
        { file: { name: "Report.pdf", bytes: "aGk=" } },
        { file: { name: "video.3gp", bytes: "aGk=" } },
      ],
    );
  });

  test("keeps blocks that hold no file bytes off the wire", async () => {
    // Text and JSON are not files, and a block whose source is an S3
    // location, a URL, or text of its own keeps its file elsewhere.
    const events = [
      toolCallStart("t1", "maker"),
      toolResult("t1", [
        new TextBlock("not a file"),
        new JsonBlock({ json: { a: 1 } }),
        new ImageBlock({
          format: "png",
          source: { location: { type: "s3", uri: "s3://bucket/key" } },
        }),
        new ImageBlock({ format: "png", source: { url: "https://e.test/i" } }),
        new DocumentBlock({
          name: "inline",
          format: "txt",
          source: { text: "read me" },
        }),
        new VideoBlock({
          format: "mp4",
          source: { location: { type: "s3", uri: "s3://bucket/clip" } },
        }),
      ]),
    ];
    assert.deepEqual(await rendered(events, { filesFrom: ["maker"] }), [
      { tool_result: { toolUseId: "t1", status: "success" } },
    ]);
  });

  test("names a file after its kind when the document has no name", async () => {
    const events = [
      toolCallStart("t1", "maker"),
      toolResult("t1", [
        new DocumentBlock({ name: "", format: "csv", source: { bytes: HI } }),
      ]),
    ];
    assert.deepEqual(await rendered(events, { filesFrom: ["maker"] }), [
      { tool_result: { toolUseId: "t1", status: "success" } },
      { file: { name: "document.csv", bytes: "aGk=" } },
    ]);
  });

  test("emits a file event per file block of the assistant message", async () => {
    const events = [modelMessage([new TextBlock("here you go"), image()])];
    assert.deepEqual(await rendered(events), [
      { file: { name: "image.png", bytes: "aGk=" } },
    ]);
  });

  test("ends an interrupted stream with the pending interrupts", async () => {
    const reason = { message: "Deploy?", options: [{ value: "y" }] };
    const events = [
      textDelta("Working on it."),
      agentResult([
        interrupt("i1", "approval", reason),
        interrupt("i2", "question", "free-form"),
      ]),
    ];
    assert.deepEqual(await rendered(events), [
      { data: "Working on it." },
      { interrupt: { id: "i1", name: "approval", reason } },
      { interrupt: { id: "i2", name: "question", reason: "free-form" } },
    ]);
  });

  test("yields nothing for the usual result, which has no interrupts", async () => {
    assert.deepEqual(await rendered([agentResult()]), []);
  });
});
