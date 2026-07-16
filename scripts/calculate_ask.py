"""Compute ask amounts, confidence, and review level for validated donors.

Usage:
    python calculate_ask.py --config <campaign.json> [--workdir work]

Reads work/validated.csv (from validate_input.py) and writes
work/computed.csv. All arithmetic happens here, deterministically, with a
full step-by-step trace per donor. A language model never calculates an
ask amount.
"""

from __future__ import annotations

import argparse
import csv
import sys
import time
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import donor_rules as rules


def run(config_path: Path, workdir: Path) -> list[dict]:
    started = time.perf_counter()
    try:
        config = rules.load_campaign_config(config_path)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(2)
    as_of_year = date.fromisoformat(config["as_of_date"]).year
    campaign_type = config["campaign_type"]

    validated_path = workdir / "validated.csv"
    if not validated_path.exists():
        print("ERROR: work/validated.csv not found; run validate_input.py first", file=sys.stderr)
        raise SystemExit(2)

    with validated_path.open(newline="", encoding="utf-8") as handle:
        donors = list(csv.DictReader(handle))

    computed: list[dict] = []
    for donor in donors:
        gift_years = [year for year, _ in rules.parse_gift_history(donor["gift_history"])]
        ask = rules.compute_ask(
            tier=donor["tier"],
            lapsed=donor["status"] == "lapsed",
            largest_gift=float(donor["largest_gift"]),
            last_gift_year=int(donor["last_gift_year"]),
            volunteer=donor["volunteer"] == "Yes",
            campaign_type=campaign_type,
            as_of_year=as_of_year,
        )

        validation_warnings = [w for w in donor["warnings"].split(" | ") if w]
        all_warnings = validation_warnings + ask.warnings
        confidence = rules.confidence_score(len(all_warnings))
        band = rules.confidence_band(confidence)
        if band == "fail" and ask.amount is not None:
            ask.amount = None
            ask.review_reasons.append(
                f"confidence {confidence:.2f} is below the fail threshold "
                f"{rules.CONFIDENCE_FAIL_BELOW:.2f}: blocked pending data fixes"
            )
        # A tier correction from validate_input.py always forces mandatory
        # review, on top of whatever compute_ask itself flagged (a lapsed
        # major donor, or an ask that exceeds the donor's largest gift).
        validation_mandatory = [r for r in donor.get("mandatory_reasons", "").split(" | ") if r]
        review_reasons = ask.review_reasons + validation_mandatory
        level = rules.review_level(donor["tier"], confidence, review_reasons)

        record = dict(donor)
        record.update({
            "streak": str(rules.giving_streak(gift_years, as_of_year)),
            "ask_amount": "" if ask.amount is None else str(ask.amount),
            "ask_trace": " -> ".join(ask.trace),
            "warnings": " | ".join(all_warnings),
            "review_reasons": " | ".join(review_reasons),
            "confidence": f"{confidence:.2f}",
            "confidence_band": band,
            "review_level": level,
        })
        computed.append(record)

    out_path = workdir / "computed.csv"
    with out_path.open("w", newline="", encoding="utf-8") as handle:
        fieldnames = list(computed[0].keys()) if computed else []
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rules.csv_safe_row(record) for record in computed)

    mandatory = sum(1 for r in computed if r["review_level"] == "mandatory")
    recommended = sum(1 for r in computed if r["review_level"] == "recommended")
    blocked = sum(1 for r in computed if r["confidence_band"] == "fail")
    no_letter = sum(1 for r in computed if not r["ask_amount"])
    elapsed_ms = round((time.perf_counter() - started) * 1000)

    print(f"asks computed:       {len(computed)}")
    print(f"review mandatory:    {mandatory}")
    print(f"review recommended:  {recommended}")
    print(f"blocked (confidence fail band): {blocked}")
    print(f"no letter (routed to a person, e.g. lapsed major donor or blocked): {no_letter}")
    print(f"elapsed: {elapsed_ms} ms, zero model calls")
    return computed


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--workdir", default=Path("work"), type=Path)
    args = parser.parse_args()
    run(args.config, args.workdir)


if __name__ == "__main__":
    main()
