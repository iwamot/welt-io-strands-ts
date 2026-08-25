import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentStreamEvent, Interrupt } from "@strands-agents/sdk";
import { AgentResult, Message } from "@strands-agents/sdk";
import type {
  RenderableEvent,
  StreamingAgent,
  WireMessage,
} from "../src/index.ts";
import { decodeMessages, renderableEvents, startReply } from "../src/index.ts";

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

/** Stream one reply and gather the events it renders. */
function events(
  agent: StreamingAgent,
  payload: unknown,
  filesFrom?: Iterable<string>,
): Promise<RenderableEvent[]> {
  return Array.fromAsync(
    renderableEvents(startReply(agent, payload), {
      filesFrom: filesFrom ?? [],
    }),
  );
}

describe("startReply", () => {
  test("a turn streams the renderable events", async () => {
    const agent = new ReplayAgent([textDelta("hi")]);

    assert.deepEqual(await events(agent, { messages: [] }), [{ data: "hi" }]);
  });

  test("a turn streams on the decoded messages", async () => {
    const agent = new ReplayAgent([]);
    const messages: WireMessage[] = [
      { role: "user", content: [{ text: "hello" }] },
    ];

    await events(agent, { messages });

    assert.deepEqual(agent.inputs, [decodeMessages(messages)]);
  });

  test("a resume streams on the decoded answers", async () => {
    const agent = new ReplayAgent([textDelta("resumed")]);

    const resumed = await events(agent, {
      interrupt_responses: { "i-1": { value: true, source: "option" } },
    });

    assert.deepEqual(resumed, [{ data: "resumed" }]);
    assert.deepEqual(agent.inputs[0], [
      { interruptResponse: { interruptId: "i-1", response: true } },
    ]);
  });

  test("a stop's questions end the reply", async () => {
    const agent = new ReplayAgent([
      agentResult([interrupt("i-1", "approval")]),
    ]);

    const streamed = await events(agent, { messages: [] });

    assert.deepEqual(streamed, [
      { interrupt: { id: "i-1", name: "approval", reason: "Go?" } },
    ]);
  });
});
