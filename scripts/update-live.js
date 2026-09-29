/**
 * Push a changed prompt and/or agent settings to agents that are already live,
 * without deleting and recreating them.
 *
 *   node scripts/update-live.js                        # dry run, all clients
 *   node scripts/update-live.js --execute
 *   node scripts/update-live.js clients/x.json --execute
 *
 * Use this instead of deploy.js for any agent that has already taken a call.
 *
 * Why deploy.js can't do this: once an LLM has been used in a real call Retell
 * publishes it, and both `llms update` and `tools update` then fail with
 * "Cannot update published LLM" — the tools live on the LLM, so the whole
 * deploy path is blocked. deploy.js's fallback is to delete and recreate the
 * LLM + agent pair, which loses Retell-side call history, changes agent_id, and
 * orphans voice_agents.retell_agent_id (making voice-call-webhook log
 * business_id: null on every subsequent call).
 *
 * The sequence that avoids all of that, worked out 2026-09-13:
 *
 *   1. POST /create-agent-version  — branch a draft off the live agent version.
 *      This implicitly opens a matching DRAFT LLM version. That is the only
 *      moment the LLM becomes writable; there is no way to open one directly.
 *   2. PATCH /update-retell-llm    — no version param. It lands on the draft
 *      opened in step 1. Called without an open draft it returns
 *      "Cannot update published LLM".
 *   3. PATCH /update-agent?version=N — agent-level settings on the same draft.
 *   4. POST /publish-agent         — promotes the draft; the LLM version it
 *      points at goes live with it. Returns 200 with an empty body, which is
 *      normal.
 *
 * Do NOT publish via `retell agents publish <id> --version N`: commander treats
 * --version as its own global flag, so the CLI prints "1.10.0", exits 0, and
 * publishes nothing. A silent no-op that reads as success.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { renderPrompt } = require("./render");

// See AGENT-FIXES.md. Retell's defaults assume a quiet line and a cooperative
// caller; interruption_sensitivity 1 treats truck noise or a garage
// speakerphone as a barge-in and truncates the agent mid-word.
const AGENT_TUNING = {
  interruption_sensitivity: 0.5,
  responsiveness: 0.9,
  enable_backchannel: false,
  reminder_trigger_ms: 12000,
  reminder_max_count: 1,
  stt_mode: "accurate",
  denoising_mode: "noise-cancellation",
};

const API = "https://api.retellai.com";

function apiKey() {
  if (process.env.RETELL_API_KEY) return process.env.RETELL_API_KEY;
  const rc = path.join(os.homedir(), ".retellrc.json");
  if (fs.existsSync(rc)) return JSON.parse(fs.readFileSync(rc, "utf8")).apiKey;
  throw new Error("No Retell API key: set RETELL_API_KEY or run `retell login`");
}

async function api(method, route, body) {
  const res = await fetch(API + route, {
    method,
    headers: {
      Authorization: "Bearer " + apiKey(),
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text || null; }
  if (!res.ok || (data && data.status === "error")) {
    throw new Error(`${method} ${route}: ${String(text).slice(0, 300)}`);
  }
  return data;
}

const isTuned = (v) =>
  Object.entries(AGENT_TUNING).every(([k, want]) => v[k] === want);

// Retell leaves every published version flagged is_published and opens a fresh
// draft right after each publish, so what actually answers the phone is the
// highest-numbered published version — never simply the latest.
const liveVersion = (versions) => {
  const published = versions.filter((v) => v.is_published);
  return published.length
    ? published.reduce((a, b) => (b.version > a.version ? b : a))
    : null;
};

async function updateOne(configPath, execute) {
  const { client, prompt } = renderPrompt(path.resolve(configPath));
  const label = client.slug.padEnd(34);

  if (!client.agent_id || !client.llm_id) {
    console.log(`${label} not deployed yet — use deploy.js for the first push`);
    return;
  }

  const versions = await api("GET", `/get-agent-versions/${client.agent_id}`);
  const latest = versions.reduce((a, b) => (b.version > a.version ? b : a));
  const live = liveVersion(versions);
  if (!live) throw new Error("no published version to branch from");

  const liveLlm = await api(
    "GET",
    `/get-retell-llm/${client.llm_id}?version=${live.response_engine.version}`
  );
  const promptCurrent = liveLlm.general_prompt === prompt;
  const tuningCurrent = isTuned(live);

  if (promptCurrent && tuningCurrent) {
    console.log(`${label} already current (agent v${live.version}, llm v${liveLlm.version})`);
    return;
  }

  const what = [!promptCurrent && "prompt", !tuningCurrent && "tuning"]
    .filter(Boolean)
    .join(" + ");

  if (!execute) {
    console.log(`${label} would push ${what} (live agent v${live.version})`);
    return;
  }

  // Reuse an already-open draft if there is one, otherwise branch off live.
  let draft = latest.is_published ? null : latest;
  if (!draft) {
    draft = await api("POST", `/create-agent-version/${client.agent_id}`, {
      base_version: live.version,
    });
  }

  if (!promptCurrent) {
    await api("PATCH", `/update-retell-llm/${client.llm_id}`, {
      general_prompt: prompt,
      begin_message: client.begin_message,
      model: "gpt-4.1",
    });
  }
  await api("PATCH", `/update-agent/${client.agent_id}?version=${draft.version}`, AGENT_TUNING);
  await api("POST", `/publish-agent/${client.agent_id}`, { version: draft.version });

  const after = liveVersion(await api("GET", `/get-agent-versions/${client.agent_id}`));
  const afterLlm = await api(
    "GET",
    `/get-retell-llm/${client.llm_id}?version=${after.response_engine.version}`
  );
  const ok = isTuned(after) && afterLlm.general_prompt === prompt;
  console.log(
    ok
      ? `${label} PUSHED ${what} — live agent v${after.version}, llm v${afterLlm.version}`
      : `${label} WARNING: published v${after.version} but verify failed ` +
        `(tuning=${isTuned(after)}, prompt=${afterLlm.general_prompt === prompt}) — check manually`
  );
}

async function main() {
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");
  const explicit = args.filter((a) => a.endsWith(".json"));

  const targets = explicit.length
    ? explicit
    : fs
        .readdirSync("clients")
        .filter((f) => /^(demo|client)-.*\.json$/.test(f))
        .filter((f) => {
          const c = JSON.parse(fs.readFileSync(path.join("clients", f), "utf8"));
          return c.slug && c.variant; // skip the standalone tool-definition files
        })
        .map((f) => path.join("clients", f));

  console.log(`${targets.length} agent(s)${execute ? "" : " — DRY RUN, pass --execute to apply"}\n`);
  let failed = 0;
  for (const t of targets) {
    try {
      await updateOne(t, execute);
    } catch (e) {
      failed++;
      console.log(`${path.basename(t).padEnd(34)} ERROR: ${String(e.message).slice(0, 200)}`);
    }
  }
  if (failed) process.exitCode = 1;
}

main();
