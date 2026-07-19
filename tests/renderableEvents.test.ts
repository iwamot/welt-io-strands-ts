import { describe, expect, test } from "bun:test";
import { renderableEvents } from "../src/index.ts";

const HI = new Uint8Array([104, 105]); // "aGk=" encoded

async function* stream(
  events: readonly unknown[],
): AsyncGenerator<unknown, void, undefined> {
  for (const event of events) {
    yield event;
  }
}

function rendered(events: readonly unknown[]) {
  return Array.fromAsync(renderableEvents(stream(events)));
}

function modelStreamUpdate(event: unknown) {
  return { type: "modelStreamUpdateEvent", event };
}

function textDelta(text: unknown) {
  return modelStreamUpdate({
    type: "modelContentBlockDeltaEvent",
    delta: { type: "textDelta", text },
  });
}

describe("renderableEvents", () => {
  test("drops unrenderable events", async () => {
    const events = [
      null,
      "start",
      ["textDelta"],
      { type: "beforeInvocationEvent" },
      { type: "messageAddedEvent", message: { content: [{ text: "x" }] } },
      { type: "contentBlockEvent", contentBlock: { type: "textBlock" } },
      { type: "modelStreamUpdateEvent" },
      modelStreamUpdate("x"),
      modelStreamUpdate({ type: "modelMessageStartEvent", role: "assistant" }),
      modelStreamUpdate({
        type: "modelMessageStopEvent",
        stopReason: "endTurn",
      }),
      modelStreamUpdate({ type: "modelMetadataEvent" }),
      modelStreamUpdate({
        type: "modelContentBlockDeltaEvent",
        delta: { type: "reasoningContentDelta", text: "hmm" },
      }),
      modelStreamUpdate({ type: "modelContentBlockStopEvent" }),
      modelStreamUpdate({ type: "modelContentBlockStartEvent" }),
      modelStreamUpdate({ type: "modelContentBlockStartEvent", start: "x" }),
    ];
    expect(await rendered(events)).toEqual([]);
  });

  test("yields text deltas", async () => {
    expect(await rendered([textDelta("Hello")])).toEqual([{ data: "Hello" }]);
  });

  test("drops empty or non-string text", async () => {
    expect(await rendered([textDelta(""), textDelta(5)])).toEqual([]);
  });

  test("turns a tool-use start into the tool-use indicator", async () => {
    const events = [
      modelStreamUpdate({
        type: "modelContentBlockStartEvent",
        start: { type: "toolUseStart", name: "my_tool", toolUseId: "t1" },
      }),
    ];
    expect(await rendered(events)).toEqual([
      { current_tool_use: { toolUseId: "t1", name: "my_tool" } },
    ]);
  });

  test("nulls missing tool-use-start fields", async () => {
    const events = [
      modelStreamUpdate({
        type: "modelContentBlockStartEvent",
        start: { type: "toolUseStart", toolUseId: 5 },
      }),
    ];
    expect(await rendered(events)).toEqual([
      { current_tool_use: { toolUseId: null, name: null } },
    ]);
  });

  test("slims tool results to the status", async () => {
    const events = [
      {
        type: "toolResultEvent",
        result: {
          type: "toolResultBlock",
          toolUseId: "t1",
          status: "success",
          content: [{ type: "textBlock", text: "big output" }],
        },
      },
    ];
    expect(await rendered(events)).toEqual([
      { tool_result: { toolUseId: "t1", status: "success" } },
    ]);
  });

  test("keeps the error status and nulls a missing toolUseId", async () => {
    const events = [
      { type: "toolResultEvent", result: { status: "error" } },
      { type: "toolResultEvent", result: {} },
      { type: "toolResultEvent", result: "x" },
    ];
    expect(await rendered(events)).toEqual([
      { tool_result: { toolUseId: null, status: "error" } },
      { tool_result: { toolUseId: null, status: "success" } },
    ]);
  });

  test("emits a file event per file block a tool returned", async () => {
    const events = [
      {
        type: "toolResultEvent",
        result: {
          toolUseId: "t1",
          status: "success",
          content: [
            {
              type: "imageBlock",
              format: "png",
              source: { type: "imageSourceBytes", bytes: HI },
            },
            {
              type: "documentBlock",
              name: "Report",
              format: "pdf",
              source: { type: "documentSourceBytes", bytes: HI },
            },
            {
              type: "videoBlock",
              format: "3gp",
              source: { type: "videoSourceBytes", bytes: HI },
            },
          ],
        },
      },
    ];
    expect(await rendered(events)).toEqual([
      { tool_result: { toolUseId: "t1", status: "success" } },
      { file: { name: "image.png", bytes: "aGk=" } },
      { file: { name: "Report.pdf", bytes: "aGk=" } },
      { file: { name: "video.3gp", bytes: "aGk=" } },
    ]);
  });

  test("skips tool-result blocks without raw bytes", async () => {
    const events = [
      {
        type: "toolResultEvent",
        result: {
          toolUseId: "t1",
          status: "success",
          content: [
            "x",
            { type: "textBlock", text: "not a file" },
            { type: "jsonBlock", json: { a: 1 } },
            { type: "imageBlock", format: "png" },
            { type: "imageBlock", format: "png", source: "x" },
            {
              type: "imageBlock",
              format: "png",
              source: { type: "imageSourceBytes", bytes: "aGk=" },
            },
            {
              type: "imageBlock",
              format: "png",
              source: { type: "imageSourceUrl", url: "https://example.com" },
            },
          ],
        },
      },
    ];
    expect(await rendered(events)).toEqual([
      { tool_result: { toolUseId: "t1", status: "success" } },
    ]);
  });

  test("names a file after its kind when the block has no name", async () => {
    const events = [
      {
        type: "toolResultEvent",
        result: {
          toolUseId: "t1",
          status: "success",
          content: [
            {
              type: "documentBlock",
              name: "",
              format: "csv",
              source: { type: "documentSourceBytes", bytes: HI },
            },
          ],
        },
      },
    ];
    expect(await rendered(events)).toEqual([
      { tool_result: { toolUseId: "t1", status: "success" } },
      { file: { name: "document.csv", bytes: "aGk=" } },
    ]);
  });

  test("omits the extension when the block has no format", async () => {
    const events = [
      {
        type: "toolResultEvent",
        result: {
          toolUseId: "t1",
          status: "success",
          content: [
            {
              type: "imageBlock",
              source: { type: "imageSourceBytes", bytes: HI },
            },
          ],
        },
      },
    ];
    expect(await rendered(events)).toEqual([
      { tool_result: { toolUseId: "t1", status: "success" } },
      { file: { name: "image", bytes: "aGk=" } },
    ]);
  });

  test("emits a file event per file block of the assistant message", async () => {
    const events = [
      {
        type: "modelMessageEvent",
        message: {
          role: "assistant",
          content: [
            { type: "textBlock", text: "here you go" },
            {
              type: "imageBlock",
              format: "png",
              source: { type: "imageSourceBytes", bytes: HI },
            },
          ],
        },
        stopReason: "endTurn",
      },
    ];
    expect(await rendered(events)).toEqual([
      { file: { name: "image.png", bytes: "aGk=" } },
    ]);
  });

  test("ignores malformed model messages", async () => {
    const events = [
      { type: "modelMessageEvent" },
      { type: "modelMessageEvent", message: "x" },
      { type: "modelMessageEvent", message: { content: "x" } },
    ];
    expect(await rendered(events)).toEqual([]);
  });

  test("ends an interrupted stream with the pending interrupts", async () => {
    const reason = { message: "Deploy?", options: [{ value: "y" }] };
    const events = [
      textDelta("Working on it."),
      {
        type: "agentResultEvent",
        result: {
          stopReason: "interrupt",
          interrupts: [
            { id: "i1", name: "approval", reason },
            { id: "i2", name: "question", reason: "free-form" },
          ],
        },
      },
    ];
    expect(await rendered(events)).toEqual([
      { data: "Working on it." },
      { interrupt: { id: "i1", name: "approval", reason } },
      { interrupt: { id: "i2", name: "question", reason: "free-form" } },
    ]);
  });

  test("yields nothing for the usual result without interrupts", async () => {
    const events = [
      { type: "agentResultEvent", result: { stopReason: "endTurn" } },
      { type: "agentResultEvent", result: "x" },
      { type: "agentResultEvent" },
    ];
    expect(await rendered(events)).toEqual([]);
  });

  test("skips interrupts without a usable id and defaults the name", async () => {
    const events = [
      {
        type: "agentResultEvent",
        result: {
          stopReason: "interrupt",
          interrupts: ["x", { name: "no-id" }, { id: "" }, { id: "i1" }],
        },
      },
    ];
    expect(await rendered(events)).toEqual([
      { interrupt: { id: "i1", name: "", reason: undefined } },
    ]);
  });
});
