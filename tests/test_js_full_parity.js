/*
 * Full-pipeline parity: runs app.js's validate+calculate over
 * sample-donors.csv and diffs every field against the real, actual
 * output the Python pipeline produced (work/validated.csv,
 * work/computed.csv from the repo root). This is the strongest parity
 * check in the suite: not isolated assertions, the two implementations'
 * real output on the real 50-donor fixture, field by field.
 *
 * Requires a fresh Python run first:
 *   python scripts/validate_input.py --input sample-donors.csv --config references/campaign_config.example.json
 *   python scripts/calculate_ask.py --config references/campaign_config.example.json
 *
 * Run: node tests/test_js_full_parity.js
 */
"use strict";
var fs = require("fs");
var path = require("path");
var App = require(path.join(__dirname, "..", "app.js"));

var ROOT = path.join(__dirname, "..");

function readCsv(p) {
  return App.parseCsv(fs.readFileSync(p, "utf8"));
}

var config = JSON.parse(fs.readFileSync(path.join(ROOT, "references", "campaign_config.example.json"), "utf8").replace(/^﻿/, ""));
var donorRows = readCsv(path.join(ROOT, "sample-donors.csv"));

var validated = App.runValidation(donorRows, config);
var pyValidated = readCsv(path.join(ROOT, "work", "validated.csv"));
var pyComputed = readCsv(path.join(ROOT, "work", "computed.csv"));

if (!pyValidated.length || !pyComputed.length) {
  console.error("work/validated.csv or work/computed.csv is empty or missing. Run the Python pipeline first (see file header).");
  process.exit(2);
}

var pyById = {};
pyValidated.forEach(function (r) { pyById[r.donor_id] = r; });

var VALIDATED_FIELDS = ["donor_name", "title", "region", "relationship_manager", "largest_gift", "lifetime_total", "last_gift_year", "volunteer", "tier", "status", "warnings", "mandatory_reasons"];

var mismatches = 0;
if (validated.validated.length !== pyValidated.length) {
  console.log("MISMATCH: JS validated " + validated.validated.length + " donors, Python validated " + pyValidated.length);
  mismatches++;
}
validated.validated.forEach(function (jsRow) {
  var pyRow = pyById[jsRow.donor_id];
  if (!pyRow) { console.log("MISMATCH: " + jsRow.donor_id + " present in JS output, missing from Python output"); mismatches++; return; }
  VALIDATED_FIELDS.forEach(function (f) {
    if (String(jsRow[f]) !== String(pyRow[f])) {
      console.log("MISMATCH " + jsRow.donor_id + "." + f + ": JS=" + JSON.stringify(jsRow[f]) + " PY=" + JSON.stringify(pyRow[f]));
      mismatches++;
    }
  });
});

// Now run calculate on the JS-validated set and compare to computed.csv.
var pyComputedById = {};
pyComputed.forEach(function (r) { pyComputedById[r.donor_id] = r; });
var COMPUTED_FIELDS = ["streak", "ask_amount", "confidence", "confidence_band", "review_level"];

validated.validated.forEach(function (jsRow) {
  var computed = App.calculateAsk(jsRow, config);
  var pyRow = pyComputedById[jsRow.donor_id];
  if (!pyRow) { console.log("MISMATCH: " + jsRow.donor_id + " missing from Python computed.csv"); mismatches++; return; }
  COMPUTED_FIELDS.forEach(function (f) {
    if (String(computed[f]) !== String(pyRow[f])) {
      console.log("MISMATCH " + jsRow.donor_id + "." + f + ": JS=" + JSON.stringify(computed[f]) + " PY=" + JSON.stringify(pyRow[f]));
      mismatches++;
    }
  });
});

console.log("\ndonors compared: " + validated.validated.length);
console.log("tier mismatches JS found: " + validated.tierMismatchCount + " (Python found 4 on the known fixture)");

if (mismatches) {
  console.log("\n" + mismatches + " FIELD MISMATCH(ES) between JS and Python output");
  process.exit(1);
} else {
  console.log("\nJS and Python produce identical output on all " + validated.validated.length + " donors, every compared field.");
}
