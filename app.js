/*
 * Pipeline logic layer: validate -> calculate -> generate, as pure
 * functions over plain JS objects. Ports scripts/validate_input.py and
 * scripts/generate_letters.py. No DOM access here; ui.js owns state and
 * rendering and calls into this file. Depends on donor_rules.js (window.DonorRules).
 */
(function (root) {
  "use strict";
  var R = (typeof module !== "undefined" && module.exports) ? require("./donor_rules.js") : root.DonorRules;

  // RFC4180-ish CSV parser: quoted fields, embedded commas/newlines/escaped
  // quotes ("" inside a quoted field). Used both for the browser file
  // upload and for the Node full-pipeline parity test. Returns a list of
  // plain objects keyed by the header row.
  function parseCsv(text) {
    var rows = [];
    var row = [];
    var field = "";
    var inQuotes = false;
    var i = 0;
    var n = text.length;
    function pushField() { row.push(field); field = ""; }
    function pushRow() { pushField(); rows.push(row); row = []; }
    while (i < n) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i += 1; continue;
        }
        field += c; i += 1; continue;
      }
      if (c === '"') { inQuotes = true; i += 1; continue; }
      if (c === ',') { pushField(); i += 1; continue; }
      if (c === '\r') { i += 1; continue; }
      if (c === '\n') { pushRow(); i += 1; continue; }
      field += c; i += 1;
    }
    if (field.length || row.length) pushRow();
    while (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") rows.pop();
    if (!rows.length) return [];
    var headers = rows[0].map(function (h) { return h.trim(); });
    return rows.slice(1).map(function (r) {
      var obj = {};
      headers.forEach(function (h, idx) { obj[h] = r[idx] !== undefined ? r[idx] : ""; });
      return obj;
    });
  }

  function toCsv(rows, fieldnames) {
    var cols = fieldnames || (rows.length ? Object.keys(rows[0]) : []);
    function esc(v) {
      var s = v === null || v === undefined ? "" : String(v);
      if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    }
    var lines = [cols.join(",")];
    rows.forEach(function (r) { lines.push(cols.map(function (c) { return esc(r[c]); }).join(",")); });
    return lines.join("\r\n") + "\r\n";
  }

  // ---- minimal ZIP writer (STORE only, no compression) ----
  // No external dependency: a full compressing zip library is real weight
  // to inline for one feature. STORE-method entries are a fully valid ZIP
  // file, just uncompressed; for a batch of short text letters the size
  // difference is negligible and every mainstream unzip tool opens it
  // exactly like any other .zip. Returns a Uint8Array; callers wrap it in
  // a Blob for download.
  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function utf8Bytes(str) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(str);
    // Node fallback for the test suite.
    return new Uint8Array(Buffer.from(str, "utf8"));
  }

  function writeUint32LE(arr, offset, value) {
    arr[offset] = value & 0xFF;
    arr[offset + 1] = (value >>> 8) & 0xFF;
    arr[offset + 2] = (value >>> 16) & 0xFF;
    arr[offset + 3] = (value >>> 24) & 0xFF;
  }
  function writeUint16LE(arr, offset, value) {
    arr[offset] = value & 0xFF;
    arr[offset + 1] = (value >>> 8) & 0xFF;
  }

  function makeZipBytes(files) {
    // files: [{name: string, content: string}]
    var DOS_TIME = 0x0000, DOS_DATE = 0x0021; // fixed dummy timestamp, not load-bearing
    var localParts = [];
    var centralParts = [];
    var offset = 0;

    files.forEach(function (file) {
      var nameBytes = utf8Bytes(file.name);
      var dataBytes = utf8Bytes(file.content);
      var crc = crc32(dataBytes);

      var local = new Uint8Array(30 + nameBytes.length);
      writeUint32LE(local, 0, 0x04034b50);
      writeUint16LE(local, 4, 20);
      writeUint16LE(local, 6, 0);
      writeUint16LE(local, 8, 0); // method 0 = store
      writeUint16LE(local, 10, DOS_TIME);
      writeUint16LE(local, 12, DOS_DATE);
      writeUint32LE(local, 14, crc);
      writeUint32LE(local, 18, dataBytes.length);
      writeUint32LE(local, 22, dataBytes.length);
      writeUint16LE(local, 26, nameBytes.length);
      writeUint16LE(local, 28, 0);
      local.set(nameBytes, 30);

      localParts.push(local, dataBytes);

      var central = new Uint8Array(46 + nameBytes.length);
      writeUint32LE(central, 0, 0x02014b50);
      writeUint16LE(central, 4, 20);
      writeUint16LE(central, 6, 20);
      writeUint16LE(central, 8, 0);
      writeUint16LE(central, 10, 0);
      writeUint16LE(central, 12, DOS_TIME);
      writeUint16LE(central, 14, DOS_DATE);
      writeUint32LE(central, 16, crc);
      writeUint32LE(central, 20, dataBytes.length);
      writeUint32LE(central, 24, dataBytes.length);
      writeUint16LE(central, 28, nameBytes.length);
      writeUint16LE(central, 30, 0);
      writeUint16LE(central, 32, 0);
      writeUint16LE(central, 34, 0);
      writeUint16LE(central, 36, 0);
      writeUint32LE(central, 38, 0);
      writeUint32LE(central, 42, offset);
      central.set(nameBytes, 46);
      centralParts.push(central);

      offset += local.length + dataBytes.length;
    });

    var centralStart = offset;
    var centralSize = centralParts.reduce(function (sum, p) { return sum + p.length; }, 0);

    var end = new Uint8Array(22);
    writeUint32LE(end, 0, 0x06054b50);
    writeUint16LE(end, 4, 0);
    writeUint16LE(end, 6, 0);
    writeUint16LE(end, 8, files.length);
    writeUint16LE(end, 10, files.length);
    writeUint32LE(end, 12, centralSize);
    writeUint32LE(end, 16, centralStart);
    writeUint16LE(end, 20, 0);

    var totalLength = localParts.reduce(function (s, p) { return s + p.length; }, 0) + centralSize + end.length;
    var out = new Uint8Array(totalLength);
    var pos = 0;
    localParts.forEach(function (p) { out.set(p, pos); pos += p.length; });
    centralParts.forEach(function (p) { out.set(p, pos); pos += p.length; });
    out.set(end, pos);
    return out;
  }

  var REQUIRED_FIELDS = ["donor_id", "donor_name", "gift_history"];
  var VOLUNTEER_YES = ["yes", "y", "true", "1"];
  var VOLUNTEER_NO = ["no", "n", "false", "0", ""];

  function statedFloat(raw) {
    var text = String(raw == null ? "" : raw).trim().replace(/,/g, "").replace(/\$/g, "");
    if (!text) return { value: null, garbage: false };
    var n = Number(text);
    if (isNaN(n)) return { value: null, garbage: true };
    return { value: n, garbage: false };
  }
  function statedInt(raw) {
    var r = statedFloat(raw);
    return { value: r.value == null ? null : Math.trunc(r.value), garbage: r.garbage };
  }

  // Mirrors validate_input.validate_row. Returns {record, exceptionReasons, mismatches}.
  function validateRow(row, asOfYear) {
    var donorId = String(row.donor_id || "").trim();
    var donorName = String(row.donor_name || "").trim();

    var missing = REQUIRED_FIELDS.filter(function (f) { return !String(row[f] || "").trim(); });
    if (missing.length) {
      return { record: null, exceptionReasons: ["missing required field(s): " + missing.join(", ")], mismatches: [] };
    }

    var gifts;
    try {
      gifts = R.parseGiftHistory(row.gift_history);
    } catch (exc) {
      return { record: null, exceptionReasons: ["unparseable gift_history: " + exc.message], mismatches: [] };
    }

    var future = gifts.filter(function (g) { return g[0] > asOfYear; }).map(function (g) { return g[0]; });
    if (future.length) {
      var uniqFuture = future.filter(function (v, i) { return future.indexOf(v) === i; }).sort();
      return { record: null, exceptionReasons: ["gift year(s) " + JSON.stringify(uniqFuture) + " are after the campaign as_of year " + asOfYear], mismatches: [] };
    }

    var amounts = gifts.map(function (g) { return g[1]; });
    var years = gifts.map(function (g) { return g[0]; });
    var computedLargest = Math.max.apply(null, amounts);
    var computedLifetime = amounts.reduce(function (a, b) { return a + b; }, 0);
    var computedLastYear = Math.max.apply(null, years);

    var warnings = [];
    var mismatches = [];

    var sl = statedFloat(row.largest_gift);
    if (sl.garbage) { warnings.push("stated largest_gift '" + row.largest_gift + "' is not a number: ignored, computed value used"); mismatches.push("value"); }
    else if (sl.value != null && Math.abs(sl.value - computedLargest) > 0.01) { warnings.push("stated largest_gift $" + R.fmtMoney0(sl.value) + " disagrees with computed $" + R.fmtMoney0(computedLargest) + " from gift_history: computed value used"); mismatches.push("value"); }

    var slt = statedFloat(row.lifetime_total);
    if (slt.garbage) { warnings.push("stated lifetime_total '" + row.lifetime_total + "' is not a number: ignored, computed value used"); mismatches.push("value"); }
    else if (slt.value != null && Math.abs(slt.value - computedLifetime) > 0.01) { warnings.push("stated lifetime_total $" + R.fmtMoney0(slt.value) + " disagrees with computed $" + R.fmtMoney0(computedLifetime) + " from gift_history: computed value used"); mismatches.push("value"); }

    var sly = statedInt(row.last_gift_year);
    if (sly.garbage) { warnings.push("stated last_gift_year '" + row.last_gift_year + "' is not a number: ignored, computed value used"); mismatches.push("value"); }
    else if (sly.value != null && sly.value !== computedLastYear) { warnings.push("stated last_gift_year " + sly.value + " disagrees with computed " + computedLastYear + " from gift_history: computed value used"); mismatches.push("value"); }

    var computedTier = R.computeTier(computedLifetime);
    var statedTier = String(row.tier || "").trim();
    var mandatoryReasons = [];
    if (statedTier && statedTier !== "Lapsed" && statedTier !== "Unknown" && statedTier !== computedTier) {
      warnings.push("stated tier '" + statedTier + "' disagrees with computed tier '" + computedTier + "' from lifetime_total $" + R.fmtMoney0(computedLifetime) + ": computed tier used");
      mismatches.push("tier");
      mandatoryReasons.push("tier corrected from '" + statedTier + "' to '" + computedTier + "': verify against the source system before sending");
    }

    var lapsed = R.isLapsed(computedLastYear, asOfYear);
    var volunteerRaw = String(row.volunteer || "").trim().toLowerCase();
    if (VOLUNTEER_YES.indexOf(volunteerRaw) === -1 && VOLUNTEER_NO.indexOf(volunteerRaw) === -1) {
      warnings.push("unrecognized volunteer value '" + row.volunteer + "': treated as No");
    }
    var volunteer = VOLUNTEER_YES.indexOf(volunteerRaw) !== -1;

    var record = {
      donor_id: donorId,
      donor_name: donorName,
      title: String(row.title || "").trim(),
      region: String(row.region || "").trim(),
      gift_history: String(row.gift_history).trim(),
      largest_gift: computedLargest.toFixed(2),
      lifetime_total: computedLifetime.toFixed(2),
      last_gift_year: String(computedLastYear),
      volunteer: volunteer ? "Yes" : "No",
      tier: computedTier,
      status: lapsed ? "lapsed" : "active",
      warnings: warnings.join(" | "),
      mandatory_reasons: mandatoryReasons.join(" | "),
      rules_version: R.RULES_VERSION,
    };
    return { record: record, exceptionReasons: [], mismatches: mismatches };
  }

  // Runs validate_row across a raw row list. Duplicate donor_id detection
  // included, mirroring validate_input.run's line loop.
  function runValidation(rows, config) {
    var asOfYear = R.asOfYear(config);
    var validated = [], exceptions = [];
    var seenIds = {};
    var tierMismatchCount = 0, otherMismatchCount = 0;

    rows.forEach(function (row, idx) {
      var donorId = String(row.donor_id || "").trim();
      if (donorId && seenIds.hasOwnProperty(donorId)) {
        exceptions.push({ line: idx + 2, donor_id: donorId, donor_name: row.donor_name || "", reason: "duplicate donor_id, first seen at line " + seenIds[donorId] });
        return;
      }
      var result = validateRow(row, asOfYear);
      if (result.exceptionReasons.length) {
        exceptions.push({ line: idx + 2, donor_id: donorId, donor_name: row.donor_name || "", reason: result.exceptionReasons.join("; ") });
        return;
      }
      if (donorId) seenIds[donorId] = idx + 2;
      tierMismatchCount += result.mismatches.filter(function (m) { return m === "tier"; }).length;
      otherMismatchCount += result.mismatches.filter(function (m) { return m === "value"; }).length;
      validated.push(result.record);
    });

    return { validated: validated, exceptions: exceptions, tierMismatchCount: tierMismatchCount, otherMismatchCount: otherMismatchCount };
  }

  // Mirrors calculate_ask.run's per-donor loop.
  function calculateAsk(donor, config) {
    var asOfYear = R.asOfYear(config);
    var giftYears = R.parseGiftHistory(donor.gift_history).map(function (g) { return g[0]; });
    var ask = R.computeAsk({
      tier: donor.tier, lapsed: donor.status === "lapsed",
      largestGift: parseFloat(donor.largest_gift), lastGiftYear: parseInt(donor.last_gift_year, 10),
      volunteer: donor.volunteer === "Yes", campaignType: config.campaign_type, asOfYear: asOfYear,
    });

    var validationWarnings = (donor.warnings || "").split(" | ").filter(Boolean);
    var allWarnings = validationWarnings.concat(ask.warnings);
    var confidence = R.confidenceScore(allWarnings.length);
    var band = R.confidenceBand(confidence);
    var amount = ask.amount;
    var reviewReasons = ask.reviewReasons.slice();
    if (band === "fail" && amount !== null) {
      amount = null;
      reviewReasons.push("confidence " + confidence.toFixed(2) + " is below the fail threshold " + R.CONFIDENCE_FAIL_BELOW.toFixed(2) + ": blocked pending data fixes");
    }
    var mandatoryFromValidation = (donor.mandatory_reasons || "").split(" | ").filter(Boolean);
    var allReviewReasons = reviewReasons.concat(mandatoryFromValidation);
    var level = R.reviewLevel(donor.tier, confidence, allReviewReasons);

    var out = {};
    Object.keys(donor).forEach(function (k) { out[k] = donor[k]; });
    out.streak = String(R.givingStreak(giftYears, asOfYear));
    out.ask_amount = amount === null ? "" : String(amount);
    out.ask_trace = ask.trace.join(" -> ");
    out.warnings = allWarnings.join(" | ");
    out.review_reasons = allReviewReasons.join(" | ");
    out.confidence = confidence.toFixed(2);
    out.confidence_band = band;
    out.review_level = level;
    return out;
  }

  // ---- letter generation (ports generate_letters.py) ----

  var BASE_PARAGRAPHS = {
    emergency_appeal: "Right now, animals rescued from cruelty and neglect need emergency shelter, veterinary care, and a safe place to recover. Your gift today goes to work immediately, funding rescue operations and urgent medical treatment for animals with nowhere else to turn.",
    annual_fund: "Year after year, steady support from donors like you is what allows us to plan rescues, staff shelters, and answer every call for help. Your continued partnership is the foundation this work is built on.",
    annual_fund_lapsed: "Our work to plan rescues, staff shelters, and answer every call for help depends on donors who step back in when they are able. We would be glad to have you with us again.",
    capital_campaign: "We are building spaces that will shelter and heal animals for decades to come. A gift to this campaign is a lasting investment, one that will still be saving lives long after the construction dust has settled.",
    event_fundraiser: "Our upcoming event brings together supporters from across the community for the animals we all care about. We would love for you to be part of it.",
  };

  var TIER_VOICE = {
    Platinum: { thanks: "On behalf of everyone at {charity}, I want to extend my deepest, most personal gratitude for your extraordinary generosity.", closing_phrase: "With my deepest gratitude" },
    Gold: { thanks: "On behalf of everyone at {charity}, I want to personally thank you for your generosity and your continued partnership with our work.", closing_phrase: "With gratitude" },
    Silver: { thanks: "On behalf of everyone at {charity}, thank you so much for your generosity and for being part of our community of supporters.", closing_phrase: "With thanks" },
    Bronze: { thanks: "On behalf of everyone at {charity}, thank you for your support. Every gift, no matter the size, helps make a real difference.", closing_phrase: "Thanks so much" },
  };

  var TIER_CLOSING_LINE = {
    Platinum: "Given your extraordinary generosity, I would welcome a conversation about a naming opportunity in recognition of your support.",
    Gold: "Your gift can also be structured as a legacy commitment; I am glad to share more about our legacy giving options.",
    Silver: "Consider spreading your impact across the year with our monthly giving option.",
    Bronze: "You can also multiply your impact by starting your own peer fundraising page!",
  };

  var LIFETIME_MENTION_MINIMUM = 500;
  var REQUIRED_LETTER_FIELDS = ["donor_id", "letter_date", "salutation", "opening_paragraph", "campaign_paragraph", "ask_paragraph", "closing_phrase", "signer_name", "signer_title", "charity_name", "donation_url"];

  function buildCampaignParagraph(donor, config) {
    var type = config.campaign_type;
    if (type === "emergency_appeal") {
      var text = BASE_PARAGRAPHS.emergency_appeal;
      if (config.match_confirmed) {
        text += " Thanks to a generous match from " + R.esc(config.match_sponsor) + ", your gift will be " + R.esc(config.match_terms) + ".";
      }
      return text;
    }
    if (type === "annual_fund") {
      var lapsed = donor.status === "lapsed";
      var t = lapsed ? BASE_PARAGRAPHS.annual_fund_lapsed : BASE_PARAGRAPHS.annual_fund;
      var streak = parseInt(donor.streak, 10) || 0;
      if (!lapsed && streak >= 2) t += " This gift will mark " + (streak + 1) + " years in a row you have stood with us.";
      return t;
    }
    if (type === "capital_campaign") return BASE_PARAGRAPHS.capital_campaign;
    if (type === "event_fundraiser") {
      var e = BASE_PARAGRAPHS.event_fundraiser;
      var count = config.event_registered_count;
      if (count) e += " Already, " + count + " people have registered to join us.";
      return e;
    }
    throw new Error("unknown campaign_type: " + type);
  }

  function buildAskParagraph(donor, config) {
    var ask = Math.trunc(parseFloat(donor.ask_amount));
    var lapsed = donor.status === "lapsed";
    var line;
    if (lapsed) {
      line = "It would mean a great deal to have you back among our supporters.";
      var gift = config.reengagement_gift;
      if (gift) line += " As a thank-you for stepping back in, we would like to send you " + R.esc(gift) + ".";
    } else {
      line = TIER_CLOSING_LINE[donor.tier] || "";
    }
    return ("Today, I would like to invite you to make a gift of $" + R.fmtMoney0(ask) + ". " + line).trim();
  }

  function buildSalutation(donor) {
    var parts = R.splitName(donor.donor_name);
    var title = donor.title;
    if (title) return "Dear " + R.esc(title) + " " + R.esc(parts[1]) + ",";
    return "Dear " + R.esc(parts[0]) + " " + R.esc(parts[1]) + ",";
  }

  function buildOpeningParagraph(donor, charityName) {
    var voice = TIER_VOICE[donor.tier];
    var text = voice.thanks.replace("{charity}", R.esc(charityName));
    var lifetime = parseFloat(donor.lifetime_total);
    if (lifetime >= LIFETIME_MENTION_MINIMUM) {
      text += " Your lifetime support of $" + R.fmtMoney0(lifetime) + " has made a real difference.";
    }
    return text;
  }

  function buildLetterModel(donor, config, letterDate) {
    return {
      donor_id: donor.donor_id,
      letter_date: letterDate,
      salutation: buildSalutation(donor),
      opening_paragraph: buildOpeningParagraph(donor, config.charity_name),
      campaign_paragraph: buildCampaignParagraph(donor, config),
      ask_paragraph: buildAskParagraph(donor, config),
      closing_phrase: TIER_VOICE[donor.tier].closing_phrase,
      signer_name: R.esc(config.signer_name),
      signer_title: R.esc(config.signer_title),
      charity_name: R.esc(config.charity_name),
      donation_url: R.esc(config.donation_url),
    };
  }

  function validateLetterModel(model) {
    var errors = [];
    REQUIRED_LETTER_FIELDS.forEach(function (f) {
      var v = model[f];
      if (typeof v !== "string" || !v.trim()) errors.push("missing or empty required field: " + f);
    });
    var amounts = (model.ask_paragraph || "").match(/\$[\d,]+/g) || [];
    if (amounts.length !== 1) errors.push("ask_paragraph must contain exactly 1 dollar amount, found " + amounts.length);
    var url = model.donation_url || "";
    if (url && url.indexOf("http://") !== 0 && url.indexOf("https://") !== 0) errors.push("donation_url must be an http(s) URL");
    return errors;
  }

  var TEMPLATE = [
    "<html>",
    '<body style="font-family: Georgia; padding: 30px; max-width: 600px; color: #222;">',
    "",
    '  <p style="text-align:right; color: #888;">{letter_date}</p>',
    "",
    "  <p>{salutation}</p>",
    "",
    "  <p>{opening_paragraph}</p>",
    "",
    "  <p>{campaign_paragraph}</p>",
    "",
    "  <p>{ask_paragraph}</p>",
    "",
    "  <p>To give, simply reply to this email or visit our donation page at",
    "  <strong>{donation_url}</strong>.</p>",
    "",
    "  <p>{closing_phrase},<br>",
    "  <strong>{signer_name}</strong><br>",
    "  {signer_title}, {charity_name}</p>",
    "",
    "</body>",
    "</html>",
  ].join("\n");

  function renderLetterHtml(model) {
    var out = TEMPLATE;
    Object.keys(model).forEach(function (k) {
      out = out.split("{" + k + "}").join(model[k]);
    });
    return out;
  }

  // Full per-donor pipeline for generation: returns {letterHtml, model, manifestNote} or {manifestNote} if no letter.
  function generateForDonor(donor, config, letterDate) {
    if (!donor.ask_amount) {
      return { letterHtml: null, model: null, note: donor.review_reasons || "blocked pending data fixes" };
    }
    var model = buildLetterModel(donor, config, letterDate);
    var errors = validateLetterModel(model);
    if (errors.length) {
      return { letterHtml: null, model: null, note: "letter schema validation failed: " + errors.join("; "), forceMandatory: true };
    }
    return { letterHtml: renderLetterHtml(model), model: model, note: donor.review_reasons || "" };
  }

  var App = {
    parseCsv: parseCsv,
    toCsv: toCsv,
    makeZipBytes: makeZipBytes,
    crc32: crc32,
    validateRow: validateRow,
    runValidation: runValidation,
    calculateAsk: calculateAsk,
    buildLetterModel: buildLetterModel,
    validateLetterModel: validateLetterModel,
    renderLetterHtml: renderLetterHtml,
    generateForDonor: generateForDonor,
    TIER_VOICE: TIER_VOICE,
    BASE_PARAGRAPHS: BASE_PARAGRAPHS,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = App;
  } else {
    root.App = App;
  }
})(typeof window !== "undefined" ? window : this);
