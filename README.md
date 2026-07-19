# @welt-io/strands

[![npm](https://img.shields.io/npm/v/%40welt-io%2Fstrands.svg)](https://www.npmjs.com/package/@welt-io/strands)
[![node](https://img.shields.io/node/v/%40welt-io%2Fstrands.svg)](https://www.npmjs.com/package/@welt-io/strands)

The [Strands Agents](https://strandsagents.com/) (TypeScript) adapter for [Welt](https://github.com/iwamot/welt)'s wire contract — one of Welt's [agent-side adapters](https://github.com/iwamot/welt#agent-side-adapters), and the TypeScript counterpart of [welt-io](https://github.com/iwamot/welt-io), the Python Strands adapter.

## Install

```bash
npm install @welt-io/strands
```

## Usage

See [`examples/agent`](examples/agent) — the smallest complete agent built on this package (text streaming, tool use, file output, file input, and a human-approval tool). The sections below explain the adapters it wires in.

## API

The wire between Welt and the agent is JSON, specified by [Welt's wire contract](https://github.com/iwamot/welt/blob/main/docs/wire.md). Strands speaks nearly the same shapes, but not exactly, in either direction. Two functions adapt the inbound payload, three the outbound stream.

### Inbound

#### `decodeMessages(messages)`

Turns Welt's Converse-shaped messages — built from the Slack thread, file bytes base64-encoded — into the messages Strands consumes. The block shapes already match; what changes is the encoding: the image/document/video bytes decode to the raw `Uint8Array` the SDK holds, and the wire's `three_gp` video token becomes the SDK's `3gp`. Malformed entries are skipped. The result feeds `Agent.stream()`:

```ts
const agent = new Agent({ tools });
const stream = agent.stream(decodeMessages(payload.messages));
```

#### `decodeInterruptResponses(responses)`

Turns Welt's resume payload — a mapping of interrupt id to the answer a human chose — into the `interruptResponse` content items Strands resumes from. The returned list feeds `Agent.stream()` on the interrupted `Agent` instance directly (see the [example agent](examples/agent) for how the host app keeps that instance around).

### Outbound

#### `renderableEvents(events)`

Reduces the events of `Agent.stream()` — objects Welt does not render — to the events Welt renders:

| Strands emits | On the wire | In the Slack thread |
|---|---|---|
| Text deltas | `data` | The streamed reply |
| Tool-use starts and tool results | `current_tool_use` / `tool_result` | "Using tool" indicators (tool output stays off the wire) |
| Image/document/video blocks a tool returns or the assistant message carries | `file` | An uploaded file ([size limits](https://github.com/iwamot/welt/blob/main/docs/wire.md#limits)) |
| Interrupts pending in the final result | `interrupt` | Buttons and/or a text field |

A run that stops for human input ends its stream with one `interrupt` event per pending interrupt — a faithful copy of the interrupt's id, name, and reason, the reason passed through unmodified since interpreting it is the renderer's job. Agents that do not interrupt see no change. To ask for human input from a tool, call `ToolContext.interrupt` with a reason built by `interruptReason` below; on resume, the same call returns the human's answer.

#### `fileEvent(name, data)`

Builds the same `file` event from a filename and raw bytes, for attaching arbitrary files of your own — yield it from the host app alongside the reduced stream. From inside a tool, no helper is needed: return an image/document/video content block and `renderableEvents` turns it into a `file` event (the [example agent](examples/agent)'s `attach_sample_file` shows this).

#### `interruptReason(message, options, input)`

Builds the structured reason Welt renders as a message with the specified widgets — choice buttons (`options`), a free-text field (`input`), or both. The specs are [the wire's own shapes](https://github.com/iwamot/welt/blob/main/docs/wire.md#interrupt); omitted fields keep Welt's defaults, and a typo becomes an immediate `TypeError` instead of a silent fallback to Welt's default rendering:

```ts
const answer = context.interrupt<string>({
  name: "prod-deploy-approval",
  reason: interruptReason(
    "Deploy to prod?",
    [
      { value: "y", label: "Deploy", style: "primary" },
      { value: "n", label: "Cancel" },
    ],
    { label: "Or tell me what to do instead" },
  ),
});
```

[Welt's Interrupts doc](https://github.com/iwamot/welt/blob/main/docs/interrupts.md) covers the Slack side: how each reason renders, who can answer, multiple questions, and expiry.

## Supported Versions

Welt releases first; @welt-io/strands follows, mirroring the minor version. While both are 0.x, a @welt-io/strands 0.Y release supports Welt v0.Y — other combinations may work, but come with no guarantee.

## License

MIT
