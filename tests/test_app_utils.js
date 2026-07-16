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

if (failures.length) {
  console.log("\n" + failures.length + " FAILURE(S)");
  process.exit(1);
} else {
  console.log("\nall app.js utility checks passed");
}
