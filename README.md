# @welt-io/strands

[![npm](https://img.shields.io/npm/v/%40welt-io%2Fstrands.svg)](https://www.npmjs.com/package/@welt-io/strands)
[![node](https://img.shields.io/node/v/%40welt-io%2Fstrands.svg)](https://www.npmjs.com/package/@welt-io/strands)
[![@strands-agents/sdk](https://img.shields.io/npm/dependency-version/%40welt-io%2Fstrands/peer/%40strands-agents%2Fsdk.svg)](https://www.npmjs.com/package/@strands-agents/sdk)

The [Strands Agents](https://strandsagents.com/) (TypeScript) adapter for [Welt](https://github.com/iwamot/welt)'s wire contract.

## Install

```bash
npm install @welt-io/strands
```

`@strands-agents/sdk` comes with it as a peer dependency: the messages this package builds and the stream events it reads are the SDK's own types.

## Usage

`weltAgent` builds the whole AgentCore Runtime invocation handler for an agent Welt drives, so a deployable is your agent plus one mount line:

```ts
import { Agent } from "@strands-agents/sdk";
import { weltAgent } from "@welt-io/strands/agentcore";
import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";

const app = new BedrockAgentCoreApp({
  invocationHandler: weltAgent(() => new Agent({ printer: false })),
});

app.run();
```

See [`examples/agent`](examples/agent) for the full version — the smallest complete agent built on this package (text streaming, tool use, file output, file input, and human-approval tools). The sections below cover the handler and the adapters it wires in.

## Supported Versions

### Welt

While both are 0.x, a @welt-io/strands 0.Y release supports Welt v0.Y. From 1.0 on, a release supports any Welt release that shares its major version, and the minor versions move independently. Support is best effort either way, and other combinations come with no guarantee.

### Strands Agents

The badge at the top states the range this release installs against. Every push and pull request runs the suite at both ends of it: the declared floor, and the newest release CI has picked up. That is best effort rather than a guarantee — the floor is where the suite was last seen to pass, so a later release may raise it, and no ceiling is declared at all.

The badge follows the current release. For the range an older release declared, read that release's own metadata on npm.

Something misbehaving inside that range is worth an [issue](https://github.com/iwamot/welt-io-strands-ts/issues).

## API

The wire between Welt and the agent is JSON, specified by [Welt's wire contract](https://github.com/iwamot/welt/blob/main/docs/wire.md). Strands speaks nearly the same shapes, but not exactly, in either direction. Two functions adapt the inbound payload, two the outbound stream. `weltAgent` wires the three of them the handler needs (`interruptReason` serves the tools themselves); reach for the pieces directly when your handler needs a shape of its own.

### Handler

#### `weltAgent(newAgent, { filesFrom })`

Builds the invocation handler `BedrockAgentCoreApp` takes. It reads which envelope Welt sent — Converse-shaped `messages` for a conversation turn, `interrupt_responses` for the answers that resume an interrupted run — drives the agent, and yields the events Welt renders, each wrapped as the SSE frame the AgentCore Runtime SDK emits.

Every turn runs on a fresh Agent from `newAgent`: the Slack thread is the source of truth for conversation history, and the messages Welt sends carry it whole. An interrupted Agent waits inside the handler for its answers — one slot, resume-only, living and dying with the session's microVM (recycled on idle timeout, 8 hours at most); resuming after that throws, which Welt renders as its resume-failure notice. `filesFrom` passes through to `renderableEvents` below.

#### `sendFile(name, data)`

Queues one file for the Slack thread from inside a tool, riding the wire beside the reply being streamed. The model never sees it — a tool whose file matters to the conversation says what it holds in its result, or returns it as a content block and is named in `filesFrom`, which puts it in front of the model and on the thread both. Every turn starts with the queue empty, so a file a failed turn left behind never rides a later reply, and an empty name or empty bytes is refused where the tool is still on the stack — Slack refuses a zero-byte upload, and the whole reply fails with it.

### Inbound

#### `decodeMessages(messages)`

Turns Welt's Converse-shaped messages — built from the Slack thread, file bytes base64-encoded — into the messages Strands consumes. The block shapes already match; what changes is the encoding: the image/document/video bytes decode to the raw `Uint8Array` the SDK holds, and the wire's `three_gp` video token becomes the SDK's `3gp`. The result feeds `Agent.stream()`:

```ts
const agent = new Agent({ tools });
const stream = agent.stream(decodeMessages(payload.messages));
```

#### `decodeInterruptResponses(responses)`

Turns Welt's resume payload — a mapping of interrupt id to the answer a human chose and the widget it came from — into the `interruptResponse` content items Strands resumes from. The answer travels on as the value it was given; the widget it came from is Welt's vocabulary, and a tool that reads its own option values already knows which of them it declared. The returned list feeds `Agent.stream()` on the interrupted `Agent` instance directly — `weltAgent` keeps that instance around for you, and a handler of your own does the same.

#### What arrives is taken as correct

Welt builds the payload and checks its own output against the wire contract before releasing it, so these two functions do no field validation of their own. Their parameter types — `WireMessage[]` and `Record<string, string>` — say what arrives, and the payload is asserted to be Welt's where it enters — `weltAgent` does this at its door, and a handler of your own does the same. A payload that departs from the contract is a bug on the sending side rather than an input to guard against, and it surfaces as an ordinary error from whatever touches it first — `decodeMessages` decodes the file bytes, so bytes that are not base64 throw a `DOMException` there.

The one thing `decodeMessages` refuses outright is a content block of a kind Welt never sends. A `messages` turn carries only `text`, `image`, `document`, and `video` blocks; a `toolUse` or `toolResult` block is not a malformed one of those but a forged conversation turn, and rebuilt into history it would let a caller that is not Welt put words the model treats as its own past tool calls and their results into the run. It throws an `Error`. This is a trust-boundary check, not the field validation the contract otherwise saves you from.

### Outbound

#### `renderableEvents(events, { filesFrom })`

Reduces the events of `Agent.stream()` — objects Welt does not render — to the events Welt renders:

| Strands emits | On the wire | In the Slack thread |
|---|---|---|
| Text deltas | `data` | The streamed reply |
| Tool-use starts and tool results | `current_tool_use` / `tool_result` | "Using tool" indicators (tool output stays off the wire) |
| Image/document/video blocks the assistant message carries, or a tool named in `filesFrom` returns | `file` | An uploaded file ([size limits](https://github.com/iwamot/welt/blob/main/docs/wire.md#limits)) |
| Interrupts pending in the final result | `interrupt` | Buttons and/or a text field |

A run that stops for human input ends its stream with one `interrupt` event per pending interrupt — a faithful copy of the interrupt's id, name, and reason, the reason passed through unmodified since interpreting it is the renderer's job. Agents that do not interrupt see no change. To ask for human input from a tool, call `ToolContext.interrupt` with a reason built by `interruptReason` below; on resume, the same call returns the human's answer.

**Code before `interrupt` runs again on resume.** Strands re-executes the interrupted tool from its start, so whatever precedes an interrupt and must not run twice — side effects, or work that must match what the human approved — has to be skipped on the second pass. Memoizing on `context.toolUse.toolUseId`, the same id on both passes, is enough: the cache lives in the same process as the interrupt state it pairs with. The [example agent](examples/agent)'s `sample_draft_report` shows the pattern.

A tool hands files to the model for either of two reasons — to have it read them, or to give them to the human — and only the agent knows which is which, so name the tools whose files belong in the thread:

```ts
for await (const event of renderableEvents(stream, {
  filesFrom: ["create_sample_file"],
})) {
```

A tool left out keeps its files to the model: one that reads a PDF for the model does not drop it into the thread as a side effect. A tool named there needs no helper — return an image, document, or video content block and `renderableEvents` turns it into a `file` event (the [example agent](examples/agent)'s `create_sample_file` shows this).

Uploaded names come from the block — a document's own `name` plus its format, the block's kind for the rest (`image.png`). That name is the model's handle on the document as much as a filename, and Converse rejects a request whose messages carry two documents under one name, so a tool that returns documents has to keep their names apart across the run: the example appends a short uuid to each.

Each event carries only what Welt reads — a `current_tool_use` is the name and id behind the indicator, a `tool_result` the id and status — so tool arguments and tool output stay off the wire. An event with nothing to render is not sent at all: a text chunk the model left empty, a block whose file lives elsewhere (in S3, behind a URL, or as text of its own) rather than in bytes the block carries, and a file whose bytes are empty, which Slack refuses and fails the whole reply with. The empty file leaves a [process warning](https://nodejs.org/api/process.html#event-warning) behind, naming what returned it.

#### `interruptReason(spec)`

Builds the structured reason Welt renders as a message with the specified widgets — the approve and reject buttons Welt words and values itself (`approve`, `reject`), choice buttons of your own (`options`), a free-text field (`input`), or any combination. `approve` and `reject` answer with `true` and `false`, so a question whose decision is approval asks for them by name instead of inventing values; `{}` takes Welt's wording, and a `label` or `style` overrides it. An option's `value` is any JSON value, and the pressed button answers with it as it was declared. With no widget at all the message renders as itself and Welt's default buttons answer it. The specs are [the wire's own shapes](https://github.com/iwamot/welt/blob/main/docs/wire.md#interrupt), typed as `ReasonSpec` over `DecisionSpec`, `OptionSpec`, and `InputSpec`, and omitted fields keep Welt's defaults:

```ts
const answer = context.interrupt<boolean | string>({
  name: "prod-deploy-approval",
  reason: interruptReason({
    message: "Deploy to prod?",
    approve: { label: "Deploy" },
    reject: { label: "Cancel" },
    input: { label: "Or type your answer" },
  }),
});
```

Building the reason through this helper is what makes a typo an error. `ToolContext.interrupt` takes its reason as `JSONValue`, so an object literal handed to it directly is checked for being JSON and nothing more, and Welt's reaction to a reason it cannot match is its default buttons — no error, no log, just widgets you did not ask for. The typed parameters catch a misspelled key before the run; the checks inside catch it in the runs the types miss, since TypeScript's excess-property check fires on an object literal written at the call site and not on one that reached it through a variable. A wrong type throws a `TypeError`, an unknown key or an empty required string an `Error`. What they check is the shape, not the size: how many buttons one Slack block holds, and how long a button value may be, are Welt's to enforce.

[Welt's Interrupts doc](https://github.com/iwamot/welt/blob/main/docs/interrupts.md) covers the Slack side: how each reason renders, who can answer, multiple questions, and expiry. On the Strands side:

- **Prefix your interrupt names** (`myapp-deploy-approval`) — names must stay unique as the agent grows, and a prefix keeps collisions out.
- **Strands' ready-made [`HumanInTheLoop`](https://strandsagents.com/docs/user-guide/concepts/agents/interventions/human-in-the-loop/) intervention works over Welt as-is** (`import { HumanInTheLoop } from "@strands-agents/sdk/vended-interventions/hitl"`). Its string reasons render with Welt's default buttons, and its default evaluator reads the `true` they answer with as approval. Do not pass `ask`: both of its inline modes block the agent waiting for input that Slack can never deliver — the default interrupt/resume mode is the one Welt drives.

## License

MIT
