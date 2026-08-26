# Example Agent

The example agent for [Welt](https://github.com/iwamot/welt): the smallest complete agent that exercises the wire in both directions through @welt-io/strands.

## Stack

| Package | Role |
|---------|------|
| [Bedrock AgentCore SDK](https://github.com/aws/bedrock-agentcore-sdk-typescript) | Serves the endpoint |
| [Strands Agents SDK](https://strandsagents.com/) | Runs the model and the tools |
| @welt-io/strands | Adapts the wire to Welt |

## Run Locally

The agent runs on your machine as-is — [Welt's Quick Start](https://github.com/iwamot/welt#quick-start) starts here, before anything is deployed: the AgentCore SDK serves the same HTTP surface locally, on port 8080, that AgentCore Runtime serves in the cloud, and Welt's local mode invokes it there.

Fetch the agent and run it with Node.js 24, which runs TypeScript directly:

```sh
curl -O https://raw.githubusercontent.com/iwamot/welt-io-strands-ts/main/examples/agent/src/main.ts
echo '{"type":"module"}' > package.json
npm install @welt-io/strands @strands-agents/sdk zod bedrock-agentcore
MODEL_ID=global.anthropic.claude-sonnet-4-6 node main.ts
```

The process needs AWS credentials and a region the standard SDK way — environment variables, `AWS_PROFILE`, an SSO session — because the model runs on Amazon Bedrock. `MODEL_ID` takes any Converse model with access enabled in the Amazon Bedrock console; unset, the agent uses `global.anthropic.claude-sonnet-4-6`, the same id as above — enable access for it, or point `MODEL_ID` elsewhere.

One difference from the cloud: AgentCore Runtime gives every session its own microVM, while the local server is a single process for all sessions — the interrupted agents this example keeps all share that one process, outlive the session that raised them, and accumulate while unanswered until the process exits.

## Deploy

Deploy with the [AgentCore CLI](https://github.com/aws/agentcore-cli):

```sh
agentcore create --name WeltExample --no-agent
cd WeltExample
agentcore add agent --name WeltExample --type create --build CodeZip --language TypeScript --framework Strands --model-provider Bedrock --memory none

curl -o app/WeltExample/main.ts https://raw.githubusercontent.com/iwamot/welt-io-strands-ts/main/examples/agent/src/main.ts
# @strands-agents/sdk's context-offloader imports @aws-sdk/client-s3, which the CodeZip bundle does not mark external
npm --prefix app/WeltExample install @welt-io/strands zod @aws-sdk/client-s3

agentcore deploy
```

`agentcore status` reports the agent runtime ARN: Welt's `AGENT_ARN` points at it.

The CLI has no teardown command — removing the deployment means deleting the CloudFormation stack it created, `AgentCore-WeltExample-default`.

## Tools

- `current_time` — the minimal tool: plain text streaming, nothing else. Ask "what time is it?" to see tool use in the thread.
- `create_sample_file` — writes a small CSV and returns it as a document block, which the model reads and Welt uploads to the thread. Its name carries a random tail (`sample-3f2a1b9c.csv`) because a document's name has to be unique across the run. Ask it for a sample file.
- `sample_dangerous_action` — a pretend dangerous action (no side effects, no extra AWS permissions) that pauses for human approval: Welt renders the pause as **Approve** / **Cancel** buttons plus a free-text field in the Slack thread, and whichever answer comes first — a press, or typed text — resumes the run. Ask "deploy to prod", then press a button or type something like "not now". See [Welt's Interrupts doc](https://github.com/iwamot/welt/blob/main/docs/interrupts.md) for the round trip.
- `sample_draft_report` — drafts a small report, pauses to show it for approval, and on approval returns it as a markdown file (`report-8f3a2c1d.md`, tailed for the same reason). Drafting before the pause is the Strands interrupt pitfall: an interrupted tool re-executes from its start on resume, so the drafting is memoized on the tool use id and the published file stays identical to the approved draft. The draft is timestamped, so a silent redraft would show. Ask "draft a report about apples", then answer the buttons.

The two that produce files are named in the entrypoint's `filesFrom` — that is what puts their files in the thread, and a tool left out of it would hand its files to the model alone.

## Optional: file input

The agent can also read files uploaded to Slack — disabled by default. To try it, set in Welt's `.env`:

```sh
FILE_INPUT_MODALITIES=image,document
```

These two are what Claude models accept; `video` needs a model that takes video input — see [Welt's Files doc](https://github.com/iwamot/welt/blob/main/docs/files.md).
