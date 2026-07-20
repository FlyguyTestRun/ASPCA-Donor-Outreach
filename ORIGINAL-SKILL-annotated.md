# The original skill, annotated

`ORIGINAL-SKILL.md` in this folder is the charity donor outreach skill exactly
as I received it for the case study, unedited. This file is my section by
section review of that original: what each instruction was, the specific
problem it creates once the skill has to run more than once, and the
deterministic code in this repository that replaces the guessed step.

The idea behind every change is the same. Verify the data first, then let
deterministic code own anything with one correct answer. The language model
never runs the batch, which is what keeps the result identical on every run
and the cost flat as the donor list grows. A person reviews by exception, and
the highest stakes steps are gated so nothing ships without a human decision.

Every code block below is the real function from `scripts/`, not a paraphrase.

## 1. Trigger description

Original:

> Use this skill whenever a user mentions donors, fundraising, money, emails,
> letters, charity, nonprofits, campaigns, giving, volunteers, events, reports,
> grants, sponsorships, or any kind of outreach or communication task.

**Problem.** This fires on almost any business sentence. In an environment with
several skills, a trigger this broad collides with the others and pulls
unrelated requests into the letter generator.

**Fix.** The description is narrowed to the one job the skill actually does:
generating outreach letters from an uploaded donor file for a fundraising
campaign.

## 2. What to do

Original:

> 1. Read the uploaded file and extract donor name, giving history, tier, and region.
> 2. Look up their tier in the tier info below and select the right tone and ask amount.
> 3. Calculate the recommended ask amount using the formula below.
> 4. Use the giving history for each donor from the tables below to personalise the letter.
> 5. Fill in the letter template and return it in-chat as HTML.

**Problem.** Every one of these steps asks a probabilistic model to do work that
has one correct answer. Reading and trusting a table, looking up a value,
running multi step arithmetic, and hand writing structured output are all
places a model can be confidently wrong, and none of it announces the error.

**Fix.** The workflow becomes validate, stop and report to a human, calculate,
generate, then hand off. The steps that compute never call a model at all, so
the token cost is the same for 50 donors or 50,000.

## 3. Donor tiers

Original:

> Platinum (lifetime giving over $50,000) ... Gold ($10,000 to $49,999) ...
> Silver ($1,000 to $9,999) ... Bronze (under $1,000) ...
> Unknown: Default to Bronze treatment.

**Problem.** The skill trusts the tier stated in the file. On the case study's
own data, four donors carry a tier label that disagrees with their own lifetime
giving. A stated tier is a claim, not a fact.

**Fix.** Tier is computed from lifetime giving on every run, never read from a
label.

```python
def compute_tier(lifetime_total: float) -> str:
    for tier, minimum in TIER_MINIMUMS:
        if lifetime_total >= minimum:
            return tier
    return "Bronze"
```

Validation then compares the computed tier against whatever the file stated and
forces a human review when they disagree:

```python
computed_tier = rules.compute_tier(computed_lifetime)
stated_tier = (row.get("tier") or "").strip()
if stated_tier and stated_tier not in ("Lapsed", "Unknown") and stated_tier != computed_tier:
    mandatory_reasons.append(
        f"tier corrected from {stated_tier!r} to {computed_tier!r}: "
        "verify against the source system before sending")
```

## 4. Campaign types

Original:

> Emergency Appeal: Use urgency language. Mention that every hour counts. Tell
> the donor their gift will be matched (even if no match is confirmed, we can
> sort that out later).

**Problem.** This is the highest risk line in the file. It instructs the
assistant to make an unconfirmed claim to a donor about their own money. That is
a fundraising claim written into the instructions, the kind that creates real
legal and reputational exposure for a nonprofit.

**Fix.** Matching language is gated behind an explicit `match_confirmed` flag in
the campaign config, with a required sponsor and terms. It is structurally
impossible for a letter to mention a match the campaign has not confirmed,
because the sentence that states it only runs when the flag is true.

```python
if config.get("match_confirmed"):
    # only inside this branch does any match language enter the letter,
    # naming the real sponsor and terms supplied in the campaign config
    paragraph += f" Thanks to a generous match from {rules.esc(config['match_sponsor'])}, ..."
```

## 5. Ask amount calculation

Original:

> 1. Take the donor's largest single gift.
> 2. Multiply by the tier percentage.
> 3. Round to the nearest $50.
> 4. If gave last year, add 10% loyalty uplift.
> 5. If volunteer, add $100 flat.
> 6. If Emergency Appeal, multiply by 1.2.
> 7. Output.

**Problem.** Two issues, beyond the general point that a model is a poor
calculator. First, it rounds at step 3, before three later steps keep changing
the number, so "round to $50" quietly stops being true. Second, "gave last year"
is never defined against any reference date, so the same input produces a
different answer depending on the day the skill runs.

**Fix.** One deterministic function, fixed operation order, a single rounding
step at the very end, and a full trace stored per donor. "Last year" is measured
against an explicit as of date from the campaign config.

```python
    if last_gift_year == as_of_year - 1:
        amount *= 1 + LOYALTY_UPLIFT
    if volunteer:
        amount += VOLUNTEER_UPLIFT
    if campaign_type == "emergency_appeal":
        amount *= EMERGENCY_MULTIPLIER

    rounded = max(round_half_up(amount), MIN_ASK)   # one rounding step, at the end
    result.amount = rounded
```

The same function routes a lapsed major donor to personal outreach instead of a
form letter, and flags any ask that exceeds the donor's own largest gift for a
fundraiser to judge rather than capping it silently.

## 6. Salutation rules

Original:

> If no title is available, guess one based on the first name if it seems obvious.

**Problem.** Guessing a title means guessing gender from a first name. It fails
on ambiguous names and on names from many cultures, and misgendering a donor in
the first line of an ask is exactly the kind of error that damages a
relationship, worse for higher tier donors.

**Fix.** A title is used only when the file provides one. Otherwise the letter
uses the donor's full name with no guessed honorific, and the record is flagged
for review, which is what the original's own next line already asked for.

```python
    tier = donor.get("tier")
    if tier in ("Platinum", "Gold"):
        title = donor["title"]
        if title:
            return f"Dear {rules.esc(title)} {rules.esc(last)},"
        return f"Dear {rules.esc(first)} {rules.esc(last)},"
    return f"Hi {rules.esc(first)},"
```

## 7. Donor giving histories

Original: a table of donor records embedded directly in the skill file.

**Problem.** The skill's own step 1 says to read an uploaded file, yet the data
is also hardcoded into the instructions. That is two sources of truth for the
same records, it sends donor information to the model on every run whether it is
needed or not, and it caps the skill at whatever fits in the file. It cannot
grow with the donor list without editing the skill itself, which is the opposite
of the case study's stated goal.

**Fix.** The skill holds no donor data of its own. The uploaded CSV or XLSX is
the only source, read once and verified before anything else runs.

## 8. HTML letter template

Original: an HTML template with `[PLACEHOLDER]` tags for the model to fill in.

**Problem.** Leaving a model to fill placeholders by hand is where a wrong
number, an invented staff name, or an unescaped value slips into a finished
letter.

**Fix.** The same template is filled by code from a validated data structure,
and the letter model is checked before it is ever rendered. Every value in the
letter traces back to a verified field.

---

The full written assessment is in `ASSESSMENT.md`, and the interactive tool that
runs all of this in the browser is `donor-data-review.html`, live at
https://flyguytestrun.github.io/ASPCA-Donor-Outreach/.
