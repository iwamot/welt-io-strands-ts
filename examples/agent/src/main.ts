/**
 * A small AgentCore agent that Welt can drive.
 *
 * Receives Welt's payload, feeds it to a Strands agent, and streams back
 * the renderable subset of its `stream()` events — BedrockAgentCoreApp
 * emits each one as SSE, which Welt (https://github.com/iwamot/welt)
 * renders into Slack. `startReply` reads which
 * envelope Welt sent (a conversation turn, or the answers that resume an
 * interrupted run) and drives the Agent this file hands it.
 *
 * Which Agent that is, this file decides — including keeping an
 * interrupted run in S3 until its buttons are answered, below, so that the
 * answers can resume it wherever they arrive.
 *
 * This example is a standalone deployable; Welt drives it only through
 * the JSON wire contract, which @welt-io/strands adapts in both
 * directions.
 */

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  Agent,
  BedrockModel,
  type LocalAgent,
  type Snapshot,
  tool,
} from "@strands-agents/sdk";
import {
  interruptReason,
  renderableEvents,
  startReply,
} from "@welt-io/strands";
import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";
import { z } from "zod";

// The model is the one place that decides which Bedrock endpoint, API, and
// region the agent talks to; nothing else in this file depends on that
// choice. BedrockModel speaks Converse to bedrock-runtime, so MODEL_ID takes
// any Converse model there. BEDROCK_REGION sends the model calls to a region
// of their own; unset, they go where the AWS SDK resolves one. `||`, not
// `??`: an empty value means unset, like Welt's own variables.
const model = new BedrockModel({
  modelId: process.env.MODEL_ID || "global.anthropic.claude-sonnet-4-6",
  ...(process.env.BEDROCK_REGION ? { region: process.env.BEDROCK_REGION } : {}),
});

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

// Draft bodies by tool use id, kept in the agent's state and dropped as
// soon as their tool call is answered.
type DraftState = { drafts: Record<string, string> };

/**
 * Draft the report body once per tool call.
 *
 * Memoized rather than plain: Strands re-executes an interrupted tool from
 * its start on resume, and drafting is the kind of work that must not run
 * twice — a redraft (timestamped here to make that visible) would silently
 * publish something other than what the human approved. The tool use id is
 * the same on both passes, and the drafts live in the agent's state, which
 * is held and restored with the interrupt state it pairs with.
 */
function draftedReport(
  agent: LocalAgent,
  toolUseId: string,
  topic: string,
): string {
  const drafts = agent.appState.get<DraftState>("drafts") ?? {};
  const drafted = drafts[toolUseId];
  if (drafted !== undefined) {
    return drafted;
  }
  const draft =
    `# ${topic}\n\nEverything about ${topic} is going well.\n\n` +
    `_Drafted at ${new Date().toISOString()}._\n`;
  agent.appState.set("drafts", { ...drafts, [toolUseId]: draft });
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
    const draft = draftedReport(context.agent, toolUseId, input.topic);
    const answer = context.interrupt<string>({
      name: "example-draft-report-approval",
      reason: interruptReason({
        message: `May I publish this draft?\n\n\`\`\`\n${draft}\`\`\``,
        options: [{ value: "Publish", style: "primary" }, { value: "Discard" }],
        input: { label: "Or type your answer" },
      }),
    });
    const { [toolUseId]: _answered, ...rest } =
      context.agent.appState.get<DraftState>("drafts") ?? {};
    context.agent.appState.set("drafts", rest);
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
    model,
    tools: [
      currentTime,
      createSampleFile,
      sampleDangerousAction,
      sampleDraftReport,
    ],
    printer: false,
  });
}

// The interrupted runs, held in S3 under the ids of the interrupts they
// raised — Welt sends those ids back when the buttons are answered, and the
// request that carries them may reach another process or machine than the
// one that stopped.
const bucket = process.env.SESSION_BUCKET;
if (!bucket) {
  throw new Error(
    "SESSION_BUCKET must name the bucket that holds interrupted runs.",
  );
}
// The bucket may be in another region than the agent; follow S3 there.
const s3 = new S3Client({ followRegionRedirects: true });

function heldKey(interruptId: string): string {
  return `interrupted/${interruptId}.json`;
}

/**
 * Keep a stopped run until its interrupts are answered.
 *
 * The snapshot carries the run's messages, its state and where it stopped;
 * the tools and the model are this file's, and are built again on resume.
 * Every id of the stop gets the same snapshot, since the answers name any
 * of them.
 */
async function hold(agent: Agent, interruptIds: string[]): Promise<void> {
  const snapshot = agent.takeSnapshot({
    preset: "session",
    appData: { interruptIds },
  });
  const body = JSON.stringify(snapshot);
  await Promise.all(
    interruptIds.map((id) =>
      s3.send(
        new PutObjectCommand({ Bucket: bucket, Key: heldKey(id), Body: body }),
      ),
    ),
  );
}

/** Read the snapshot held under an interrupt id, if one is held. */
async function heldBody(interruptId: string): Promise<string | undefined> {
  try {
    const held = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: heldKey(interruptId) }),
    );
    return await held.Body?.transformToString();
  } catch (error) {
    if (error instanceof NoSuchKey) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Take the held run the answered interrupts belong to.
 *
 * A stop's questions are answered together, so every id in one payload
 * names the same run, and the whole stop is dropped here. An answered id
 * no longer held means the run was answered already or cleared, and there
 * is nothing to resume.
 */
async function resumed(answers: Record<string, unknown>): Promise<Agent> {
  for (const answeredId of Object.keys(answers)) {
    const body = await heldBody(answeredId);
    if (body === undefined) {
      continue;
    }
    const snapshot: Snapshot = JSON.parse(body);
    const agent = newAgent();
    agent.loadSnapshot(snapshot);
    const stoppedIds = snapshot.appData.interruptIds as string[];
    await Promise.all(
      stoppedIds.map((id) =>
        s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: heldKey(id) })),
      ),
    );
    return agent;
  }
  throw new Error("No interrupted agent to resume in this session.");
}

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    async *process(payload: unknown) {
      const envelope = payload as {
        interrupt_responses?: Record<string, unknown>;
      };
      const answers = envelope.interrupt_responses;
      const agent = answers === undefined ? newAgent() : await resumed(answers);

      const interruptIds: string[] = [];
      for await (const event of renderableEvents(startReply(agent, payload), {
        filesFrom: FILES_FROM,
      })) {
        if ("interrupt" in event) {
          interruptIds.push(event.interrupt.id);
        }
        // The AgentCore Runtime SDK puts a yielded object's `data` field
        // on the SSE `data:` line.
        yield { data: event };
      }
      if (interruptIds.length > 0) {
        await hold(agent, interruptIds);
      }
    },
  },
});

// Lambda Web Functions name the address to serve on, as host:port; AgentCore
// Runtime, and a local run, take the SDK's default of port 8080.
const lambdaEndpoint = process.env.AWS_LAMBDA_HTTP_ENDPOINT;
if (lambdaEndpoint) {
  const colon = lambdaEndpoint.lastIndexOf(":");
  app.run({
    host: lambdaEndpoint.slice(0, colon),
    port: Number(lambdaEndpoint.slice(colon + 1)),
  });
} else {
  app.run();
}
