/** Serve a Strands Harness agent through Welt's wire contract. */

import { tmpdir } from "node:os";
import { createHarness } from "@strands-agents/harness";
import { type Agent, BedrockModel, tool } from "@strands-agents/sdk";
import { renderableEvents, startReply } from "@welt-io/strands";
import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";

// AgentCore Runtime's writable directory also holds files created by the tools.
process.chdir(tmpdir());

const model = new BedrockModel({
  modelId: process.env.MODEL_ID || "global.anthropic.claude-sonnet-4-6",
  ...(process.env.BEDROCK_REGION ? { region: process.env.BEDROCK_REGION } : {}),
});

const currentTime = tool({
  name: "current_time",
  description: "Get the current UTC date and time in ISO 8601 format.",
  callback: () => new Date().toISOString(),
});

/** Build a fresh turn using the conversation history supplied by Welt. */
export async function newAgent(): Promise<Agent> {
  return createHarness({
    model,
    tools: [currentTime],
    builtinTools: ["shell", "read", "write", "edit", "web_fetch"],
    session: false,
    memory: false,
    skills: false,
    backgroundTasks: false,
    interventions: "ask",
    caching: false,
    printer: false,
  });
}

// Approval answers must resume the Agent that raised the interrupt. The map
// lasts for this process; a recycled Runtime session loses pending approvals.
const interrupted = new Map<string, Agent>();

function takeInterrupted(answers: Record<string, unknown>): Agent {
  const agent = Object.keys(answers)
    .map((id) => interrupted.get(id))
    .find((held) => held !== undefined);
  if (agent === undefined) {
    throw new Error("No interrupted agent to resume in this session.");
  }
  for (const [id, held] of interrupted) {
    if (held === agent) {
      interrupted.delete(id);
    }
  }
  return agent;
}

/** Stream a Harness reply or resume a pending tool approval. */
export async function* invoke(payload: unknown) {
  const envelope = payload as {
    interrupt_responses?: Record<string, unknown>;
  };
  const answers = envelope.interrupt_responses;
  const agent =
    answers === undefined ? await newAgent() : takeInterrupted(answers);

  for await (const event of renderableEvents(startReply(agent, payload))) {
    if ("interrupt" in event) {
      interrupted.set(event.interrupt.id, agent);
    }
    yield { data: event };
  }
}

if (import.meta.main) {
  const app = new BedrockAgentCoreApp({
    invocationHandler: { process: invoke },
  });
  app.run();
}
