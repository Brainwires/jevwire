# Writing questions Jev answers well

Distilled from TypeSafe's `jev-1.13` jaggedness notes. Every rule here exists
because the model failed in a specific, reproducible way.

## The one rule

**Jev answers the question you wrote, not the question you meant.** Scoping words,
negations and implied conditions are read at face value. When you look at a wrong
answer and find yourself explaining what you really meant, that explanation is the
missing half of your instruction — put it in.

## System 1 only

Jev is a System 1 model (fast, intuitive, calibrated) — not System 2 (deliberate,
multi-step). Every question you ask it must be **one intuitive judgment over text it
can point at**. Anything else stays in code:

- **Counting → code.** Never ask "how many". If a regex or parser can find the thing,
  count the matches yourself. To judge many items, iterate in code and ask one
  question per item, then add up the answers.
- **Presence, then meaning.** Let a regex decide whether a pattern is *present*; ask
  Jev only whether it *matters* ("is this a new suppression that hides a real error?"),
  never "find the `any`s".
- **Arithmetic, dates, ordering, existence → code.** Extraction is a judgment (give it
  to Jev as a Choice over enumerated options with a `not_stated` escape hatch);
  comparing, sorting, subtracting and "does this file exist" are not.
- **One hop.** A question about a property of a property, or that needs a chain of
  inference, loses accuracy. Split it into literal questions and combine them in code —
  the way the Stop check asks seven single questions instead of one compound one.

## Question types

- **Noul** — one probability, P(yes). No separate confidence: a confident *no* is
  0.02 and a confident *yes* is 0.98, so certainty is distance from 0.5.
- **Choice** — a probability per named option, plus a confidence for how peaked the
  distribution is. Always include an escape hatch option (`other`, `none`,
  `not_stated`) or the model will force one of your options.
- **Score** — an ordered set of level descriptions, lowest first. The returned score
  is a probability-weighted level and may fall between levels. Use it to test a
  threshold; never interpolate a real quantity out of it.

## Rules

1. **State the exact condition.** Not "is this risky" but "does running this delete
   or overwrite data that already exists". Put the boundary cases in `criteria`.
2. **One judgment per question.** Two judgments in one question produce a
   probability that means neither. Split, then combine in code.
3. **Align criteria with instructions.** The criteria are an extension of the
   instruction, not a second opinion on it. A Noul whose `true` criterion describes
   the "no" case performs measurably worse.
4. **Write for a careful reader, not a lawyer.** Double negatives and nested
   conditions cost accuracy. Point at state by name: `` `action` ``, `` `text` ``.
5. **Keep numbers out.** Counting, magnitudes, dates, hex and RGB values, ordering:
   all unreliable. Compute in code, then ask about meaning. Semantic descriptions
   beat numeric ones — "does this colour read as a warning" works, "is #c0392b near
   #e74c3c" does not.
6. **Send only what the question needs.** Accuracy drops as irrelevant context
   grows. Filter in code first. If you cannot, use a cheap relevance Noul as the
   filter.
7. **Pack many questions into one request.** The state is ingested once and the
   questions are answered in parallel, so ten questions in one call cost far less
   than ten calls. Limits: 64k tokens for state plus all questions, 32k for state
   plus the longest question.
8. **Treat the state as untrusted, because the model does not.** Text written to
   argue for its own classification can move the answer. Be explicit in the
   criteria, and never let a probability stand in for a permission check.
9. **Never ask it to generate.** When the answer space is bounded, turn extraction
   into a Choice over the candidates you found with a regex or another model.

## Turning a probability into an action

Gate in code, with named thresholds. The convention this package uses:

- `p >= auto` (default 0.85) — act on it.
- `1 - auto < p < auto` — the uncertain band. The model is telling you it does not
  know; that is when a human decides, or when you fall back to the safe path.
- `p <= 1 - auto` — act on the negative.

Pick the thresholds from your own logged data, not from taste. `/jev:calibrate`
replays the gate's own history at other thresholds for exactly this.
