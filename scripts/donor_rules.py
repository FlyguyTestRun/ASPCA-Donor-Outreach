"""Shared policy implementation for the charity-donor-outreach skill.

Every threshold here mirrors references/policy.md. If the two ever
disagree, that is a defect, not a choice to make at read time. Nothing in
this module calls a language model; every function is a pure calculation
over inputs already on disk, which is what makes the batch pipeline free
to run at any donor count.
"""

from __future__ import annotations

import html
import json
import re
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

# Bumped whenever a threshold, formula, or gate in this file or policy.md
# changes in a way that would change output for the same input. Stamped
# into every validated/computed/manifest row, so any letter can be traced
# back to the exact rule version that produced it, independent of git
# history.
RULES_VERSION = "1.0.0"

TIER_MINIMUMS = [
    ("Platinum", 50_000),
    ("Gold", 10_000),
    ("Silver", 1_000),
    ("Bronze", 0),
]
PERCENT_ASK = {"Platinum": 0.40, "Gold": 0.25, "Silver": 0.15}
FLAT_ASK_BRONZE = 150
FLAT_ASK_LAPSED = 50
LAPSED_AFTER_YEARS = 3
LOYALTY_UPLIFT = 0.10
VOLUNTEER_UPLIFT = 100
EMERGENCY_MULTIPLIER = 1.2
ROUND_TO = 50
MIN_ASK = 50

CAMPAIGN_TYPES = ("emergency_appeal", "annual_fund", "capital_campaign", "event_fundraiser")

CONFIDENCE_FAIL_BELOW = 0.70
CONFIDENCE_REPORT_BELOW = 0.90
WARNING_PENALTY = 0.10

_GIFT_TOKEN = re.compile(r"^\s*(\d{4})\s*:\s*\$?\s*([\d,]+(?:\.\d+)?)\s*$")

REQUIRED_CONFIG_FIELDS = [
    "campaign_type", "as_of_date", "charity_name", "donation_url",
    "signer_name", "signer_title", "match_confirmed",
]


def load_campaign_config(path: Path) -> dict:
    """Read and validate the campaign config, or raise ValueError naming
    exactly what is wrong. A missing or malformed config is a person's
    mistake to fix, and should tell them precisely what to fix, not hand
    them a stack trace."""
    try:
        config = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        raise ValueError(f"campaign config not found: {path}")
    except json.JSONDecodeError as exc:
        raise ValueError(f"campaign config is not valid JSON: {exc}")

    missing = [f for f in REQUIRED_CONFIG_FIELDS if config.get(f) in (None, "")]
    if missing:
        raise ValueError(f"campaign config is missing required field(s): {', '.join(missing)}")

    if config["campaign_type"] not in CAMPAIGN_TYPES:
        raise ValueError(
            f"campaign config campaign_type {config['campaign_type']!r} is not one of {CAMPAIGN_TYPES}"
        )

    try:
        date.fromisoformat(config["as_of_date"])
    except ValueError:
        raise ValueError(f"campaign config as_of_date {config['as_of_date']!r} is not a valid YYYY-MM-DD date")

    if config["match_confirmed"] not in (True, False):
        raise ValueError("campaign config match_confirmed must be true or false")
    if config["match_confirmed"]:
        for field_name in ("match_sponsor", "match_terms"):
            if not str(config.get(field_name) or "").strip():
                raise ValueError(f"campaign config match_confirmed is true but {field_name} is missing")

    return config


def parse_gift_history(raw: str) -> list[tuple[int, float]]:
    """Parse a semicolon-separated year:amount string. Raises on anything malformed.

    This is the one field the pipeline treats as ground truth. Every other
    numeric donor field is cross-checked against this one, never trusted on
    its own.
    """
    if raw is None or not str(raw).strip():
        raise ValueError("gift_history is empty")
    gifts: list[tuple[int, float]] = []
    for token in str(raw).split(";"):
        match = _GIFT_TOKEN.match(token)
        if not match:
            raise ValueError(f"unparseable gift entry: {token.strip()!r}")
        year, amount = int(match.group(1)), float(match.group(2).replace(",", ""))
        if amount <= 0:
            raise ValueError(f"non-positive gift amount: {token.strip()!r}")
        gifts.append((year, amount))
    return sorted(gifts)


def compute_tier(lifetime_total: float) -> str:
    for tier, minimum in TIER_MINIMUMS:
        if lifetime_total >= minimum:
            return tier
    return "Bronze"


def is_lapsed(last_gift_year: int, as_of_year: int) -> bool:
    return (as_of_year - last_gift_year) > LAPSED_AFTER_YEARS


def giving_streak(gift_years: list[int], as_of_year: int) -> int:
    """Consecutive giving years ending at as_of_year - 1, for streak messaging."""
    years = set(gift_years)
    streak, year = 0, as_of_year - 1
    while year in years:
        streak += 1
        year -= 1
    return streak


def round_half_up(amount: float, step: int = ROUND_TO) -> int:
    """Round to the nearest step, halves rounding up (not Python's banker's rounding)."""
    return int((amount + step / 2) // step) * step


@dataclass
class AskResult:
    amount: int | None
    trace: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    review_reasons: list[str] = field(default_factory=list)


def compute_ask(
    tier: str,
    lapsed: bool,
    largest_gift: float,
    last_gift_year: int,
    volunteer: bool,
    campaign_type: str,
    as_of_year: int,
) -> AskResult:
    """Deterministic ask calculation. Fixed step order, one rounding step at the end.

    A lapsed Gold or Platinum donor never gets an automated ask: a form
    letter to a lapsed major donor risks more of the relationship than a
    flat-rate re-engagement ask could ever raise back. That record routes
    to personal outreach instead.
    """
    result = AskResult(amount=None)

    if lapsed and tier in ("Gold", "Platinum"):
        result.review_reasons.append(f"lapsed {tier} donor: route to personal outreach, no automated letter")
        result.trace.append("lapsed major donor: ask calculation skipped by policy")
        return result

    if lapsed:
        amount = float(FLAT_ASK_LAPSED)
        result.trace.append(f"base: lapsed re-engagement flat ${FLAT_ASK_LAPSED}")
    elif tier in PERCENT_ASK:
        pct = PERCENT_ASK[tier]
        amount = largest_gift * pct
        result.trace.append(f"base: {tier} {pct:.0%} of largest gift ${largest_gift:,.0f} = ${amount:,.2f}")
    else:
        amount = float(FLAT_ASK_BRONZE)
        result.trace.append(f"base: Bronze flat ${FLAT_ASK_BRONZE}")

    if last_gift_year == as_of_year - 1:
        amount *= 1 + LOYALTY_UPLIFT
        result.trace.append(f"loyalty uplift: gave in {as_of_year - 1}, x{1 + LOYALTY_UPLIFT:.2f} = ${amount:,.2f}")
    if volunteer:
        amount += VOLUNTEER_UPLIFT
        result.trace.append(f"volunteer uplift: +${VOLUNTEER_UPLIFT} = ${amount:,.2f}")
    if campaign_type == "emergency_appeal":
        amount *= EMERGENCY_MULTIPLIER
        result.trace.append(f"emergency multiplier: x{EMERGENCY_MULTIPLIER} = ${amount:,.2f}")

    rounded = max(round_half_up(amount), MIN_ASK)
    result.trace.append(f"rounded once to nearest ${ROUND_TO}: ${rounded:,}")
    result.amount = rounded

    if not lapsed and tier in PERCENT_ASK and rounded > largest_gift:
     
        result.review_reasons.append(f"computed ask ${rounded:,} exceeds largest single gift ${largest_gift:,.0f}: needs a fundraiser's judgment before sending, not capped automatically")

    return result


def confidence_score(warning_count: int) -> float:
    return round(max(1.0 - WARNING_PENALTY * warning_count, 0.0), 2)


def confidence_band(confidence: float) -> str:
    """Fail, report, pass. Below 0.70 blocked outright; below 0.90 held for review."""
    if confidence < CONFIDENCE_FAIL_BELOW:
        return "fail"
    if confidence < CONFIDENCE_REPORT_BELOW:
        return "report"
    return "pass"


def review_level(tier: str, confidence: float, review_reasons: list[str]) -> str:
    if tier == "Platinum" or review_reasons or confidence < CONFIDENCE_REPORT_BELOW:
        return "mandatory"
    if confidence < 1.0:
        return "recommended"
    return "none"


def csv_safe(value) -> str:
    """Neutralize spreadsheet formula injection (a donor named '=HYPERLINK(...)')."""
    text = str(value)
    return "'" + text if text[:1] in ("=", "+", "-", "@") else text


def csv_safe_row(row: dict) -> dict:
    return {key: csv_safe(value) for key, value in row.items()}


def esc(value) -> str:
    """HTML-escape donor-derived text before it lands in a rendered letter."""
    return html.escape(str(value), quote=False)


def split_name(full_name: str) -> tuple[str, str]:
    parts = full_name.split()
    return (parts[0], parts[0]) if len(parts) == 1 else (" ".join(parts[:-1]), parts[-1])
