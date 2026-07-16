/*
 * Shared policy implementation for the charity-donor-outreach skill.
 *
 * This is a line-for-line port of scripts/donor_rules.py. Every threshold
 * here must match references/policy.md and donor_rules.py exactly; if this
 * file and the Python version ever disagree, that is a defect, checked by
 * tests/test_js_parity.js against the same fixed expected values the
 * Python test suite asserts. Runs identically in Node (for the parity
 * test) and in the browser (for the interactive tool), with no build
 * step and no dependency.
 */
(function (root) {
  "use strict";

  var RULES_VERSION = "1.0.0";

  var TIER_MINIMUMS = [
    ["Platinum", 50000],
    ["Gold", 10000],
    ["Silver", 1000],
    ["Bronze", 0],
  ];
  var PERCENT_ASK = { Platinum: 0.40, Gold: 0.25, Silver: 0.15 };
  var FLAT_ASK_BRONZE = 150;
  var FLAT_ASK_LAPSED = 50;
  var LAPSED_AFTER_YEARS = 3;
  var LOYALTY_UPLIFT = 0.10;
  var VOLUNTEER_UPLIFT = 100;
  var EMERGENCY_MULTIPLIER = 1.2;
  var ROUND_TO = 50;
  var MIN_ASK = 50;

  var CAMPAIGN_TYPES = ["emergency_appeal", "annual_fund", "capital_campaign", "event_fundraiser"];

  var CONFIDENCE_FAIL_BELOW = 0.70;
  var CONFIDENCE_REPORT_BELOW = 0.90;
  var WARNING_PENALTY = 0.10;

  var GIFT_TOKEN = /^\s*(\d{4})\s*:\s*\$?\s*([\d,]+(?:\.\d+)?)\s*$/;

  var REQUIRED_CONFIG_FIELDS = [
    "campaign_type", "as_of_date", "charity_name", "donation_url",
    "signer_name", "signer_title", "match_confirmed",
  ];

  function fmtMoney(n) {
    var v = Math.round(n * 100) / 100;
    return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtMoney0(n) {
    return Math.round(n).toLocaleString("en-US");
  }

  function validateCampaignConfig(config) {
    // Same checks as donor_rules.load_campaign_config, applied to an
    // already-parsed object instead of a file path. Throws Error with a
    // specific, human-readable message naming exactly what is wrong.
    var missing = REQUIRED_CONFIG_FIELDS.filter(function (f) {
      var v = config[f];
      return v === undefined || v === null || v === "";
    });
    if (missing.length) {
      throw new Error("campaign config is missing required field(s): " + missing.join(", "));
    }
    if (CAMPAIGN_TYPES.indexOf(config.campaign_type) === -1) {
      throw new Error("campaign config campaign_type '" + config.campaign_type + "' is not one of " + CAMPAIGN_TYPES.join(", "));
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(config.as_of_date) || isNaN(Date.parse(config.as_of_date + "T00:00:00Z"))) {
      throw new Error("campaign config as_of_date '" + config.as_of_date + "' is not a valid YYYY-MM-DD date");
    }
    if (typeof config.match_confirmed !== "boolean") {
      throw new Error("campaign config match_confirmed must be true or false");
    }
    if (config.match_confirmed) {
      ["match_sponsor", "match_terms"].forEach(function (f) {
        if (!String(config[f] || "").trim()) {
          throw new Error("campaign config match_confirmed is true but " + f + " is missing");
        }
      });
    }
    return config;
  }

  function asOfYear(config) {
    return parseInt(String(config.as_of_date).split("-")[0], 10);
  }

  function letterDateLabel(config) {
    var MONTHS = ["January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"];
    var parts = String(config.as_of_date).split("-");
    var y = parts[0], m = parseInt(parts[1], 10), d = parseInt(parts[2], 10);
    return MONTHS[m - 1] + " " + String(d).padStart(2, "0") + ", " + y;
  }

  function parseGiftHistory(raw) {
    if (raw === null || raw === undefined || !String(raw).trim()) {
      throw new Error("gift_history is empty");
    }
    var tokens = String(raw).split(";");
    var gifts = [];
    for (var i = 0; i < tokens.length; i++) {
      var token = tokens[i];
      var match = GIFT_TOKEN.exec(token);
      if (!match) {
        throw new Error("unparseable gift entry: '" + token.trim() + "'");
      }
      var year = parseInt(match[1], 10);
      var amount = parseFloat(match[2].replace(/,/g, ""));
      if (!(amount > 0)) {
        throw new Error("non-positive gift amount: '" + token.trim() + "'");
      }
      gifts.push([year, amount]);
    }
    gifts.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    return gifts;
  }

  function computeTier(lifetimeTotal) {
    for (var i = 0; i < TIER_MINIMUMS.length; i++) {
      if (lifetimeTotal >= TIER_MINIMUMS[i][1]) return TIER_MINIMUMS[i][0];
    }
    return "Bronze";
  }

  function isLapsed(lastGiftYear, asOfYearVal) {
    return (asOfYearVal - lastGiftYear) > LAPSED_AFTER_YEARS;
  }

  function givingStreak(giftYears, asOfYearVal) {
    var years = {};
    giftYears.forEach(function (y) { years[y] = true; });
    var streak = 0, year = asOfYearVal - 1;
    while (years[year]) { streak += 1; year -= 1; }
    return streak;
  }

  function roundHalfUp(amount, step) {
    step = step || ROUND_TO;
    return Math.floor((amount + step / 2) / step) * step;
  }

  function computeAsk(opts) {
    // opts: {tier, lapsed, largestGift, lastGiftYear, volunteer, campaignType, asOfYear}
    var result = { amount: null, trace: [], warnings: [], reviewReasons: [] };

    if (opts.lapsed && (opts.tier === "Gold" || opts.tier === "Platinum")) {
      result.reviewReasons.push("lapsed " + opts.tier + " donor: route to personal outreach, no automated letter");
      result.trace.push("lapsed major donor: ask calculation skipped by policy");
      return result;
    }

    var amount;
    if (opts.lapsed) {
      amount = FLAT_ASK_LAPSED;
      result.trace.push("base: lapsed re-engagement flat $" + FLAT_ASK_LAPSED);
    } else if (PERCENT_ASK.hasOwnProperty(opts.tier)) {
      var pct = PERCENT_ASK[opts.tier];
      amount = opts.largestGift * pct;
      result.trace.push("base: " + opts.tier + " " + Math.round(pct * 100) + "% of largest gift $" + fmtMoney0(opts.largestGift) + " = $" + fmtMoney(amount));
    } else {
      amount = FLAT_ASK_BRONZE;
      result.trace.push("base: Bronze flat $" + FLAT_ASK_BRONZE);
    }

    if (opts.lastGiftYear === opts.asOfYear - 1) {
      amount *= 1 + LOYALTY_UPLIFT;
      result.trace.push("loyalty uplift: gave in " + (opts.asOfYear - 1) + ", x" + (1 + LOYALTY_UPLIFT).toFixed(2) + " = $" + fmtMoney(amount));
    }
    if (opts.volunteer) {
      amount += VOLUNTEER_UPLIFT;
      result.trace.push("volunteer uplift: +$" + VOLUNTEER_UPLIFT + " = $" + fmtMoney(amount));
    }
    if (opts.campaignType === "emergency_appeal") {
      amount *= EMERGENCY_MULTIPLIER;
      result.trace.push("emergency multiplier: x" + EMERGENCY_MULTIPLIER + " = $" + fmtMoney(amount));
    }

    var rounded = Math.max(roundHalfUp(amount), MIN_ASK);
    result.trace.push("rounded once to nearest $" + ROUND_TO + ": $" + fmtMoney0(rounded));
    result.amount = rounded;

    if (!opts.lapsed && PERCENT_ASK.hasOwnProperty(opts.tier) && rounded > opts.largestGift) {
      result.reviewReasons.push("computed ask $" + fmtMoney0(rounded) + " exceeds largest single gift $" + fmtMoney0(opts.largestGift) + ": needs a fundraiser's judgment before sending, not capped automatically");
    }

    return result;
  }

  function confidenceScore(warningCount) {
    return Math.round(Math.max(1.0 - WARNING_PENALTY * warningCount, 0.0) * 100) / 100;
  }

  function confidenceBand(confidence) {
    if (confidence < CONFIDENCE_FAIL_BELOW) return "fail";
    if (confidence < CONFIDENCE_REPORT_BELOW) return "report";
    return "pass";
  }

  function reviewLevel(tier, confidence, reviewReasons) {
    if (tier === "Platinum" || (reviewReasons && reviewReasons.length) || confidence < CONFIDENCE_REPORT_BELOW) {
      return "mandatory";
    }
    if (confidence < 1.0) return "recommended";
    return "none";
  }

  function csvSafe(value) {
    var text = String(value);
    var first = text.slice(0, 1);
    return (first === "=" || first === "+" || first === "-" || first === "@") ? "'" + text : text;
  }

  function esc(value) {
    // Matches Python's html.escape(str(value), quote=False): & < > only.
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function splitName(fullName) {
    var parts = String(fullName).trim().split(/\s+/).filter(Boolean);
    if (parts.length <= 1) return [parts[0] || "", parts[0] || ""];
    return [parts.slice(0, -1).join(" "), parts[parts.length - 1]];
  }

  var DonorRules = {
    RULES_VERSION: RULES_VERSION,
    TIER_MINIMUMS: TIER_MINIMUMS,
    PERCENT_ASK: PERCENT_ASK,
    FLAT_ASK_BRONZE: FLAT_ASK_BRONZE,
    FLAT_ASK_LAPSED: FLAT_ASK_LAPSED,
    LAPSED_AFTER_YEARS: LAPSED_AFTER_YEARS,
    CAMPAIGN_TYPES: CAMPAIGN_TYPES,
    CONFIDENCE_FAIL_BELOW: CONFIDENCE_FAIL_BELOW,
    CONFIDENCE_REPORT_BELOW: CONFIDENCE_REPORT_BELOW,
    validateCampaignConfig: validateCampaignConfig,
    asOfYear: asOfYear,
    letterDateLabel: letterDateLabel,
    parseGiftHistory: parseGiftHistory,
    computeTier: computeTier,
    isLapsed: isLapsed,
    givingStreak: givingStreak,
    roundHalfUp: roundHalfUp,
    computeAsk: computeAsk,
    confidenceScore: confidenceScore,
    confidenceBand: confidenceBand,
    reviewLevel: reviewLevel,
    csvSafe: csvSafe,
    esc: esc,
    splitName: splitName,
    fmtMoney0: fmtMoney0,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = DonorRules;
  } else {
    root.DonorRules = DonorRules;
  }
})(typeof window !== "undefined" ? window : this);
