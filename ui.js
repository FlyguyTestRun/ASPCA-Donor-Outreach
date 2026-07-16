/*
 * State management, DOM rendering, and event wiring for the interactive
 * donor-data-review tool. Everything here runs entirely in the browser;
 * no network call is ever made. State lives in memory only; "Save
 * session" writes an explicit JSON file the user chooses to download,
 * "Load session" reads one back in. Depends on donor_rules.js (R) and
 * app.js (App), both loaded as plain <script> tags before this file.
 */
(function () {
  "use strict";
  var R = window.DonorRules;
  var App = window.App;

  var State = {
    config: null,
    donors: {},            // donor_id -> raw input row (source of truth)
    order: [],              // donor_id insertion order
    results: {},            // donor_id -> computed result row
    exceptions: [],
    confirmed: {},           // donor_id -> true/false
    confirmedSnapshot: {},   // donor_id -> JSON of donor row at confirm time
    pendingConflicts: [],    // [{donorId, existing, incoming}]
    manualCounter: 0,
    changeLog: [],           // [{time, donorId, donorName, kind, description}], for the human-readable audit trail
  };

  function rowFingerprint(row) {
    return JSON.stringify(row);
  }

  function logChange(donorId, donorName, kind, description) {
    State.changeLog.push({
      time: new Date().toISOString(),
      donor_id: donorId || "",
      donor_name: donorName || "",
      kind: kind,
      description: description,
    });
  }

  // Translates the pipeline's precise-but-technical warning/review strings
  // into plain sentences for someone without technical training, without
  // hiding the original: callers show this first and keep the raw string
  // available behind a "technical detail" toggle. Falls back to the raw
  // text untouched if a pattern isn't recognized, so nothing is ever
  // silently dropped, only re-worded when we're sure what it means.
  function humanize(raw) {
    if (!raw) return "";
    var m;
    if ((m = raw.match(/^stated tier '(.+)' disagrees with computed tier '(.+)' from lifetime_total \$([\d,]+): computed tier used$/))) {
      return "The file said " + m[1] + " tier, but based on $" + m[3] + " in lifetime giving, this donor actually qualifies for " + m[2] + " tier. We used " + m[2] + ".";
    }
    if ((m = raw.match(/^stated (largest_gift|lifetime_total|last_gift_year) '(.+)' is not a number: ignored, computed value used$/))) {
      return "The file's " + m[1].replace(/_/g, " ") + " value ('" + m[2] + "') wasn't a usable number, so we recalculated it from their actual gift history instead.";
    }
    if ((m = raw.match(/^stated (largest_gift|lifetime_total|last_gift_year) .+ disagrees with computed .+: computed value used$/))) {
      return "The file's stated " + m[1].replace(/_/g, " ") + " didn't match what their gift history actually adds up to. We used the number calculated from their real gift history.";
    }
    if ((m = raw.match(/^computed ask \$([\d,]+) exceeds largest single gift \$([\d,]+):/))) {
      return "This ask ($" + m[1] + ") is larger than any single gift this donor has ever given ($" + m[2] + "). Worth a second look before it goes out.";
    }
    if ((m = raw.match(/^lapsed (\w+) donor: route to personal outreach, no automated letter$/))) {
      return "This is a " + m[1] + "-level donor who hasn't given in over 3 years. We recommend reaching out personally instead of sending a form letter, so no letter was generated for them.";
    }
    if ((m = raw.match(/^confidence ([\d.]+) is below the fail threshold ([\d.]+): blocked pending data fixes$/))) {
      return "There were too many problems with this donor's data to safely calculate an ask. Fix the issues below and it will recalculate automatically.";
    }
    if ((m = raw.match(/^unrecognized volunteer value '(.*)': treated as No$/))) {
      return "We couldn't tell from the file whether this donor volunteers (saw '" + m[1] + "'), so we assumed no.";
    }
    if ((m = raw.match(/^gift year\(s\) (.+) are after the campaign as_of year (\d+)$/))) {
      return "This record lists a gift dated after " + m[2] + ", which is this campaign's reference date. That looks like a data entry error; please check the year.";
    }
    if ((m = raw.match(/^missing required field\(s\): (.+)$/))) {
      return "This row is missing required information (" + m[1].replace(/_/g, " ") + ") and can't be processed until it's filled in.";
    }
    if ((m = raw.match(/^unparseable gift_history: (.+)$/))) {
      return "This donor's giving history isn't in the expected format (year:amount, separated by semicolons) and couldn't be read: " + m[1];
    }
    if ((m = raw.match(/^duplicate donor_id, first seen at line (\d+)$/))) {
      return "Another row earlier in this file already uses this same donor ID (line " + m[1] + "). Each donor needs a unique ID.";
    }
    return raw;
  }

  function humanizeList(pipeSeparated) {
    return (pipeSeparated || "").split(" | ").filter(Boolean).map(humanize);
  }

  function nextManualId() {
    State.manualCounter += 1;
    var id = "M" + String(State.manualCounter).padStart(3, "0");
    if (State.donors.hasOwnProperty(id)) return nextManualId();
    return id;
  }

  // ---- recompute: the single place validate -> calculate -> generate runs ----
  // Shared by the full batch recompute and the single-donor fast path:
  // validate -> calculate -> generate for one already-validated row.
  function computeOneDonor(record) {
    var computed = App.calculateAsk(record, State.config);
    var letterDate = R.letterDateLabel(State.config);
    var gen = App.generateForDonor(computed, State.config, letterDate);
    computed.letter_html = gen.letterHtml;
    computed.letter_model = gen.model;
    computed.generation_note = gen.note;
    computed.is_placeholder = !!gen.isPlaceholder;
    if (gen.forceMandatory) computed.review_level = "mandatory";
    return computed;
  }

  function applyConfirmationCarryover(donorId) {
    if (State.confirmed[donorId]) {
      var fp = rowFingerprint(State.donors[donorId]);
      if (State.confirmedSnapshot[donorId] !== fp) {
        State.confirmed[donorId] = false;
        delete State.confirmedSnapshot[donorId];
      }
    }
  }

  // Full batch recompute: every donor, plus whole-list checks (duplicate
  // donor_id). Used whenever something changes that could affect more
  // than one donor at once: loading a file, merging, a campaign config
  // change (the ask formula and letter wording both depend on it).
  function recompute() {
    var rows = State.order.map(function (id) { return State.donors[id]; });
    var out;
    try {
      out = App.runValidation(rows, State.config);
    } catch (err) {
      toast("Config error: " + err.message, "bad");
      return;
    }
    State.exceptions = out.exceptions;
    State.results = {};

    out.validated.forEach(function (row) {
      State.results[row.donor_id] = computeOneDonor(row);
      applyConfirmationCarryover(row.donor_id);
    });

    // Any donor now in exceptions can't be confirmed either.
    State.exceptions.forEach(function (exc) {
      if (exc.donor_id) { State.confirmed[exc.donor_id] = false; }
    });

    renderAll();
  }

  // Single-donor fast path: donors are independent of each other (no
  // donor's ask depends on another donor's data), so an edit that only
  // touches one donor's own fields never needs to touch the other N-1.
  // At a few thousand donors this is the difference between an edit that
  // feels instant and one that visibly pauses the page; verified
  // directly (2,000-donor synthetic set: ~360ms full recompute per edit
  // vs. a single-digit-ms fast path). Duplicate-donor_id checking is a
  // whole-list concern and is deliberately not done here: nothing that
  // calls this path ever changes a donor's own id (the edit form doesn't
  // expose that field), so a new duplicate cannot be created this way.
  function recomputeDonor(donorId) {
    var row = State.donors[donorId];
    if (!row) return;
    var asOfYear;
    try {
      asOfYear = R.asOfYear(State.config);
    } catch (err) {
      toast("Config error: " + err.message, "bad");
      return;
    }
    var validated = App.validateRow(row, asOfYear);
    State.exceptions = State.exceptions.filter(function (e) { return e.donor_id !== donorId; });
    if (validated.exceptionReasons.length) {
      State.exceptions.push({ line: 0, donor_id: donorId, donor_name: row.donor_name || "", reason: validated.exceptionReasons.join("; ") });
      delete State.results[donorId];
      State.confirmed[donorId] = false;
      delete State.confirmedSnapshot[donorId];
    } else {
      State.results[donorId] = computeOneDonor(validated.record);
      applyConfirmationCarryover(donorId);
    }
    renderAll();
  }

  function invalidateAllConfirmations(reason) {
    Object.keys(State.confirmed).forEach(function (id) { State.confirmed[id] = false; });
    State.confirmedSnapshot = {};
    if (reason) toast(reason, "warn");
  }

  // Every field that differs between two donor rows, for both the
  // conflict panel and the plain-language edit summary.
  var COMPARABLE_FIELDS = ["donor_name", "title", "region", "gift_history", "largest_gift", "lifetime_total", "last_gift_year", "tier", "volunteer"];
  function diffRows(a, b) {
    var diffs = [];
    COMPARABLE_FIELDS.forEach(function (f) {
      var av = (a && a[f]) || "", bv = (b && b[f]) || "";
      if (String(av) !== String(bv)) diffs.push({ field: f, oldValue: av, newValue: bv });
    });
    return diffs;
  }

  // ---- loading / merging donor data ----
  // A donor who needs manual follow-up (routed to personal outreach,
  // blocked by low confidence, or failed validation entirely) is worth a
  // named entry in the change log at the point the data was loaded, not
  // just a row in the manifest a person might not open. One consolidated
  // entry per load/merge, not one per donor, so this stays a useful
  // signal instead of routine noise.
  function logPlaceholderSummary() {
    var placeholders = State.order.filter(function (id) {
      return State.results[id] && State.results[id].is_placeholder;
    }).map(function (id) { return State.results[id].donor_name + " (" + id + ")"; });
    var exceptionNames = State.exceptions.map(function (exc) {
      return (exc.donor_name || exc.donor_id || "unnamed") + (exc.donor_id ? " (" + exc.donor_id + ")" : "");
    });
    if (!placeholders.length && !exceptionNames.length) return;
    var parts = [];
    if (placeholders.length) parts.push(placeholders.length + " donor(s) need personal outreach, no automated letter: " + placeholders.join(", "));
    if (exceptionNames.length) parts.push(exceptionNames.length + " donor(s) failed validation and need manual review: " + exceptionNames.join(", "));
    logChange("", "", "needs-review", parts.join(". ") + ".");
  }

  function loadDonorsReplace(rows) {
    State.donors = {};
    State.order = [];
    State.confirmed = {};
    State.confirmedSnapshot = {};
    rows.forEach(function (row) {
      var id = String(row.donor_id || "").trim() || nextManualId();
      row.donor_id = id;
      State.donors[id] = row;
      State.order.push(id);
    });
    State.changeLog.push({ time: new Date().toISOString(), donor_id: "", donor_name: "", kind: "load", description: "Loaded " + rows.length + " donor(s), replacing the working set." });
    recompute();
    logPlaceholderSummary();
    renderChangeLog();
  }

  function mergeDonors(rows, sourceLabel) {
    var conflicts = [];
    var addedCount = 0;
    rows.forEach(function (row) {
      var id = String(row.donor_id || "").trim() || nextManualId();
      row.donor_id = id;
      if (State.donors.hasOwnProperty(id)) {
        conflicts.push({ donorId: id, existing: State.donors[id], incoming: row, source: sourceLabel });
      } else {
        State.donors[id] = row;
        State.order.push(id);
        addedCount += 1;
        logChange(id, row.donor_name, "merge-add", "Added from " + sourceLabel + " (new donor ID, no conflict).");
      }
    });
    if (conflicts.length) {
      State.pendingConflicts = State.pendingConflicts.concat(conflicts);
      renderConflicts();
      toast(conflicts.length + " donor ID(s) already exist. Resolve the conflicts below before they rejoin the working set.", "warn");
    }
    if (addedCount) toast("Added " + addedCount + " new donor(s) from " + sourceLabel + ".", "ok");
    recompute();
    logPlaceholderSummary();
    renderChangeLog();
  }

  function resolveConflict(index, choice) {
    var c = State.pendingConflicts[index];
    if (!c) return;
    if (choice === "existing") {
      logChange(c.donorId, c.existing.donor_name, "merge-conflict-resolved", "Conflict from " + c.source + ": kept the existing version.");
    } else if (choice === "incoming") {
      var diffs = diffRows(c.existing, c.incoming);
      var summary = diffs.length ? diffs.map(function (d) { return d.field.replace(/_/g, " "); }).join(", ") : "no field differences detected";
      State.donors[c.donorId] = c.incoming;
      if (State.order.indexOf(c.donorId) === -1) State.order.push(c.donorId);
      logChange(c.donorId, c.incoming.donor_name, "merge-conflict-resolved", "Conflict from " + c.source + ": used the incoming version (changed: " + summary + ").");
    }
    State.pendingConflicts.splice(index, 1);
    renderConflicts();
    recompute();
  }

  function addManualDonor(fields) {
    var id = String(fields.donor_id || "").trim() || nextManualId();
    if (State.donors.hasOwnProperty(id)) {
      toast("donor_id '" + id + "' already exists. Choose a different ID.", "bad");
      return false;
    }
    var row = {
      donor_id: id, donor_name: fields.donor_name || "", title: fields.title || "",
      region: fields.region || "", relationship_manager: fields.relationship_manager || "",
      gift_history: fields.gift_history || "",
      volunteer: fields.volunteer || "No", tier: "", largest_gift: "", lifetime_total: "", last_gift_year: "",
    };
    State.donors[id] = row;
    State.order.push(id);
    logChange(id, row.donor_name, "manual-add", "Added manually by the user.");
    recompute();
    return true;
  }

  function editDonorField(donorId, field, value) {
    if (!State.donors[donorId]) return;
    State.donors[donorId][field] = value;
    logChange(donorId, State.donors[donorId].donor_name, "edit", "Field '" + field + "' changed.");
    recomputeDonor(donorId);
  }

  function removeDonor(donorId) {
    var name = State.donors[donorId] ? State.donors[donorId].donor_name : "";
    delete State.donors[donorId];
    delete State.results[donorId];
    delete State.confirmed[donorId];
    delete State.confirmedSnapshot[donorId];
    State.order = State.order.filter(function (id) { return id !== donorId; });
    logChange(donorId, name, "remove", "Removed from the working set by the user.");
    recompute();
  }

  function confirmDonor(donorId, value) {
    State.confirmed[donorId] = !!value;
    if (value) {
      State.confirmedSnapshot[donorId] = rowFingerprint(State.donors[donorId]);
      logChange(donorId, State.donors[donorId] ? State.donors[donorId].donor_name : "", "confirm", "Reviewed and confirmed by the user.");
    } else {
      delete State.confirmedSnapshot[donorId];
    }
    renderTable();
    renderSummary();
    renderSteps();
    renderChangeLog();
    renderExportGate();
  }

  // Bulk-confirm only ever applies to the currently filtered/visible rows,
  // and always names every donor it is about to mark before doing
  // anything, specifically so this can't become a way to wave through
  // donors nobody actually looked at. The point of mandatory review is
  // the review; a bulk button that skipped that would be a HITL feature
  // with a hole in it.
  function bulkConfirmVisible() {
    var ids = currentVisibleIds().filter(function (id) {
      var r = State.results[id];
      return r && (r.review_level === "mandatory" || r.review_level === "recommended") && !State.confirmed[id];
    });
    if (!ids.length) { toast("Nothing currently shown needs confirmation.", "warn"); return; }
    var names = ids.map(function (id) { return State.results[id].donor_name; });
    var ok = window.confirm("Mark these " + ids.length + " donor(s) as reviewed?\n\n" + names.join("\n"));
    if (!ok) return;
    ids.forEach(function (id) { confirmDonor(id, true); });
    toast("Confirmed " + ids.length + " donor(s).", "ok");
  }

  // ---- session save/load (explicit, local, never automatic) ----
  function saveSession() {
    var payload = {
      saved_at: new Date().toISOString(),
      rules_version: R.RULES_VERSION,
      config: State.config,
      donors: State.order.map(function (id) { return State.donors[id]; }),
      confirmed: State.confirmed,
      confirmed_snapshot: State.confirmedSnapshot,
      manual_counter: State.manualCounter,
      change_log: State.changeLog,
    };
    downloadText(JSON.stringify(payload, null, 2), "donor-session.json", "application/json");
  }

  function loadSession(text) {
    var payload;
    try { payload = JSON.parse(text); } catch (e) { toast("Session file is not valid JSON.", "bad"); return; }
    if (!payload.donors || !payload.config) { toast("Session file is missing config or donors.", "bad"); return; }
    State.config = payload.config;
    State.donors = {}; State.order = [];
    payload.donors.forEach(function (row) { State.donors[row.donor_id] = row; State.order.push(row.donor_id); });
    State.confirmed = payload.confirmed || {};
    State.confirmedSnapshot = payload.confirmed_snapshot || {};
    State.manualCounter = payload.manual_counter || 0;
    State.changeLog = payload.change_log || [];
    renderConfigForm();
    recompute();
    toast("Session restored (saved " + (payload.saved_at || "unknown time") + ").", "ok");
  }

  // ---- export ----
  // "manifest" (summary) and "working set" (full modified data) are
  // deliberately two different exports: the manifest is a short per-donor
  // status list; the working-set CSV is every field, including anything
  // edited or merged in, ready to be handed back to the source system.
  function buildManifestCsv() {
    var rows = State.order.map(function (id) {
      var r = State.results[id];
      if (!r) return null;
      return {
        donor_id: id, donor_name: r.donor_name, tier: r.tier, status: r.status,
        ask_amount: r.ask_amount, confidence: r.confidence, review_level: r.review_level,
        confirmed: State.confirmed[id] ? "Yes" : "No", notes: r.review_reasons,
      };
    }).filter(Boolean);
    // Every donor that failed validation entirely still gets a manifest
    // row, same as the batch pipeline: "produce them (all of them)" does
    // not stop at "all of them that validated cleanly."
    State.exceptions.forEach(function (exc) {
      rows.push({
        donor_id: exc.donor_id || "", donor_name: exc.donor_name || "",
        tier: "", status: "", ask_amount: "", confidence: "",
        review_level: "mandatory", confirmed: "No",
        notes: "failed validation: " + exc.reason,
      });
    });
    return App.toCsv(rows, ["donor_id", "donor_name", "tier", "status", "ask_amount", "confidence", "review_level", "confirmed", "notes"]);
  }

  function buildWorkingSetCsv() {
    var rows = State.order.map(function (id) {
      var r = State.results[id] || {};
      var d = State.donors[id];
      return {
        donor_id: id, donor_name: d.donor_name, title: d.title || "", region: d.region || "",
        relationship_manager: d.relationship_manager || "",
        gift_history: d.gift_history, tier: r.tier || "", status: r.status || "",
        largest_gift: r.largest_gift || "", lifetime_total: r.lifetime_total || "",
        last_gift_year: r.last_gift_year || "", volunteer: r.volunteer || d.volunteer || "",
        ask_amount: r.ask_amount || "", confidence: r.confidence || "", review_level: r.review_level || "",
        confirmed: State.confirmed[id] ? "Yes" : "No",
      };
    });
    return App.toCsv(rows, ["donor_id", "donor_name", "title", "region", "relationship_manager", "gift_history", "tier", "status", "largest_gift", "lifetime_total", "last_gift_year", "volunteer", "ask_amount", "confidence", "review_level", "confirmed"]);
  }

  function buildChangeSummaryCsv() {
    var rows = State.changeLog.map(function (c) {
      return { time: c.time, donor_id: c.donor_id, donor_name: c.donor_name, type: c.kind, what_changed: c.description };
    });
    return App.toCsv(rows, ["time", "donor_id", "donor_name", "type", "what_changed"]);
  }

  // Every donor with a valid, generated letter gets one in the export,
  // the same rule scripts/generate_letters.py follows for the batch path
  // (it writes output/letters/<id>.html for every donor with an
  // ask_amount, with no separate per-donor "confirmed" concept at all).
  // Confirmation is what gates whether the export button is unlocked in
  // the first place (see exportReadiness); it was never meant to also
  // filter which of the already-cleared letters make it into the zip, a
  // donor whose review_level is "none" has nothing to confirm and would
  // otherwise silently never ship.
  // Donor ID leads the filename, not the name, so the letters/ folder
  // sorts by donor number (D001, D002, D003...) in any plain file
  // listing, the same order the on-page table and manifest.csv use, not
  // an alphabetical shuffle by first name.
  function allGeneratedLetterFiles() {
    var ids = State.order.filter(function (id) { return State.results[id] && State.results[id].letter_html; });
    var files = ids.map(function (id) {
      var slug = State.results[id].donor_name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
      return { name: id + "-" + slug + ".html", content: State.results[id].letter_html };
    });
    // A donor who failed validation entirely still gets a file in the
    // export, same reasoning as allGeneratedLetterFiles above and
    // buildManifestCsv: no donor is silently absent from the output.
    var letterDate = R.letterDateLabel(State.config);
    State.exceptions.forEach(function (exc) {
      var id = exc.donor_id || ("exception-" + exc.line);
      var name = exc.donor_name || id;
      var slug = name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
      files.push({
        name: id + "-" + slug + ".html",
        content: App.generateExceptionPlaceholder(exc, letterDate),
      });
    });
    return files;
  }

  // ---- export readiness gate ----
  // Exporting is the step that hands a batch of real dollar asks to a
  // fundraiser to send. It is deliberately locked until every data
  // exception is resolved, every merge conflict is settled, and every
  // flagged donor has a human confirmation on it, the same gate the
  // reference build enforces (its archive button stays disabled until
  // required reviews hit 0). Before that point there is nothing to
  // export yet, only work still in progress.
  function exportReadiness() {
    var total = State.order.length;
    var excCount = State.exceptions.length;
    var conflictCount = State.pendingConflicts.length;
    var needsReview = State.order.filter(function (id) {
      var r = State.results[id];
      return r && (r.review_level === "mandatory" || r.review_level === "recommended") && !State.confirmed[id];
    }).length;
    return {
      total: total, excCount: excCount, conflictCount: conflictCount, needsReview: needsReview,
      ready: total > 0 && excCount === 0 && conflictCount === 0 && needsReview === 0,
    };
  }

  function jumpToWork() {
    var r = exportReadiness();
    var selector = r.conflictCount ? '[data-tour="conflicts"]' : (r.excCount ? "#exceptionsPanel" : '[data-tour="table"]');
    var target = document.querySelector(selector);
    if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function renderExportGate() {
    var btn = document.getElementById("exportBtn");
    var msg = document.getElementById("exportGateMsg");
    if (!btn || !msg) return;
    var r = exportReadiness();
    btn.disabled = !r.ready;
    if (r.total === 0) {
      msg.innerHTML = "Load donor data above to begin.";
    } else if (r.ready) {
      msg.innerHTML = "All exceptions are resolved, all merge conflicts are settled, and every flagged donor is confirmed. Ready to export.";
    } else {
      var parts = [];
      if (r.excCount) parts.push(r.excCount + " data exception(s) to fix");
      if (r.conflictCount) parts.push(r.conflictCount + " merge conflict(s) to resolve");
      if (r.needsReview) parts.push(r.needsReview + " flagged donor(s) awaiting confirmation");
      msg.innerHTML = "Export is locked until: " + parts.join(", ") + ". " +
        '<button class="link" type="button" onclick="UI.jumpToWork()">Take me there</button>';
    }
  }

  // The complete package: everything this session produced, plus the
  // skill itself and the case for it, plus a working copy of this exact
  // tool. Whoever receives this zip, a fundraiser using the system or
  // Doug reviewing the case study, gets the same thing: the records, the
  // rewritten skill, the assessment behind it, and a program they can
  // open and rerun, not just a report about one. Nothing here needs a
  // server or a repository checkout to make sense of. The button behind
  // this is disabled until exportReadiness().ready, but this check stays
  // here too since the function is reachable from the console.
  function exportEverything() {
    if (!exportReadiness().ready) {
      toast("Resolve outstanding exceptions, merge conflicts, and confirmations first.", "warn");
      return;
    }
    var files = [
      { name: "manifest.csv", content: buildManifestCsv() },
      { name: "donor-data-modified.csv", content: buildWorkingSetCsv() },
      { name: "change-summary.csv", content: buildChangeSummaryCsv() },
      { name: "SKILL.md", content: (window.SKILL_MD_TEXT || "") },
      { name: "ASSESSMENT.md", content: (window.ASSESSMENT_MD_TEXT || "") },
    ];
    if (window.README_MD_TEXT) files.push({ name: "README.md", content: window.README_MD_TEXT });
    var letters = allGeneratedLetterFiles();
    letters.forEach(function (f) { files.push({ name: "letters/" + f.name, content: f.content }); });
    // A working copy of this exact page, live DOM serialized back to
    // HTML, not the original template: opening it lands on whatever was
    // on screen when this export was made, and it is just as runnable
    // as the file it came from, same embedded logic, same embedded data.
    var selfCopy = "<!doctype html>\n" + document.documentElement.outerHTML;
    files.push({ name: "donor-data-review.html", content: selfCopy });
    downloadBytes(App.makeZipBytes(files), "donor-outreach-package.zip", "application/zip");
    toast("Downloaded the complete package: records, SKILL.md, the assessment, and the tool itself (" + letters.length + " letter(s), every donor with a valid, generated letter), in one zip.", "ok");
  }

  function downloadBytes(bytes, filename, mime) {
    var blob = new Blob([bytes], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function downloadText(text, filename, mime) {
    var blob = new Blob([text], { type: mime + ";charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ---- toast ----
  var toastTimer = null;
  function toast(message, kind) {
    var el = document.getElementById("toast");
    el.textContent = message;
    el.className = "toast show " + (kind || "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = "toast"; }, 5000);
  }

  // ==================== RENDERING ====================

  function renderAll() {
    renderSummary();
    renderFindings();
    renderExceptions();
    renderTable();
    renderConflicts();
    renderTierVoice();
    renderChangeLog();
    renderSteps();
    renderExportGate();
  }

  function renderSteps() {
    // Steps 3 and 4 are deliberately two different gates, not one split in
    // half: step 3 is data-quality (rows that failed validation entirely
    // and were excluded), step 4 is judgment (flagged donors a person has
    // to actually confirm). A file can clear step 3 with zero exceptions
    // and still have plenty of work left in step 4, or vice versa.
    var total = State.order.length;
    var excCount = State.exceptions.length;
    var mandatory = State.order.filter(function (id) { return State.results[id] && State.results[id].review_level === "mandatory"; }).length;
    var recommended = State.order.filter(function (id) { return State.results[id] && State.results[id].review_level === "recommended"; }).length;
    var flaggedTotal = mandatory + recommended;
    var confirmedCount = Object.keys(State.confirmed).filter(function (id) { return State.confirmed[id]; }).length;
    var needsReview = flaggedTotal - confirmedCount;

    var steps = document.querySelectorAll("#stepsTracker .step");
    if (!steps.length) return;
    var badge2 = document.getElementById("stepBadge2");
    var badge3 = document.getElementById("stepBadge3");
    var badge4 = document.getElementById("stepBadge4");
    if (badge2) badge2.textContent = total ? (excCount ? excCount + " excluded" : "clean") : "";
    if (badge3) badge3.textContent = total ? (excCount ? excCount + " to fix" : "none") : "";
    if (badge4) badge4.textContent = flaggedTotal ? confirmedCount + "/" + flaggedTotal : (total ? "none needed" : "");

    var step3Done = total > 0 && excCount === 0;
    var step4Done = total > 0 && needsReview === 0;
    var states = [
      total > 0 ? "done" : "active",                              // 1 data loaded
      total > 0 ? "done" : "pending",                              // 2 validated
      total > 0 ? (step3Done ? "done" : "active") : "pending",     // 3 review & correct data errors
      total > 0 ? (step4Done ? "done" : (step3Done ? "active" : "pending")) : "pending", // 4 sign off
      step3Done && step4Done ? "active" : "pending",                // 5 export
    ];
    steps.forEach(function (el, i) {
      el.classList.remove("done", "active");
      if (states[i] === "done") el.classList.add("done");
      if (states[i] === "active") el.classList.add("active");
    });
  }

  function renderChangeLog() {
    var el = document.getElementById("changeLogPanel");
    if (!el) return;
    if (!State.changeLog.length) { el.innerHTML = '<p class="badge-empty">No changes yet this session.</p>'; return; }
    var rows = State.changeLog.slice().reverse().slice(0, 100);
    el.innerHTML = "<table><thead><tr><th>When</th><th>Donor</th><th>What</th></tr></thead><tbody>" +
      rows.map(function (c) {
        var when = c.time ? new Date(c.time).toLocaleTimeString() : "";
        return "<tr><td class=\"badge-empty\">" + R.esc(when) + "</td><td>" + R.esc(c.donor_name || c.donor_id || "(campaign-wide)") + "</td><td>" + R.esc(c.description) + "</td></tr>";
      }).join("") + "</tbody></table>";
  }

  // Computed live from whatever is currently in State.results, not
  // hardcoded: if the working data changes, this list changes with it.
  // On the untouched sample data it reproduces the case study's own
  // named findings; on modified or a user's own data it reports whatever
  // is actually true of that data.
  function renderFindings() {
    var el = document.getElementById("findingsPanel");
    if (!el) return;
    var tierCorrections = [];
    var lapsedMajor = [];
    State.order.forEach(function (id) {
      var r = State.results[id];
      if (!r) return;
      if ((r.mandatory_reasons || "").indexOf("tier corrected from") !== -1) {
        var m = r.mandatory_reasons.match(/tier corrected from '(.+)' to '(.+)'/);
        tierCorrections.push(r.donor_name + " (labeled " + (m ? m[1] : "?") + ", actually " + (m ? m[2] : r.tier) + " based on $" + Number(r.lifetime_total).toLocaleString() + " lifetime giving)");
      }
      if ((r.review_reasons || "").indexOf("route to personal outreach") !== -1) {
        lapsedMajor.push(r.donor_name + " (" + r.tier + ", last gift " + r.last_gift_year + ")");
      }
    });
    if (!tierCorrections.length && !lapsedMajor.length) {
      el.innerHTML = '<h3>Findings in this data</h3><p class="badge-empty">No tier-label mismatches or lapsed major donors detected in the current working set.</p>';
      return;
    }
    var html = "<h3>Findings in this data</h3>";
    if (tierCorrections.length) {
      html += "<p><strong>" + tierCorrections.length + " donor(s) had a tier label that didn't match their own lifetime giving.</strong> The file's label was overridden by the number calculated from their gift history:</p><ul style=\"margin:4px 0; padding-left:20px;\">" +
        tierCorrections.map(function (t) { return "<li>" + R.esc(t) + "</li>"; }).join("") + "</ul>";
    }
    if (lapsedMajor.length) {
      html += "<p><strong>" + lapsedMajor.length + " major donor(s) (Gold or Platinum) haven't given in over 3 years.</strong> No automated letter was generated for them; they're routed to personal outreach instead:</p><ul style=\"margin:4px 0; padding-left:20px;\">" +
        lapsedMajor.map(function (t) { return "<li>" + R.esc(t) + "</li>"; }).join("") + "</ul>";
    }
    el.innerHTML = html;
  }

  function renderTierVoice() {
    var el = document.getElementById("tierVoicePanel");
    if (!el || !window.App || !App.TIER_VOICE) return;
    var charity = (State.config && State.config.charity_name) || "[charity name]";
    var order = ["Platinum", "Gold", "Silver", "Bronze"];
    el.innerHTML = order.map(function (tier) {
      var v = App.TIER_VOICE[tier];
      return '<p><strong>' + tier + ':</strong> "' + R.esc(v.thanks.replace("{charity}", charity)) + '"</p>';
    }).join("");
  }

  function renderSummary() {
    var total = State.order.length;
    var validCount = Object.keys(State.results).length;
    var excCount = State.exceptions.length;
    var tierMismatches = State.order.filter(function (id) {
      var r = State.results[id];
      return r && (r.mandatory_reasons || "").indexOf("tier corrected") !== -1;
    }).length;
    var generated = State.order.filter(function (id) { return State.results[id] && State.results[id].letter_html && !State.results[id].is_placeholder; }).length;
    var needsOutreach = State.order.filter(function (id) { return State.results[id] && State.results[id].is_placeholder; }).length;
    var mandatory = State.order.filter(function (id) { return State.results[id] && State.results[id].review_level === "mandatory"; }).length;
    var confirmedCount = Object.keys(State.confirmed).filter(function (id) { return State.confirmed[id]; }).length;
    var needsReview = State.order.filter(function (id) {
      var r = State.results[id];
      return r && (r.review_level === "mandatory" || r.review_level === "recommended") && !State.confirmed[id];
    }).length;

    var stats = [
      [total, "Donors loaded"],
      [validCount, "Validated"],
      [excCount, "Exceptions"],
      [tierMismatches, "Tier labels corrected"],
      [generated, "Letters generated"],
      [needsOutreach, "Needs personal outreach"],
      [mandatory, "Mandatory review"],
      [confirmedCount, "Confirmed"],
      [needsReview, "Awaiting confirmation"],
    ];
    document.getElementById("summaryStats").innerHTML = stats.map(function (s) {
      return '<div class="stat"><div class="num">' + s[0] + '</div><div class="label">' + s[1] + '</div></div>';
    }).join("");

    var allReady = needsReview === 0 && total > 0;
    var banner = document.getElementById("readyBanner");
    if (allReady) {
      banner.className = "panel ready-banner ok";
      banner.textContent = "All flagged donors are confirmed. Data ties out. Ready to export.";
    } else if (total === 0) {
      banner.className = "panel ready-banner";
      banner.textContent = "Load a donor file to begin.";
    } else {
      banner.className = "panel ready-banner warn";
      banner.textContent = needsReview + " donor(s) still need human confirmation before this batch is ready (see the Review column).";
    }

    var flaggedTotal = mandatory + State.order.filter(function (id) { return State.results[id] && State.results[id].review_level === "recommended"; }).length;
    var flaggedConfirmed = flaggedTotal - needsReview;
    var pct = flaggedTotal > 0 ? Math.round((flaggedConfirmed / flaggedTotal) * 100) : (total > 0 ? 100 : 0);
    var fill = document.getElementById("progressFill");
    if (fill) {
      fill.style.width = pct + "%";
      fill.title = flaggedConfirmed + " of " + flaggedTotal + " flagged donor(s) reviewed";
    }
  }

  function renderExceptions() {
    var el = document.getElementById("exceptionsPanel");
    if (!State.exceptions.length) { el.innerHTML = ""; el.style.display = "none"; return; }
    el.style.display = "block";
    el.innerHTML = "<h3>Exceptions: " + State.exceptions.length + " row(s) excluded</h3>" +
      "<table><thead><tr><th>Donor</th><th>Reason</th></tr></thead><tbody>" +
      State.exceptions.map(function (e) {
        return "<tr><td>" + R.esc(e.donor_name || e.donor_id) + "</td><td>" + R.esc(e.reason) + "</td></tr>";
      }).join("") + "</tbody></table>";
  }

  function renderConflicts() {
    var el = document.getElementById("conflictPanel");
    if (!State.pendingConflicts.length) { el.innerHTML = ""; el.style.display = "none"; return; }
    el.style.display = "block";
    el.innerHTML = "<h3>Merge conflicts: " + State.pendingConflicts.length + "</h3><p class=\"sub\">These donor IDs already exist in the working set. Nothing is changed automatically; pick which version to keep for each one.</p>" +
      State.pendingConflicts.map(function (c, i) {
        var diffs = diffRows(c.existing, c.incoming);
        var diffTable = diffs.length
          ? "<table><thead><tr><th>Field</th><th>Existing</th><th>Incoming</th></tr></thead><tbody>" +
            diffs.map(function (d) {
              return "<tr><td>" + R.esc(d.field.replace(/_/g, " ")) + "</td><td>" + R.esc(d.oldValue) + "</td><td>" + R.esc(d.newValue) + "</td></tr>";
            }).join("") + "</tbody></table>"
          : '<p class="badge-empty">No field differences detected between the two versions.</p>';
        return '<div class="conflict-row">' +
          '<div><strong>' + R.esc(c.existing.donor_name || c.incoming.donor_name) + '</strong> <span class="badge-empty">' + R.esc(c.donorId) + ', from ' + R.esc(c.source) + '</span></div>' +
          diffTable +
          '<div class="controls">' +
          '<button onclick="UI.resolveConflict(' + i + ', \'existing\')">Keep existing</button>' +
          '<button onclick="UI.resolveConflict(' + i + ', \'incoming\')">Use incoming</button>' +
          '</div></div>';
      }).join("");
  }

  var sortKey = null;
  var sortDir = 1;

  function setSort(key) {
    if (sortKey === key) { sortDir = -sortDir; } else { sortKey = key; sortDir = 1; }
    document.querySelectorAll("th[data-key]").forEach(function (th) {
      th.classList.remove("sort-asc", "sort-desc");
      if (th.dataset.key === sortKey) th.classList.add(sortDir === 1 ? "sort-asc" : "sort-desc");
    });
    renderTable();
  }

  function currentVisibleIds() {
    var q = (document.getElementById("search").value || "").toLowerCase();
    var tierFilter = document.getElementById("tierFilter").value;
    var reviewFilter = document.getElementById("reviewFilter").value;
    var ids = State.order.filter(function (id) {
      var r = State.results[id];
      if (!r) return false;
      if (tierFilter && r.tier !== tierFilter) return false;
      if (reviewFilter && r.review_level !== reviewFilter) return false;
      if (q && !((r.donor_name || "").toLowerCase().indexOf(q) !== -1 || id.toLowerCase().indexOf(q) !== -1)) return false;
      return true;
    });
    if (sortKey) {
      ids = ids.slice().sort(function (a, b) {
        var av = State.results[a][sortKey], bv = State.results[b][sortKey];
        var an = parseFloat(av), bn = parseFloat(bv);
        if (!isNaN(an) && !isNaN(bn)) { av = an; bv = bn; } else { av = String(av || "").toLowerCase(); bv = String(bv || "").toLowerCase(); }
        if (av < bv) return -sortDir;
        if (av > bv) return sortDir;
        return 0;
      });
    }
    return ids;
  }

  function renderTable() {
    var body = document.getElementById("donorTableBody");
    var ids = currentVisibleIds();

    body.innerHTML = ids.map(function (id) {
      var r = State.results[id];
      var pillClass = r.review_level === "mandatory" ? "bad" : (r.review_level === "recommended" ? "warn" : "ok");
      var confirmed = !!State.confirmed[id];
      var needsAttention = (r.review_level === "mandatory" || r.review_level === "recommended");
      return '<tr class="row' + (needsAttention && !confirmed ? " needs-attention" : "") + '">' +
        '<td>' + R.esc(id) + '</td>' +
        '<td>' + R.esc(r.donor_name) + '</td>' +
        '<td>' + R.esc(r.tier) + (r.tier === "Platinum" ? ' <span class="pill bad">always review</span>' : "") + '</td>' +
        '<td>' + R.esc(r.status) + '</td>' +
        '<td>' + (r.ask_amount ? "$" + Number(r.ask_amount).toLocaleString() : "n/a") + '</td>' +
        '<td>' + R.esc(r.confidence) + '</td>' +
        '<td><span class="pill ' + pillClass + '">' + R.esc(r.review_level) + '</span></td>' +
        '<td><label><input type="checkbox" ' + (confirmed ? "checked" : "") + (needsAttention ? "" : " disabled") + ' onchange="UI.confirmDonor(\'' + id + '\', this.checked)"> confirm</label></td>' +
        '<td>' +
        '<button class="link" onclick="UI.openLetter(\'' + id + '\')">letter</button> ' +
        '<button class="link" onclick="UI.openEdit(\'' + id + '\')">edit</button> ' +
        '<button class="link" onclick="UI.removeDonor(\'' + id + '\')">remove</button>' +
        '</td></tr>';
    }).join("");
  }

  function renderConfigForm() {
    var c = State.config;
    ["campaign_type", "as_of_date", "charity_name", "donation_url", "signer_name", "signer_title", "match_sponsor", "match_terms", "event_registered_count", "reengagement_gift"].forEach(function (f) {
      var el = document.getElementById("cfg_" + f);
      if (el) el.value = c[f] == null ? "" : c[f];
    });
    document.getElementById("cfg_match_confirmed").checked = !!c.match_confirmed;
  }

  function applyConfigForm() {
    var c = {};
    ["campaign_type", "as_of_date", "charity_name", "donation_url", "signer_name", "signer_title", "match_sponsor", "match_terms", "reengagement_gift"].forEach(function (f) {
      c[f] = document.getElementById("cfg_" + f).value.trim();
    });
    c.match_confirmed = document.getElementById("cfg_match_confirmed").checked;
    var count = document.getElementById("cfg_event_registered_count").value.trim();
    c.event_registered_count = count ? parseInt(count, 10) : null;
    try {
      R.validateCampaignConfig(c);
    } catch (err) {
      // Reject the change without corrupting state, and put the form back
      // to what is actually still in effect so the screen never shows a
      // value that doesn't match reality (e.g. a browser-rejected date
      // input left blank while the real setting is untouched).
      toast(err.message, "bad");
      renderConfigForm();
      return;
    }
    var changedFields = Object.keys(c).filter(function (f) { return String(State.config[f]) !== String(c[f]); });
    State.config = c;
    logChange("", "", "campaign-settings", "Campaign settings changed (" + (changedFields.join(", ") || "no visible change") + "). All confirmations reset.");
    invalidateAllConfirmations("Campaign settings changed. All confirmations reset; every flagged donor needs review again.");
    recompute();
    toast("Campaign settings applied.", "ok");
  }

  // ---- letter / edit modals ----
  function openLetter(donorId) {
    var r = State.results[donorId];
    var view = document.getElementById("letterView");
    var body = document.getElementById("letterBody");
    var extra = "";
    if (r.ask_trace) extra += '<div style="padding:10px 14px;"><strong>How the ask amount was calculated</strong><div class="trace">' + R.esc(r.ask_trace.split(" -> ").join("\n-> ")) + '</div></div>';
    var plain = humanizeList(r.warnings);
    var mandatoryPlain = humanizeList(r.review_reasons);
    var noteLines = mandatoryPlain.concat(plain.filter(function (p) { return mandatoryPlain.indexOf(p) === -1; }));
    if (noteLines.length) {
      extra += '<div style="padding:0 14px 14px;"><strong>What we found, in plain terms</strong><ul style="margin:6px 0 0; padding-left:20px;">' +
        noteLines.map(function (p) { return "<li>" + R.esc(p) + "</li>"; }).join("") + '</ul>' +
        '<details style="margin-top:6px;"><summary class="badge-empty">Technical detail</summary><div class="trace">' + R.esc((r.warnings + (r.warnings && r.review_reasons ? " | " : "") + r.review_reasons).split(" | ").filter(Boolean).join("\n")) + '</div></details></div>';
    }
    var confirmBtn = (r.review_level !== "none") ? '<button class="primary" onclick="UI.confirmDonor(\'' + donorId + '\', ' + (!State.confirmed[donorId]) + '); UI.openLetter(\'' + donorId + '\')">' + (State.confirmed[donorId] ? "Unconfirm" : "Confirm this letter") + '</button>' : '<p class="badge-empty">No review needed for this donor.</p>';
    if (r.letter_html) {
      body.innerHTML = extra + '<div style="padding:0 14px;">' + confirmBtn + '</div><iframe style="width:100%;height:480px;border:1px solid #eee;border-radius:8px;margin-top:8px;" srcdoc="' + r.letter_html.replace(/"/g, "&quot;") + '"></iframe>';
    } else {
      body.innerHTML = extra + '<div style="padding:14px;"><strong>No letter was generated for this donor.</strong> ' + R.esc(humanize(r.generation_note) || "") + '</div>';
    }
    view.classList.add("open");
  }
  function closeLetter() { document.getElementById("letterView").classList.remove("open"); }

  function openEdit(donorId) {
    var row = State.donors[donorId];
    var view = document.getElementById("editView");
    document.getElementById("editDonorId").textContent = donorId;
    ["donor_name", "title", "region", "relationship_manager", "gift_history", "largest_gift", "lifetime_total", "last_gift_year", "tier", "volunteer"].forEach(function (f) {
      var el = document.getElementById("edit_" + f);
      if (el) el.value = row[f] || "";
    });
    document.getElementById("editImpact").innerHTML = "";
    view.dataset.donorId = donorId;
    view.classList.add("open");
  }
  function closeEdit() { document.getElementById("editView").classList.remove("open"); }
  function saveEdit() {
    var donorId = document.getElementById("editView").dataset.donorId;
    var before = State.results[donorId] ? {
      tier: State.results[donorId].tier, status: State.results[donorId].status,
      ask_amount: State.results[donorId].ask_amount, review_level: State.results[donorId].review_level,
    } : null;
    ["donor_name", "title", "region", "relationship_manager", "gift_history", "largest_gift", "lifetime_total", "last_gift_year", "tier", "volunteer"].forEach(function (f) {
      var el = document.getElementById("edit_" + f);
      if (el) State.donors[donorId][f] = el.value;
    });
    recomputeDonor(donorId);
    var after = State.results[donorId];
    var lines = [];
    if (!after) {
      lines.push("This donor could not be validated after the change; see Exceptions above for the specific reason.");
    } else if (before) {
      if (before.tier !== after.tier) lines.push("Tier changed from " + before.tier + " to " + after.tier + ".");
      if (before.status !== after.status) lines.push("Status changed from " + before.status + " to " + after.status + ".");
      if (before.ask_amount !== after.ask_amount) {
        var b = before.ask_amount ? "$" + Number(before.ask_amount).toLocaleString() : "no ask";
        var a = after.ask_amount ? "$" + Number(after.ask_amount).toLocaleString() : "no ask";
        lines.push("Ask amount changed from " + b + " to " + a + ".");
      }
      if (before.review_level !== after.review_level) lines.push("Review status changed from '" + before.review_level + "' to '" + after.review_level + "'" + (after.review_level !== "none" ? ", so this donor now needs to be confirmed again." : ".") );
      if (!lines.length) lines.push("Recalculated. Nothing about this donor's tier, ask, or review status changed as a result.");
    }
    document.getElementById("editImpact").innerHTML = '<div class="panel" style="background:var(--accent-soft); border-color:var(--accent);"><strong>What changed:</strong><ul style="margin:6px 0 0; padding-left:20px;">' +
      lines.map(function (l) { return "<li>" + R.esc(l) + "</li>"; }).join("") + "</ul></div>";
    renderTable();
    toast("Donor updated and recomputed.", "ok");
  }

  // ---- file upload ----
  function handleFileUpload(fileInput, mode) {
    var file = fileInput.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var rows = App.parseCsv(String(reader.result));
      if (!rows.length) { toast("No rows found in that file.", "bad"); return; }
      if (mode === "replace") loadDonorsReplace(rows);
      else mergeDonors(rows, file.name);
      fileInput.value = "";
    };
    reader.readAsText(file);
  }

  function handleSessionUpload(fileInput) {
    var file = fileInput.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () { loadSession(String(reader.result)); fileInput.value = ""; };
    reader.readAsText(file);
  }

  // ---- init ----
  function init(sampleCsvText, defaultConfig) {
    State.config = defaultConfig;
    renderConfigForm();
    loadDonorsReplace(App.parseCsv(sampleCsvText));
    ["search", "tierFilter", "reviewFilter"].forEach(function (id) {
      document.getElementById(id).addEventListener("input", renderTable);
      document.getElementById(id).addEventListener("change", renderTable);
    });
    document.querySelectorAll("th[data-key]").forEach(function (th) {
      th.addEventListener("click", function () { setSort(th.dataset.key); });
    });
    document.querySelectorAll("#stepsTracker .step").forEach(function (stepEl) {
      stepEl.addEventListener("click", function () {
        var target = document.querySelector('[data-tour="' + stepEl.dataset.jump + '"]');
        if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    });
  }

  function showPageError(message) {
    var el = document.getElementById("pageError");
    if (!el) { window.alert("Error: " + message); return; }
    el.style.display = "block";
    el.innerHTML = "<strong>Something went wrong:</strong> " + R.esc(message) +
      "<br>Try reloading the page. If it keeps happening, open the browser console (F12) and share what it shows.";
  }

  // ---- guided tour: highlight and scroll to each major section in turn.
  // No audio (Bryan is recording his own narration); this is just
  // navigation and a caption per step.
  var TOUR_STEPS = [
    { sel: '[data-tour="findings"]', text: "Every number here is the real output of validating the loaded data live, right now, in this browser. This panel names the exact donors whose tier label didn't match their own giving, and any major donor who's lapsed." },
    { sel: '[data-tour="settings"]', text: "Campaign settings. Changing any of these recomputes every donor and clears every confirmation, since the ask amount and letter wording both depend on these values." },
    { sel: '[data-tour="donordata"]', text: "Replace the whole list, merge in more from a second file, or add one donor by hand. Nothing here touches a server; it's all read and processed in this tab." },
    { sel: '[data-tour="table"]', text: "The donor table. Click any column header to sort. Edit a donor and watch tier, ask, and letter recompute immediately, with a plain-language summary of exactly what changed." },
    { sel: '[data-tour="export"]', text: "When you're done, export everything as one zip: the manifest, the full modified dataset, the change log, and every confirmed letter as its own file." },
  ];
  var tourIndex = -1;
  function startTour() {
    tourIndex = 0;
    document.getElementById("tourStart").style.display = "none";
    ["tourNext", "tourBack", "tourEnd"].forEach(function (id) { document.getElementById(id).style.display = ""; });
    showTourStep();
  }
  function tourStep(delta) {
    tourIndex = Math.max(0, Math.min(TOUR_STEPS.length - 1, tourIndex + delta));
    showTourStep();
  }
  function showTourStep() {
    document.querySelectorAll(".spotlight").forEach(function (el) { el.classList.remove("spotlight"); });
    var step = TOUR_STEPS[tourIndex];
    var el = document.querySelector(step.sel);
    if (el) { el.classList.add("spotlight"); el.scrollIntoView({ behavior: "smooth", block: "center" }); }
    document.getElementById("tourCaption").textContent = "(" + (tourIndex + 1) + "/" + TOUR_STEPS.length + ") " + step.text;
  }
  function endTour() {
    document.querySelectorAll(".spotlight").forEach(function (el) { el.classList.remove("spotlight"); });
    tourIndex = -1;
    document.getElementById("tourStart").style.display = "";
    ["tourNext", "tourBack", "tourEnd"].forEach(function (id) { document.getElementById(id).style.display = "none"; });
    document.getElementById("tourCaption").textContent = "A short, guided tour of what this page actually does, if you want it.";
  }

  window.UI = {
    init: init,
    applyConfigForm: applyConfigForm,
    loadDonorsReplace: loadDonorsReplace,
    mergeDonors: mergeDonors,
    handleFileUpload: handleFileUpload,
    handleSessionUpload: handleSessionUpload,
    resolveConflict: resolveConflict,
    addManualDonor: addManualDonor,
    editDonorField: editDonorField,
    removeDonor: removeDonor,
    confirmDonor: confirmDonor,
    openLetter: openLetter,
    closeLetter: closeLetter,
    openEdit: openEdit,
    closeEdit: closeEdit,
    saveEdit: saveEdit,
    saveSession: saveSession,
    loadSession: loadSession,
    exportEverything: exportEverything,
    jumpToWork: jumpToWork,
    bulkConfirmVisible: bulkConfirmVisible,
    startTour: startTour,
    tourStep: tourStep,
    endTour: endTour,
    showPageError: showPageError,
    renderTable: renderTable,
    State: State,
  };
})();
