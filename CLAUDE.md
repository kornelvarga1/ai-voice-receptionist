# CLAUDE.md — Contractor Voice Receptionist Template

Retell AI voice receptionist for home service contractors. Standalone product — sells on a live demo call, no free trial, no dependency on the rest of the VargaFlow stack. See `[[project_ai_receptionist_pivot]]` in memory for the business reasoning.

## What this agent does

Answers inbound calls for a contractor, figures out what the caller needs, captures name/address/phone/job details, checks the contractor's real Google Calendar for open slots, and books the appointment for real. If it doesn't know something, it says so and flags the contractor for a callback — it never invents an answer. Feature-complete as of 2026-08-25: real phone numbers, real calendar booking, real email notifications, all tested end-to-end on live calls.

## Architecture

One prompt skeleton (`templates/base.md`), two trade variants spliced into it at `<!-- VARIANT_INSERT -->`, one JSON config per client/demo with the values that fill in `{{placeholders}}`.

```
templates/
  base.md                  ← shared skeleton: identity, style, honesty rule, booking, wrap-up
  emergency-service.md     ← variant A: plumbing / electrical / HVAC
  inspection-estimate.md   ← variant B: roofing / fencing / remodeling / handyman / cleaning
clients/
  demo-emergency-plumbing.json
  demo-inspection-roofing.json
  demo-emergency-garage-door.json      ← +16164491976  Apex Overhead Door
  demo-emergency-appliance-repair.json ← +15673648596  Redline Appliance Repair
  demo-inspection-air-duct.json        ← +18783789417  Clearway Duct & Air
  demo-inspection-chimney.json         ← +17084386561  Hearth & Flue Chimney Co.
  demo-inspection-pest-control.json    ← +17165763217  Sentry Pest Solutions
  <slug>.json              ← new clients/demos go here
scripts/
  render.js                ← merges base + variant + client vars → final prompt text
  deploy.js                ← creates/updates the Retell LLM + agent, saves ids back to the client json
```

### Which variant to use

- **emergency-service**: trades where a meaningful share of calls are "come now" (plumbing, electrical, HVAC). Adds urgency triage right after greeting, plus a hard safety carve-out (gas smell, fire, active flooding → tell them to leave/call 911 before anything else). Appointment is framed as a service call, not an inspection.
- **inspection-estimate**: trades where price depends on seeing the property and there's no real urgency (roofing, fencing, remodeling, handyman, cleaning). No urgency triage. Focus is capturing job scope; appointment is framed as a free inspection/estimate visit.

Don't hardcode "inspection" language into the shared base — it only applies to variant B. The base only knows about a generic `{{appointment_type_label}}`.

### Trade-specific fields — the thing that makes a demo real (added 2026-09-06)

The variants used to hardcode roofing/plumbing intake questions, so cloning a demo and renaming it produced an agent that asked a pest control caller about **storm damage**. Two required per-client fields fix that:

- **`trade_intake`** (both variants) — the bullet list of what to capture for *this* trade. This is the single highest-value field in the config; it's what a caller uses to judge whether the thing actually knows their business. A garage door caller clocks a wrong question inside twenty seconds, which is exactly the window where non-matching callers hang up.
- **`trade_safety_note`** (emergency-service only) — the trade's real hazard. Plumbing gets "shut off the main"; garage door gets "don't touch the torsion spring"; appliance gets "unplug it, don't run it." Do not reuse another trade's note, it reads as obviously wrong.
- **`service_call_fee`** (both variants, added 2026-09-10) — one sentence the agent says verbatim when asked what it costs to come out, e.g. "It's an $85 service call to come out and diagnose it, and that gets waived if you go ahead with the repair." Free-estimate trades say so plainly instead. `base.md` used to say flatly "you don't quote prices" and lumped the trip fee in with everything else it didn't know, so agents stonewalled the single most common question on the call — a real prospect (a garage door company, 2026-09-10) asked four times, got refused four times, and hung up saying he'd call someone else. The rule now is narrow on purpose: **state the flat trip fee, still refuse the repair quote.** They are different questions and collapsing them into one refusal is what loses the booking. For a real client this is an onboarding question, never a guess; for a fictional demo, pick a realistic market rate.

`render.js`'s `fillVars` **throws** on a missing variable rather than rendering blank — that's deliberate. If you add a placeholder to a template you must backfill every existing client JSON or renders fail loudly.

## Adding a new client or demo

1. Copy `clients/demo-*.json` to `clients/<slug>.json`, fill in:
   - `variant`: `emergency-service` or `inspection-estimate`
   - `business_name`, `trade`, `service_area`, `contact_first_name`
   - `appointment_type_label` (e.g. "service call", "free inspection")
   - `assistant_name` — a first name for the AI, disclosed proactively in the greeting
   - `no_live_transfer_line` — what to say if the caller demands a human right now
   - `voice_id` (see `retell voices list` for options), `begin_message` (first thing the agent says — **must include a recording disclosure**, e.g. "this call may be recorded for quality," since data storage is set to "everything" and several US states are two-party consent)
   - Leave `llm_id` / `agent_id` as `null` — deploy.js fills these in
   - `appointment_booking_line` is dead/unused (calendar booking is dynamic now) — safe to omit on new clients
2. In Supabase, create a `businesses` row and a matching `voice_agents` row (`business_id`, `variant`, `notification_email`; leave `retell_agent_id`/`retell_phone_number`/`google_*` for later steps) — put the resulting `business_id` in the client JSON
3. `node scripts/render.js clients/<slug>.json` — sanity-check the rendered prompt reads naturally before pushing it live
4. `node scripts/deploy.js clients/<slug>.json` — creates the Retell LLM + agent + all three tools, writes ids back into the client file
5. Buy a phone number and bind it, then save it into the client JSON's `phone_number` field and re-run `deploy.js` once so the tool URLs/etc. stay in sync.

   **`retell-cli` can no longer buy or bind numbers** (found 2026-09-10). Retell deprecated the single-agent phone fields on 2026-03-31, and retell-cli v1.10.0 still sends `inbound_agent_id`, so `phone-numbers create --inbound-agent` fails with a misleading `{"error":"Resource not found","code":"NOT_FOUND"}` — which reads like the area code is unavailable rather than a bad request. Call the raw API with the weighted form instead:

   ```bash
   curl -X POST https://api.retellai.com/create-phone-number \
     -H "Authorization: Bearer $RETELL_API_KEY" -H "Content-Type: application/json" \
     -d '{"area_code":669,"nickname":"<Business>",
          "inbound_agents":[{"agent_id":"<agent_id>","weight":1}],
          "inbound_webhook_url":"https://zfmchywjmgykmlhjihls.supabase.co/functions/v1/voice-inbound-webhook"}'
   ```

   A genuinely unavailable area code returns `{"status":"error","message":"No phone numbers of this area code."}` — distinct from the deprecation error, so you can tell them apart. Match the client's own area code when you can; if it's sold out, use the local overlay (408 San Jose → 669) rather than jumping to a different region.

   **That re-run usually recreates the LLM + agent pair** (observed 2026-09-09 on a fresh client that had never taken a call — the publish attempt at the end of the first run is enough to lock the LLM). Consequences, in order:
   - `client.agent_id` changes, and `deploy.js` re-binds the number to the new agent automatically. The re-bind omits `--inbound-webhook-url`, but Retell patches partially so **the webhook survives** — verified, don't "fix" it.
   - **`voice_agents.retell_agent_id` is orphaned again.** So patch that column *after* the final `deploy.js` run, never before, or you'll do it twice. This is the column `voice-call-webhook` uses to resolve `business_id`; stale means every call logs `business_id: null`.
   - Always re-check `retell phone-numbers get <number>` and the `voice_agents` row after the last deploy, not after the first.
6. Send them `https://zfmchywjmgykmlhjihls.supabase.co/functions/v1/voice-calendar-oauth-start?business_id=<their business_id>` to connect their calendar. **No test-user step any more** — the Google app was published to production 2026-09-09, so any Google account can connect. Warn them they'll hit a "Google hasn't verified this app" screen and must click **Advanced → Go to VargaFlow Voice AI**; that's the single most likely place for a non-technical client to bail. They land on `vargaflow.com/calendar-connected` when it works. Cap is 100 connected accounts
7. Walk them through call forwarding from their existing number to the Retell number — see `CALL-FORWARDING.md`. This is the only step that happens on their phone, and the one most likely to stall an onboarding.
8. Test via the Retell dashboard's Test Call button, `retell calls create-web --agent-id <id>`, or just call the real number

Re-running `deploy.js` on a client that already has `llm_id`/`agent_id` set updates the existing LLM prompt in place (and publishes the draft) rather than creating a duplicate agent.

## Updating an agent that is already live — use `update-live.js`, not `deploy.js`

**`deploy.js` is for the first push only.** Once an agent has taken a real call its
LLM is published, and both `llms update` and `tools update` fail with "Cannot
update published LLM" (the custom tools live on the LLM, so the whole deploy path
is blocked). deploy.js's fallback is to delete and recreate the LLM + agent pair,
which loses Retell-side call history, changes `agent_id`, and orphans
`voice_agents.retell_agent_id` — every later call then logs `business_id: null`.

```bash
node scripts/update-live.js                     # dry run, all clients
node scripts/update-live.js --execute
node scripts/update-live.js clients/x.json --execute
```

It is idempotent — it compares the rendered prompt and the tuning constants
against the live version and skips anything already current.

**The sequence it uses** (worked out 2026-09-13; there is no documented path for
this and the CLI cannot do it):

1. `POST /create-agent-version` with `{"base_version": <live>}` — branches a draft
   off the live agent version. **This implicitly opens a matching draft LLM
   version, and that is the only moment the LLM becomes writable.** There is no
   endpoint to open an LLM draft directly.
2. `PATCH /update-retell-llm/<llm_id>` with **no version param** — it lands on the
   draft from step 1. Called without an open draft it returns "Cannot update
   published LLM", which is what makes this look impossible at first.
3. `PATCH /update-agent/<agent_id>?version=<draft>` — agent-level settings.
4. `POST /publish-agent/<agent_id>` with `{"version": <draft>}` — promotes the
   draft, and the LLM version it points at goes live with it. Returns 200 with an
   empty body; that is normal, not a failure.

Verified: tools, tool URLs, phone bindings, `agent_id` and call history all
survive. Two traps:

- **Never publish with `retell agents publish <id> --version N`.** Commander
  treats `--version` as its own global flag, so the CLI prints `1.10.0`, exits 0,
  and publishes nothing. A silent no-op that reads as success.
- **"Latest version" is not "live version".** Retell leaves every published
  version flagged `is_published` and opens a fresh draft immediately after each
  publish, so the latest version is normally an empty draft. What answers the
  phone is the highest-numbered published version.

### Agent turn-taking settings (added 2026-09-13)

`AGENT_TUNING` in `deploy.js` (applied at create) and `update-live.js` (backfilled
onto live agents). Every agent before this ran on Retell defaults, which assume a
quiet line: `interruption_sensitivity` 1 treats truck noise or a garage
speakerphone as a barge-in and truncates the agent mid-word. On the 2026-09-12
Clearway call the agent's last six turns came out as "Thanks" / "Great" / "Sorry,
I didn't" / "Sorry," and the caller hung up. Current values: sensitivity 0.5,
responsiveness 0.9, backchannel off, `stt_mode` accurate, denoising on, one
12s reminder. See `AGENT-FIXES.md` for the full teardown.

### `trade_knowledge` — required field (added 2026-09-13)

Four to six sentences on **how this trade actually does the work** — method,
equipment, process, what's standard. Rendered into a `## What we actually do`
section in `base.md`. `base.md` used to list "technical specifics" among the
things to punt on, so agents deflected the most common qualifying question a
tradesman asks. The Clearway caller asked "high pressure or physical abrasion?"
— a question answered on every duct company's homepage — and got *"I'm Ray, the
AI assistant, so I don't have the technical details."*

`base.md` now also forbids ever giving being an AI as the *reason* for not
knowing something. Disclosing it is required; using it as an excuse is what makes
the thing sound like a toy at the exact moment a contractor is judging it.

Like `trade_intake` and `service_call_fee`, `fillVars` throws if it is missing, so
adding it means backfilling every client JSON in the same commit. For a real
client this is an onboarding question — the two real client configs currently
carry standard-practice text that has **not** been confirmed by the owner.

## retell-cli notes

- Community tool (`npm i -g retell-cli`), not an official Retell package. Auth via `retell login` (stores key in `~/.retellrc.json`) or `RETELL_API_KEY` env var.
- On Windows, the CLI must be invoked with `shell: true` from Node (`retell.cmd` can't be spawned directly without EINVAL) — see the comment in `deploy.js`. Because of that, any value with spaces or shell metacharacters (business names, ampersands, parens) is passed through a temp JSON file via `-f`, never as a raw `--flag` argument, to avoid cmd.exe mangling it.
- A freshly created agent (`agents create`) is live at version 0 immediately — no publish step needed. `agents publish` is only for pushing a draft version of an *existing* agent live, and errors if there's no pending draft.
- **An LLM appears to lock ("Cannot update published LLM") once it's actually been used in a call**, not just because the agent exists — an agent that's never received a call can still have its LLM updated in place, but the moment you test-call it, further `llms update` calls on that llm_id 400. `deploy.js` handles this automatically: on that specific error it deletes the old LLM+agent pair and recreates fresh ones (losing that pair's call history/transcripts, which is fine for demo iteration but worth knowing before doing this against a client's real, in-use agent).
- If a client config has a `phone_number` field, `deploy.js` re-binds that number to the (possibly just-recreated) `agent_id` at the end of every run — otherwise a recreate from the point above would silently leave the number pointed at a deleted agent.
- **A recreate also orphans `voice_agents.retell_agent_id`** — that column is written once by hand when a client/demo row is created and never touched again by `deploy.js`, so after any agent recreate it points at a deleted agent_id until manually updated (found and fixed 2026-08-30 on both demo rows, which had silently drifted since 2026-08-22 testing). `deploy.js` prints a warning when this happens; update the row via a direct Supabase REST PATCH. This matters because `voice-call-webhook` resolves `business_id` by looking up `retell_agent_id`, so a stale row makes every call from that agent log with `business_id: null`.
- Phone numbers are purchased through the Retell **dashboard**, not the CLI — `phone-numbers create` 403s with "Permission denied" regardless of billing status on this account's API key. Buy in the dashboard, then bind via `retell phone-numbers update <number> --inbound-agent <agent_id>` (which does work from the CLI).

## Backend integration (notifications, caller ID, calendar — all built 2026-08-22 through 2026-08-25)

Every client has a row in `voice_agents` (Supabase table, migration `vargaflow-admin/supabase/migrations/20260822180000_voice_agents.sql`) keyed by `business_id`, holding `retell_agent_id`, `retell_phone_number`, `notification_email`, `google_calendar_id`, `google_refresh_token`. Separate from the general `settings` table specifically so OAuth secrets never surface in a settings-edit UI — RLS enabled, no policies, service_role-only access.

Three Retell custom tools are defined per-client (templates in `scripts/*_tool_template.json`, rendered and pushed by `deploy.js`'s tool-ensure loop — add if missing, update if present, re-run on every deploy since an LLM-lock-triggered agent recreate wipes all tools):

- **`notify_contractor`** → `vargaflow-admin/supabase/functions/voice-notify/`. Called after every booking confirmation and every handoff/safety situation. Looks up `notification_email` from `voice_agents`, sends a transactional Resend email (no unsubscribe footer — an ops alert to your paying customer, not a marketing email to a lead).
- **`check_availability`** → `vargaflow-admin/supabase/functions/voice-check-availability/`. Calls Google's `freebusy.query` against the connected calendar, returns the next 2 open 1-hour slots. **Business hours (8am–6pm) and timezone (`America/New_York`) are hardcoded** — needs to become a per-client `voice_agents` column before onboarding a client outside that timezone/schedule.
- **`book_appointment`** → `vargaflow-admin/supabase/functions/voice-book-appointment/`. Creates the real Google Calendar event from the exact slot the caller picked.

**Auth pattern for all three**: secret passed via both an `x-webhook-secret` header AND baked directly into the tool's static `url` field as a query string (`?business_id=...&k=...`) at deploy time. **Do not use Retell's `query_parameters` tool-config feature for values that must actually arrive** — it does not reliably attach to the real outbound request even when `retell tools get` shows the config stored correctly (cost real debugging time on 2026-08-25). The secret lives as the `VOICE_NOTIFY_WEBHOOK_SECRET` Supabase secret and locally (gitignored) in `scripts/notify-config.json`, which also holds each function's URL.

**Caller ID**: `vargaflow-admin/supabase/functions/voice-inbound-webhook/` is registered as the *inbound webhook* on each phone number (`retell phone-numbers update <number> --inbound-webhook-url ...`) — Retell calls it before the agent starts talking, verifies Retell's HMAC signature (`RETELL_API_KEY` secret), and injects the caller's real number as the `{{caller_number}}` dynamic variable. **Retell's documented automatic `{{from_number}}` system variable does NOT work** inside a `retell-llm`'s `general_prompt` for inbound calls (tested, came through as literal unresolved text) — this webhook is the real fix; don't try the bare system variable again. `render.js`'s `RETELL_RUNTIME_VARS` allowlist controls which `{{var}}` names it leaves untouched for Retell to resolve at call time — only `caller_number` is confirmed to actually work.

**Call logging (built 2026-08-30)**: both demo agents have an agent-level `webhook_url` pointed at `vargaflow-admin/supabase/functions/voice-call-webhook/`, which Retell calls on `call_started`/`call_ended`/`call_analyzed` for every call regardless of outcome. Logs to a new `voice_demo_calls` table (migration `20260830130000_voice_demo_calls.sql`) — call_id, agent_id, from/to number, duration, transcript, recording_url, post-call analysis (summary/sentiment/success), and a best-effort `matched_contact_id` (normalized phone match against `contacts` where `business_id IS NULL`). Purpose: a prospect who calls the shared demo number but never replies to the cold-outreach SMS still surfaces as an interest signal. `deploy.js` now sets `webhook_url` at agent-creation time (survives future recreates); setting it on an *existing published* agent requires the create-draft-version → patch → publish dance since Retell 404s a direct PATCH on a published agent (`retell agents create-version` CLI flag validation incorrectly rejects `--base-version 0`, the only version that exists pre-recreate — call the raw API directly with `{"base_version":0}` instead, then `retell agents publish` as normal; a `{"error":"Unexpected end of JSON input"}` from that publish call is the known cosmetic empty-response bug, not a real failure — confirm via `retell agents versions <agent_id>`).

**Google Calendar OAuth**: one-time setup already done (Google Cloud project "VargaFlow Voice AI", OAuth Client ID/Secret stored as `GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET` Supabase secrets). Per-client connection flow: `vargaflow-admin/supabase/functions/voice-calendar-oauth-start/?business_id=<id>` redirects to Google's consent screen; `voice-calendar-oauth-callback/` stores the refresh token. **App is in Google's "Testing" mode (not verified)** — the contractor's Google account must be added as a test user in Google Cloud Console → Google Auth Platform → Audience tab before they can complete the consent flow (100-user cap; full verification is a future task once there are enough real clients to justify it).

## Not yet built

- Per-client business hours/timezone (currently hardcoded to `America/New_York`, 8am–6pm in `voice-check-availability`)
- Inbound phone number provisioning per client beyond the two demo numbers — a real client gets their existing number forwarded to a new Retell number, not ported
