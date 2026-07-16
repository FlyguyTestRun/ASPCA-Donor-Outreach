---
name: charity-donor-outreach
description: >-
  Use this skill when a user uploads a donor file and asks to generate
  personalized outreach letters for a fundraising campaign.
---

# Charity Donor Outreach Letter Generator

An orchestrator, not a calculator: every rule with one right answer,
including tone by tier, lives in code, tested outside this file, and
runs at zero model cost regardless of how many donors are in the batch.
`references/policy.md` is the full policy this pipeline implements; this
file only holds what changes what the agent does next.

## Required inputs

1. **Donor file** (CSV or XLSX), at minimum donor_id, donor_name,
   gift_history. Full format in `references/policy.md`.
   `sample-donors.csv` / `sample-donors.xlsx` are test fixtures, not a
   data source.
2. **Campaign config** (JSON): campaign_type, as_of_date, charity_name,
   donation_url, signer_name, signer_title, match_confirmed (plus sponsor
   and terms if true). Example at `references/campaign_config.example.json`.

If the donor file is uploaded without a campaign config, ask for the
config; do not wait for both before engaging. Never fill in a charity
name, donation URL, signer, date, or campaign type yourself.

## Workflow

### Step 1: Validate

```
python scripts/validate_input.py --input <donor_file.csv|.xlsx> --config <campaign.json>
```

(Use `python3` instead of `python` if that is what resolves on the host.)

Writes `work/validated.csv` and `work/exceptions.csv` (every rejected row
with a specific reason). Tier, totals, and lapsed status are recomputed
from each donor's gift history here; a stated value that disagrees is
never used, only flagged and carried forward as a warning. A missing or
invalid campaign config stops here with a named reason, not a stack
trace.

### Step 2: Stop and report

Show the user the validation summary and the full contents of
`work/exceptions.csv` before generating anything. Excluded rows stay
excluded until a person fixes the source file and this step is rerun.

### Step 3: Calculate asks

```
python scripts/calculate_ask.py --config <campaign.json>
```

Writes `work/computed.csv`: ask amount, a full step-by-step calculation
trace, a confidence score, and a review level per donor. Never adjust an
ask amount yourself, for any reason.

### Step 4: Generate letters

```
python scripts/generate_letters.py --config <campaign.json>
```

Renders every valid donor's letter from the approved paragraph library in
`references/policy.md`, then writes `output/letters/<donor_id>.html` and
`output/manifest.csv`. Register (formal, warm, friendly, casual and
encouraging) varies by tier here, by a fixed lookup table, the same way
the ask percentage does; it is not something to write or adjust
yourself, in this step or step 5. A lapsed Gold or Platinum donor gets
no automated letter; that record routes to personal outreach instead.

### Step 5: Optional bounded personalization

Only if the user explicitly asks for a letter to read as more
personalized than the template, and only against one already-generated
letter at a time. Follow `references/personalization_prompt.md` exactly;
its guardrails are not repeated here so the common batch-only path never
pays their context cost. In short: ground everything in
`work/computed.csv` or the campaign config, never introduce a number,
promise, honorific, or urgency device not already present, and leave the
paragraph unchanged if you cannot personalize within those bounds.

### Step 6: Hand off

Report letters generated, rows excluded to exceptions, and how many
letters are flagged mandatory versus recommended for review. Nothing is
ever sent by this skill.

## Hard rules

- **No automatic sending, ever.** Everything else this pipeline
  guarantees (no in-model arithmetic, no guessed names or honorifics, no
  unconfirmed matching claims, no fabricated data) is enforced by the
  scripts themselves and documented in `references/policy.md`; this is
  the one rule that is about the agent's own behavior in the wider
  session, not something the code already prevents.
- If a step's script reports an error, stop and show the user the exact
  message. Do not work around it, retry with different arguments, or
  paper over it when reporting back.
