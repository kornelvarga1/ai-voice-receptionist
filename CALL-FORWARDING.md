# Call forwarding — the client-side setup

The one onboarding step that happens on the contractor's phone, not on ours.

Nothing in VargaFlow controls forwarding. We own the Retell number; their carrier
decides which calls reach it. That means switching modes later is free, instant,
and needs nothing from us — no redeploy, no config change, no new number.

It also means this is the step where an onboarding stalls, because every carrier
does it differently and you can't do it for them. Budget ten minutes on the video
call and share your screen.

**They keep their number.** Nothing is ported, their marketing and Google
Business Profile stay exactly as they are. That's the whole reason this can go
live the same day, and it's worth saying out loud — "porting" is a word that
makes contractors nervous.

---

## Two modes — recommend conditional

### Conditional (recommended)

Their phone rings first. The AI only picks up what they don't. Nothing changes
about how they work; they just stop losing the calls they miss.

This is the easier sell by a distance. It reframes the product from "replace me"
to "catch what I'm already dropping," which is a thing they already know they do.

There are **three separate cases**, and you want all three set or there are holes:

| Case | Why it matters |
|---|---|
| No answer | On a roof, hands full, phone in the truck |
| Busy | Already on another call — the classic double-booked lost job |
| Unreachable | Dead battery, no signal, phone off. **Most-forgotten, and the one where a missed call is most certain** |

### Unconditional / instant

Every call goes straight to the AI; their phone never rings. Right for someone
who has genuinely stopped answering, or who wants the AI to run the front desk
outright. Ask before assuming — most contractors want to keep answering when they
can.

---

## GSM carriers — AT&T, T-Mobile, most of the world

Dial these like a phone number and press call. They aren't calls: the network
answers immediately with an on-screen confirmation ("Setting activation
succeeded"). Nothing rings, nothing is billed. The setting lives in the carrier's
switch, so it survives reboots and works while the phone is off — which is what
makes the unreachable case work at all.

| What | Code |
|---|---|
| No answer | `*61*<number>#` |
| Busy | `*67*<number>#` |
| Unreachable | `*62*<number>#` |
| **All three at once** | `*004*<number>#` |
| Everything, unconditional | `**21*<number>#` |
| Cancel all conditional | `##002#` |
| Cancel unconditional only | `##21#` |
| Check what's currently set | `*#61#`, `*#67#`, `*#62#`, `*#21#` |

Use `*004*<number>#` unless you have a reason not to — one code, all three cases,
far less to get wrong on a call.

Enter the number in full international form (`+1` then the ten digits).

### Ring timer

How long their phone rings before the AI takes it:

```
*61*<number>**20#      → 20 seconds, roughly 4–5 rings
```

Values are usually 5–30 seconds in steps of 5. Twenty is a good default: long
enough that they can genuinely grab it, short enough that the caller hasn't given
up. Too long is the more common mistake — a caller who hangs up before the AI
answers is indistinguishable from having no AI.

⚠️ The base codes above are reliable. This timer syntax varies by handset and
network — confirm it on the actual phone rather than trusting it blind.

---

## Verizon

Verizon comes from CDMA and does not use the GSM codes. A Verizon contractor
dialling `*61*` gets an error and concludes your product is broken.

| What | Code |
|---|---|
| Conditional (no answer / busy) | `*71<number>` then press call |
| Unconditional | `*72<number>` then press call |
| Cancel | `*73` |

No `*` separators and no `#` — just the prefix followed by the digits.

**Ask which carrier they're on before you tell them what to dial.** It's the first
question of this part of the call.

---

## VoIP

No dial codes. Forwarding is a setting inside the provider's app or web portal,
named differently by every one of them, and some put it behind a paid tier or
don't offer it at all.

The general shape: log into the app or portal → find Settings → look for "Call
Forwarding", "Forward calls", or sometimes "Call Handling" / "Advanced Calling" →
enter the Retell number → save. Conditional forwarding may be a separate toggle
("forward when unanswered") or may not exist, in which case it's all-or-nothing.

Don't guess at a provider you haven't seen. Screen-share and find it together —
it takes two minutes and beats sending them somewhere that doesn't exist.

### Verified providers

Fill this in as real clients arrive. Guessed instructions are worse than none.

| Provider | Where the setting lives | Conditional? | Verified |
|---|---|---|---|
| Dingtone | Settings → Call Forwarding; enter the destination number | **No — unconditional only.** One field, forwards everything instantly. No ring-timer, no busy/no-answer rules | 2026-09-09 — works, caller ID preserved |

Expect consumer VoIP apps to be all-or-nothing like Dingtone: one field, everything
forwards. The conditional rules generally show up on real mobile carriers (where the
GSM/Verizon codes apply) and on business VoIP platforms, which tend to expose proper
call-handling rules — ring-for-N-seconds, then a fallback destination.

So the practical split on an onboarding call is: **carrier SIM → conditional, the
recommended setup. Consumer VoIP app → unconditional is the only option.** That's
not a dealbreaker — a contractor who has stopped answering unknown numbers anyway
loses nothing by sending everything to the AI, and they can still call out normally.
Just don't promise "it only picks up what you miss" before you know what they're on.

---

## Confirm it actually worked

Never end the call on "that should do it."

1. Call their business number **from a different phone** — not the phone that owns
   the number, which some carriers short-circuit.
2. For conditional: let it ring out without answering. The AI should pick up after
   the timer.
3. For unconditional: the AI should answer immediately and their phone shouldn't ring.
4. Book a real appointment through it and confirm the event lands on their calendar.

That last step is also the most convincing thing they'll see all call — they watch
a booking appear on their own calendar, made by something that answered their own
number.

**Caller ID passes through.** Verified 2026-09-09 on a VoIP hop: the AI saw the
original caller's number, not the forwarding service's. That matters, because the
callback number the agent captures and reads back is that caller ID. If you ever
onboard a provider that replaces it, the agent will still work — it falls back to
asking for the number — but the captured callbacks will be wrong, so check it on
the confirmation call.

---

## When it doesn't work

| Symptom | Likely cause |
|---|---|
| Code returns an error | Wrong carrier family — try the Verizon codes, or it's a VoIP line |
| "Not supported on your plan" | Some prepaid plans block conditional forwarding. Unconditional usually still works |
| Nothing forwards, no error | Set on the wrong number — a phone with two lines, or a VoIP app that owns the number rather than the SIM |
| AI answers instantly when it shouldn't | Unconditional got set instead of conditional. Cancel with `##002#` / `##21#` and redo |
| Rings forever, never reaches the AI | Timer too long, or only "no answer" was set and this call hit busy/unreachable. Use `*004*` |
