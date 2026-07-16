# Walkthrough notes for the video

The *! ... !* blocks are the points to hit on camera. Everything else is the
original file, quoted verbatim, so you can read it on screen and then
speak to the annotation right after it. Every *! !* below describes only
what is actually in this folder right now (`SKILL.md`, `scripts/`,
`references/`)

---

## Frontmatter

```yaml
---
name: charity-donor-outreach
description: >-
  Use this skill whenever a user mentions donors, fundraising, money, emails,
  letters, charity, nonprofits, campaigns, giving, volunteers, events, reports,
  grants, sponsorships, or any kind of outreach or communication task.
---
```

*!This trigger fires on almost anything, not on donor-letter generation
specifically. Now: narrowed to "when a user uploads a donor file and
asks to generate personalized outreach letters for a fundraising
campaign." Fewer false triggers, and it names the one job the skill
actually does.!*

## Intro paragraph

> "Use this skill when someone uploads a CSV or donor list and wants to
> generate personalised outreach letters for a fundraising campaign."

*!Replaced with a framing paragraph up front: "An orchestrator, not a
calculator." States the architecture before anything else. Every rule
with one right answer, including tone by tier, lives in code, tested
outside this file, and runs at zero model cost no matter how many
donors are in the batch. That's the one sentence that explains
everything that follows.!*

## "What to do" (5 steps)

> 1. Read the uploaded file and extract donor name, giving history, tier, and region.
> 2. Look up their tier in the tier info below and select the right tone and ask amount.
> 3. Calculate the recommended ask amount using the formula below.
> 4. Use the giving history for each donor from the tables below to personalise the letter.
> 5. Fill in the letter template and return it in-chat as HTML.

*!Every one of these five steps asked a language model to do something
a model is bad at: read and trust a data table, look up a value,
do multi-step arithmetic, and hand-write structured output. Now: six
steps, each one either a real script or a mandatory human checkpoint.!*

**Now, `SKILL.md` "Workflow":**

1. **Validate.** `python scripts/validate_input.py --input <donor_file.csv|.xlsx> --config <campaign.json>`. Reads either CSV or XLSX. Recomputes tier, totals, and lapsed status from each donor's own gift history; never trusts a stated value. Writes `work/exceptions.csv` for anything it can't use, with a specific reason.
2. **Stop and report.** No original counterpart at all. Show the exceptions report before generating anything. This is the mandatory human checkpoint the original never had.
3. **Calculate asks.** `python scripts/calculate_ask.py`. Deterministic function, full step-by-step trace, confidence score. No model arithmetic.
4. **Generate letters.** `python scripts/generate_letters.py`. Writes `output/letters/<donor_id>.html` and `output/manifest.csv`. No chat dump.
5. **Optional bounded personalization.** Off by default, only if asked; guardrails live in `references/personalization_prompt.md` so the common batch-only path doesn't pay their context cost.
6. **Hand off.** Report counts, mandatory vs. recommended review. Nothing is ever sent by this skill.

*!Talking point: steps 1 through 4 never call a model at all. Zero
token cost whether it's 50 donors or 50,000. That's the direct answer
to "cheap and scalable."!*

## Donor Tiers

> **Platinum** (lifetime giving over $50,000): Very formal tone. Assign a
> personal relationship manager name. Always ask for 40% of their largest
> single gift. Mention a naming opportunity.
>
> **Gold** ($10,000-$49,999): Warm but professional. 25%. Legacy giving.
>
> **Silver** ($1,000-$9,999): Friendly tone. 15%. Monthly giving upgrade.
>
> **Bronze** (under $1,000): Casual and encouraging. Flat $150. Peer pages.
>
> **Lapsed** (no gift in over 3 years): Apologetic tone. Tote bag. Flat $50.
>
> **Unknown**: Default to Bronze treatment.

*!This is bundling four different concerns into one prose block: a
threshold, an ask formula, a tone, and a talking point. Split three
ways now, on purpose.!*

- Thresholds go to `policy.md` "Giving tiers," computed by `donor_rules.compute_tier` from `lifetime_total`. Never read from a stated label.
- Ask percentage goes to `policy.md` "Ask amount" and `donor_rules.compute_ask`.
- Tone goes to `policy.md` "Voice by tier" and the `TIER_VOICE` table in `generate_letters.py`.

*!Catch worth calling out by name on camera: running the actual
pipeline against the case study's own 50 donors found four donors
whose stated Tier label disagrees with their own Lifetime Total (Ada
Yamamoto-Pierce, Ruth Andersen, and Shirley Magnusdottir labeled Silver
at $17,000, $25,000, and $22,000 lifetime, all Gold range; Arthur
Mwangi labeled Bronze at $2,600, Silver range). The rewrite catches and
corrects all four automatically.!*

*!Sharper version of the same bug, only visible once "Lapsed" stops
being a sixth tier and becomes its own independent status: Robert
Svensson and Walter Adeyemi are both labeled Platinum but haven't given
since 2020, lapsed by the data's own clock. The original's tier field
can't express "Platinum but currently inactive" at all, since it's one
value. Now: they correctly route to personal outreach instead of
getting a 40 percent, naming-opportunity solicitation.!*

*!"Unknown: default to Bronze" is gone, and correctly impossible now.
Tier is always computed from a real lifetime_total.!*

## Campaign Types and Messaging Angles

> **Emergency Appeal**: ... Tell the donor their gift will be matched
> (even if no match is confirmed, we can sort that out later).
>
> ...
>
> **Unknown campaign**: Default to Annual Fund messaging.

*!This is the single highest-risk line in the original file. It's not
a tone problem, it's an instruction to tell a real donor an unconfirmed
claim about their money. Now: matching language is gated behind a
`match_confirmed` field in the campaign config with a required sponsor
and terms. It's structurally impossible for a letter to mention a match
that hasn't been confirmed, because the code that writes that sentence
only runs when the flag is true.!*

*!"Unknown campaign: default to Annual Fund" also gone. An unrecognized
campaign type now stops the run with an error. Silently sending the
wrong campaign's messaging at scale is worse than stopping.!*

*!One more thing the original never had: Annual Fund's default
paragraph claims "steady support" and "continued partnership," true
for an active donor, false for a lapsed one. A lapsed donor now gets a
different, honest paragraph instead.!*

## Ask Amount Calculation

> 1. Take the donor's largest single gift.
> 2. Multiply by tier percentage.
> 3. Round to the nearest $50.
> 4. If gave last year, add 10% loyalty uplift.
> 5. If volunteer, add $100 flat.
> 6. If Emergency Appeal, multiply by 1.2.
> 7. Output.

*!Two real bugs here, not just "a model shouldn't do math." First: it
rounds at step 3, before the loyalty, volunteer, and emergency
adjustments keep changing the number, so "round to $50" quietly stops
being true most of the time. Fixed: rounding moved to the very last
step, once. Second: "gave last year" is never defined against
anything. Fixed: tied to an explicit `as_of_date` required in every
campaign config.!*

*!Same percentages, same uplifts, same multiplier. This isn't a new
formula, it's the same formula done as one deterministic function with
a full trace instead of prose a model executes per letter.!*

*!Added, not in the original at all: if the computed ask exceeds the
donor's own largest single gift, the letter still generates, but it's
forced into mandatory review instead of silently going out. That's a
judgment call for a fundraiser, not something a formula should decide
alone.!*

## Salutation Rules

> - Platinum and Gold: "Dear [Title] [Last Name],"
> - Silver and Bronze: "Hi [First Name],"
> - Lapsed: "We've missed you, [First Name]!"
> - If no title, guess one based on the first name if it seems obvious.

*!The guessing is the obvious problem: misgendering a donor in a
personalized ask is a real relationship risk, worse the bigger the
gift. Fixed: title only if the file provides one, full name otherwise,
never guessed.!*

*!Less obvious catch, and worth a beat on camera: I also dropped the
tiered greeting styles themselves, "Hi [First]," for Silver and Bronze,
"We've missed you!" for Lapsed. Every donor gets the same respectful
salutation now. A cheerier greeting for a smaller gift reads as
condescending once you notice the pattern across a whole batch, even
though no single letter looks wrong by itself. The tone that greeting
used to carry didn't disappear, it moved into the Voice-by-tier table
below, in the body of the letter instead of the greeting.!*

## Voice by tier (not in the original's structure, but answers its own requirement)

*!This deserves its own beat. The original did specify a real,
distinct tone per tier, very formal down to casual and encouraging, and
that's a legitimate requirement, not decoration. My first pass at this
rewrite accidentally flattened that: it kept the ask math and the
tier-specific closing line, but made the rest of every letter's body
identical regardless of tier. That's not actually "personalized," and
it wasn't something the assessment ever said needed removing. Fixed in
a second pass: `generate_letters.py`'s `TIER_VOICE` table now varies
both the opening thank-you line and the closing sign-off phrase by
tier, the same kind of deterministic, one-right-answer-per-tier
decision as the ask percentage. Facts never vary by tier, only
register does. A lapsed donor's opening still reflects their computed
financial tier, while the invite-back framing lives in the ask
paragraph: a lapsed Gold donor is thanked in a Gold register while
being invited back, never thanked for support they haven't given.!*

## Donor Giving Histories (the ~50-row table)

*!Embedded directly in the prompt, contradicting the file's own step 1,
which says to read the uploaded file. Gone entirely now.
`sample-donors.csv` and `sample-donors.xlsx` hold the same 50 donors,
unchanged in value, as files the pipeline reads, never as instructions
a model reasons over.!*

## HTML Letter Template

*!Same layout, same placeholders, same Georgia-font block. The
difference is who fills it in: the original had a model fill in
`[PLACEHOLDER]` tags by hand. Now, `generate_letters.py`'s `TEMPLATE`
string is filled by `str.format()` from a validated data structure.
Same look, deterministic fill.!*

## Closing line

> "If the donor file has missing fields, make reasonable assumptions and
> proceed."

*!The exact opposite rule now, structurally enforced, not just stated:
`validate_input.py` routes anything missing or unparseable to
`work/exceptions.csv` with a named reason. No assumptions, ever.!*

---

## Live demo: donor-data-review.html answers "how does this scale?"

*!This is the part to actually demo live, not just describe. Open
`donor-data-review.html` in any browser, no install, no server. It
loads the sample data and validates it immediately: same 50 in, 0
exceptions, 4 tier corrections, on screen in real time. Point at the
Findings panel right under the summary numbers: it names the exact
donors by name, Ada Yamamoto-Pierce, Ruth Andersen, Shirley
Magnusdottir, Arthur Mwangi for the tier corrections, Robert Svensson
and Walter Adeyemi for the lapsed-Platinum routing, computed live from
whatever data is actually loaded, not a hardcoded blurb, so it would say
something different if the data were different.!*

*!Then show, live, in this order:!*

- *!**Edit a donor.** Open Ruth Andersen, change her gift history, save.
  Point at the "What changed" box that appears immediately: "Ask amount
  changed from $2,050 to $4,250." That box is new since the first
  version of this tool; the first pass silently recomputed with no
  feedback at all, which I caught by actually testing it, not by
  guessing it would be fine.!*
- *!**Merge a file with a conflicting donor ID.** Upload a second CSV
  with one donor_id that already exists. Point out it does not silently
  overwrite; it drops into a conflict panel showing a real field-by-field
  table, existing versus incoming, and stays out of the computed results
  until a person picks one.!*
- *!**Add one donor by hand.** Show the auto-assigned ID (M001) and the
  new row appearing in the table already validated.!*
- *!**Open a letter and show the plain-language findings.** The warnings
  and review reasons are no longer raw engineering strings; they read
  like "The file said Silver tier, but based on $25,000 in lifetime
  giving, this donor actually qualifies for Gold tier." The exact
  technical string is still there under a "Technical detail" toggle,
  never hidden, just not the first thing a non-technical reader sees.!*
- *!**Confirm a Platinum letter** and point out the ready banner will not
  say "ready" until every flagged donor is confirmed.!*
- *!**Open the change log** near the bottom: every edit, merge, add, and
  confirmation this session, in plain language, with a timestamp.!*
- *!**Export.** Four buttons: the review manifest, the full modified
  donor dataset as a CSV, the change summary as a CSV, and every
  confirmed letter as its own file in one zip, not one combined
  document. That zip is built by a small zip-writer I wrote from
  scratch, verified twice: once by hand against Windows' own unzip tool,
  and permanently by a test that reads the bytes back with a completely
  separate parser.!*

*!Then explain why all of this exists: there's no database, so the file
is the database, and the tool's whole job is validating, merging, and
recomputing it correctly every time a person touches it, which is the
honest answer to Doug's scaling question rather than a promise about
infrastructure that doesn't exist yet.!*

*!One more thing worth saying out loud: this is a second, independent
implementation of the exact same policy the Python scripts run
(`donor_rules.js` mirrors `donor_rules.py`), and that's a real risk, two
copies of business logic can drift apart silently. Point at
`tests/test_js_full_parity.js`: it runs the JavaScript version over the
real 50-donor fixture and diffs every field against the Python
pipeline's actual output. All 50 match, every field, including a
rendered letter byte-identical to the Python one. That's not a claim,
it's a test that fails loudly the moment the two disagree.!*

## Things to mention that don't map to any single original section

*!Worth a dedicated beat, since these came from auditing my own
rewrite, not just the original. Shows the same discipline applied both
ways.!*

- *!A single non-numeric value in the donor file, "TBD" in a gift
  amount, used to crash the entire 50-donor batch, not just that row.
  I reproduced it, then fixed it: unparseable stated values degrade to
  a warning now, since `gift_history` is authoritative regardless.!*
- *!A missing campaign config field used to crash with a raw Python
  traceback. Now it's a named, specific error.!*
- *!A tier correction and an ask that exceeds the donor's own largest
  gift used to only cost a soft confidence penalty. On the real run,
  that put all four tier-corrected donors right at the pass/report
  boundary, only earning "recommended" review. Now both force
  `mandatory` review outright, since they're judgment calls, not data
  quality noise.!*
- *!Compared this rewrite against a second, much larger independent
  rebuild of the same skill. Both converged on the same core diagnosis
  independently: trust nothing, compute everything, gate on review.
  That convergence is itself a useful signal. Where they differ is
  scope: I kept a version stamp on every output row and a lean test
  suite (23 tests), and deliberately left out a correction-and-resubmit
  CLI, a decision log, separate JSON schema files, a style-learning
  loop, and a standalone review UI, each with a specific reason in
  `ASSESSMENT.md` Part 3. Not because they're bad ideas: none of them
  are needed to answer the actual brief, and building them anyway would
  be scope creep dressed as thoroughness.!*
- *!Every number reconciles end to end: 50 donors in, 0 exceptions,
  4 tier labels corrected, 2 lapsed major donors routed to personal
  outreach instead of getting a letter, 48 letters generated, 9 flagged
  for mandatory review. Same result whether the donor file is `.csv` or
  `.xlsx`, confirmed byte-for-byte identical.!*
