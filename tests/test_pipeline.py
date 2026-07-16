"""Tests for the charity-donor-outreach pipeline.

Runs with stdlib unittest only (no pytest dependency), so it works in any
Python environment without an extra install:

    python -m unittest discover -s tests -v

Each test here exists because this session found and fixed a real defect
or made a real design decision; the point is to keep it fixed, not to
demonstrate coverage for its own sake.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import donor_rules as rules  # noqa: E402
import validate_input  # noqa: E402
import generate_letters  # noqa: E402


class TierAndLapsedTests(unittest.TestCase):
    def test_tier_boundaries(self):
        self.assertEqual(rules.compute_tier(0), "Bronze")
        self.assertEqual(rules.compute_tier(999.99), "Bronze")
        self.assertEqual(rules.compute_tier(1_000), "Silver")
        self.assertEqual(rules.compute_tier(9_999.99), "Silver")
        self.assertEqual(rules.compute_tier(10_000), "Gold")
        self.assertEqual(rules.compute_tier(49_999.99), "Gold")
        self.assertEqual(rules.compute_tier(50_000), "Platinum")

    def test_lapsed_boundary_is_strictly_greater_than_three_years(self):
        self.assertFalse(rules.is_lapsed(last_gift_year=2021, as_of_year=2024))  # exactly 3
        self.assertTrue(rules.is_lapsed(last_gift_year=2020, as_of_year=2024))  # 4


class RoundingTests(unittest.TestCase):
    def test_half_rounds_up_not_to_even(self):
        # Python's round() would send 25 to the nearest even multiple; a
        # donor's ask amount should not depend on that kind of surprise.
        self.assertEqual(rules.round_half_up(1975), 2000)
        self.assertEqual(rules.round_half_up(2025), 2050)
        self.assertEqual(rules.round_half_up(2000), 2000)


class AskCalculationTests(unittest.TestCase):
    def test_platinum_ask_matches_known_trace(self):
        # Earl Fontaine from sample-donors.csv: largest $90,000, gave 2022
        # (not "last year" relative to 2024), volunteer, annual fund.
        result = rules.compute_ask(
            tier="Platinum", lapsed=False, largest_gift=90_000,
            last_gift_year=2022, volunteer=True,
            campaign_type="annual_fund", as_of_year=2024,
        )
        self.assertEqual(result.amount, 36_100)  # 90000*0.40 + 100, no loyalty uplift

    def test_lapsed_platinum_gets_no_automated_ask(self):
        result = rules.compute_ask(
            tier="Platinum", lapsed=True, largest_gift=50_000,
            last_gift_year=2020, volunteer=False,
            campaign_type="annual_fund", as_of_year=2024,
        )
        self.assertIsNone(result.amount)
        self.assertTrue(result.review_reasons)

    def test_lapsed_silver_gets_flat_reengagement_ask(self):
        result = rules.compute_ask(
            tier="Silver", lapsed=True, largest_gift=400,
            last_gift_year=2017, volunteer=False,
            campaign_type="annual_fund", as_of_year=2024,
        )
        self.assertEqual(result.amount, 50)

    def test_bronze_flat_ask_still_gets_volunteer_uplift(self):
        # Documented decision: uplifts apply on top of flat bases too.
        result = rules.compute_ask(
            tier="Bronze", lapsed=False, largest_gift=500,
            last_gift_year=2019, volunteer=True,
            campaign_type="annual_fund", as_of_year=2024,
        )
        self.assertEqual(result.amount, 250)  # 150 + 100, rounded

    def test_ask_exceeding_largest_gift_forces_mandatory_not_capped(self):
        # A tiny largest_gift plus the flat $100 volunteer uplift reliably
        # pushes the computed ask past the donor's own largest single gift.
        result = rules.compute_ask(
            tier="Silver", lapsed=False, largest_gift=10,
            last_gift_year=2020, volunteer=True,
            campaign_type="annual_fund", as_of_year=2024,
        )
        self.assertGreater(result.amount, 10)
        self.assertTrue(result.review_reasons)
        self.assertEqual(result.warnings, [])  # not a data-quality warning


class ReviewLevelTests(unittest.TestCase):
    def test_tier_mismatch_forces_mandatory_review(self):
        level = rules.review_level(
            tier="Gold", confidence=0.90,
            review_reasons=["tier corrected from 'Silver' to 'Gold': verify against the source system before sending"],
        )
        self.assertEqual(level, "mandatory")

    def test_clean_silver_record_needs_no_review(self):
        level = rules.review_level(tier="Silver", confidence=1.0, review_reasons=[])
        self.assertEqual(level, "none")

    def test_platinum_is_always_mandatory(self):
        level = rules.review_level(tier="Platinum", confidence=1.0, review_reasons=[])
        self.assertEqual(level, "mandatory")


class CsvSafetyTests(unittest.TestCase):
    def test_formula_injection_is_neutralized(self):
        self.assertEqual(rules.csv_safe("=HYPERLINK(\"http://evil\")"), "'=HYPERLINK(\"http://evil\")")
        self.assertEqual(rules.csv_safe("Robert Svensson"), "Robert Svensson")


class ValidateRowTests(unittest.TestCase):
    def test_garbage_stated_value_is_a_warning_not_a_crash(self):
        row = {
            "donor_id": "D999", "donor_name": "Test Donor",
            "gift_history": "2023:2000", "largest_gift": "TBD",
        }
        record, reasons, mismatches = validate_input.validate_row(row, as_of_year=2024)
        self.assertIsNotNone(record)
        self.assertEqual(reasons, [])
        self.assertIn("not a number", record["warnings"])

    def test_missing_required_field_goes_to_exceptions(self):
        row = {"donor_id": "D999", "donor_name": "Test Donor", "gift_history": ""}
        record, reasons, mismatches = validate_input.validate_row(row, as_of_year=2024)
        self.assertIsNone(record)
        self.assertTrue(reasons)

    def test_tier_mismatch_is_computed_not_trusted(self):
        row = {
            "donor_id": "D999", "donor_name": "Test Donor",
            "gift_history": "2023:25000", "tier": "Silver",
        }
        record, reasons, mismatches = validate_input.validate_row(row, as_of_year=2024)
        self.assertEqual(record["tier"], "Gold")
        self.assertIn("tier", mismatches)
        self.assertTrue(record["mandatory_reasons"])


class ConfigValidationTests(unittest.TestCase):
    def test_missing_required_field_is_named_not_a_keyerror(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "bad_config.json"
            config_path.write_text(json.dumps({"campaign_type": "annual_fund", "charity_name": "ASPCA"}))
            with self.assertRaises(ValueError) as ctx:
                rules.load_campaign_config(config_path)
            self.assertIn("as_of_date", str(ctx.exception))

    def test_unconfirmed_match_does_not_require_sponsor(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "config.json"
            config_path.write_text(json.dumps({
                "campaign_type": "annual_fund", "as_of_date": "2024-06-30",
                "charity_name": "ASPCA", "donation_url": "https://x.org/donate",
                "signer_name": "Jordan Ellis", "signer_title": "Director",
                "match_confirmed": False,
            }))
            config = rules.load_campaign_config(config_path)
            self.assertFalse(config["match_confirmed"])


class IngestionParityTests(unittest.TestCase):
    def test_csv_and_xlsx_produce_identical_rows(self):
        try:
            import pandas as pd
        except ImportError:
            self.skipTest("pandas not installed")
        with tempfile.TemporaryDirectory() as tmp:
            rows = [
                {"donor_id": "D001", "donor_name": "Robert Svensson", "title": "",
                 "region": "Northeast", "gift_history": "2020:50000", "largest_gift": "50000",
                 "lifetime_total": "50000", "last_gift_year": "2020", "volunteer": "No", "tier": "Platinum"},
            ]
            df = pd.DataFrame(rows)
            csv_path = Path(tmp) / "donors.csv"
            xlsx_path = Path(tmp) / "donors.xlsx"
            df.to_csv(csv_path, index=False)
            df.to_excel(xlsx_path, index=False)
            csv_rows = validate_input.read_donor_rows(csv_path)
            xlsx_rows = validate_input.read_donor_rows(xlsx_path)
            self.assertEqual(csv_rows, xlsx_rows)


class SalutationAndVoiceTests(unittest.TestCase):
    def test_no_title_means_full_name_not_a_guess(self):
        # Platinum/Gold format ("Dear ...") applies; no title on file falls
        # back to the full name rather than a guessed honorific. The row
        # is separately flagged for mandatory review in validate_input.py.
        donor = {"donor_name": "Elizabeth Warren", "title": "", "tier": "Gold", "status": "active"}
        salutation = generate_letters.build_salutation(donor)
        self.assertEqual(salutation, "Dear Elizabeth Warren,")

    def test_title_present_is_used_as_is(self):
        donor = {"donor_name": "Robert Svensson", "title": "Dr.", "tier": "Platinum", "status": "active"}
        salutation = generate_letters.build_salutation(donor)
        self.assertEqual(salutation, "Dear Dr. Svensson,")

    def test_silver_bronze_use_first_name_only(self):
        donor = {"donor_name": "Maria Yamamoto", "title": "", "tier": "Silver", "status": "active"}
        self.assertEqual(generate_letters.build_salutation(donor), "Hi Maria,")

    def test_lapsed_gets_the_original_missed_you_opener(self):
        # Per the original's literal Salutation Rules, and overrides the
        # donor's own computed tier's format (a lapsed donor who happens
        # to be Silver by lifetime giving still gets this, not "Hi").
        donor = {"donor_name": "Michael Torres", "title": "", "tier": "Silver", "status": "lapsed"}
        self.assertEqual(generate_letters.build_salutation(donor), "We've missed you, Michael!")

    def test_tone_actually_differs_by_tier(self):
        platinum = generate_letters.build_opening_paragraph(
            {"tier": "Platinum", "status": "active", "lifetime_total": "100000"}, "ASPCA")
        bronze = generate_letters.build_opening_paragraph(
            {"tier": "Bronze", "status": "active", "lifetime_total": "100"}, "ASPCA")
        self.assertNotEqual(platinum, bronze)

    def test_lapsed_gets_apologetic_voice_not_underlying_tier_voice(self):
        # A lapsed donor computed as Silver by lifetime total does not get
        # the "friendly" Silver voice; Lapsed's own apologetic register
        # applies instead, matching the original's "Apologetic tone".
        lapsed = generate_letters.build_opening_paragraph(
            {"tier": "Silver", "status": "lapsed", "lifetime_total": "1800"}, "ASPCA")
        active_silver = generate_letters.build_opening_paragraph(
            {"tier": "Silver", "status": "active", "lifetime_total": "1800"}, "ASPCA")
        self.assertNotEqual(lapsed, active_silver)
        self.assertIn("missed", lapsed.lower())


class RelationshipManagerGateTests(unittest.TestCase):
    def test_platinum_missing_manager_forces_mandatory_review(self):
        row = {
            "donor_id": "D999", "donor_name": "Test Platinum",
            "gift_history": "2023:60000",
        }
        record, reasons, mismatches = validate_input.validate_row(row, as_of_year=2024)
        self.assertEqual(record["tier"], "Platinum")
        self.assertIn("relationship manager", record["mandatory_reasons"])

    def test_gold_does_not_require_a_manager(self):
        # The original assigns this only in Platinum's section, not Gold's.
        row = {
            "donor_id": "D998", "donor_name": "Test Gold",
            "gift_history": "2023:15000",
        }
        record, reasons, mismatches = validate_input.validate_row(row, as_of_year=2024)
        self.assertEqual(record["tier"], "Gold")
        self.assertNotIn("relationship manager", record["mandatory_reasons"])

    def test_manager_present_is_used_as_the_signer(self):
        donor = {
            "tier": "Platinum", "status": "active", "relationship_manager": "Pat Nguyen",
            "donor_id": "D999", "donor_name": "Test Platinum", "title": "", "lifetime_total": "60000",
            "streak": "0", "ask_amount": "24000",
        }
        config = {
            "charity_name": "ASPCA", "signer_name": "Jordan Ellis", "signer_title": "Director",
            "campaign_type": "annual_fund", "donation_url": "https://x.org/donate", "match_confirmed": False,
        }
        model = generate_letters.build_letter_model(donor, config, "June 30, 2024")
        self.assertEqual(model["signer_name"], "Pat Nguyen")
        self.assertEqual(model["signer_title"], "Personal Relationship Manager")

    def test_manager_absent_falls_back_to_campaign_signer(self):
        donor = {
            "tier": "Platinum", "status": "active", "relationship_manager": "",
            "donor_id": "D999", "donor_name": "Test Platinum", "title": "", "lifetime_total": "60000",
            "streak": "0", "ask_amount": "24000",
        }
        config = {
            "charity_name": "ASPCA", "signer_name": "Jordan Ellis", "signer_title": "Director",
            "campaign_type": "annual_fund", "donation_url": "https://x.org/donate", "match_confirmed": False,
        }
        model = generate_letters.build_letter_model(donor, config, "June 30, 2024")
        self.assertEqual(model["signer_name"], "Jordan Ellis")
        self.assertEqual(model["signer_title"], "Director")


class PlaceholderLetterTests(unittest.TestCase):
    def test_no_ask_donor_gets_a_placeholder_not_nothing(self):
        html = generate_letters.build_placeholder_html({
            "donor_id": "D001", "donor_name": "Robert Svensson", "tier": "Platinum",
            "region": "Northeast", "lifetime_total": "$145,000", "last_gift_year": "2020",
            "gift_history": "2010:25000;2013:30000;2016:40000;2020:50000",
            "reason": "lapsed Platinum donor: route to personal outreach, no automated letter",
        }, "June 30, 2024")
        self.assertIn("Internal review notice", html)
        self.assertIn("Robert Svensson", html)
        self.assertIn("route to personal outreach", html)
        self.assertIn("Not yet assigned", html)

    def test_placeholder_names_the_assigned_relationship_manager(self):
        html = generate_letters.build_placeholder_html({
            "donor_id": "D001", "donor_name": "Robert Svensson", "reason": "routed",
            "relationship_manager": "Pat Nguyen",
        }, "June 30, 2024")
        self.assertIn("Pat Nguyen", html)
        self.assertNotIn("Not yet assigned", html)

    def test_placeholder_works_with_almost_nothing_known(self):
        # An exception donor: only donor_id/donor_name/reason are ever
        # available, everything else is genuinely unknown.
        html = generate_letters.build_placeholder_html({
            "donor_id": "D999", "donor_name": "Test Broken Donor",
            "reason": "failed validation: missing required field(s): gift_history",
        }, "June 30, 2024")
        self.assertIn("Test Broken Donor", html)
        self.assertIn("missing required field(s)", html)
        self.assertIn("(unknown)", html)


class GivingStreakTests(unittest.TestCase):
    def test_consecutive_years_counted_correctly(self):
        # Gifts in 2021, 2022, 2023; as_of_year 2024 -> streak of 3 ending 2023.
        self.assertEqual(rules.giving_streak([2019, 2021, 2022, 2023], 2024), 3)

    def test_gap_breaks_the_streak(self):
        self.assertEqual(rules.giving_streak([2018, 2019, 2022, 2023], 2024), 2)


if __name__ == "__main__":
    unittest.main()
