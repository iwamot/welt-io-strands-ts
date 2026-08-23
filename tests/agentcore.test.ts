import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, test } from "node:test";
import type { AgentStreamEvent, Interrupt } from "@strands-agents/sdk";
import { AgentResult, Message } from "@strands-agents/sdk";
import type { StreamingAgent } from "../src/agentcore.ts";
import { sendFile, weltAgent } from "../src/agentcore.ts";
import type { WireMessage } from "../src/index.ts";
import { decodeMessages } from "../src/index.ts";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const PNG_BASE64 = Buffer.from(PNG_BYTES).toString("base64");

/**
 * Stand in for one event of `Agent.stream()`.
 *
 * The SDK builds each event around the Agent itself, which nothing
 * outside the SDK can build; these carry the fields `renderableEvents`
 * reads, and the blocks inside them are the SDK's own.
 */
function streamEvent(event: object): AgentStreamEvent {
  return event as AgentStreamEvent;
}

const textDelta = (text: string) =>
  streamEvent({
    type: "modelStreamUpdateEvent",
    event: {
      type: "modelContentBlockDeltaEvent",
      delta: { type: "textDelta", text },
    },
  });

const interrupt = (id: string, name: string) =>
  ({ id, name, reason: "Go?", source: "tool" }) as Interrupt;

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

type AgentInput = Parameters<StreamingAgent["stream"]>[0];

/**
 * A Strands-shaped agent that replays scripted events, one list per call.
 *
 * Constructed input data, not a mock: it holds the event lists to stream
 * and the inputs it was streamed on, and verifies nothing itself.
 */
class ReplayAgent implements StreamingAgent {
  readonly inputs: AgentInput[] = [];
  private readonly scripts: AgentStreamEvent[][];

  constructor(...scripts: AgentStreamEvent[][]) {
    this.scripts = scripts;
  }

  stream(input: AgentInput): AsyncIterable<AgentStreamEvent> {
    this.inputs.push(input);
    const script = this.scripts.shift();
    if (script === undefined) {
      throw new Error("no scripted event list left");
    }
    return replay(script);
  }
}

async function* replay(
  events: readonly AgentStreamEvent[],
): AsyncGenerator<AgentStreamEvent, void, undefined> {
  for (const event of events) {
    yield event;
  }
}

function frames(handler: ReturnType<typeof weltAgent>, payload: unknown) {
  return Array.fromAsync(handler.process(payload));
}

describe("weltAgent", () => {
  test("a turn streams the renderable events as SSE frames", async () => {
    const agent = new ReplayAgent([textDelta("hi")]);

    const handler = weltAgent(() => agent);

    assert.deepEqual(await frames(handler, { messages: [] }), [
      { data: { data: "hi" } },
    ]);
  });

  test("a turn runs on the decoded messages", async () => {
    const agent = new ReplayAgent([]);
    const messages: WireMessage[] = [
      { role: "user", content: [{ text: "hello" }] },
    ];

    await frames(
      weltAgent(() => agent),
      { messages },
    );

    assert.deepEqual(agent.inputs, [decodeMessages(messages)]);
  });

  test("each turn runs on a fresh agent", async () => {
    const agents = [
      new ReplayAgent([textDelta("one")]),
      new ReplayAgent([textDelta("two")]),
    ];
    const made = agents.values();

    const handler = weltAgent(() => {
      const agent = made.next().value;
      if (agent === undefined) {
        throw new Error("no agent left");
      }
      return agent;
    });
    await frames(handler, { messages: [] });
    await frames(handler, { messages: [] });

    assert.deepEqual(
      agents.map(({ inputs }) => inputs.length),
      [1, 1],
    );
  });

  test("a file a tool queued rides beside the reply", async () => {
    const agent: StreamingAgent = {
      stream: () =>
        (async function* () {
          yield textDelta("before");
          sendFile("chart.png", PNG_BYTES);
          yield textDelta("after");
        })(),
    };

    const handler = weltAgent(() => agent, { filesFrom: ["some_tool"] });

    assert.deepEqual(await frames(handler, { messages: [] }), [
      { data: { data: "before" } },
      { data: { data: "after" } },
      { data: { file: { name: "chart.png", bytes: PNG_BASE64 } } },
    ]);
  });

  test("a file queued after the last event still rides the reply", async () => {
    const agent: StreamingAgent = {
      stream: () =>
        (async function* () {
          yield textDelta("before");
          sendFile("chart.png", PNG_BYTES);
        })(),
    };

    assert.deepEqual(
      await frames(
        weltAgent(() => agent),
        { messages: [] },
      ),
      [
        { data: { data: "before" } },
        { data: { file: { name: "chart.png", bytes: PNG_BASE64 } } },
      ],
    );
  });

  test("a failed turn's leftover files stay off the next reply", async () => {
    sendFile("stale.txt", new Uint8Array([1]));
    const agent = new ReplayAgent([textDelta("fresh")]);

    assert.deepEqual(
      await frames(
        weltAgent(() => agent),
        { messages: [] },
      ),
      [{ data: { data: "fresh" } }],
    );
  });

  test("resume without an interrupted run is refused", async () => {
    const handler = weltAgent(() => new ReplayAgent());

    await assert.rejects(
      frames(handler, { interrupt_responses: {} }),
      /No interrupted agent to resume/,
    );
  });

  test("an interrupted run resumes on the agent that raised it", async () => {
    const agent = new ReplayAgent(
      [agentResult([interrupt("i-1", "approval")])],
      [textDelta("resumed")],
    );
    let turnsStarted = 0;

    const handler = weltAgent(() => {
      turnsStarted += 1;
      return agent;
    });
    const first = await frames(handler, { messages: [] });
    const second = await frames(handler, {
      interrupt_responses: { "i-1": { value: true, source: "option" } },
    });

    assert.deepEqual(first, [
      { data: { interrupt: { id: "i-1", name: "approval", reason: "Go?" } } },
    ]);
    assert.deepEqual(second, [{ data: { data: "resumed" } }]);
    // The resume ran on the stashed agent, not a fresh one.
    assert.equal(turnsStarted, 1);
    assert.deepEqual(agent.inputs[1], [
      { interruptResponse: { interruptId: "i-1", response: true } },
    ]);
  });

  test("the slot empties once resumed", async () => {
    const agent = new ReplayAgent(
      [agentResult([interrupt("i-1", "approval")])],
      [textDelta("resumed")],
    );

    const handler = weltAgent(() => agent);
    await frames(handler, { messages: [] });
    await frames(handler, {
      interrupt_responses: { "i-1": { value: true, source: "option" } },
    });

    await assert.rejects(
      frames(handler, {
        interrupt_responses: { "i-1": { value: true, source: "option" } },
      }),
      /No interrupted agent to resume/,
    );
  });

  test("a resume that interrupts again can resume again", async () => {
    const agent = new ReplayAgent(
      [agentResult([interrupt("i-1", "first")])],
      [agentResult([interrupt("i-2", "second")])],
      [textDelta("done")],
    );

    const handler = weltAgent(() => agent);
    await frames(handler, { messages: [] });
    await frames(handler, {
      interrupt_responses: { "i-1": { value: true, source: "option" } },
    });
    const third = await frames(handler, {
      interrupt_responses: { "i-2": { value: true, source: "option" } },
    });

    assert.deepEqual(third, [{ data: { data: "done" } }]);
  });
});

describe("sendFile", () => {
  test("a name that is not a string is refused", () => {
    assert.throws(
      () => sendFile(1 as unknown as string, PNG_BYTES),
      /name must be a string, not number/,
    );
  });

  test("an empty name is refused", () => {
    assert.throws(() => sendFile("", PNG_BYTES), /name must not be empty/);
  });

  test("data that is not a Uint8Array is refused", () => {
    assert.throws(
      () => sendFile("chart.png", "bytes" as unknown as Uint8Array),
      /data must be a Uint8Array/,
    );
  });

  test("empty data is refused", () => {
    assert.throws(
      () => sendFile("chart.png", new Uint8Array()),
      /data must not be empty/,
    );
  });

  test("a refused file is not queued", async () => {
    assert.throws(() => sendFile("chart.png", new Uint8Array()));
    const agent = new ReplayAgent([textDelta("clean")]);

    assert.deepEqual(
      await frames(
        weltAgent(() => agent),
        { messages: [] },
      ),
      [{ data: { data: "clean" } }],
    );
  });
});
