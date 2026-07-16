"""Validate a donor file against the policy in references/policy.md.

Usage:
    python validate_input.py --input <donor_file.csv|.xlsx> --config <campaign.json> [--workdir work]

Writes work/validated.csv (rows safe to compute an ask for) and
work/exceptions.csv (every rejected row with a specific reason). Nothing
here trusts a stated value: largest_gift, lifetime_total, last_gift_year,
and tier are all recomputed from gift_history and compared against what
the file claims. A disagreement is a warning that follows the donor
through the pipeline, not a silent pick of one value over the other.

Accepts either a .csv or an .xlsx donor file, dispatched by extension.
Both are read as plain text (no type inference) so a donor file behaves
identically regardless of which format a fundraiser happened to export.
"""

from __future__ import annotations

import argparse
import csv
import sys
import time
from datetime import date
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import donor_rules as rules

REQUIRED_FIELDS = ["donor_id", "donor_name", "gift_history"]
VOLUNTEER_YES = {"yes", "y", "true", "1"}
VOLUNTEER_NO = {"no", "n", "false", "0", ""}
SUPPORTED_EXTENSIONS = (".csv", ".xlsx", ".xls")


def read_donor_rows(path: Path) -> list[dict]:
    """Read a donor file as CSV or XLSX into the same list-of-string-dict
    shape csv.DictReader would produce, so every check downstream behaves
    identically no matter which format a fundraiser exported."""
    suffix = path.suffix.lower()
    if suffix == ".csv":
        frame = pd.read_csv(path, dtype=str, encoding="utf-8-sig", keep_default_na=False)
    elif suffix in (".xlsx", ".xls"):
        frame = pd.read_excel(path, dtype=str, keep_default_na=False)
    else:
        raise ValueError(f"unsupported donor file type {suffix!r}: use .csv or .xlsx")
    frame.columns = [str(c).strip() for c in frame.columns]
    return frame.fillna("").to_dict(orient="records")


def _stated_float(raw: str | None) -> tuple[float | None, bool]:
    """Return (value, was_garbage). A stated cross-check field that fails to
    parse (e.g. "TBD") is not fatal: gift_history is authoritative regardless,
    so this is a warning, never a reason to drop the whole row or the batch."""
    text = (raw or "").strip().replace(",", "").replace("$", "")
    if not text:
        return None, False
    try:
        return float(text), False
    except ValueError:
        return None, True


def _stated_int(raw: str | None) -> tuple[int | None, bool]:
    value, garbage = _stated_float(raw)
    return (int(value) if value is not None else None), garbage


def validate_row(row: dict, as_of_year: int) -> tuple[dict | None, list[str], list[str]]:
    """Return (validated_record, exception_reasons, mismatch_warnings).

    Exactly one of validated_record / exception_reasons is populated.
    mismatch_warnings holds only the stated-vs-computed disagreement
    warnings (a subset of record["warnings"]), tagged so the caller can
    tally tier mismatches separately from other field mismatches without
    re-parsing a joined string.
    """
    donor_id = (row.get("donor_id") or "").strip()
    donor_name = (row.get("donor_name") or "").strip()

    missing = [f for f in REQUIRED_FIELDS if not (row.get(f) or "").strip()]
    if missing:
        return None, [f"missing required field(s): {', '.join(missing)}"], []

    try:
        gifts = rules.parse_gift_history(row["gift_history"])
    except ValueError as exc:
        return None, [f"unparseable gift_history: {exc}"], []

    future = [year for year, _ in gifts if year > as_of_year]
    if future:
        return None, [f"gift year(s) {sorted(set(future))} are after the campaign as_of year {as_of_year}"], []

    computed_largest = max(amount for _, amount in gifts)
    computed_lifetime = sum(amount for _, amount in gifts)
    computed_last_year = max(year for year, _ in gifts)

    warnings: list[str] = []
    mismatches: list[str] = []  # "tier" or "value", one tag per mismatch warning below
    stated_largest, garbage = _stated_float(row.get("largest_gift"))
    if garbage:
        warnings.append(f"stated largest_gift {row.get('largest_gift')!r} is not a number: ignored, computed value used")
        mismatches.append("value")
    elif stated_largest is not None and abs(stated_largest - computed_largest) > 0.01:
        warnings.append(f"stated largest_gift ${stated_largest:,.0f} disagrees with computed ${computed_largest:,.0f} from gift_history: computed value used")
        mismatches.append("value")
    stated_lifetime, garbage = _stated_float(row.get("lifetime_total"))
    if garbage:
        warnings.append(f"stated lifetime_total {row.get('lifetime_total')!r} is not a number: ignored, computed value used")
        mismatches.append("value")
    elif stated_lifetime is not None and abs(stated_lifetime - computed_lifetime) > 0.01:
        warnings.append(f"stated lifetime_total ${stated_lifetime:,.0f} disagrees with computed ${computed_lifetime:,.0f} from gift_history: computed value used")
        mismatches.append("value")
    stated_last_year, garbage = _stated_int(row.get("last_gift_year"))
    if garbage:
        warnings.append(f"stated last_gift_year {row.get('last_gift_year')!r} is not a number: ignored, computed value used")
        mismatches.append("value")
    elif stated_last_year is not None and stated_last_year != computed_last_year:
        warnings.append(f"stated last_gift_year {stated_last_year} disagrees with computed {computed_last_year} from gift_history: computed value used")
        mismatches.append("value")

    computed_tier = rules.compute_tier(computed_lifetime)
    stated_tier = (row.get("tier") or "").strip()
    mandatory_reasons: list[str] = []
    if stated_tier and stated_tier not in ("Lapsed", "Unknown") and stated_tier != computed_tier:
        message = f"stated tier {stated_tier!r} disagrees with computed tier {computed_tier!r} from lifetime_total ${computed_lifetime:,.0f}: computed tier used"
        warnings.append(message)
        mismatches.append("tier")
        # A tier change alters the donor's entire treatment (percentage, ask,
        # register), and means the source CRM disagrees with what this run is
        # about to send. That is worth a person's attention before this
        # letter goes out, not just a soft confidence penalty.
        mandatory_reasons.append(f"tier corrected from {stated_tier!r} to {computed_tier!r}: verify against the source system before sending")

    lapsed = rules.is_lapsed(computed_last_year, as_of_year)
    volunteer_raw = (row.get("volunteer") or "").strip().lower()
    if volunteer_raw not in VOLUNTEER_YES and volunteer_raw not in VOLUNTEER_NO:
        warnings.append(f"unrecognized volunteer value {row.get('volunteer')!r}: treated as No")
    volunteer = volunteer_raw in VOLUNTEER_YES

    record = {
        "donor_id": donor_id,
        "donor_name": donor_name,
        "title": (row.get("title") or "").strip(),
        "region": (row.get("region") or "").strip(),
        "gift_history": row["gift_history"].strip(),
        "largest_gift": f"{computed_largest:.2f}",
        "lifetime_total": f"{computed_lifetime:.2f}",
        "last_gift_year": str(computed_last_year),
        "volunteer": "Yes" if volunteer else "No",
        "tier": computed_tier,
        "status": "lapsed" if lapsed else "active",
        "warnings": " | ".join(warnings),
        "mandatory_reasons": " | ".join(mandatory_reasons),
        "rules_version": rules.RULES_VERSION,
    }
    return record, [], mismatches


def run(input_path: Path, config_path: Path, workdir: Path) -> None:
    started = time.perf_counter()
    workdir.mkdir(parents=True, exist_ok=True)
    try:
        config = rules.load_campaign_config(config_path)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(2)
    as_of_year = date.fromisoformat(config["as_of_date"]).year

    if not input_path.exists():
        print(f"ERROR: donor file not found: {input_path}", file=sys.stderr)
        raise SystemExit(2)
    try:
        rows = read_donor_rows(input_path)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(2)

    validated: list[dict] = []
    exceptions: list[dict] = []
    seen_ids: dict[str, int] = {}
    tier_mismatch_count = 0
    other_mismatch_count = 0

    for line_number, row in enumerate(rows, start=2):  # header is line 1
        donor_id = (row.get("donor_id") or "").strip()
        if donor_id and donor_id in seen_ids:
            exceptions.append({
                "line": line_number, "donor_id": donor_id,
                "donor_name": row.get("donor_name", ""),
                "reason": f"duplicate donor_id, first seen at line {seen_ids[donor_id]}",
            })
            continue
        record, reasons, mismatches = validate_row(row, as_of_year)
        if reasons:
            exceptions.append({
                "line": line_number, "donor_id": donor_id,
                "donor_name": row.get("donor_name", ""),
                "reason": "; ".join(reasons),
            })
            continue
        if donor_id:
            seen_ids[donor_id] = line_number
        tier_mismatch_count += mismatches.count("tier")
        other_mismatch_count += mismatches.count("value")
        validated.append(record)

    validated_path = workdir / "validated.csv"
    with validated_path.open("w", newline="", encoding="utf-8") as handle:
        fieldnames = list(validated[0].keys()) if validated else [
            "donor_id", "donor_name", "title", "region", "gift_history",
            "largest_gift", "lifetime_total", "last_gift_year", "volunteer",
            "tier", "status", "warnings", "mandatory_reasons", "rules_version",
        ]
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rules.csv_safe_row(r) for r in validated)

    exceptions_path = workdir / "exceptions.csv"
    with exceptions_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["line", "donor_id", "donor_name", "reason"])
        writer.writeheader()
        writer.writerows(rules.csv_safe_row(r) for r in exceptions)

    elapsed_ms = round((time.perf_counter() - started) * 1000)
    print(f"rows read:          {len(rows)}")
    print(f"validated:          {len(validated)}")
    print(f"exceptions:         {len(exceptions)} (see work/exceptions.csv)")
    print(f"tier label mismatches (computed tier used instead): {tier_mismatch_count}")
    print(f"other stated-value mismatches (computed value used instead): {other_mismatch_count}")
    print(f"elapsed: {elapsed_ms} ms, zero model calls")
    if exceptions:
        print("\nExceptions require a person to fix the source file and resubmit:")
        for exc in exceptions:
            print(f"  line {exc['line']} ({exc['donor_name'] or exc['donor_id']}): {exc['reason']}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--workdir", default=Path("work"), type=Path)
    args = parser.parse_args()
    run(args.input, args.config, args.workdir)


if __name__ == "__main__":
    main()
