const fs = require("fs");
const path = require("path");

const TEMPLATES_DIR = path.join(__dirname, "..", "templates");

// Variables resolved by Retell itself at call time, not at deploy/render
// time — leave them untouched here. `caller_number` is a real custom dynamic
// variable injected by our own voice-inbound-webhook function (see
// vargaflow-admin/supabase/functions/voice-inbound-webhook/), configured as
// each phone number's inbound webhook. This works reliably, unlike Retell's
// documented-but-broken automatic {{from_number}} system variable, which
// does NOT resolve inside a retell-llm's general_prompt for inbound calls
// (tested 2026-08-25 — came through as the literal unresolved string).
const RETELL_RUNTIME_VARS = new Set(["caller_number"]);

function fillVars(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (RETELL_RUNTIME_VARS.has(key)) return match;
    if (!(key in vars)) {
      throw new Error(`Missing template variable: ${key}`);
    }
    return vars[key];
  });
}

function renderPrompt(clientConfigPath) {
  const client = JSON.parse(fs.readFileSync(clientConfigPath, "utf8"));

  const base = fs.readFileSync(path.join(TEMPLATES_DIR, "base.md"), "utf8");
  const variant = fs.readFileSync(
    path.join(TEMPLATES_DIR, `${client.variant}.md`),
    "utf8"
  );

  const filledVariant = fillVars(variant, client);
  const merged = base.replace("<!-- VARIANT_INSERT -->", filledVariant);
  const finalPrompt = fillVars(merged, client);

  return { client, prompt: finalPrompt };
}

module.exports = { renderPrompt, fillVars };

if (require.main === module) {
  const clientArg = process.argv[2];
  if (!clientArg) {
    console.error("Usage: node render.js <client-config.json>");
    process.exit(1);
  }
  const { prompt } = renderPrompt(path.resolve(clientArg));
  console.log(prompt);
}
