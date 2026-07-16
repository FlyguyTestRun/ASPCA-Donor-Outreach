# Assessment: charity-donor-outreach skill

Prepared by Bryan Shaw.

## Summary

The original skill reads as reasonable prose and fails at every layer that
matters once it has to run more than once. It embeds its data instead of
reading it, trusts labels its own data contradicts, asks a language model
to do arithmetic, invents facts when data is missing, and instructs the
assistant to make an untrue claim to donors. None of that announces
itself. Each failure produces a confident, well-formatted, wrong letter.

The fix is one principle held consistently: verify the data first, then
let each tool do the job it is actually good at. Deterministic code owns
validation, tier computation, ask arithmetic, and rendering. The model is
never in the batch path at all, which is also what keeps this cheap: the
same three scripts process 50 donors or 50,000 for the same cost, zero
model calls either way. A model only ever touches language in one narrow,
optional, explicitly-requested step, grounded in already-verified fields.
Humans review by exception, with mandatory gates where the stakes are
highest.

Run against the case study's own 50 donors: the pipeline recomputes every
number from each donor's own gift history rather than trusting any stated
field, catches four mislabeled tiers, and catches something a label-only
read never would: two donors stated as Platinum who have not given in
over three years by the data's own clock, and who now correctly route to
personal outreach instead of receiving a naming-opportunity solicitation.
Forty-eight letters generate cleanly; the remaining two are exactly those
routed donors.

## Part 1: Findings and their impact

**Unsupported donor claims.** The original instructs the assistant to
tell every donor their gift is matched, "even if no match is confirmed,
we can sort that out later." That is not a hallucination risk to manage;
it is an unsupported fundraising claim written into the instructions,
the kind that creates fraudulent-solicitation exposure. *Fix:* matching
language is gated behind a `match_confirmed` config field with a required
sponsor and terms; it is structurally impossible for a letter to mention
a match the campaign has not confirmed, because the code that writes that
sentence only runs when the flag is true.

**Tier trusted instead of verified, twice over.** The donor database lives
inside the instruction file instead of the CSV the original skill's own
step 1 says to read, and every stated field is trusted on faith. Checking
the supplied table against its own tier thresholds finds four donors
whose stated tier disagrees with their lifetime total (Ada Yamamoto-Pierce,
Ruth Andersen, and Shirley Magnusdottir are labeled Silver at $17,000,
$25,000, and $22,000 lifetime, all Gold range; Arthur Mwangi is labeled
Bronze at $2,600, Silver range). Running the actual pipeline surfaces a
second, sharper version of the same problem: Robert Svensson and Walter
Adeyemi are both labeled Platinum, and both have not given since 2020,
more than three years before the data's own reference date. A tier field
that conflates "gives a lot" with "gives currently" would have sent both
a very formal, 40 percent, naming-opportunity solicitation despite being
lapsed. *Fix:* the skill holds zero donor data of its own and recomputes
tier, totals, and lapsed status from each donor's raw gift history on
every run, never from a stated label. Tier and lapsed status are modeled
as two independent facts, not one field, specifically because "how much"
and "how recently" answer different questions. A lapsed Gold or Platinum
donor gets no automated letter at all; that record routes to personal
outreach, because a form letter to a lapsed major donor risks more of the
relationship than a flat-rate ask could raise back.

**Every derived number, not just tier, needs the same treatment.**
Largest gift, lifetime total, and last gift year are themselves derived
from the gift history, and a source file can state any of them
incorrectly independent of the tier label. *Fix:* all three are
recomputed from `gift_history` and compared against whatever the file
states; a disagreement is a warning that follows the record through the
pipeline, and the computed value is what gets used, always. On the case
study's own 50 rows all three tie out cleanly. Tier is the only field
that does not.

**Calendar drift.** "Lapsed" and "gave last year" are date calculations
with no defined reference point in the original; the data's own internal
clock is 2024, so running the skill on a different day silently changes
who counts as lapsed. *Fix:* every run requires an explicit `as_of_date`
in the campaign config, used everywhere a date matters. The demo config
here points at 2024-06-30, the data's own clock, deliberately: advancing
it to today without two years of donor activity that was never collected
would flip roughly a quarter of this list to lapsed overnight for a
reason that has nothing to do with those donors actually stopping their
giving. Pointing `as_of_date` at today on a live, continuously updated
donor file is exactly correct; dressing up a frozen fixture to look more
current than it honestly is would not be.

**Inconsistent numbers.** A seven-step ask formula executed by a model in
prose rounds mid-sequence and leaves "gave last year" undefined; a model
is a poor calculator even when the formula is exact, and small drift
compounds across a batch. *Fix:* one deterministic function, fixed
operation order, one rounding step at the end, a full trace stored per
donor so any ask amount can be checked back to the rule that produced it.
If a computed ask exceeds the donor's own largest gift, the letter still
generates but is flagged for a fundraiser's review rather than silently
capped; that is a judgment call, not a formula's to make alone.

**Fabricated data and people.** "Make reasonable assumptions and proceed"
on missing fields, and an unsourced "relationship manager name" for
Platinum donors specifically, even though the template signs every
letter regardless of tier. *Fix:* a missing or unparseable required field
routes the row to `work/exceptions.csv` with the specific reason instead
of a guess, and every letter, for every tier, is signed by the real
person named once in the campaign config. Nothing is ever invented.

**Gender and title inference.** The original guesses a title from a first
name "if it seems obvious." *Fix:* a title is used only when the file
provides one; otherwise every donor gets `Dear {First Name} {Last Name},`
with no guessed honorific. This build goes one step further than treating
that as a Platinum-and-Gold-only concession: every tier gets the same
respectful salutation. A cheerier greeting for a smaller gift, or a
presumptive "we've missed you" opener for a lapsed donor, reads as
condescending once you notice the pattern across a whole batch, even
though no single instance looks wrong in isolation. The original's tone
requirement (very formal for Platinum down to casual and encouraging for
Bronze) is real and did not disappear; it moved out of the greeting and
into a deterministic voice table, see Part 4.

**Donors matched by name instead of a stable identifier.** The original
looks donors up by name string throughout. Two donors sharing a name, or
a small typo between systems, can attach one donor's financial history to
a letter addressed to someone else. *Fix:* the donor file carries a
`donor_id` column, and every stage of the pipeline joins on that id, never
on name. This also sidesteps a failure mode common to the alternative
approach of deriving an id from the name at read time (a slugified name
can collide between two different donors); requiring a stable id in the
source file removes that whole class of bug rather than adding a check
for it downstream.

**No scalable review path.** Output was HTML pasted into chat with no
review step, and the trigger fired on nearly any mention of money, email,
or events. *Fix:* letters are files plus a manifest carrying a per-donor
confidence score and review level; every Platinum letter and anything
flagged is reviewed by a person before anything ships. The skill never
sends anything itself. The trigger description now names the one job the
skill does.

## Part 2: The rewrite

`SKILL.md` is a short orchestrator over three deterministic stages, plus
one optional, narrowly bounded step where a model may touch language:

1. **Validate** (`scripts/validate_input.py`): check required fields,
   recompute everything computable from `gift_history`, verify every
   stated value against it, and stop for a person before anything else
   happens.
2. **Calculate** (`scripts/calculate_ask.py`): apply the ask policy from
   `references/policy.md`, with a full trace and a confidence score per
   donor.
3. **Generate** (`scripts/generate_letters.py`): build a small structured
   letter model from the approved paragraph library, validate that model,
   and only then render it to HTML. A letter is complete and correct with
   zero model calls; personalization beyond the template is optional,
   off by default, and constrained to one to two sentences grounded only
   in already-validated fields, per `references/personalization_prompt.md`,
   kept out of `SKILL.md` itself so the common batch-only path does not
   pay the context cost of guardrails it never uses.

`references/policy.md` is the single place tiers, the ask formula,
salutation rules, the messaging library, and review gates are defined.
The scripts implement it; if the two ever disagree, that is a bug in the
code, not a judgment call for whoever reads it next.

`validate_input.py` accepts either a CSV or an XLSX donor file,
dispatched by extension, into the identical shape before anything else
runs. Real donor exports are at least as often Excel files as CSVs;
requiring a fundraiser to convert their own export before this skill
will even read it is friction the pipeline can absorb for free.

**Why `SKILL.md` stays short.** It is the file an agent reads at the
moment it decides what to do next, and every line in it competes for the
same attention a well-written prompt is trying to hold. The rule applied
here: if a line does not change what the agent does next, it belongs in
`references/policy.md` instead, one link away, not in the file the agent
pays the context cost of on every single trigger.

## Part 3: Two independent rebuilds, reconciled deliberately

This rewrite was checked against a second, independent, much larger
rebuild of the same skill (a separate eleven-pass effort covering the
same brief, complete with a schema-validated pipeline, a correction and
resubmit loop, an operational decision log, a style-learning feedback
loop, a Streamlit review UI, and roughly 160 automated tests). Comparing
the two is useful precisely because they converge on the same core
diagnosis independently: read the file, never trust a stated label,
compute deterministically, gate on review. Where they differ is scope,
and every difference below was a deliberate call, not an oversight.

**Adopted from the larger build:** a version stamp (`rules_version`) on
every output row, so any letter traces back to the exact policy version
that produced it; and the discipline of a lean, purpose-built automated
test suite (`tests/test_pipeline.py`, 23 tests, stdlib `unittest`, no
extra dependency to run) locking in exactly the behaviors this rewrite
found and fixed, rather than testing for its own sake.

**Deliberately left out, with the reasoning:**

- **Separate JSON schema files** for the donor row and the letter model.
  A schema file plus a schema-interpreter function is more code than
  writing the checks directly, and it adds a second place (the schema
  and the interpreter) that can drift out of sync. Schema files earn
  their cost when a second consumer needs to validate independently of
  this pipeline; right now there is one pipeline. Inline checks in
  `validate_input.py` and `generate_letters.py` give the identical
  guarantee for less code.
- **A correction-and-resubmit CLI plus an operational decision log.**
  `work/exceptions.csv` already gives a fundraiser a specific, named
  reason per rejected row to fix in their own source system and
  resubmit; that loop already exists in `SKILL.md` step 2. A tool that
  applies structured corrections and logs who approved what earns its
  keep once there is real usage volume and multiple staff approving
  batches. Building it now would be solving a problem this case study
  does not yet have.
- **A style-learning feedback loop.** Even in the build that started
  one, it is admittedly speculative with no outcome data yet to learn
  from. Premature there; premature here too, for the same reason.
- **A server-hosted review application** (the other build's Streamlit
  app). Running a Python server is real infrastructure someone has to
  host, patch, and keep running. A serverless alternative that needs
  nothing running and nothing hosted, a client-side tool that recomputes
  the identical policy in the browser, does the same job for a
  non-technical user at a fraction of the operational cost. That tool
  is `donor-data-review.html`; see Part 6.
- **Webhook escalation, run archiving, a structured JSON mirror of every
  CSV.** Each needs either a real external system to integrate with or
  solves a problem (losing last week's run, needing machine-readable
  output for a second consumer) that does not exist yet at this scale.
  `output/` is overwritten each run; that is disclosed in
  `references/policy.md` rather than engineered around.
- **44 architecture decision records and a docs/ tree.** That is the
  other build's own process history. This document is the equivalent at
  the size this case study actually needs.

The reason for all of it is scope, not doubt: Doug's brief asks for two
things, describe the improvements and their impact, and rewrite the
skill. A skill that reads its own data, verifies rather than trusts
every number, computes deterministically, and gates its highest-stakes
output behind a person answers that brief completely on its own.
Nothing cut here is blocked from being built later; the review level,
confidence score, and manifest already written are exactly the seams a
correction loop or a review UI would attach to without a redesign.

## Part 4: Second pass, auditing the rewrite itself

The same discipline applied to the original was turned on this rewrite
before calling it done. Four things this pass found and fixed:

**A single bad value in the donor file crashed the entire batch.**
Setting one donor's `largest_gift` to a non-numeric placeholder like
`"TBD"`, a near-certainty in a real CRM export, raised an unhandled
exception that took down validation for all 50 donors, not just that
one row. Every other bad-data case in this pipeline degrades to an
excluded row or a warning; this one did not, and it is exactly the
failure mode the original was criticized for at the data layer, just
surfacing one layer down. *Fix:* an unparseable stated value is now a
warning, not a crash; `gift_history` is authoritative regardless, so
there was never a reason for this to be fatal. Verified by reproducing
the crash, then rerunning the same input clean.

**A missing or malformed campaign config crashed with a raw traceback**
instead of a named reason, the same failure mode as above at the config
layer. *Fix:* one shared `load_campaign_config` validates every required
field up front with a specific, human-readable error. Verified the same
way: reproduced the crash with a config missing four required fields,
confirmed the fix names all four.

**Business-meaningful warnings were escalated the same as noise.** A
tier-label mismatch and a soft data-formatting warning both cost the
same 0.10 confidence penalty, so on the real run all four tier-mismatch
donors landed at exactly 0.90 confidence, the pass/report boundary,
which only earns "recommended" review. But a tier correction changes a
donor's entire treatment (percentage, ask, register) and means the
source CRM disagrees with what this run is about to send; that is worth
a guaranteed look, not an easy-to-skip nudge. *Fix:* a tier correction
and a computed ask that exceeds the donor's largest gift now force
`mandatory` review directly, independent of the confidence score, which
is reserved for actual data-quality questions.

**Tone by tier, restored as a deterministic lookup, not a rewrite of the
salutation.** The original specified a distinct register per tier
(Platinum very formal down to Bronze casual and encouraging); the first
pass preserved the ask math and tier-specific closing line but otherwise
made every letter's body copy identical regardless of tier, which is not
actually what "personalized outreach" means and was not something the
original findings called for removing, only the guessing was broken, not
the tone variation itself. *Fix:* `scripts/generate_letters.py` now
selects both the opening thank-you line and the closing sign-off phrase
from a `TIER_VOICE` lookup table, the same style of deterministic
decision as the ask percentage. The facts (campaign paragraph, ask
amount) still never vary by tier; only the register does. A lapsed
donor's opening still reflects their computed financial tier, while the
re-engagement framing lives in the campaign and ask paragraphs, so a
lapsed Gold donor is thanked in a Gold register while being invited back
rather than thanked for support they are not currently giving.

One resolved ambiguity was also written down rather than left implicit:
whether the loyalty, volunteer, and emergency uplifts apply on top of
Bronze's and lapsed donors' flat asks, which the original never states
either way. They do, in this build; `references/policy.md` now says so
directly instead of leaving it to be inferred from the code.

## Part 5: Proof, on the case study's own data

```
python scripts/validate_input.py --input sample-donors.csv --config references/campaign_config.example.json
  rows read: 50, validated: 50, exceptions: 0
  tier label mismatches (computed tier used instead): 4
  other stated-value mismatches: 0

python scripts/calculate_ask.py --config references/campaign_config.example.json
  asks computed: 50, review mandatory: 9, review recommended: 0
  blocked: 0, no letter (routed to a person): 2

python scripts/generate_letters.py --config references/campaign_config.example.json
  letters generated: 48, no letter (routed to a person): 2
  generated letters needing mandatory review: 7
```

The two routed-not-generated records are Robert Svensson and Walter
Adeyemi, the lapsed Platinum donors described above. The nine mandatory
reviews are the five Platinum donors plus the four tier-corrected donors
(Ada Yamamoto-Pierce, Ruth Andersen, Shirley Magnusdottir, Arthur
Mwangi), two of the nine with no letter at all and seven with a
generated letter still held for review; recommended review sits at zero
because every donor that used to land there had a reason serious enough
to be mandatory instead, per Part 4. Every number above reconciles
across all three stages by construction, since each stage's output file
is the next stage's only input.

`sample-donors.csv` is the case study's original donor table, unchanged
in value, moved out of the instructions and into the file format the
pipeline actually reads. `sample-donors.xlsx` is the same 50 rows as an
Excel file; running `validate_input.py` against it produces a
byte-identical `validated.csv` to the CSV run, confirmed directly.
`python -m unittest discover -s tests` passes all 23 tests.

## Part 6: A second front door, and the answer to "how does this scale?"

`SKILL.md` and the Python scripts answer how an AI agent runs this
reliably in a batch. They assume something is already driving the
agent, uploading a file, and reading its output. That leaves an open
question: what does a fundraiser who is not working through an agent
actually do?

`donor-data-review.html` is the answer, and it is not a report of a
Python run anymore, it is the program itself. `donor_rules.js` and
`app.js` are a faithful, tested port of the exact same policy the
Python scripts implement: open the file in any browser, and it loads
the case study's sample data, validates it, recomputes every tier and
ask, and shows the result immediately, no install, no server, nothing
transmitted anywhere. A person can then:

- **Replace or merge in more data**, from another file or one donor
  entered by hand. There is no database behind this; the working set is
  whatever is currently loaded in the browser tab, which is the honest
  answer to scaling without persistent storage: the file is the
  database, and the tool's job is to validate, merge, and recompute it
  correctly every time, not to pretend it owns a system of record it
  does not have.
- **Edit any donor's data directly**, and watch it recompute live. If
  that donor's tier, ask, or letter changes as a result, and it had
  already been confirmed, the confirmation clears automatically. A
  stale approval is treated as no approval at all.
- **Merge conflicts are never resolved automatically.** A donor ID that
  already exists in the working set is shown side by side, existing
  versus incoming, and stays out of the computed results until a person
  picks one.
- **Every Platinum donor, every tier correction, and every ask that
  exceeds a donor's own giving history is visibly flagged and requires
  an explicit confirmation checkbox before it counts as reviewed.** The
  ready banner at the top will not say the batch is ready until every
  flagged donor has been confirmed, matching the original's own stated
  intention that the highest tiers get the most scrutiny, just enforced
  structurally instead of hoped for.
- **A session can be saved and reloaded** as an explicit JSON file the
  user downloads and re-uploads themselves. Nothing persists
  automatically between visits; nothing is written anywhere without the
  user choosing to write it.

**Keeping two implementations of the same policy honest.** A JavaScript
port of Python logic is a real risk: the two can quietly drift apart.
`tests/test_js_parity.js` asserts the JavaScript version against the
exact same expected values the Python test suite asserts. More directly,
`tests/test_js_full_parity.js` runs the JavaScript pipeline over the
real 50-donor fixture and diffs every field against the Python
pipeline's actual output file by file: as of this build, all 50 donors
match on every compared field, and a rendered letter (Ruth Andersen's,
the corrected Gold-tier donor) is byte-identical to the Python-rendered
version once line endings are normalized. If the two ever disagree,
that test fails and says exactly which donor and which field.

## Part 7: This build against the reference build, compared directly

A second, independent, eleven-pass rebuild of the same skill exists,
also live: its own `donor-data-review.html` is hosted on GitHub Pages.
This section compares the two directly, having actually used both, not
just read one's source.

**The findings are the same skill, examined twice, not two different
verdicts.** Both rebuilds land on the same core diagnosis of the
original: it embeds data instead of reading it, trusts a tier label its
own data contradicts, fabricates a match claim, guesses gender, and asks
a model to do arithmetic. Both catch the identical four tier-label
mismatches in the mocked data (Ada Yamamoto-Pierce, Ruth Andersen,
Shirley Magnusdottir, Arthur Mwangi) because both compute tier from
lifetime giving instead of trusting a label. What changed in this
build's second and third passes was never the findings; it was the
tooling built to surface and act on them. That convergence, reached
independently, is itself evidence the diagnosis is right, not an
accident of two people copying each other.

**Where the architectures genuinely differ, and why that is not a small
detail.** The reference build's browser tool edits and reviews data, but
it does not compute: its own code says so directly ("the browser never
recomputes an ask"), and its workflow is edit in the browser, download a
cleaned CSV, then run `calculate_ask.py` and `generate_letters.py` in
Python to see real updated numbers. This build's browser tool computes
everything live: `donor_rules.js` is a full, tested port of
`donor_rules.py`, so an edit shows its real, recalculated consequence
immediately, no round trip through a terminal. Neither choice is simply
better; they trade different things:

- The reference build's approach has a real advantage: there is exactly
  one implementation of the business logic, in Python, so there is no
  possibility of two engines quietly disagreeing. Its cost is friction:
  a person reviewing donor data cannot see the actual effect of a
  correction without leaving the browser.
- This build's approach directly answers what was actually asked for
  throughout this exercise (a tool a non-technical user can use
  entirely on their own, seeing a change's real effect immediately) at
  the cost of taking on a real risk: two implementations of the same
  policy that could drift apart silently. That risk is not waved away;
  it is the reason `tests/test_js_full_parity.js` exists, diffing the
  JavaScript engine against the Python engine's real output on every
  run, field by field, and failing loudly the moment they disagree.

**What this build adopted from the reference build, on inspection, and
what it deliberately did not.** Its live version has a clear numbered
step tracker (data loaded, errors found, review and correct, sign off,
export) that this build's original dashboard-style layout lacked; that
pattern was adopted directly (see `donor-data-review.html`'s step
tracker, now with two independent gates, data exceptions and donor
confirmations, rather than one). Its page is also a far denser
documentation surface, walking a technical reader through ADRs and
architecture decisions inline on the same page as the data. This build
deliberately keeps the tool itself lean and puts that depth in
`ASSESSMENT.md` and `WALKTHROUGH.md` instead, on the judgment that a
tool meant for a fundraiser to actually use should not also try to be a
technical essay; a reader who wants the deep reasoning has it, one link
away, without every visitor paying the context cost of reading past it.

**What this build has that the reference build does not.** A single
"download the complete package" export bundling the review manifest,
the full modified donor data, the change log, every confirmed letter as
its own file, `SKILL.md`, `ASSESSMENT.md`, and a working copy of the
tool itself, all in one zip, generated from inside the tool with one
click. The reference build's export is narrower: a cleaned CSV, meant
to be fed back into the Python pipeline. Plain-language translation of
every technical warning and review reason, with the original technical
string always one click away, not replaced. A merge-conflict view that
shows the exact fields that differ, not just the two donor names. A
bulk-confirm action that is not a silent shortcut: it names every donor
it is about to mark reviewed, in a real confirmation dialog, before
doing anything, so it cannot become a way to wave through donors nobody
actually looked at.

**The honest answer to "which is better."** For the literal brief,
consistent, reliable, scalable, both satisfy it; the deterministic
pipeline underneath is materially the same idea in both. For a
non-technical fundraiser working alone, without a terminal, this build
is the stronger answer, because it is the one where editing data and
seeing the truth immediately are the same action. For an organization
that would rather never run two implementations of the same logic and
is comfortable asking staff to use a terminal step, the reference
build's simpler, single-engine design is the more conservative choice,
and conservative is not a criticism in a system that computes what a
real donor gets asked for.
