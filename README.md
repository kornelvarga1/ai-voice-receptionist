# AI Voice Receptionist

An AI phone receptionist for home service contractors (plumbers, roofers, HVAC, pest control). It answers as the business, works out what the caller needs, reads back every detail, checks the owner's real Google Calendar and books an actual appointment into it. If it doesn't know something, it says so and flags the owner for a callback. It never invents an answer or a price.

Built on Retell AI with ElevenLabs voices and Twilio numbers. The backend it calls lives in [vargaflow-admin](https://github.com/kornelvarga1/vargaflow-admin/tree/main/supabase/functions) as Supabase edge functions.

## Call it

These are live demo lines for fictional businesses, running the same system a real client gets.

| Line | Answers as | Try |
|---|---|---|
| **+1 (656) 246-0255** | Ironclad Plumbing | A burst pipe, then a gas smell |
| **+1 (213) 238-5364** | Summit Roofing | Ask for a price. It won't make one up. |

US numbers. If your plan can't dial them, [talk to it in the browser](https://kornelvarga.com#demos).

## How it works

A new business is a config file, not a new agent. One prompt skeleton, two trade variants, one JSON file per business:

```
templates/
  base.md                 shared skeleton: identity, style, honesty rule, booking, wrap-up
  emergency-service.md    variant for plumbing / electrical / HVAC: urgency triage + safety carve-out
  inspection-estimate.md  variant for roofing / fencing / pest control: scope capture, free estimate
clients/
  demo-*.json             one per business: name, trade, service area, service call fee, trade knowledge
scripts/
  render.js               base + variant + client values -> final prompt (throws on any missing value)
  deploy.js               creates the Retell LLM, agent, tools and webhooks; writes the ids back to the config
  update-live.js          pushes prompt/setting changes to agents that already took calls, without recreating them
```

```bash
node scripts/deploy.js clients/demo-emergency-plumbing.json        # new agent
node scripts/update-live.js clients/demo-emergency-plumbing.json   # dry run on a live agent
node scripts/update-live.js clients/demo-emergency-plumbing.json --execute
```

`deploy.js` needs `scripts/notify-config.json` (see the `.example`) and the `retell` CLI authenticated.

### What happens on a call

```
caller dials the Twilio number
   │
   ▼
voice-inbound-webhook   verifies Retell's HMAC signature, injects the caller's real number
   │
   ▼
agent (Retell LLM)  ── check_availability ──►  Google Calendar free/busy, next open slots
   │                ── book_appointment ───►  real calendar event for the slot the caller picked
   │                ── notify_contractor ──►  email to the owner: booking, callback or safety flag
   ▼
voice-call-webhook      logs every call (transcript, recording, sentiment) for follow-up
```

Tool callbacks are authenticated with a shared secret per deploy. Google refresh tokens live in a service-role-only table with RLS on and no policies, so they never reach a UI.

## Decisions worth reading the code for

- **Safety before booking.** The emergency variant checks for gas, fire and active flooding before anything else, and tells the caller to leave and call 911. That call never becomes a booking.
- **State the trip fee, refuse the repair quote.** The first version refused every price question. A real prospect asked four times what a visit costs, was refused four times, and hung up. Now the agent states the flat service call fee and still refuses to guess a repair price. Those are different questions.
- **Caller ID through our own webhook.** Retell's documented `{{from_number}}` variable doesn't resolve inside the prompt on inbound calls. The inbound webhook injects the real number instead, and `render.js` keeps an allowlist of variables left for Retell to fill at call time.
- **Updating live agents without losing them.** Once an agent has taken a call, Retell locks its LLM. Recreating it changes the agent id and drops the call history, so `update-live.js` goes through the draft version → patch → publish path instead.
- **Turn-taking tuned for job sites.** Default interruption sensitivity treated truck noise as the caller talking and cut the agent off mid-word. See [AGENT-FIXES.md](AGENT-FIXES.md) for the call that exposed it and the five fixes that came out of it.

For the longer story: [Every bug that cost me a booking looked like success](BLOG-silent-failures.md), six failures that returned 200 and looked fine everywhere except on the call.

## Also in here

- [CALL-FORWARDING.md](CALL-FORWARDING.md): how a contractor forwards their existing number to the agent
- [CLAUDE.md](CLAUDE.md): the full working notes, including every Retell quirk found along the way
- `clients/vargaflow-self*`: the agent that answers VargaFlow's own sales line and books calls with me

Real client configs are kept out of this public copy.

---

Built by [Kornél Varga](https://kornelvarga.com).
