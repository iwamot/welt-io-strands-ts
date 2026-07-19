/**
 * A small AgentCore agent that Welt can drive.
 *
 * Receives Welt's payload, feeds it to a Strands agent, and yields the
 * renderable subset of its `stream()` events — BedrockAgentCoreApp emits
 * each one as SSE, which Welt (https://github.com/iwamot/welt) renders
 * into Slack. The payload carries one of two envelopes: Converse-shaped
 * `messages` for a conversation turn, or `interrupt_responses` when a
 * human answered the approval buttons of an interrupted run.
 *
 * This example is a standalone deployable; Welt drives it only through
 * the JSON wire contract, which @welt-io/strands adapts in both
 * directions.
 */

import { Buffer } from "node:buffer";
import { Agent, tool } from "@strands-agents/sdk";
import type { RenderableEvent } from "@welt-io/strands";
import {
  decodeInterruptResponses,
  decodeMessages,
  interruptReason,
  renderableEvents,
} from "@welt-io/strands";
import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";
import { z } from "zod";

const currentTime = tool({
  name: "current_time",
  description: "Get the current date and time.",
  callback: () => new Date().toISOString(),
});

const attachSampleFile = tool({
  name: "attach_sample_file",
  description: "Attach a small sample CSV file to the Slack thread.",
  callback: () => {
    // A document block in the tool result surfaces as a `file` wire
    // event, which Welt uploads to the thread.
    const csv = Buffer.from("fruit,count\napple,3\nbanana,5\n");
    return {
      document: {
        name: "sample",
        format: "csv",
        source: { bytes: csv.toString("base64") },
      },
    };
  },
});

const sampleDangerousAction = tool({
  name: "sample_dangerous_action",
  description:
    "Pretend to run a dangerous or irreversible action the user asked for.",
  inputSchema: z.object({
    action: z.string().describe("The action to pretend to run."),
  }),
  // A sample of the approval round trip: the interrupt below pauses the
  // run until someone answers in the Slack thread — with the buttons, or
  // by typing an instruction into the text field. Nothing is actually
  // executed.
  callback: (input, context) => {
    if (context === undefined) {
      throw new Error("This tool needs its execution context to interrupt.");
    }
    const answer = context.interrupt<string>({
      name: "example-dangerous-action-approval",
      reason: interruptReason(
        `May I run this dangerous action? — ${input.action}`,
        [
          { value: "y", label: "Approve", style: "primary" },
          { value: "n", label: "Cancel" },
        ],
        { label: "Or tell me what to do instead" },
      ),
    });
    if (answer === "y") {
      return `Ran: ${input.action}. (This example doesn't actually run anything.)`;
    }
    if (answer === "n") {
      return "The action was cancelled by the user.";
    }
    return `The action was not run. The user said instead: ${answer}`;
  },
});

// Where an interrupted Agent waits for its answers. One slot is enough:
// AgentCore Runtime runs each session in its own microVM, so this process
// never serves two sessions. Resume only: a normal turn always builds a
// fresh Agent and streams from the messages Welt sends (the Slack thread
// is the source of truth for conversation history, so the slot must not
// stand in for it). No persistence either — the slot lives and dies with
// the session's microVM (recycled on idle timeout, 8 hours at most).
let interruptedAgent: Agent | null = null;

function newAgent(): Agent {
  return new Agent({
    // Any Converse model; unset falls back to the Strands default.
    // `||`, not `??`: an empty MODEL_ID means unset, like Welt's own
    // variables.
    ...(process.env.MODEL_ID ? { model: process.env.MODEL_ID } : {}),
    tools: [currentTime, attachSampleFile, sampleDangerousAction],
    printer: false,
  });
}

/**
 * Reduce one agent stream to wire events, re-stashing the agent whenever
 * the stream stops for human input so a resume that interrupts again
 * keeps working.
 *
 * Each event is wrapped as `{data: event}`: the AgentCore SDK treats a
 * yielded object's `data` field as the SSE data payload, so the wrapper
 * puts the wire event itself — text events included, whose own `data`
 * key would otherwise be mistaken for the envelope — on the `data:`
 * line.
 */
async function* replies(
  agent: Agent,
  stream: AsyncIterable<unknown>,
): AsyncGenerator<{ data: RenderableEvent }> {
  let interrupted = false;
  for await (const event of renderableEvents(stream)) {
    if ("interrupt" in event) {
      interrupted = true;
    }
    yield { data: event };
  }
  if (interrupted) {
    interruptedAgent = agent;
  }
}

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    process: async function* (payload: unknown) {
      const envelope = payloadEnvelope(payload);

      if (envelope.interruptResponses !== undefined) {
        const agent = interruptedAgent;
        interruptedAgent = null;
        if (agent === null) {
          // The microVM was recycled while the buttons waited. The SDK
          // reports the throw as an `error` event, and Welt renders its
          // resume-failure notice.
          throw new Error("No interrupted agent to resume in this session.");
        }
        const responses = decodeInterruptResponses(envelope.interruptResponses);
        yield* replies(agent, agent.stream(responses));
        return;
      }

      const messages = decodeMessages(envelope.messages);
      if (messages.length === 0) {
        yield {
          data: {
            data: "I received an empty conversation, so there is nothing to reply to.",
          },
        };
        return;
      }
      const agent = newAgent();
      yield* replies(agent, agent.stream(messages));
    },
  },
});

function payloadEnvelope(payload: unknown): {
  messages?: unknown;
  interruptResponses?: unknown;
} {
  if (typeof payload !== "object" || payload === null) {
    return {};
  }
  const record = payload as Record<string, unknown>;
  return "interrupt_responses" in record
    ? { interruptResponses: record.interrupt_responses }
    : { messages: record.messages };
}

app.run();
