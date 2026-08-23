/**
 * The AgentCore Runtime invocation handler for a Strands agent Welt drives.
 *
 * `weltAgent` builds the handler that `BedrockAgentCoreApp` serves, so an
 * agent connects to Welt without rewriting the wiring every deployable
 * needs: telling a conversation turn from the answers that resume an
 * interrupted run, decoding each envelope, keeping the interrupted Agent
 * until its answers arrive, reducing the stream to the events Welt
 * renders, and wrapping each one as `{ data: event }` — the AgentCore
 * Runtime SDK treats a yielded object's `data` field as the SSE data
 * payload, so the wrapper puts the wire event itself on the `data:` line.
 * The example agent of this repository once wrote this wiring out by
 * hand; this module is the same wiring as a function.
 *
 * The interrupted Agent waits inside the returned handler, under the
 * runtime's own lifecycle: AgentCore Runtime serves each session from its
 * own microVM, so one slot is enough, and the slot lives and dies with
 * that microVM — resuming after it was recycled (idle timeout, 8 hours at
 * most) throws an error the AgentCore Runtime SDK reports as an `error`
 * event, which Welt renders as its resume-failure notice. The slot is
 * resume-only: a normal turn always builds a fresh Agent, because the
 * Slack thread is the source of truth for conversation history and the
 * messages Welt sends already carry it whole.
 *
 * `sendFile` hands the Slack thread a file without handing it to the
 * model: a tool queues the file, and the handler puts it on the wire
 * beside the events of the reply being streamed. The model never sees
 * what was sent, so a tool whose file matters to the conversation says
 * what it holds in its result — or returns the file as an
 * image/document/video content block and is named in `filesFrom` instead.
 */

import { Buffer } from "node:buffer";
import type { AgentStreamEvent } from "@strands-agents/sdk";
import type {
  FileEvent,
  InterruptAnswer,
  RenderableEvent,
  WireMessage,
} from "./index.ts";
import {
  decodeInterruptResponses,
  decodeMessages,
  renderableEvents,
} from "./index.ts";

/** What the handler streams an agent on: one envelope's decoded input. */
type AgentInput =
  | ReturnType<typeof decodeMessages>
  | ReturnType<typeof decodeInterruptResponses>;

/**
 * What the handler drives: the Agent's streaming face.
 *
 * Importing the SDK to name the Agent would say what one method already
 * says. This names it instead, and an Agent satisfies it. The `never[]`
 * rest makes room for the parameters the SDK's own signature takes
 * beyond what the handler passes.
 */
export interface StreamingAgent {
  stream(input: AgentInput, ...rest: never[]): AsyncIterable<AgentStreamEvent>;
}

/** What `weltAgent` takes beside the agent factory. */
export interface WeltAgentOptions {
  /**
   * The names of the tools whose files become `file` events, as
   * `renderableEvents` takes it. Omitted, no tool's files reach the
   * thread this way.
   */
  filesFrom?: Iterable<string>;
}

/** An SSE frame: the wire event on the `data:` line. */
export interface DataFrame {
  data: RenderableEvent;
}

/** What `BedrockAgentCoreApp` takes as its `invocationHandler`. */
export interface InvocationHandler {
  process(payload: unknown): AsyncGenerator<DataFrame, void, undefined>;
}

/**
 * Welt's payload, which carries one of the two envelopes.
 *
 * What Welt sends is taken as correct: it checks its own output against
 * the wire contract before sending it, so this says what arrives rather
 * than checking it. A payload carrying neither key is Welt's bug, and the
 * error it raises is reported as an `error` event by the SDK.
 */
type WeltPayload =
  | { messages: WireMessage[] }
  | { interrupt_responses: Record<string, InterruptAnswer> };

// The files queued by `sendFile`, on their way to the Slack thread. One
// queue for the process, like the interrupt slot is one per handler:
// AgentCore Runtime serves each session from its own microVM, so no other
// reply's files can interleave with the running one's.
const pendingFiles: FileEvent[] = [];

/**
 * Queue one file for the Slack thread, beside the reply being streamed.
 *
 * The file rides the wire between the events of the running reply, and
 * never reaches the model. A tool that wants the model to know what the
 * file holds says so in its result — or returns the file as an
 * image/document/video content block and is named in `filesFrom`, which
 * puts it in front of the model and on the thread both.
 *
 * A file queued by a turn that failed before draining does not ride a
 * later reply: the handler starts every turn with the queue empty.
 *
 * @param name - The upload filename, extension included.
 * @param data - The raw file bytes.
 * @throws TypeError if the name or the data is of the wrong type.
 * @throws Error if either is empty. Slack refuses a zero-byte upload, and
 *   the whole reply fails with it, so an empty file is refused here,
 *   where the tool that queued it is still on the stack.
 */
export function sendFile(name: string, data: Uint8Array): void {
  pendingFiles.push({
    file: {
      name: checkedName(name),
      bytes: Buffer.from(checkedData(data)).toString("base64"),
    },
  });
}

/** Check an upload filename. */
function checkedName(name: unknown): string {
  if (typeof name !== "string") {
    throw new TypeError(`name must be a string, not ${typeof name}`);
  }
  if (name.length === 0) {
    throw new Error("name must not be empty");
  }
  return name;
}

/** Check a file's bytes. */
function checkedData(data: unknown): Uint8Array {
  if (!(data instanceof Uint8Array)) {
    throw new TypeError("data must be a Uint8Array");
  }
  if (data.length === 0) {
    throw new Error("data must not be empty; Slack refuses an empty upload");
  }
  return data;
}

/** Take every queued file off the queue, in order, as SSE frames. */
function* drainedFrames(): Generator<DataFrame, void, undefined> {
  for (const file of pendingFiles.splice(0, pendingFiles.length)) {
    yield { data: file };
  }
}

/**
 * Build the AgentCore Runtime invocation handler for an agent Welt drives.
 *
 * The returned object is what `BedrockAgentCoreApp` takes:
 *
 * ```ts
 * const app = new BedrockAgentCoreApp({
 *   invocationHandler: weltAgent(newAgent, { filesFrom: ["generate_image"] }),
 * });
 * ```
 *
 * It reads which envelope Welt sent — Converse-shaped `messages` for a
 * conversation turn, `interrupt_responses` for the answers that resume an
 * interrupted run — drives the agent, and yields the events Welt renders,
 * the files tools queued with `sendFile` among them.
 *
 * @param newAgent - Builds the Agent of one conversation turn. Called on
 *   every turn, so each turn runs on the messages Welt sends and nothing
 *   carried over — except an interrupted run, which resumes on the Agent
 *   that raised the interrupt.
 * @param options - `filesFrom`: the names of the tools whose files become
 *   `file` events.
 * @returns The invocation handler. Resuming a run its microVM no longer
 *   holds throws, which the AgentCore Runtime SDK reports as an `error`
 *   event and Welt renders as its resume-failure notice.
 */
export function weltAgent(
  newAgent: () => StreamingAgent,
  options?: WeltAgentOptions,
): InvocationHandler {
  const filesFrom = [...(options?.filesFrom ?? [])];
  let interruptedAgent: StreamingAgent | null = null;

  /**
   * Reduce one agent stream to SSE frames, re-stashing the agent
   * whenever the stream stops for human input so a resume that
   * interrupts again keeps working.
   */
  async function* relayed(
    agent: StreamingAgent,
    events: AsyncIterable<AgentStreamEvent>,
  ): AsyncGenerator<DataFrame, void, undefined> {
    let interrupted = false;
    for await (const event of renderableEvents(events, { filesFrom })) {
      if ("interrupt" in event) {
        interrupted = true;
      }
      yield { data: event };
      yield* drainedFrames();
    }
    // Files a tool queued after its result's events had already drained —
    // the stream's tail — still belong to this reply.
    yield* drainedFrames();
    if (interrupted) {
      interruptedAgent = agent;
    }
  }

  return {
    async *process(payload: unknown) {
      // A failed turn's leftovers stay off this reply.
      pendingFiles.length = 0;
      const envelope = payload as WeltPayload;

      if ("interrupt_responses" in envelope) {
        const agent = interruptedAgent;
        interruptedAgent = null;
        if (agent === null) {
          // The microVM was recycled while the buttons waited.
          throw new Error("No interrupted agent to resume in this session.");
        }
        const responses = decodeInterruptResponses(
          envelope.interrupt_responses,
        );
        yield* relayed(agent, agent.stream(responses));
        return;
      }

      const agent = newAgent();
      yield* relayed(agent, agent.stream(decodeMessages(envelope.messages)));
    },
  };
}
