/*
 * Parity test: asserts donor_rules.js against the exact same expected
 * values tests/test_pipeline.py asserts against donor_rules.py. If this
 * file and the Python suite ever both pass but on different numbers for
 * the same case, that is exactly the drift this test exists to catch.
 *
 * Run: node tests/test_js_parity.js
 */
"use strict";
var assert = require("assert");
var path = require("path");
var R = require(path.join(__dirname, "..", "donor_rules.js"));

var failures = [];
function test(name, fn) {
  try {
    fn();
    console.log("ok - " + name);
  } catch (err) {
    failures.push(name + ": " + err.message);
    console.log("FAIL - " + name + ": " + err.message);
  }
}

test("tier boundaries", function () {
  assert.strictEqual(R.computeTier(0), "Bronze");
  assert.strictEqual(R.computeTier(999.99), "Bronze");
  assert.strictEqual(R.computeTier(1000), "Silver");
  assert.strictEqual(R.computeTier(9999.99), "Silver");
  assert.strictEqual(R.computeTier(10000), "Gold");
  assert.strictEqual(R.computeTier(49999.99), "Gold");
  assert.strictEqual(R.computeTier(50000), "Platinum");
});

test("lapsed boundary is strictly greater than three years", function () {
  assert.strictEqual(R.isLapsed(2021, 2024), false);
  assert.strictEqual(R.isLapsed(2020, 2024), true);
});

test("half rounds up, not to even", function () {
  assert.strictEqual(R.roundHalfUp(1975), 2000);
  assert.strictEqual(R.roundHalfUp(2025), 2050);
  assert.strictEqual(R.roundHalfUp(2000), 2000);
});

test("platinum ask matches known trace (Earl Fontaine)", function () {
  var result = R.computeAsk({
    tier: "Platinum", lapsed: false, largestGift: 90000,
    lastGiftYear: 2022, volunteer: true,
    campaignType: "annual_fund", asOfYear: 2024,
  });
  assert.strictEqual(result.amount, 36100);
});

test("lapsed platinum gets no automated ask", function () {
  var result = R.computeAsk({
    tier: "Platinum", lapsed: true, largestGift: 50000,
    lastGiftYear: 2020, volunteer: false,
    campaignType: "annual_fund", asOfYear: 2024,
  });
  assert.strictEqual(result.amount, null);
  assert.ok(result.reviewReasons.length > 0);
});

test("lapsed silver gets flat reengagement ask", function () {
  var result = R.computeAsk({
    tier: "Silver", lapsed: true, largestGift: 400,
    lastGiftYear: 2017, volunteer: false,
    campaignType: "annual_fund", asOfYear: 2024,
  });
  assert.strictEqual(result.amount, 50);
});

test("bronze flat ask still gets volunteer uplift", function () {
  var result = R.computeAsk({
    tier: "Bronze", lapsed: false, largestGift: 500,
    lastGiftYear: 2019, volunteer: true,
    campaignType: "annual_fund", asOfYear: 2024,
  });
  assert.strictEqual(result.amount, 250);
});

test("ask exceeding largest gift forces mandatory, not capped", function () {
  var result = R.computeAsk({
    tier: "Silver", lapsed: false, largestGift: 10,
    lastGiftYear: 2020, volunteer: true,
    campaignType: "annual_fund", asOfYear: 2024,
  });
  assert.ok(result.amount > 10);
  assert.ok(result.reviewReasons.length > 0);
  assert.strictEqual(result.warnings.length, 0);
});

test("tier mismatch forces mandatory review", function () {
  var level = R.reviewLevel("Gold", 0.90, ["tier corrected from 'Silver' to 'Gold'"]);
  assert.strictEqual(level, "mandatory");
});

test("clean silver record needs no review", function () {
  assert.strictEqual(R.reviewLevel("Silver", 1.0, []), "none");
});

test("platinum is always mandatory", function () {
  assert.strictEqual(R.reviewLevel("Platinum", 1.0, []), "mandatory");
});

test("formula injection is neutralized", function () {
  assert.strictEqual(R.csvSafe('=HYPERLINK("http://evil")'), "'=HYPERLINK(\"http://evil\")");
  assert.strictEqual(R.csvSafe("Robert Svensson"), "Robert Svensson");
});

test("giving streak: consecutive years counted correctly", function () {
  assert.strictEqual(R.givingStreak([2019, 2021, 2022, 2023], 2024), 3);
});

test("giving streak: gap breaks the streak", function () {
  assert.strictEqual(R.givingStreak([2018, 2019, 2022, 2023], 2024), 2);
});

test("no title means full name, not a guess", function () {
  var parts = R.splitName("Elizabeth Warren");
  assert.deepStrictEqual(parts, ["Elizabeth", "Warren"]);
});

test("gift history parses and sorts", function () {
  var gifts = R.parseGiftHistory("2023:2000;2019:500");
  assert.deepStrictEqual(gifts, [[2019, 500], [2023, 2000]]);
});

test("gift history rejects garbage", function () {
  assert.throws(function () { R.parseGiftHistory("not-a-gift"); });
});

test("config validation names the missing field", function () {
  assert.throws(function () {
    R.validateCampaignConfig({ campaign_type: "annual_fund", charity_name: "ASPCA" });
  }, /as_of_date/);
});

test("letter date label formats without timezone drift", function () {
  assert.strictEqual(R.letterDateLabel({ as_of_date: "2024-06-30" }), "June 30, 2024");
});

if (failures.length) {
  console.log("\n" + failures.length + " FAILURE(S)");
  process.exit(1);
} else {
  console.log("\nall JS parity checks passed");
}
