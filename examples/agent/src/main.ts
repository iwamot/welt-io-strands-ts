/**
 * A small AgentCore agent that Welt can drive.
 *
 * Receives Welt's payload, feeds it to a Strands agent, and streams back
 * the renderable subset of its `stream()` events — BedrockAgentCoreApp
 * emits each one as SSE, which Welt (https://github.com/iwamot/welt)
 * renders into Slack. `weltAgent` is the whole connection: it reads which
 * envelope Welt sent (a conversation turn, or the answers that resume an
 * interrupted run), drives the agent, and keeps an interrupted run until
 * its answers arrive.
 *
 * This example is a standalone deployable; Welt drives it only through
 * the JSON wire contract, which @welt-io/strands adapts in both
 * directions.
 */

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { Agent, tool } from "@strands-agents/sdk";
import { interruptReason } from "@welt-io/strands";
import { weltAgent } from "@welt-io/strands/agentcore";
import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";
import { z } from "zod";

const currentTime = tool({
  name: "current_time",
  description: "Get the current date and time.",
  callback: () => new Date().toISOString(),
});

/**
 * Name a document apart from every other document of the run.
 *
 * Converse rejects a request whose messages carry two documents under one
 * name, and the tool that returns a document is the only one placed to
 * keep it apart — it cannot know what the rest of the run named theirs,
 * so it pays the going price of a random tail. The name is the model's
 * handle on the document, and the filename Welt uploads it under.
 */
function documentName(stem: string): string {
  return `${stem}-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

const createSampleFile = tool({
  name: "create_sample_file",
  description: "Create a small sample CSV file.",
  callback: () => {
    // The document block reaches the model, and the Slack thread because
    // the entrypoint takes files from this tool.
    const csv = Buffer.from("fruit,count\napple,3\nbanana,5\n");
    const name = documentName("sample");
    return [
      { text: `Created ${name}.csv.` },
      {
        document: {
          name,
          format: "csv",
          source: { bytes: csv.toString("base64") },
        },
      },
    ];
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
  // by typing an answer into the text field. Nothing is actually
  // executed.
  callback: (input, context) => {
    if (context === undefined) {
      throw new Error("This tool needs its execution context to interrupt.");
    }
    const answer = context.interrupt<string | boolean>({
      name: "example-dangerous-action-approval",
      reason: interruptReason({
        message: `May I run this dangerous action? — ${input.action}`,
        approve: {},
        reject: { label: "Cancel" },
        input: { label: "Or type your answer" },
      }),
    });
    if (answer === true) {
      return `Ran: ${input.action}. Completed successfully (simulated by this demo tool).`;
    }
    if (answer === false) {
      return "The action was cancelled by the user.";
    }
    return `The action was not run. The user answered: ${answer}`;
  },
});

// Draft bodies by tool use id, dropped as soon as their tool call is
// answered.
const drafts = new Map<string, string>();

/**
 * Draft the report body once per tool call.
 *
 * Memoized rather than plain: Strands re-executes an interrupted tool from
 * its start on resume, and drafting is the kind of work that must not run
 * twice — a redraft (timestamped here to make that visible) would silently
 * publish something other than what the human approved. The tool use id is
 * the same on both passes, and the cache outlives neither more nor less
 * than the interrupt state it pairs with: both live in this process.
 */
function draftedReport(toolUseId: string, topic: string): string {
  const drafted = drafts.get(toolUseId);
  if (drafted !== undefined) {
    return drafted;
  }
  const draft =
    `# ${topic}\n\nEverything about ${topic} is going well.\n\n` +
    `_Drafted at ${new Date().toISOString()}._\n`;
  drafts.set(toolUseId, draft);
  return draft;
}

const sampleDraftReport = tool({
  name: "sample_draft_report",
  description: "Draft a small report on a topic and ask whether to publish it.",
  inputSchema: z.object({
    topic: z.string().describe("The report topic."),
  }),
  // A sample of work before an interrupt: the draft is written first, then
  // the run pauses to show it for the publish decision. Approval returns
  // the approved draft as a markdown file.
  callback: (input, context) => {
    if (context === undefined) {
      throw new Error("This tool needs its execution context to interrupt.");
    }
    const toolUseId = context.toolUse.toolUseId;
    const draft = draftedReport(toolUseId, input.topic);
    const answer = context.interrupt<string>({
      name: "example-draft-report-approval",
      reason: interruptReason({
        message: `May I publish this draft?\n\n\`\`\`\n${draft}\`\`\``,
        options: [{ value: "Publish", style: "primary" }, { value: "Discard" }],
        input: { label: "Or type your answer" },
      }),
    });
    drafts.delete(toolUseId);
    if (answer === "Publish") {
      const name = documentName("report");
      return [
        {
          text:
            "The user answered the publish question in the thread by" +
            ` pressing Publish, so this draft is already published there as` +
            ` ${name}.md. The publish flow is complete; nothing is left to` +
            " approve.",
        },
        {
          document: {
            name,
            format: "md",
            source: { bytes: Buffer.from(draft).toString("base64") },
          },
        },
      ];
    }
    if (answer === "Discard") {
      return "The user discarded the draft; nothing was published.";
    }
    return `The draft was not published. The user answered: ${answer}`;
  },
});

// The tools whose files belong in the Slack thread. A tool left out keeps
// its files to the model — this agent has none, but an agent that reads
// documents for the model would.
const FILES_FROM = ["create_sample_file", "sample_draft_report"];

function newAgent(): Agent {
  return new Agent({
    // Any Converse model; unset falls back to the Strands default.
    // `||`, not `??`: an empty MODEL_ID means unset, like Welt's own
    // variables.
    ...(process.env.MODEL_ID ? { model: process.env.MODEL_ID } : {}),
    tools: [
      currentTime,
      createSampleFile,
      sampleDangerousAction,
      sampleDraftReport,
    ],
    printer: false,
  });
}

const app = new BedrockAgentCoreApp({
  invocationHandler: weltAgent(newAgent, { filesFrom: FILES_FROM }),
});

app.run();
