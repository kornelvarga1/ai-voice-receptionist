const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { renderPrompt } = require("./render");

const notifyConfig = JSON.parse(
  fs.readFileSync(path.join(__dirname, "notify-config.json"), "utf8")
);

// Agent-level webhook (call_started/call_ended/call_analyzed) — logs every call
// to voice_demo_calls so a prospect who calls but never replies still shows up
// as an interest signal. Fixed URL, no per-client secret needed (auth is via
// Retell's own HMAC signature, same as voice-inbound-webhook). Set here at
// agent-creation time so it survives the LLM-lock-triggered recreate path too.
const CALL_WEBHOOK_URL = "https://zfmchywjmgykmlhjihls.supabase.co/functions/v1/voice-call-webhook";

// Turn-taking defaults. Retell's out-of-the-box values are tuned for a quiet
// line with a cooperative caller; on a real contractor call — truck noise, a
// speakerphone in a garage, someone who talks over you — the default
// interruption_sensitivity of 1 treats background sound as a barge-in and
// truncates the agent mid-word. The 2026-09-12 Clearway call is what this
// fixes: the agent's last six turns came out as "Thanks" / "Great" / "Sorry,
// I didn't" / "Sorry," and the caller hung up. See AGENT-FIXES.md.
//
// Applied at create time here, and backfilled onto existing agents by
// scripts/tune-agents.js (a published agent can't be PATCHed directly).
const AGENT_TUNING = {
  interruption_sensitivity: 0.5,
  responsiveness: 0.9,
  enable_backchannel: false,
  reminder_trigger_ms: 12000,
  reminder_max_count: 1,
  stt_mode: "accurate",
  denoising_mode: "noise-cancellation",
};

function retell(args) {
  // shell:true is required on Windows to invoke the retell.cmd shim; to avoid
  // cmd.exe metacharacter issues (&, parens, etc.) in arguments like business
  // names, every call here passes data via -f <jsonfile> rather than raw flags.
  const out = execFileSync("retell", args, { encoding: "utf8", shell: true });
  return JSON.parse(out);
}

function main() {
  const clientArg = process.argv[2];
  if (!clientArg) {
    console.error("Usage: node deploy.js <client-config.json>");
    process.exit(1);
  }

  const clientConfigPath = path.resolve(clientArg);
  const { client, prompt } = renderPrompt(clientConfigPath);

  const llmBody = {
    general_prompt: prompt,
    model: "gpt-4.1",
    begin_message: client.begin_message,
  };
  const tmpFile = path.join(os.tmpdir(), `retell-llm-${client.slug}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(llmBody, null, 2));

  if (client.llm_id) {
    console.log(`Updating existing LLM ${client.llm_id}...`);
    try {
      retell(["llms", "update", client.llm_id, "-f", tmpFile]);
    } catch (e) {
      if (String(e.message).includes("Cannot update published LLM")) {
        // A published LLM/agent pair can't be hot-edited in place — Retell has
        // no "create draft version" path for retell-llm via this CLI, so the
        // pragmatic fix while iterating on copy is to replace the pair outright.
        console.log("LLM is published and locked — deleting old LLM + agent and recreating...");
        try {
          retell(["agents", "delete", client.agent_id]);
        } catch (_) {}
        try {
          retell(["llms", "delete", client.llm_id]);
        } catch (_) {}
        client.llm_id = null;
        client.agent_id = null;
        const llm = retell(["llms", "create", "-f", tmpFile]);
        client.llm_id = llm.llm_id;
        console.log(`Recreated LLM ${client.llm_id}`);
      } else {
        throw e;
      }
    }
  } else {
    console.log("Creating new LLM...");
    const llm = retell(["llms", "create", "-f", tmpFile]);
    client.llm_id = llm.llm_id;
    console.log(`Created LLM ${client.llm_id}`);
  }

  let justCreatedAgent = false;
  if (client.agent_id) {
    console.log(`Agent ${client.agent_id} already exists — prompt content updated via LLM above.`);
  } else {
    justCreatedAgent = true;
    console.log("Creating new agent...");
    const agentBody = {
      agent_name: `${client.business_name} Receptionist (demo)`,
      voice_id: client.voice_id,
      response_engine: { type: "retell-llm", llm_id: client.llm_id },
      webhook_url: CALL_WEBHOOK_URL,
      ...AGENT_TUNING,
    };
    const agentTmpFile = path.join(os.tmpdir(), `retell-agent-${client.slug}.json`);
    fs.writeFileSync(agentTmpFile, JSON.stringify(agentBody, null, 2));
    const agent = retell(["agents", "create", "--voice", client.voice_id, "-f", agentTmpFile]);
    client.agent_id = agent.agent_id;
    console.log(`Created agent ${client.agent_id}`);
  }

  fs.writeFileSync(clientConfigPath, JSON.stringify(client, null, 2) + "\n");

  if (justCreatedAgent) {
    console.log("\nFreshly created agent is already live at version 0 — no publish step needed.");
  } else {
    console.log("\nPublishing draft changes...");
    try {
      retell(["agents", "publish", client.agent_id]);
      console.log("Published.");
    } catch (e) {
      console.log("Publish skipped (likely no draft changes to publish):", e.message);
    }
  }

  if (client.phone_number) {
    console.log(`\nRe-binding ${client.phone_number} to agent ${client.agent_id} (in case the agent was just recreated)...`);
    retell(["phone-numbers", "update", client.phone_number, "--inbound-agent", client.agent_id]);
  }

  if (justCreatedAgent && client.business_id) {
    console.log(
      `\nWARNING: Agent was (re)created — voice_agents.retell_agent_id for business_id ${client.business_id} ` +
      `needs updating to ${client.agent_id} or the voice-call-webhook business_id lookup will silently miss.`
    );
  }

  if (client.business_id) {
    const tools = [
      { name: "notify_contractor", template: "notify_tool_template.json", url: notifyConfig.supabaseFunctionsUrl },
      { name: "check_availability", template: "check_availability_tool_template.json", url: notifyConfig.checkAvailabilityUrl },
      { name: "book_appointment", template: "book_appointment_tool_template.json", url: notifyConfig.bookAppointmentUrl },
      { name: "send_confirmation_email", template: "send_confirmation_email_tool_template.json", url: notifyConfig.sendConfirmationUrl },
    ];

    const existingTools = retell(["tools", "list", client.agent_id]);
    const existingNames = new Set((existingTools.general_tools || []).map((t) => t.name));

    for (const tool of tools) {
      console.log(`\nEnsuring ${tool.name} tool is present...`);
      const toolTemplate = fs.readFileSync(path.join(__dirname, tool.template), "utf8");
      const toolBody = toolTemplate
        .replaceAll("__URL__", tool.url)
        .replaceAll("__BUSINESS_ID__", client.business_id)
        .replaceAll("__WEBHOOK_SECRET__", notifyConfig.webhookSecret);
      const toolTmpFile = path.join(os.tmpdir(), `retell-tool-${client.slug}-${tool.name}.json`);
      fs.writeFileSync(toolTmpFile, toolBody);

      if (existingNames.has(tool.name)) {
        retell(["tools", "update", client.agent_id, tool.name, "-f", toolTmpFile]);
        console.log(`Updated existing ${tool.name} tool.`);
      } else {
        retell(["tools", "add", client.agent_id, "-f", toolTmpFile]);
        console.log(`Added ${tool.name} tool.`);
      }
    }

    try {
      retell(["agents", "publish", client.agent_id]);
    } catch (_) {
      // Same cosmetic empty-body JSON parse error as the publish call above.
    }
  }

  console.log(`\nDone. Dashboard: https://dashboard.retellai.com/agents/${client.agent_id}`);
  console.log("Use the dashboard's Test Call button to talk to it in-browser, or:");
  console.log(`  retell calls create-web --agent-id ${client.agent_id}`);
}

main();
