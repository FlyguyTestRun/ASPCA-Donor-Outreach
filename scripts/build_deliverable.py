"""Build the self-contained donor-data-review.html from its template.

Usage:
    python scripts/build_deliverable.py

Reads donor-data-review.template.html and inlines, in order: the sample
data (from sample-donors.csv and references/campaign_config.example.json,
so there is exactly one authored copy of each), then the contents of
donor_rules.js, app.js, and ui.js verbatim. Writes the result to
donor-data-review.html: one file, zero external <script src> references.

Why this matters: a page opened directly from disk (file://, i.e.
double-clicking it) cannot reliably fetch() a sibling file, and several
browsers additionally restrict or block <script src="local-file.js">
entirely for file:// pages as a security measure. A page that references
no external script or data file at all sidesteps both problems by
construction, which is also the pattern the reference GitHub build uses.
The three .js files stay the canonical, tested source (see
tests/test_js_parity.js, test_js_full_parity.js, test_app_utils.js,
which import them directly under Node); this script only inlines copies
of them into the shipped HTML, it does not fork their logic.
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLACEHOLDER = "<!-- BUILD:INLINE_SCRIPTS -->"


def build_data_script() -> str:
    csv_text = (ROOT / "sample-donors.csv").read_text(encoding="utf-8")
    config_text = (ROOT / "references" / "campaign_config.example.json").read_text(encoding="utf-8-sig")
    config = json.loads(config_text)
    # SKILL.md, ASSESSMENT.md, and README.md are embedded too, purely as
    # text, so the page's own "download everything" export can include
    # them without a fetch() (blocked over file://) and without asking
    # the user to separately go find them. A person handed just the
    # exported zip gets the whole package: the skill, the assessment, and
    # the tool itself, the same thing this repository ships.
    skill_text = (ROOT / "SKILL.md").read_text(encoding="utf-8")
    assessment_text = (ROOT / "ASSESSMENT.md").read_text(encoding="utf-8")
    readme_text = (ROOT / "README.md").read_text(encoding="utf-8") if (ROOT / "README.md").exists() else ""
    return (
        "<script>\n"
        "/* Embedded starting data and documents, generated from the canonical files. */\n"
        "var SAMPLE_DONORS_CSV = " + json.dumps(csv_text) + ";\n"
        "var DEFAULT_CAMPAIGN_CONFIG = " + json.dumps(config, indent=2) + ";\n"
        "var SKILL_MD_TEXT = " + json.dumps(skill_text) + ";\n"
        "var ASSESSMENT_MD_TEXT = " + json.dumps(assessment_text) + ";\n"
        "var README_MD_TEXT = " + json.dumps(readme_text) + ";\n"
        "</script>"
    )


def inline_script(filename: str) -> str:
    content = (ROOT / filename).read_text(encoding="utf-8")
    if "</script" in content.lower():
        raise ValueError(f"{filename} contains a literal '</script' string, cannot inline safely")
    return f"<script>\n/* Inlined from {filename}. Edit that file, not this one; run this build script to regenerate. */\n{content}\n</script>"


def main() -> None:
    template_path = ROOT / "donor-data-review.template.html"
    template = template_path.read_text(encoding="utf-8")
    if PLACEHOLDER not in template:
        raise ValueError(f"{template_path} is missing the {PLACEHOLDER!r} marker")

    inlined = "\n".join([
        build_data_script(),
        inline_script("donor_rules.js"),
        inline_script("app.js"),
        inline_script("ui.js"),
    ])
    page = template.replace(PLACEHOLDER, inlined)

    out_path = ROOT / "donor-data-review.html"
    out_path.write_text(page, encoding="utf-8")

    remaining_src_tags = page.count("<script src=")
    print(f"wrote {out_path} ({out_path.stat().st_size:,} bytes)")
    print(f"external <script src> tags remaining: {remaining_src_tags} (must be 0)")
    if remaining_src_tags:
        raise SystemExit("BUILD FAILED: external script references remain; the file will not open reliably via file://")


if __name__ == "__main__":
    main()
