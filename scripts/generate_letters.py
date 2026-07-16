"""Render one HTML letter per validated, computed donor. No model call.

Usage:
    python generate_letters.py --config <campaign.json> [--workdir work] [--outdir output]

Reads work/computed.csv, builds a small structured letter model per donor
from the approved paragraph library below (gated strictly by config
fields, per references/policy.md), validates that model, then renders it
to output/letters/<donor_id>.html. Donors with no ask_amount (blocked, or
a lapsed Gold/Platinum donor routed to personal outreach) get no letter
and are recorded in the manifest with the reason. Nothing is ever sent;
output is files for a person to review.
"""

from __future__ import annotations

import argparse
import csv
import re
import sys
import time
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import donor_rules as rules

BASE_PARAGRAPHS = {
    "emergency_appeal": (
        "Right now, animals rescued from cruelty and neglect need emergency "
        "shelter, veterinary care, and a safe place to recover. Your gift "
        "today goes to work immediately, funding rescue operations and "
        "urgent medical treatment for animals with nowhere else to turn."
    ),
    "annual_fund": (
        "Year after year, steady support from donors like you is what "
        "allows us to plan rescues, staff shelters, and answer every call "
        "for help. Your continued partnership is the foundation this work "
        "is built on."
    ),
    "annual_fund_lapsed": (
        "Our work to plan rescues, staff shelters, and answer every call "
        "for help depends on donors who step back in when they are able. "
        "We would be glad to have you with us again."
    ),
    "capital_campaign": (
        "We are building spaces that will shelter and heal animals for "
        "decades to come. A gift to this campaign is a lasting investment, "
        "one that will still be saving lives long after the construction "
        "dust has settled."
    ),
    "event_fundraiser": (
        "Our upcoming event brings together supporters from across the "
        "community for the animals we all care about. We would love for "
        "you to be part of it."
    ),
}

# Register varies by tier as a code lookup, never as model judgment: the
# original asked for a distinct tone per tier (very formal / warm and
# professional / friendly / casual and encouraging) and that is a
# personalization decision with a single right answer per tier, exactly
# like the ask percentage. It belongs here, not left to a model to
# improvise per letter. Facts and figures never vary by tier; only the
# register of the thank-you opening, the closing invitation, and the sign-off
# phrase do.
TIER_VOICE = {
    "Platinum": {
        "thanks": "On behalf of everyone at {charity}, I want to extend my deepest, most personal gratitude for your extraordinary generosity.",
        "closing_phrase": "With my deepest gratitude",
    },
    "Gold": {
        "thanks": "On behalf of everyone at {charity}, I want to personally thank you for your generosity and your continued partnership with our work.",
        "closing_phrase": "With gratitude",
    },
    "Silver": {
        "thanks": "On behalf of everyone at {charity}, thank you so much for your generosity and for being part of our community of supporters.",
        "closing_phrase": "With thanks",
    },
    "Bronze": {
        "thanks": "On behalf of everyone at {charity}, thank you for your support. Every gift, no matter the size, helps make a real difference.",
        "closing_phrase": "Thanks so much",
    },
    # Lapsed is its own register per the original ("Apologetic tone"), used
    # instead of the donor's computed financial tier's voice whenever an
    # automated letter is actually generated for a lapsed donor (Silver and
    # Bronze lifetime ranges only; a lapsed Gold or Platinum donor never
    # reaches this at all, routed to personal outreach in compute_ask).
    "Lapsed": {
        "thanks": "On behalf of everyone at {charity}, I wanted to reach out personally. It has been a while since we last heard from you, and we have missed having you as part of our community.",
        "closing_phrase": "Hoping to welcome you back",
    },
}

TIER_CLOSING_LINE = {
    "Platinum": "Given your extraordinary generosity, I would welcome a conversation about a naming opportunity in recognition of your support.",
    "Gold": "Your gift can also be structured as a legacy commitment; I am glad to share more about our legacy giving options.",
    "Silver": "Consider spreading your impact across the year with our monthly giving option.",
    "Bronze": "You can also multiply your impact by starting your own peer fundraising page!",
}

LIFETIME_MENTION_MINIMUM = 500
REQUIRED_LETTER_FIELDS = [
    "donor_id", "letter_date", "salutation", "opening_paragraph",
    "campaign_paragraph", "ask_paragraph", "closing_phrase",
    "signer_name", "signer_title", "charity_name", "donation_url",
]


def build_campaign_paragraph(donor: dict, config: dict) -> str:
    campaign_type = config["campaign_type"]
    if campaign_type == "emergency_appeal":
        text = BASE_PARAGRAPHS["emergency_appeal"]
        if config.get("match_confirmed"):
            text += (
                f" Thanks to a generous match from {rules.esc(config['match_sponsor'])}, "
                f"your gift will be {rules.esc(config['match_terms'])}."
            )
        return text
    if campaign_type == "annual_fund":
        lapsed = donor["status"] == "lapsed"
        text = BASE_PARAGRAPHS["annual_fund_lapsed"] if lapsed else BASE_PARAGRAPHS["annual_fund"]
        streak = int(donor["streak"])
        if not lapsed and streak >= 2:
            text += f" This gift will mark {streak + 1} years in a row you have stood with us."
        return text
    if campaign_type == "capital_campaign":
        return BASE_PARAGRAPHS["capital_campaign"]
    if campaign_type == "event_fundraiser":
        text = BASE_PARAGRAPHS["event_fundraiser"]
        count = config.get("event_registered_count")
        if count:
            text += f" Already, {count} people have registered to join us."
        return text
    raise ValueError(f"unknown campaign_type: {campaign_type!r}")


def build_ask_paragraph(donor: dict, config: dict) -> str:
    ask = int(float(donor["ask_amount"]))
    lapsed = donor["status"] == "lapsed"
    if lapsed:
        line = "It would mean a great deal to have you back among our supporters."
        gift = config.get("reengagement_gift")
        if gift:
            line += f" As a thank-you for stepping back in, we would like to send you {rules.esc(gift)}."
    else:
        line = TIER_CLOSING_LINE.get(donor["tier"], "")
    return f"Today, I would like to invite you to make a gift of ${ask:,}. {line}".strip()


def build_salutation(donor: dict) -> str:
    """Per the original's Salutation Rules: Lapsed gets its own opener
    regardless of computed tier; Platinum/Gold use title + last name (full
    name if no title is on file, never a guessed honorific, flagged for
    review separately in validate_input.py); Silver/Bronze use first name
    only."""
    first, last = rules.split_name(donor["donor_name"])
    if donor.get("status") == "lapsed":
        return f"We've missed you, {rules.esc(first)}!"
    tier = donor.get("tier")
    if tier in ("Platinum", "Gold"):
        title = donor["title"]
        if title:
            return f"Dear {rules.esc(title)} {rules.esc(last)},"
        return f"Dear {rules.esc(first)} {rules.esc(last)},"
    return f"Hi {rules.esc(first)},"


def _voice_key(donor: dict) -> str:
    return "Lapsed" if donor.get("status") == "lapsed" else donor["tier"]


def build_opening_paragraph(donor: dict, charity_name: str) -> str:
    voice = TIER_VOICE[_voice_key(donor)]
    text = voice["thanks"].format(charity=rules.esc(charity_name))
    lifetime = float(donor["lifetime_total"])
    if lifetime >= LIFETIME_MENTION_MINIMUM:
        text += f" Your lifetime support of ${lifetime:,.0f} has made a real difference."
    return text


def build_letter_model(donor: dict, config: dict, letter_date: str) -> dict:
    # A Platinum donor with a named relationship manager is signed by that
    # person, not the campaign's generic signer, the whole point of
    # "assign a personal relationship manager" is that the letter comes
    # from a specific human this donor is meant to know. No relationship
    # manager on file falls back to the normal campaign signer (never
    # invented), and validate_input.py already forces mandatory review on
    # that donor so the fallback is a visible, confirmed choice, not a
    # silent one.
    manager = (donor.get("relationship_manager") or "").strip()
    use_manager = donor["tier"] == "Platinum" and manager
    signer_name = manager if use_manager else config["signer_name"]
    signer_title = "Personal Relationship Manager" if use_manager else config["signer_title"]
    return {
        "donor_id": donor["donor_id"],
        "letter_date": letter_date,
        "salutation": build_salutation(donor),
        "opening_paragraph": build_opening_paragraph(donor, config["charity_name"]),
        "campaign_paragraph": build_campaign_paragraph(donor, config),
        "ask_paragraph": build_ask_paragraph(donor, config),
        "closing_phrase": TIER_VOICE[_voice_key(donor)]["closing_phrase"],
        "signer_name": rules.esc(signer_name),
        "signer_title": rules.esc(signer_title),
        "charity_name": rules.esc(config["charity_name"]),
        "donation_url": rules.esc(config["donation_url"]),
    }


def validate_letter_model(model: dict) -> list[str]:
    """Structured check before rendering. A model that fails this is never rendered."""
    errors = []
    for field_name in REQUIRED_LETTER_FIELDS:
        value = model.get(field_name)
        if not isinstance(value, str) or not value.strip():
            errors.append(f"missing or empty required field: {field_name}")
    amounts = re.findall(r"\$[\d,]+", model.get("ask_paragraph") or "")
    if len(amounts) != 1:
        errors.append(f"ask_paragraph must contain exactly 1 dollar amount, found {len(amounts)}")
    url = model.get("donation_url") or ""
    if url and not url.startswith(("http://", "https://")):
        errors.append("donation_url must be an http(s) URL")
    return errors


TEMPLATE = """<html>
<body style="font-family: Georgia; padding: 30px; max-width: 600px; color: #222;">

  <p style="text-align:right; color: #888;">{letter_date}</p>

  <p>{salutation}</p>

  <p>{opening_paragraph}</p>

  <p>{campaign_paragraph}</p>

  <p>{ask_paragraph}</p>

  <p>To give, simply reply to this email or visit our donation page at
  <strong>{donation_url}</strong>.</p>

  <p>{closing_phrase},<br>
  <strong>{signer_name}</strong><br>
  {signer_title}, {charity_name}</p>

</body>
</html>
"""

# A donor who gets no automated letter (routed to personal outreach,
# blocked by low confidence, or failed validation entirely) still gets an
# HTML file, per the original's "produce them (all of them)": no donor is
# ever silently absent from the output. Deliberately shaped nothing like
# TEMPLATE above, an internal review record, not a solicitation, so it can
# never be mistaken for one and sent by accident.
PLACEHOLDER_TEMPLATE = """<html>
<body style="font-family: Georgia; padding: 30px; max-width: 600px; color: #222;">

  <div style="background:#fff3cd; border:1px solid #997404; color:#664d03; padding:14px 18px; border-radius:8px; margin-bottom:20px;">
    <strong>Internal review notice, not a letter to send.</strong> No automated
    solicitation was generated for this donor. This page is a record for a
    person to follow up on directly.
  </div>

  <p style="text-align:right; color: #888;">{letter_date}</p>

  <h2 style="margin:0 0 4px;">{donor_name}</h2>
  <p style="color:#555; margin:0 0 18px;">Donor ID: {donor_id} &middot; Tier: {tier} &middot;
  Region: {region} &middot; Lifetime giving: {lifetime_total} &middot; Last gift: {last_gift_year}</p>

  <p><strong>Why no letter was generated:</strong> {reason}</p>

  <p><strong>Gift history on file:</strong> {gift_history}</p>

  <p><strong>Assigned to:</strong> {assigned}</p>

  <p>This donor needs personal outreach rather than an automated letter.
  Please follow up directly rather than sending this page to them.</p>

</body>
</html>
"""


def build_placeholder_html(fields: dict, letter_date: str) -> str:
    """Fill PLACEHOLDER_TEMPLATE from whatever is actually known about a
    donor. Works for a fully validated donor with no ask (most fields
    present) down to a donor that failed validation entirely (often only
    donor_id/donor_name and the reason). Anything unknown says so rather
    than being left blank or guessed."""
    defaults = {
        "donor_id": "(not on file)", "donor_name": "(name not on file)",
        "tier": "(unknown)", "region": "(not on file)",
        "lifetime_total": "(unknown)", "last_gift_year": "(unknown)",
        "gift_history": "(not on file)", "reason": "no reason recorded",
        "relationship_manager": "",
    }
    merged = {**defaults, **{k: v for k, v in fields.items() if v}}
    assigned = merged["relationship_manager"] or "Not yet assigned. Assign a relationship manager before any outreach."
    return PLACEHOLDER_TEMPLATE.format(
        letter_date=letter_date,
        donor_id=rules.esc(merged["donor_id"]),
        donor_name=rules.esc(merged["donor_name"]),
        tier=rules.esc(merged["tier"]),
        region=rules.esc(merged["region"]),
        lifetime_total=rules.esc(merged["lifetime_total"]),
        last_gift_year=rules.esc(merged["last_gift_year"]),
        gift_history=rules.esc(merged["gift_history"]),
        reason=rules.esc(merged["reason"]),
        assigned=rules.esc(assigned),
    )


def run(config_path: Path, workdir: Path, outdir: Path) -> None:
    started = time.perf_counter()
    try:
        config = rules.load_campaign_config(config_path)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(2)
    letter_date = date.fromisoformat(config["as_of_date"]).strftime("%B %d, %Y")

    computed_path = workdir / "computed.csv"
    if not computed_path.exists():
        print("ERROR: work/computed.csv not found; run calculate_ask.py first", file=sys.stderr)
        raise SystemExit(2)
    with computed_path.open(newline="", encoding="utf-8") as handle:
        donors = list(csv.DictReader(handle))

    letters_dir = outdir / "letters"
    letters_dir.mkdir(parents=True, exist_ok=True)
    for stale in letters_dir.glob("*.html"):
        stale.unlink()

    def placeholder_fields(donor: dict, reason: str) -> dict:
        lifetime = donor.get("lifetime_total") or ""
        try:
            lifetime = f"${float(lifetime):,.0f}" if lifetime else ""
        except ValueError:
            pass
        return {
            "donor_id": donor.get("donor_id", ""), "donor_name": donor.get("donor_name", ""),
            "tier": donor.get("tier", ""), "region": donor.get("region", ""),
            "lifetime_total": lifetime, "last_gift_year": donor.get("last_gift_year", ""),
            "gift_history": donor.get("gift_history", ""), "reason": reason,
            "relationship_manager": donor.get("relationship_manager", ""),
        }

    manifest_rows: list[dict] = []
    generated = 0
    placeholders = 0
    for donor in donors:
        if not donor["ask_amount"]:
            reason = donor["review_reasons"] or "blocked pending data fixes"
            html_out = build_placeholder_html(placeholder_fields(donor, reason), letter_date)
            letter_file = f"{donor['donor_id']}.html"
            (letters_dir / letter_file).write_text(html_out, encoding="utf-8")
            placeholders += 1
            manifest_rows.append({
                "donor_id": donor["donor_id"], "donor_name": donor["donor_name"],
                "tier": donor["tier"], "status": donor["status"],
                "relationship_manager": donor.get("relationship_manager", ""),
                "ask_amount": "", "confidence": donor["confidence"],
                "review_level": donor["review_level"], "letter_file": f"letters/{letter_file}",
                "notes": reason, "rules_version": donor.get("rules_version", rules.RULES_VERSION),
            })
            continue

        model = build_letter_model(donor, config, letter_date)
        errors = validate_letter_model(model)
        if errors:
            reason = "letter schema validation failed: " + "; ".join(errors)
            html_out = build_placeholder_html(placeholder_fields(donor, reason), letter_date)
            letter_file = f"{donor['donor_id']}.html"
            (letters_dir / letter_file).write_text(html_out, encoding="utf-8")
            placeholders += 1
            manifest_rows.append({
                "donor_id": donor["donor_id"], "donor_name": donor["donor_name"],
                "tier": donor["tier"], "status": donor["status"],
                "relationship_manager": donor.get("relationship_manager", ""),
                "ask_amount": donor["ask_amount"], "confidence": donor["confidence"],
                "review_level": "mandatory", "letter_file": f"letters/{letter_file}",
                "notes": reason,
                "rules_version": donor.get("rules_version", rules.RULES_VERSION),
            })
            continue

        html_out = TEMPLATE.format(**model)
        letter_file = f"{donor['donor_id']}.html"
        (letters_dir / letter_file).write_text(html_out, encoding="utf-8")
        generated += 1
        manifest_rows.append({
            "donor_id": donor["donor_id"], "donor_name": donor["donor_name"],
            "tier": donor["tier"], "status": donor["status"],
            "relationship_manager": donor.get("relationship_manager", ""),
            "ask_amount": donor["ask_amount"], "confidence": donor["confidence"],
            "review_level": donor["review_level"], "letter_file": f"letters/{letter_file}",
            "notes": donor["review_reasons"],
            "rules_version": donor.get("rules_version", rules.RULES_VERSION),
        })

    # A donor who never made it past validate_input.py (missing required
    # fields, unparseable gift_history, a duplicate donor_id) still gets a
    # placeholder and a manifest row here, built from whatever raw fields
    # survived: the original's "produce them (all of them)" does not stop
    # at "all of them that validated cleanly."
    exceptions_path = workdir / "exceptions.csv"
    if exceptions_path.exists():
        with exceptions_path.open(newline="", encoding="utf-8") as handle:
            exception_rows = list(csv.DictReader(handle))
        for exc in exception_rows:
            donor_id = (exc.get("donor_id") or "").strip() or f"exception-line{exc.get('line', '?')}"
            donor_name = exc.get("donor_name") or ""
            reason = f"failed validation: {exc.get('reason', '')}"
            html_out = build_placeholder_html({
                "donor_id": donor_id, "donor_name": donor_name, "reason": reason,
            }, letter_date)
            letter_file = f"{donor_id}.html"
            (letters_dir / letter_file).write_text(html_out, encoding="utf-8")
            placeholders += 1
            manifest_rows.append({
                "donor_id": donor_id, "donor_name": donor_name,
                "tier": "", "status": "", "relationship_manager": "", "ask_amount": "", "confidence": "",
                "review_level": "mandatory", "letter_file": f"letters/{letter_file}",
                "notes": reason, "rules_version": rules.RULES_VERSION,
            })

    manifest_path = outdir / "manifest.csv"
    with manifest_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(manifest_rows[0].keys()) if manifest_rows else [])
        writer.writeheader()
        writer.writerows(rules.csv_safe_row(r) for r in manifest_rows)

    mandatory = sum(1 for r in manifest_rows if r["review_level"] == "mandatory" and r["letter_file"])
    missing_file = sum(1 for r in manifest_rows if not r["letter_file"])
    elapsed_ms = round((time.perf_counter() - started) * 1000)

    print(f"solicitation letters generated: {generated} (output/letters/)")
    print(f"placeholder pages (no automated ask; needs personal outreach): {placeholders}")
    print(f"total donors with a file in output/letters/: {generated + placeholders} of {len(manifest_rows)}")
    print(f"donors with no file at all: {missing_file} (should always be 0)")
    print(f"files needing mandatory review before anything is sent: {mandatory}")
    print(f"manifest:            output/manifest.csv")
    print(f"elapsed: {elapsed_ms} ms, zero model calls")
    print("Nothing generated by this run is sent automatically.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--workdir", default=Path("work"), type=Path)
    parser.add_argument("--outdir", default=Path("output"), type=Path)
    args = parser.parse_args()
    run(args.config, args.workdir, args.outdir)


if __name__ == "__main__":
    main()
