# Donor Outreach Policy

Single source of truth for tiers, ask amounts, messaging, and review gates.
`scripts/donor_rules.py` implements these rules. If this document and the
code ever disagree, that is a defect to fix, not an ambiguity to interpret
either way.

Every row in `validated.csv`, `computed.csv`, and `manifest.csv` carries a
`rules_version` stamp (`donor_rules.RULES_VERSION`), bumped whenever a
threshold or formula here changes output for the same input. Any letter
can be traced back to the exact rule version that produced it without
needing git history.

## Input format

Two inputs are required for every run: a donor file and a campaign config.
The skill holds no donor data of its own; `sample-donors.csv` and
`sample-donors.xlsx` are test fixtures, not a data source.

**Donor file (CSV or XLSX).** One row per donor. `scripts/validate_input.py`
reads either format, dispatched by file extension, into the same shape
before anything else runs, so every rule below applies identically no
matter which one a fundraiser exported.

| Column | Required | Notes |
|---|---|---|
| donor_id | yes | Stable unique identifier from the source system. This is the join key everywhere in the pipeline, specifically so two donors who happen to share a name can never collide the way a name-derived key can. |
| donor_name | yes | Full name, for the salutation and letters only. Never used as a lookup key. |
| title | no | Honorific exactly as the donor provided it. Never inferred. Blank is fine and expected. |
| region | no | Optional context field, not currently used in messaging. |
| gift_history | yes | Semicolon-separated `year:amount` pairs, e.g. `2019:500;2021:1200`. This is the only field the pipeline treats as ground truth. |
| largest_gift, lifetime_total, last_gift_year | no | If present, checked against what `gift_history` computes. A disagreement is a warning, not a rejection: the computed value is always what gets used. |
| tier | no | Stated tier, if the source system has one. Verified against the tier computed from `lifetime_total`, never trusted on its own. |
| volunteer | no | Yes/No (also accepts Y/N/true/false/1/0, case-insensitive). Defaults to No when blank. |

Validation stops a row and routes it to `work/exceptions.csv` when: a
required field is missing, `gift_history` cannot be parsed, `donor_id` is
duplicated, or any gift is dated after the campaign's `as_of_date` year.

**Campaign config (JSON).** See `references/campaign_config.example.json`.

| Key | Required | Notes |
|---|---|---|
| campaign_type | yes | One of `emergency_appeal`, `annual_fund`, `capital_campaign`, `event_fundraiser`. Anything else stops the run rather than defaulting silently. |
| as_of_date | yes | `YYYY-MM-DD`. The reference point for every date calculation (lapsed status, loyalty uplift, future-gift checks). Explicit on purpose: a donor file has its own internal clock, and the wall clock the pipeline happens to run on is the wrong instrument for deciding who counts as lapsed. |
| charity_name, donation_url | yes | Rendered in every letter. |
| signer_name, signer_title | yes | The real person who signs every letter, regardless of tier. Never invented. |
| match_confirmed | yes | Boolean. Matching language appears only when `true`. |
| match_sponsor, match_terms | when match_confirmed | Who is matching, and the exact terms. |
| event_registered_count | no | Cited only if present, for `event_fundraiser`. |
| reengagement_gift | no | e.g. "a welcome-back tote", mentioned only if present, for lapsed donors. |

## Giving tiers

Tier is computed from lifetime giving, never taken on faith from a stated
label.

| Tier | Lifetime giving |
|---|---|
| Platinum | $50,000 and above |
| Gold | $10,000 to $49,999 |
| Silver | $1,000 to $9,999 |
| Bronze | under $1,000 |

## Lapsed status

Lapsed is a status layered on top of tier, not a tier of its own:

```
lapsed = (as_of_year - last_gift_year) > 3
```

A lapsed Bronze or Silver donor gets a flat $50 re-engagement ask. A
lapsed Gold or Platinum donor gets no automated letter at all; that
record routes to personal outreach, because a form letter to a lapsed
major donor risks more of the relationship than a flat-rate ask could
raise back.

## Ask amount

All arithmetic runs in `scripts/donor_rules.compute_ask`, never in a
model. Fixed step order, one rounding step at the end:

1. Base: Platinum 40%, Gold 25%, Silver 15% of largest single gift; Bronze
   flat $150; lapsed (Bronze/Silver only) flat $50.
2. Loyalty uplift: if `last_gift_year == as_of_year - 1`, multiply by 1.10.
3. Volunteer uplift: if volunteer, add $100 flat.
4. Emergency multiplier: if `campaign_type` is `emergency_appeal`, multiply
   by 1.2.
5. Round once to the nearest $50, half rounds up. Minimum ask $50.

The loyalty, volunteer, and emergency adjustments apply on top of the
Bronze and lapsed flat bases too, not only the percentage-based tiers.
The original's wording did not say either way; this is a documented
decision, not an accident of the code: a Bronze volunteer donor still
gets the same $100 recognition every other volunteer gets, and a
lapsed donor's flat re-engagement ask still gets the emergency
multiplier during an emergency appeal, for the same reason anyone
else's would.

If the computed ask exceeds the donor's own largest single gift, the
letter is still generated but forced to mandatory review rather than
silently capped. This is a judgment call, not a data problem: the input
is fine, the number is just aggressive relative to history, and that
determination belongs to a fundraiser, not a formula. It is tracked
separately from the confidence score below, which measures something
different: how much the pipeline had to correct or guess about the
input data, not whether the resulting number is one a person should
sanity-check.

## Salutation

- Title present in the file: `Dear {Title} {Last Name},`
- No title: `Dear {First Name} {Last Name},`
- A title, and by extension gender, is never inferred from a first name.
- Every donor gets the same respectful salutation regardless of tier.
  Tone differences between tiers belong in the body of the letter, not in
  how someone is addressed; a cheerier greeting for a smaller gift, or a
  presumptive "we've missed you" opener for a lapsed donor, reads as
  condescending at scale even when no single instance looks wrong.

## Voice by tier

The original specified a distinct register per tier (Platinum very
formal, Gold warm but professional, Silver friendly, Bronze casual and
encouraging), and that is a real requirement, not decoration: a letter
that reads identically to a first-time $50 donor and a $90,000 lifetime
donor is not actually personalized. This is a lookup, in
`scripts/generate_letters.py`'s `TIER_VOICE` table, the same kind of
deterministic decision as the ask percentage: one right answer per
tier, applied by code, never improvised per letter.

Two lines vary by tier: the opening thank-you sentence, and the closing
sign-off phrase. Everything else in the letter (the salutation, the
campaign paragraph, the specific ask) is governed by campaign type and
the donor's own data, not by tier, so that facts never drift with tone.
A lapsed donor's opening line still reflects their computed financial
tier; the re-engagement framing lives in the campaign and ask
paragraphs instead, so a lapsed Gold donor is thanked in a Gold
register while being invited back rather than thanked for ongoing
support they have not given.

## Campaign messaging

One approved base paragraph per campaign type, in `scripts/generate_letters.py`.
A paragraph may only be extended with config-gated facts (a confirmed
match's sponsor and terms, a real event registration count, a computed
giving streak); it never gains a number, promise, or urgency device that
is not already in this document or the campaign config.

- **Emergency appeal.** Matching language appears only when
  `match_confirmed` is true, naming the exact sponsor and terms from the
  config. No match confirmed means no match mentioned.
- **Annual fund.** The default paragraph asserts an ongoing pattern of the
  donor's own giving ("steady support," "continued partnership"), which is
  false for a lapsed donor by definition. A donor with `status = lapsed`
  gets a different paragraph instead, one that does not claim current or
  ongoing giving. A genuine giving streak (2 or more consecutive years
  ending the year before `as_of_date`) may be named for an active donor.
- **Capital campaign.** Fixed paragraph, no config-gated additions.
- **Event fundraiser.** A registration count is cited only from
  `event_registered_count`; if it is empty, no count is mentioned.
- **Unknown campaign type.** The run stops with an error. Defaulting
  silently to another campaign's messaging sends donors the wrong letter
  at scale.

## Content rules for every letter

- Lifetime giving is mentioned in the opening paragraph only when it is
  $500 or more. Thanking someone for "incredible generosity" of $75 reads
  as sarcasm.
- Every letter closes with the real signer named in the campaign config.
  A "relationship manager" name is never invented, for any tier.
- All donor-derived text is HTML-escaped before rendering.

## Review gates

Two separate mechanisms decide how closely a letter gets reviewed, and
they measure different things.

**Confidence** is a fail / report / pass rubric driven by how many
data-quality warnings a record accumulated (each costs 0.10): a stated
field that did not parse, or a stated value that disagreed with what
`gift_history` computes.

- **Below 0.70: fail.** The record is blocked. No letter is generated
  until the data is fixed and the file is resubmitted.
- **Below 0.90: report.** A letter is generated but held for review.
- **0.90 and above: pass.** Any remaining warning still flags
  recommended review; a clean record needs none.

**Mandatory review** is forced outright, independent of confidence
score, whenever the situation is not a data-quality question but a
judgment one: the donor is Platinum tier; the source file's stated tier
disagreed with the computed one (the source system is out of sync with
what this run is about to send, worth a heads-up regardless of how
confident the pipeline is in its own math); the computed ask exceeds
the donor's largest single gift; or the donor is a lapsed Gold or
Platinum major donor routed to personal outreach instead of a letter.
A record can have a perfect data-quality score and still be mandatory
for one of these reasons, on purpose.

Nothing this skill produces is ever sent automatically; output is files
for a fundraiser to review.
