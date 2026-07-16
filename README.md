# charity-donor-outreach: assessment and rewrite

Prepared by Bryan Shaw, in response to the case study brief: assess the
`charity-donor-outreach` skill, describe improvements and their impact,
and rewrite the skill so it produces consistent, reliable output at a
growing scale.

## Where to start

1. **[ASSESSMENT.md](ASSESSMENT.md)** answers both parts of the brief
   directly: what was wrong, why it matters, what changed, and what was
   deliberately left out of scope and why.
2. **[donor-data-review.html](donor-data-review.html)** is the
   interactive tool itself: one self-contained file, no external script
   or data file, no install, no server. Double-click it. It loads the
   case study's sample data, validates it live, and lets you edit, merge
   in more data, and confirm flagged donors, all in the browser, nothing
   ever transmitted anywhere. This is the direct answer to "how does
   this scale without a database."
3. **[SKILL.md](SKILL.md)** is the rewritten skill an AI agent reads for
   the batch/automated path.

## Two front doors, one policy

Every rule lives in `references/policy.md`. Two independent
implementations run it:

- **`scripts/*.py`**, driven by an agent through `SKILL.md`, for batch
  runs at any donor count.
- **`donor_rules.js` + `app.js` + `ui.js`**, driven directly by a
  person in `donor-data-review.html`, for hands-on review with no agent
  and no server involved.

`tests/test_js_full_parity.js` runs both over the same 50-donor fixture
and diffs every field; they must agree, or the test fails and says
exactly where.

## Running the Python pipeline

```
python scripts/validate_input.py --input sample-donors.csv --config references/campaign_config.example.json
python scripts/calculate_ask.py --config references/campaign_config.example.json
python scripts/generate_letters.py --config references/campaign_config.example.json
python -m unittest discover -s tests
```

`sample-donors.csv` and `sample-donors.xlsx` are the case study's
original 50 donors, unchanged in value, in the file format the pipeline
actually reads (both work identically; extension decides which reader
runs). `references/campaign_config.example.json` is a complete example
campaign configuration. `work/` and `output/` are the last run's real,
regeneratable output, kept here as evidence the pipeline runs clean:
0 exceptions, 4 tier labels corrected against their own lifetime
totals, 48 letters generated, 2 lapsed major donors routed to personal
outreach instead of an automated letter.

## Running the interactive tool

Open `donor-data-review.html` directly in a browser (double-click it,
or `file://` it), no server needed. Or, to run the JS test suites,
Node is required:

```
node tests/test_js_parity.js
node tests/test_js_full_parity.js
node tests/test_app_utils.js
```

The interactive tool itself: auto-loads and validates the sample data on
open (matches the Python run exactly, including the 4 tier corrections
and 2 lapsed-major-donor routes, named explicitly in its Findings
panel), lets you edit any donor, merge in more data (a file or a manual
entry), and always shows what changed in plain language before asking
for confirmation. A merge conflict (a donor_id already present) is never
resolved automatically; it's shown field by field for a person to
decide. Sort any column, and use "mark all shown reviewed" to bulk-confirm
donors matching your current filter, only after naming every one of them
in a confirmation dialog first, never silently. Every load, edit, merge,
and confirmation is recorded in an in-page change log, exportable as its
own CSV. A guided tour (top of the page) walks through all of it step by
step. Exports: everything in one zip (manifest, modified donor data,
change log, every confirmed letter as its own file), or each piece
separately. The zip is written by a small in-house zip function, no
external library, verified against Windows' native unzip and against an
independent reader in the test suite. Nothing leaves the browser at any
point; a session can be saved and reloaded as an explicit JSON file the
user downloads and re-uploads themselves.

## Layout

```
SKILL.md                     the skill an agent reads (batch path)
donor-data-review.html       the interactive tool (hands-on path), self-contained, built
donor-data-review.template.html  the source template (edit this, not the built file)
donor_rules.js, app.js, ui.js  the browser-side implementation (canonical source, tested directly)
scripts/                     the deterministic Python pipeline
  donor_rules.py               shared policy logic (tiers, ask math, confidence)
  validate_input.py            step 1: read, verify, recompute (CSV or XLSX)
  calculate_ask.py             step 3: deterministic ask calculation
  generate_letters.py          step 4: render letters, tone by tier
  build_deliverable.py         inlines the sample data and the three .js files into
                                the template, producing the self-contained HTML above
references/
  policy.md                    single source of truth for every rule
  campaign_config.example.json
  personalization_prompt.md    step 5's guardrails (off by default)
tests/
  test_pipeline.py             23 Python tests, stdlib only
  test_js_parity.js            JS unit tests against the same expected values
  test_js_full_parity.js       full-pipeline JS vs. Python diff on the real fixture
  test_app_utils.js            CSV round-trip and the zip writer, read back by an independent parser
sample-donors.csv / .xlsx    the case study's data, as an uploaded file
ASSESSMENT.md                 the written answer to the brief
WALKTHROUGH.md                section-by-section talking points (speaker notes, not a deliverable in itself)
work/, output/                the last Python run's real output
```
