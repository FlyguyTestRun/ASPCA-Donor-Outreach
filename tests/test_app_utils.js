/*
 * Tests for app.js utilities that don't have a Python equivalent to diff
 * against (CSV round-trip, the ZIP writer). The ZIP writer was also
 * verified by hand against Windows' native Expand-Archive, which
 * confirmed a real-world unzip tool reads it correctly; this test is the
 * permanent, automated regression guard for the same property, reading
 * the bytes back with a small independent parser rather than trusting
 * the writer to check its own work.
 *
 * Run: node tests/test_app_utils.js
 */
"use strict";
var assert = require("assert");
var path = require("path");
var App = require(path.join(__dirname, "..", "app.js"));

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

test("csv parse/write round-trip, including quoted fields", function () {
  var rows = [
    { donor_id: "D001", donor_name: "Robert Svensson", gift_history: "2010:25000;2013:30000" },
    { donor_id: "D002", donor_name: 'Name, "with" quirks', gift_history: "2020:100" },
  ];
  var csv = App.toCsv(rows, ["donor_id", "donor_name", "gift_history"]);
  var parsed = App.parseCsv(csv);
  assert.strictEqual(parsed.length, 2);
  assert.strictEqual(parsed[1].donor_name, 'Name, "with" quirks');
  assert.strictEqual(parsed[0].gift_history, "2010:25000;2013:30000");
});

// Minimal independent ZIP reader: parses local file headers directly out
// of the byte stream. Deliberately does not reuse any logic from
// makeZipBytes, so this is a real check of the format, not a mirror of
// the writer's own assumptions.
function readZipEntries(bytes) {
  var entries = [];
  var i = 0;
  while (i < bytes.length - 4) {
    var sig = bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24);
    if ((sig >>> 0) !== 0x04034b50) { i++; continue; }
    var compSize = bytes[i + 18] | (bytes[i + 19] << 8) | (bytes[i + 20] << 16) | (bytes[i + 21] << 24);
    var nameLen = bytes[i + 26] | (bytes[i + 27] << 8);
    var extraLen = bytes[i + 28] | (bytes[i + 29] << 8);
    var nameStart = i + 30;
    var name = Buffer.from(bytes.slice(nameStart, nameStart + nameLen)).toString("utf8");
    var dataStart = nameStart + nameLen + extraLen;
    var data = Buffer.from(bytes.slice(dataStart, dataStart + compSize)).toString("utf8");
    entries.push({ name: name, content: data });
    i = dataStart + compSize;
  }
  return entries;
}

test("zip writer produces entries a real reader can extract, content intact", function () {
  var files = [
    { name: "D002.html", content: "<html><body>Earl letter with a $ sign and unicode é</body></html>" },
    { name: "D024.html", content: "<html><body>Ruth letter</body></html>" },
  ];
  var bytes = App.makeZipBytes(files);
  assert.ok(bytes.length > 0);
  // Local file header magic number at the very start.
  assert.strictEqual(bytes[0], 0x50);
  assert.strictEqual(bytes[1], 0x4b);
  var extracted = readZipEntries(bytes);
  assert.strictEqual(extracted.length, 2);
  assert.strictEqual(extracted[0].name, "D002.html");
  assert.strictEqual(extracted[0].content, files[0].content);
  assert.strictEqual(extracted[1].name, "D024.html");
  assert.strictEqual(extracted[1].content, files[1].content);
});

test("crc32 is stable and distinguishes different content", function () {
  var a = App.crc32(Buffer.from("hello", "utf8"));
  var b = App.crc32(Buffer.from("hello", "utf8"));
  var c = App.crc32(Buffer.from("hellp", "utf8"));
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);
});

var BASE_CONFIG = {
  charity_name: "ASPCA", signer_name: "Jordan Ellis", signer_title: "Director",
  campaign_type: "annual_fund", donation_url: "https://x.org/donate", match_confirmed: false,
};

test("lapsed salutation overrides the donor's own computed tier format", function () {
  var donor = {
    donor_id: "D030", donor_name: "Michael Torres", title: "", tier: "Silver", status: "lapsed",
    lifetime_total: "1800", streak: "0", ask_amount: "50",
  };
  var model = App.buildLetterModel(donor, BASE_CONFIG, "June 30, 2024");
  assert.strictEqual(model.salutation, "We've missed you, Michael!");
});

test("silver/bronze salutation is first name only", function () {
  var donor = {
    donor_id: "D018", donor_name: "Margaret Alcott", title: "", tier: "Silver", status: "active",
    lifetime_total: "4950", streak: "0", ask_amount: "400",
  };
  var model = App.buildLetterModel(donor, BASE_CONFIG, "June 30, 2024");
  assert.strictEqual(model.salutation, "Hi Margaret,");
});

test("platinum/gold salutation uses title + last name when present", function () {
  var donor = {
    donor_id: "D001", donor_name: "Robert Svensson", title: "Dr.", tier: "Platinum", status: "active",
    lifetime_total: "145000", streak: "0", ask_amount: "20000", relationship_manager: "",
  };
  var model = App.buildLetterModel(donor, BASE_CONFIG, "June 30, 2024");
  assert.strictEqual(model.salutation, "Dear Dr. Svensson,");
});

test("platinum/gold salutation falls back to full name when no title on file", function () {
  var donor = {
    donor_id: "D002", donor_name: "Earl Fontaine", title: "", tier: "Platinum", status: "active",
    lifetime_total: "275000", streak: "0", ask_amount: "36100", relationship_manager: "",
  };
  var model = App.buildLetterModel(donor, BASE_CONFIG, "June 30, 2024");
  assert.strictEqual(model.salutation, "Dear Earl Fontaine,");
});

test("platinum relationship manager, when present, signs the letter instead of the campaign signer", function () {
  var donor = {
    donor_id: "D001", donor_name: "Robert Svensson", title: "", tier: "Platinum", status: "active",
    lifetime_total: "145000", streak: "0", ask_amount: "20000", relationship_manager: "Pat Nguyen",
  };
  var model = App.buildLetterModel(donor, BASE_CONFIG, "June 30, 2024");
  assert.strictEqual(model.signer_name, "Pat Nguyen");
  assert.strictEqual(model.signer_title, "Personal Relationship Manager");
});

test("platinum relationship manager absent falls back to the campaign's default signer", function () {
  var donor = {
    donor_id: "D001", donor_name: "Robert Svensson", title: "", tier: "Platinum", status: "active",
    lifetime_total: "145000", streak: "0", ask_amount: "20000", relationship_manager: "",
  };
  var model = App.buildLetterModel(donor, BASE_CONFIG, "June 30, 2024");
  assert.strictEqual(model.signer_name, "Jordan Ellis");
  assert.strictEqual(model.signer_title, "Director");
});

test("lapsed donor gets the Lapsed apologetic voice, not their underlying tier's voice", function () {
  var lapsed = App.buildLetterModel({
    donor_id: "D030", donor_name: "Michael Torres", title: "", tier: "Silver", status: "lapsed",
    lifetime_total: "1800", streak: "0", ask_amount: "50",
  }, BASE_CONFIG, "June 30, 2024");
  var active = App.buildLetterModel({
    donor_id: "D018", donor_name: "Margaret Alcott", title: "", tier: "Silver", status: "active",
    lifetime_total: "1800", streak: "0", ask_amount: "400",
  }, BASE_CONFIG, "June 30, 2024");
  assert.notStrictEqual(lapsed.opening_paragraph, active.opening_paragraph);
  assert.notStrictEqual(lapsed.closing_phrase, active.closing_phrase);
  assert.ok(/missed/i.test(lapsed.opening_paragraph));
});

test("a donor with no ask_amount still gets a placeholder HTML, not nothing", function () {
  var donor = {
    donor_id: "D001", donor_name: "Robert Svensson", tier: "Platinum", status: "lapsed",
    region: "Northeast", lifetime_total: "145000", last_gift_year: "2020",
    gift_history: "2010:25000;2013:30000;2016:40000;2020:50000",
    review_reasons: "lapsed Platinum donor: route to personal outreach, no automated letter",
    ask_amount: "",
  };
  var gen = App.generateForDonor(donor, BASE_CONFIG, "June 30, 2024");
  assert.strictEqual(gen.isPlaceholder, true);
  assert.ok(gen.letterHtml, "placeholder HTML should not be empty");
  assert.ok(/Internal review notice/.test(gen.letterHtml));
  assert.ok(/Robert Svensson/.test(gen.letterHtml));
  assert.ok(/route to personal outreach/.test(gen.letterHtml));
  assert.ok(/Not yet assigned/.test(gen.letterHtml));
});

test("a placeholder names the assigned relationship manager when one is on file", function () {
  var donor = {
    donor_id: "D001", donor_name: "Robert Svensson", tier: "Platinum", status: "lapsed",
    region: "Northeast", lifetime_total: "145000", last_gift_year: "2020",
    gift_history: "2010:25000", review_reasons: "lapsed Platinum donor: route to personal outreach",
    ask_amount: "", relationship_manager: "Pat Nguyen",
  };
  var gen = App.generateForDonor(donor, BASE_CONFIG, "June 30, 2024");
  assert.ok(/Pat Nguyen/.test(gen.letterHtml));
  assert.ok(!/Not yet assigned/.test(gen.letterHtml));
});

test("an exception (failed validation entirely) still gets a minimal placeholder", function () {
  var html = App.generateExceptionPlaceholder(
    { donor_id: "D999", donor_name: "Test Broken Donor", reason: "missing required field(s): gift_history" },
    "June 30, 2024"
  );
  assert.ok(/Internal review notice/.test(html));
  assert.ok(/Test Broken Donor/.test(html));
  assert.ok(/missing required field\(s\): gift_history/.test(html));
});

if (failures.length) {
  console.log("\n" + failures.length + " FAILURE(S)");
  process.exit(1);
} else {
  console.log("\nall app.js utility checks passed");
}
