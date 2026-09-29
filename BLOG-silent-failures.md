# Every bug that cost me a booking looked like success

I spent six months building an AI phone receptionist for home service contractors. It answers as the business, works out what the caller needs, checks a real Google Calendar, and writes an actual appointment into it.

It works now. Getting there was mostly a fight with one specific class of bug.

Normal software fails loudly. A stack trace, a 500, a red test. Voice agents built on top of an LLM and three vendor APIs fail *politely*. The agent says something reasonable, the API returns 200, the CLI exits 0, the queue says "sent" — and the booking never happened. Nothing anywhere reports an error, because from every individual component's point of view, nothing went wrong.

Here are the six that cost me the most, and how each one was eventually found.

---

## 1. The agent confidently told a caller there was no availability. There were 35 open slots.

Retell passes custom-tool parameters nested under an `args` key, alongside call metadata. My `check_availability` handler read them flat:

```js
const timeOfDay = body.time_of_day;  // undefined, always
```

In a saner world this throws. Instead `undefined` fell through to a default, the function searched the wrong window, returned what it found, and the agent — correctly, given what it was handed — told the caller that afternoon was full.

The caller hung up. The logs were clean. The function returned 200.

What made this genuinely hard: **I tested the endpoint by hand and it passed.** I sent the flat shape curl-style, got back real slots, and concluded the tool was fine. A hand-rolled test that doesn't replicate the platform's exact envelope proves nothing at all — it only tests the shape you already believe in.

Two things fixed it permanently:

```js
const args = body.args ?? body;
```

and, more importantly, making the response echo back the parameters it actually parsed:

```json
{ "searched": { "time_of_day": "afternoon", "timezone": "America/Denver" }, "slots": [...] }
```

That echo is what made the bug findable from a call transcript alone, with no access to logs. If you build tool endpoints for a voice agent, **have them state what they think you asked for.** It costs nothing and it's the difference between a five-minute diagnosis and a week of guessing.

---

## 2. "Cannot update published agent" — and the undocumented way around it

Once an agent has taken a real call, its language model is published, and published means frozen. Any attempt to update the prompt returns:

```json
{"status":"error","message":"Cannot update published LLM"}
```

The tools live on the LLM too, so tool updates fail the same way. The entire deploy path is blocked.

The obvious workaround — delete the pair, recreate it — is a trap. It loses all Retell-side call history, changes the `agent_id`, and orphans every downstream reference to it. In my case that silently broke the webhook that resolves which business a call belongs to, so every subsequent call logged against a null tenant.

The actual sequence, which I could not find documented anywhere:

1. `POST /create-agent-version` with `{"base_version": <live>}` — branches a draft off the live agent.
2. **That implicitly opens a matching draft LLM version.** This is the part that isn't written down, and it's the whole trick: there is no endpoint to open an LLM draft directly. Branching the *agent* is the only thing that makes the *model* writable.
3. `PATCH /update-retell-llm/<id>` with **no version parameter** — it lands on the draft from step 1. Called on its own, it's the error above, which is why this looks impossible from the outside.
4. `POST /publish-agent/<id>` — promotes the draft; the LLM version goes live with it. Returns 200 with an empty body, which is normal.

Agent ID, call history, tools, and phone bindings all survive.

**Bonus silent failure inside the fix:** the vendor CLI's publish command takes a `--version` flag. So does Commander, the arg-parsing library underneath it. Running `publish <agent_id> --version 3` prints `1.10.0` — the CLI's own version number — and exits 0, having published nothing. I "successfully" published nine agents that way before a verification step caught it. Now I always publish through the API and read the state back afterward.

---

## 3. Default turn-taking sounds fine in testing and falls apart on a real call

A prospect called one of my demo lines from what sounded like a garage. The last six turns of the transcript:

```
Agent: Thanks
Agent: Great
Agent: Sorry, I didn't
Agent: Sorry,
```

Four consecutive `(unintelligible audio)` from the caller in between. He hung up.

I had never set a single turn-taking parameter on any agent I'd deployed. Every one was running platform defaults, and the default interruption sensitivity is maximum — which means background noise counts as a barge-in and truncates the agent mid-word. On a quiet line during testing this never surfaces. On a real call from a work site it's constant.

```js
{
  interruption_sensitivity: 0.5,
  responsiveness: 0.9,
  enable_backchannel: false,
  stt_mode: "accurate",
  denoising_mode: "noise-cancellation",
}
```

The deeper point: **your callers are in trucks, garages, and crawlspaces, on speakerphone.** If you only ever test from a desk with a headset, you are testing the one environment your product will never run in.

---

## 4. The agent used being an AI as an excuse

A caller — clearly a tradesman evaluating whether the thing was any good — asked a completely standard qualifying question:

> "What method do you use to clean the duct? Is it high pressure? Is it physical abrasion?"

The agent replied:

> "I'm the AI assistant, so I don't have the technical details on that."

That's not a model failure. My prompt *caused* it. The honesty section listed "technical specifics" among the things to decline, and the identity section told it to disclose being an AI. The model combined them into the single worst sentence it could have produced — because it reached for its AI-ness as the *reason* it couldn't help.

The answer to his question is on the homepage of every duct cleaning company. It was a config gap, not a knowledge limit.

Two rules now, in every prompt I write:

- **Never give being an AI as the reason you don't know something.** Disclose it once, answer plainly if asked again, never use it as an excuse. "I don't have that detail — the tech will walk you through it on site" is fine. "I'm just the AI assistant, so I don't know" tells the caller a machine is standing between them and a real answer.
- **Give it the trade's actual working knowledge.** Method, equipment, process, what's standard. The people who ask these questions are your most serious callers — they're checking whether you know the trade before letting you into their house.

---

## 5. My SMS agent had a seven-message conversation with another company's AI

Unrelated system, same class of bug. My outreach texts got a reply, and my auto-reply agent answered it. Then it answered the answer. Both sides were bots, thanking each other politely, for seven rounds, until a rate limit finally stopped it.

Detecting this is harder than it sounds. Compliance boilerplate — "Reply STOP", "Msg&Data rates", "opted in" — catches the obvious auto-responders, but this one opened with:

> "Welcome to [company], my name is Autumn. Are you looking to get a brand new service quote today?"

Which reads perfectly human. The actual tell was in the timestamps: it arrived **16.7 seconds** after my text. Nobody reads a cold message and fires back a full scripted greeting in under half a minute.

So the guard is patterns *plus* a 30-second window, applied only to the first inbound of a thread — because once a real conversation is going, a fast reply just means an engaged human, and dropping that would be much worse than answering a robot.

I validated it against every real inbound message I'd ever received: 8 automated senders caught, zero false positives on genuine ones. **If you're adding a heuristic that silently drops messages, backtest it on your real history before you ship it.** Mine would otherwise have eaten live leads.

---

## 6. The confirmation emails were fine. They were also in spam.

Bookings worked, confirmations sent, callers never saw them. I went straight to DNS, found the root SPF record didn't include the email provider, and confidently diagnosed a misconfiguration.

Wrong. The envelope sender was a subdomain with its own passing SPF record. Pulling the real headers out of Gmail — Show original — showed `dkim=pass`, `spf=pass`, `dmarc=pass`. Authentication was clean. It was new-domain reputation, which no DNS change fixes.

**Read the actual headers on a delivered message before touching DNS.** Inferring deliverability from lookups alone is how you spend an afternoon "fixing" something that was never broken.

---

## The pattern

Every one of these produced a convincing success signal:

| What happened | What it looked like |
|---|---|
| Tool args silently defaulted | Agent confidently states no availability |
| Hand-rolled endpoint test | Passes, proves nothing |
| CLI published nothing | Exit 0, prints a version number |
| Agent truncated mid-word | Valid text, just incomplete |
| Bot talking to a bot | A perfectly polite conversation |
| Emails in spam | Provider reports delivered |

None of them showed up in an error log, because from each component's local point of view nothing failed. The only artifact that contained the truth was the **call transcript** — which is why the single highest-leverage thing I built wasn't a feature, it was logging every call with its full transcript and post-call analysis to my own database, regardless of outcome.

If you're building voice agents: instrument for lying, not for crashing. Make every tool echo its parsed inputs. Read your transcripts, especially the short calls. And verify state after every write — never trust a 200 or an exit code to mean the thing you asked for actually happened.

---

*I build AI phone agents and the backend systems around them — Retell, Vapi, Twilio, real calendar integration. Available for contract work.*
