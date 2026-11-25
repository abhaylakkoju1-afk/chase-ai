// Unit tests for src/app/data/saved-data-check.js: how the saved personal
// bests ("pbs") and Profile ("profile") in localStorage are classified, and
// that reading never writes to storage.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { PROFILE_FIELDS } from "../src/app/data/user-data.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(__dirname, "..", "src", "app", "data", "saved-data-check.js"), "utf8");

// Loads the script in a sandbox with a fake localStorage that records writes.
// `refuseWrite(key)` may return an error to throw instead of storing (a
// full or blocked storage), or "truncate" to store a shortened value.
// `page: true` adds a still-loading page (document) and records the
// listeners the script adds, so the end of page loading and another tab's
// storage change can be played back.
function load(items = {}, { throwOnRead = false, refuseWrite = () => null, page = false } = {}) {
  const data = new Map(Object.entries(items));
  const writes = [];
  const localStorage = {
    getItem(k) {
      if (throwOnRead) throw new Error("blocked");
      return data.has(k) ? data.get(k) : null;
    },
    setItem(k, v) {
      const refusal = refuseWrite(k);
      if (refusal === "truncate") { data.set(k, String(v).slice(0, 3)); return; }
      if (refusal) throw refusal;
      writes.push(["set", k, v]); data.set(k, String(v));
    },
    removeItem(k) { writes.push(["remove", k]); data.delete(k); },
    get length() { return data.size; },
    key(i) { return [...data.keys()][i] ?? null; },
  };
  const sandbox = { localStorage };
  const listeners = {};
  if (page) {
    sandbox.document = {
      readyState: "loading",
      addEventListener(type, fn) { listeners[`document:${type}`] = fn; },
      getElementById: () => null,
      querySelector: () => null,
    };
    sandbox.addEventListener = (type, fn) => { listeners[`window:${type}`] = fn; };
  }
  vm.runInNewContext(SOURCE, sandbox);
  return { api: sandbox.swimticsSavedData, writes, data, listeners };
}

const VALID_PBS = [
  { event: "Freestyle 50m", course: "Long Course", time: "28.45", history: [29.1, 28.45] },
  { event: "Freestyle 100m", course: "Short Course", time: "1:05.32" },                 // no history (older data)
  { event: "IM 200m", course: "Long Course", time: "abc", history: [null, -5, "x"] },   // invalid time/history entries are flagged per row, not here
  { event: "Butterfly 50m", course: "Long Course", time: "30.00", history: null, historyIds: ["a"] },
];

const VALID_PROFILE = { name: "Sam", gender: "female", club: "Tigers", height: 172, photo: "data:image/png;base64,AAAA", updatedAt: 123 };

describe("classifySaved: personal bests", () => {
  test("missing", () => {
    const { api } = load();
    assert.deepEqual({ ...api.classifySaved("pbs", null) }, { key: "pbs", status: "missing", raw: null, value: undefined, problem: null });
  });

  test("valid lists are ok and returned unchanged", () => {
    const { api } = load();
    for (const list of [[], VALID_PBS]) {
      const raw = JSON.stringify(list);
      const r = api.classifySaved("pbs", raw);
      assert.equal(r.status, "ok");
      assert.equal(r.raw, raw);
      assert.deepEqual(JSON.parse(JSON.stringify(r.value)), list);
    }
  });

  test("malformed JSON", () => {
    const { api } = load();
    for (const raw of ["[{\"event\":", "not json", "", "undefined", "[1,2,", "{'a':1}"]) {
      const r = api.classifySaved("pbs", raw);
      assert.equal(r.status, "invalid-json", raw);
      assert.equal(r.raw, raw);
      assert.equal(r.value, undefined);
    }
  });

  const WRONG = [
    ["{}", /not a list/],
    ["null", /null, not a list/],
    ["\"text\"", /a string, not a list/],
    ["42", /a number, not a list/],
    ["true", /a boolean, not a list/],
    ["[null]", /entry 1 is null/],
    ["[[1,2]]", /entry 1 is a list/],
    ["[\"Freestyle 50m\"]", /entry 1 is a string/],
    ['[{"course":"Long Course","time":"28.00"}]', /entry 1 has no event name/],
    ['[{"event":5,"course":"Long Course","time":"28.00"}]', /entry 1 has no event name/],
    ['[{"event":"Freestyle 50m","time":"28.00"}]', /entry 1 has no course/],
    ['[{"event":"Freestyle 50m","course":"Long Course"}]', /entry 1's time isn't text/],
    ['[{"event":"Freestyle 50m","course":"Long Course","time":28}]', /entry 1's time isn't text/],
    ['[{"event":"Freestyle 50m","course":"Long Course","time":"28.00"},{"event":"Freestyle 100m","course":"Long Course","time":"1:00.00","history":"60"}]', /entry 2's history isn't a list/],
  ];
  for (const [raw, problem] of WRONG) {
    test(`wrong shape: ${raw}`, () => {
      const { api } = load();
      const r = api.classifySaved("pbs", raw);
      assert.equal(r.status, "wrong-shape");
      assert.match(r.problem, problem);
      assert.equal(r.raw, raw);
      assert.equal(r.value, undefined);
    });
  }
});

describe("classifySaved: profile", () => {
  test("valid profiles are ok", () => {
    const { api } = load();
    for (const p of [{}, VALID_PROFILE, { name: null, gender: null, photo: null }, { extra: { nested: true } }]) {
      const r = api.classifySaved("profile", JSON.stringify(p));
      assert.equal(r.status, "ok");
      assert.deepEqual(JSON.parse(JSON.stringify(r.value)), p);
    }
  });

  test("malformed JSON", () => {
    const { api } = load();
    for (const raw of ["{\"name\":\"Sam\"", "{name: 'Sam'}", "Sam"]) {
      assert.equal(api.classifySaved("profile", raw).status, "invalid-json", raw);
    }
  });

  const WRONG = [
    ["[]", /a list, not a profile/],
    ["null", /null, not a profile/],
    ["\"Sam\"", /a string, not a profile/],
    ["7", /a number, not a profile/],
    ['{"name":{"first":"Sam"}}', /"name" field is an object/],
    ['{"club":["A"]}', /"club" field is a list/],
    ['{"height":true}', /"height" field is a boolean/],
    ['{"gender":1}', /"gender" field is a number/],
    ['{"photo":{}}', /"photo" field is an object/],
  ];
  for (const [raw, problem] of WRONG) {
    test(`wrong shape: ${raw}`, () => {
      const { api } = load();
      const r = api.classifySaved("profile", raw);
      assert.equal(r.status, "wrong-shape");
      assert.match(r.problem, problem);
    });
  }

  test("checks every Profile field the page shows", () => {
    const { api } = load();
    assert.deepEqual([...api.PROFILE_TEXT_FIELDS, "gender"].sort(), [...PROFILE_FIELDS].sort());
  });
});

describe("reading never writes to storage", () => {
  test("readSaved, usablePbs and usableProfile leave every value as saved", () => {
    const items = { pbs: "[{\"event\":", profile: "[]" };
    const { api, writes, data } = load(items);
    assert.equal(api.readSaved("pbs").status, "invalid-json");
    assert.equal(api.readSaved("profile").status, "wrong-shape");
    assert.equal(api.needsRecovery(api.readSaved("pbs")), true);
    assert.deepEqual(JSON.parse(JSON.stringify(api.usablePbs())), []);
    assert.deepEqual(JSON.parse(JSON.stringify(api.usableProfile())), {});
    assert.deepEqual(writes, []);
    assert.equal(data.get("pbs"), items.pbs);
    assert.equal(data.get("profile"), items.profile);
  });

  test("valid data is returned as saved", () => {
    const { api, writes } = load({ pbs: JSON.stringify(VALID_PBS), profile: JSON.stringify(VALID_PROFILE) });
    assert.deepEqual(JSON.parse(JSON.stringify(api.usablePbs())), VALID_PBS);
    assert.deepEqual(JSON.parse(JSON.stringify(api.usableProfile())), VALID_PROFILE);
    assert.equal(api.needsRecovery(api.readSaved("pbs")), false);
    assert.deepEqual(writes, []);
  });

  test("nothing saved: empty defaults, no recovery", () => {
    const { api } = load();
    assert.equal(api.needsRecovery(api.readSaved("pbs")), false);
    assert.deepEqual(JSON.parse(JSON.stringify(api.usablePbs())), []);
    assert.deepEqual(JSON.parse(JSON.stringify(api.usableProfile())), {});
  });

  test("storage that can't be read is 'unavailable', not a recovery case", () => {
    const { api } = load({}, { throwOnRead: true });
    const r = api.readSaved("pbs");
    assert.equal(r.status, "unavailable");
    assert.equal(api.needsRecovery(r), false);
    assert.deepEqual(JSON.parse(JSON.stringify(api.usablePbs())), []);
  });
});

describe("per-account copies of unreadable text", () => {
  const PREFIX = "swimtics:unreadableCopy:uid-1:";
  const BAD_PBS = '[{"event":"Freestyle 50m"';
  const BAD_PROFILE = '["not a profile"]';

  test("keeps the exact text of each unreadable value, once, and nothing for readable or missing values", () => {
    const { api, data, writes } = load({ pbs: BAD_PBS, profile: JSON.stringify(VALID_PROFILE) });
    const made = api.keepUnreadableCopies(PREFIX);
    assert.equal(made.length, 1);
    assert.match(made[0], /^swimtics:unreadableCopy:uid-1:pbs:\d+$/);
    assert.equal(data.get(made[0]), BAD_PBS);
    assert.equal(data.get("pbs"), BAD_PBS, "the working copy itself is not touched");
    assert.deepEqual(writes.map(([kind, k]) => [kind, k]), [["set", made[0]]]);
    assert.deepEqual([...api.keepUnreadableCopies(PREFIX)], [], "the same text is not kept twice");
  });

  test("lists only this prefix's copies, oldest first, with the raw text; removes one", () => {
    const { api } = load({
      [`${PREFIX}profile:200`]: BAD_PROFILE,
      [`${PREFIX}pbs:100`]: BAD_PBS,
      "swimtics:unreadableCopy:uid-10:pbs:50": "other account",      // a longer uid with the same start
      [`${PREFIX}notes:1`]: "not a copy key",
      pbs: "[]",
    });
    const list = JSON.parse(JSON.stringify(api.listUnreadableCopies(PREFIX)));
    assert.deepEqual(list, [
      { storageKey: `${PREFIX}pbs:100`, key: "pbs", at: 100, raw: BAD_PBS },
      { storageKey: `${PREFIX}profile:200`, key: "profile", at: 200, raw: BAD_PROFILE },
    ]);
    assert.equal(api.removeUnreadableCopy(`${PREFIX}pbs:100`), true);
    assert.deepEqual([...api.listUnreadableCopies(PREFIX).map((c) => c.key)], ["profile"]);
  });

  test("keys limits which values are kept", () => {
    const { api } = load({ pbs: BAD_PBS, profile: BAD_PROFILE });
    const made = api.keepUnreadableCopies(PREFIX, ["profile"]);
    assert.equal(made.length, 1);
    assert.match(made[0], /:profile:\d+$/);
  });

  test("storage that can't be read lists nothing and keeps nothing", () => {
    const { api, writes } = load({ pbs: BAD_PBS }, { throwOnRead: true });
    assert.deepEqual([...api.listUnreadableCopies(PREFIX)], []);
    assert.deepEqual([...api.keepUnreadableCopies(PREFIX)], []);
    assert.deepEqual(writes, []);
  });

  test("the signed-in note names what can't be read", () => {
    const { api } = load();
    assert.match(api.deviceDataNoteText(["pbs"]), /^This device's own saved personal bests can't be read\. They're kept/);
    assert.match(api.deviceDataNoteText(["profile"]), /^This device's own saved profile can't be read\. It's kept/);
    assert.match(api.deviceDataNoteText(["pbs", "profile"]), /^This device's own saved personal bests and profile can't be read\. They're kept/);
  });
});

describe("when browser storage refuses a write", () => {
  const PREFIX = "swimtics:unreadableCopy:uid-1:";
  const BAD_PBS = '[{"event":"Freestyle 50m"';
  const BAD_PROFILE = '{"name":"Sam","club":';
  const quota = () => new DOMException("The quota has been exceeded.", "QuotaExceededError");
  const blocked = () => new Error("SecurityError: storage is blocked");

  test("writeSavedText stores or removes the exact text and reads it back", () => {
    const { api, data } = load({ gone: "x" });
    assert.equal(api.writeSavedText("k", BAD_PBS), true);
    assert.equal(data.get("k"), BAD_PBS);
    assert.equal(api.writeSavedText("gone", null), true);
    assert.equal(data.has("gone"), false);
  });

  for (const [label, refusal] of [["quota exceeded", quota], ["a general storage error", blocked], ["a value that doesn't read back", () => "truncate"]]) {
    test(`writeSavedText is false on ${label}, and the earlier value stays`, () => {
      const { api, data } = load({ k: "earlier" }, { refuseWrite: (k) => (k === "k" ? refusal() : null) });
      assert.equal(api.writeSavedText("k", BAD_PBS), false);
      if (label !== "a value that doesn't read back") assert.equal(data.get("k"), "earlier");
    });

    test(`preserveUnreadableCopies reports a copy refused by ${label}; the working copy is untouched`, () => {
      const { api, data } = load({ pbs: BAD_PBS, profile: BAD_PROFILE }, {
        refuseWrite: (k) => (k.startsWith(`${PREFIX}pbs:`) ? refusal() : null),
      });
      const result = api.preserveUnreadableCopies(PREFIX);
      assert.deepEqual([...result.failed], ["pbs"]);
      assert.equal(result.made.length, 1);
      assert.match(result.made[0], /:profile:\d+$/);
      assert.equal(data.get(result.made[0]), BAD_PROFILE);
      assert.equal(data.get("pbs"), BAD_PBS);
      assert.equal(data.get("profile"), BAD_PROFILE);
    });
  }

  test("a value already kept with the same text needs no new copy, even while storage refuses writes", () => {
    const { api } = load({ pbs: BAD_PBS, [`${PREFIX}pbs:100`]: BAD_PBS }, { refuseWrite: quota });
    assert.deepEqual(JSON.parse(JSON.stringify(api.preserveUnreadableCopies(PREFIX))), { made: [], failed: [] });
  });

  test("readable or missing values need no copy, so a refusing storage isn't a failure", () => {
    const { api } = load({ pbs: "[]" }, { refuseWrite: quota });
    assert.deepEqual(JSON.parse(JSON.stringify(api.preserveUnreadableCopies(PREFIX))), { made: [], failed: [] });
  });

  test("keepUnreadableCopies still returns only the copies made", () => {
    const { api } = load({ pbs: BAD_PBS }, { refuseWrite: quota });
    assert.deepEqual([...api.keepUnreadableCopies(PREFIX)], []);
  });

  test("the page message says what was left in place and what to do next, without claiming a backup", () => {
    const { api } = load();
    for (const step of ["sign-in", "leave", "leave-restore", "reload", "signed-out"]) {
      const t = api.storageProblemText(step, ["pbs"]);
      assert.match(t.title, /browser storage is full or blocked$/);
      assert.ok(t.lead.length > 40, step);
      assert.match(t.next, /Nothing was deleted, but no backup was made either\./);
      assert.match(t.next, /free up browser storage/);
      assert.match(t.next, /reload this page/);
      assert.doesNotMatch(`${t.lead} ${t.next}`, /was backed up|backup was (saved|made)(?! either)|has been saved|was deleted(?!, but)/);
    }
    // where the page still shows the text, its own message offers a backup
    for (const step of ["sign-in", "reload"]) assert.match(api.storageProblemText(step, ["pbs"]).next, /"Download a backup"/);
    // where the account's data is hidden, no backup of it is offered and the page never claims to show it
    for (const step of ["leave", "leave-restore", "signed-out"]) {
      const t = api.storageProblemText(step, ["pbs"]);
      assert.match(t.lead, /hidden on this page/);
      assert.match(t.lead, /kept in this browser exactly as (it was|they were)/);
      assert.match(t.next, /saving changes to the profile or personal bests here is paused/);
      assert.match(t.next, /Signing in to that account again shows its data/);
      assert.doesNotMatch(`${t.lead} ${t.next}`, /may still show|even after logging out|Download a backup/);
    }
    const ended = api.storageProblemText("signed-out");
    assert.match(ended.title, /^Your session ended: the account's data is hidden/);
    assert.match(ended.lead, /signed out outside this page \(for example, by logging out in another tab, or because the session expired\)/);
    assert.match(api.storageProblemText("leave", ["pbs", "profile"]).lead, /saved personal bests and profile that can't be read/);
    assert.match(api.storageProblemText("reload", ["profile"]).lead, /^Your account's profile saved in this browser can't be read/);
    assert.match(api.storageProblemText("sign-in").lead, /your account's data wasn't loaded over them/);
  });

  test("the message for an account whose code doesn't run on this page says its data is hidden and how to reach it, without claiming a backup", () => {
    const { api } = load();
    const t = api.storageProblemText("not-here", ["pbs", "profile"]);
    assert.equal(t.title, "An account's data is hidden on this page");
    assert.match(t.lead, /^This browser holds personal bests and profile saved for an account that this page doesn't sign in/);
    assert.match(t.lead, /can't confirm that account is signed in/);
    assert.match(t.lead, /kept in this browser exactly as it was/);
    assert.match(t.next, /^Nothing was deleted or sent anywhere, but no backup was made either\./);
    assert.match(t.next, /saving changes to the profile or personal bests here is paused/);
    assert.match(t.next, /open the page that account signs in on/);
    assert.doesNotMatch(`${t.title} ${t.lead} ${t.next}`, /browser storage is full|may still show|Download a backup|was backed up|was deleted(?! or)/);
  });

  test("when Log Out can't preserve the account's data, the message says you're still signed in and to log out again", () => {
    const { api } = load();
    for (const step of ["sign-out", "sign-out-restore"]) {
      const t = api.storageProblemText(step, ["pbs"]);
      assert.match(t.title, /^You're still signed in: logging out didn't finish because browser storage is full or blocked$/);
      assert.match(t.lead, /you weren't logged out and nothing was replaced/);
      assert.match(t.next, /Nothing was deleted, but no backup was made either\./);
      assert.match(t.next, /free up browser storage/);
      assert.match(t.next, /then choose Log Out again/);
      assert.match(t.next, /"Download a backup"/);
      assert.doesNotMatch(`${t.lead} ${t.next}`, /even after logging out|was backed up|backup was (saved|made)(?! either)|has been saved/);
    }
    assert.match(api.storageProblemText("sign-out", ["pbs", "profile"]).lead, /^Your account's personal bests and profile saved in this browser can't be read/);
  });
});

describe("account data hidden while its account isn't signed in (accountMask)", () => {
  const FB = "swimtics:activeUid";               // account.js stores the id as JSON text
  const SB = "swimtics-test:activeUid";          // the Supabase code stores it as plain text
  const PBS = JSON.stringify([{ event: "Freestyle 50m", course: "Long Course", time: "28.45" }]);
  const PROFILE = JSON.stringify({ name: "Account swimmer" });
  const STROKES = JSON.stringify({ freestyle: { photo: "data:image/png;base64,AAAA" } });

  test("no account marker: nothing is hidden and the page reads the saved values as before", () => {
    const { api, writes } = load({ pbs: PBS, profile: PROFILE, strokeData: STROKES });
    assert.deepEqual([...api.accountMask.hiddenKeys()], []);
    assert.equal(api.readSaved("pbs").status, "ok");
    assert.equal(api.usableProfile().name, "Account swimmer");
    assert.deepEqual(JSON.parse(JSON.stringify(api.usableStrokeData())), JSON.parse(STROKES));
    assert.deepEqual(writes, []);
  });

  test("a marker with no one signed in hides the account's values (no value, no raw text) and writes nothing", () => {
    const { api, writes, data } = load({ pbs: PBS, profile: PROFILE, strokeData: STROKES, [FB]: JSON.stringify("uid-a") });
    for (const key of ["pbs", "profile"]) {
      assert.deepEqual({ ...api.readSaved(key) }, { key, status: "hidden", raw: null, value: undefined, problem: null });
      assert.equal(api.needsRecovery(api.readSaved(key)), false);   // so no backup or Start fresh is offered
    }
    assert.deepEqual([...api.usablePbs()], []);
    assert.deepEqual({ ...api.usableProfile() }, {});
    assert.deepEqual({ ...api.usableStrokeData() }, {});              // Firebase also swaps stroke-card photos
    assert.equal(api.accountMask.hides("strokeData"), true);
    assert.deepEqual(writes, []);
    assert.equal(data.get("pbs"), PBS);
    assert.equal(data.get("profile"), PROFILE);
  });

  test("the account's own user signed in sees it; another user, or signing out, hides it again", () => {
    const { api, writes } = load({ pbs: PBS, profile: PROFILE, [SB]: "uid-a" });
    api.accountMask.signedIn(SB, "uid-a");
    assert.equal(api.readSaved("pbs").status, "ok");
    assert.equal(api.readSaved("profile").raw, PROFILE);
    api.accountMask.signedIn(SB, "uid-b");
    assert.equal(api.readSaved("pbs").status, "hidden");
    api.accountMask.signedIn(SB, null);
    assert.equal(api.readSaved("profile").status, "hidden");
    assert.equal(api.accountMask.hides("strokeData"), false);       // the Supabase code doesn't swap stroke-card photos
    assert.deepEqual(writes, []);
  });

  test("it follows the stored marker: once the device's data is put back (marker removed) nothing is hidden", () => {
    const { api, data } = load({ pbs: PBS, [FB]: JSON.stringify("uid-a") });
    assert.equal(api.readSaved("pbs").status, "hidden");
    data.delete(FB);
    assert.equal(api.readSaved("pbs").status, "ok");
  });

  test("signing in for one account system doesn't show another system's hidden data", () => {
    const { api } = load({ pbs: PBS, [FB]: JSON.stringify("uid-a") });
    api.accountMask.signedIn(SB, "uid-a");
    assert.equal(api.readSaved("pbs").status, "hidden");
  });

  test("hidden text is still preserved exactly: an unreadable account copy is kept for that account", () => {
    const BAD = '{"event":"Backstroke 50m"';
    const { api, data } = load({ pbs: BAD, [SB]: "uid-a" });
    assert.equal(api.readSaved("pbs").status, "hidden");
    const { made, failed } = api.preserveUnreadableCopies("swimtics-test:unreadableCopy:uid-a:");
    assert.equal(made.length, 1);
    assert.deepEqual([...failed], []);
    assert.equal(data.get(made[0]), BAD);
    assert.equal(data.get("pbs"), BAD);
  });

  test("a marker no account code on this page claims keeps hiding after the page has loaded, and follows another tab's change", () => {
    const { api, writes, data, listeners } = load({ pbs: PBS, profile: PROFILE, [SB]: "uid-a" }, { page: true });
    api.accountMask.claim(FB);                                       // only the Firebase code runs on this page
    listeners["document:DOMContentLoaded"]();
    assert.equal(api.readSaved("pbs").status, "hidden");
    assert.equal(api.readSaved("profile").status, "hidden");
    assert.deepEqual([...api.usablePbs()], []);
    // another tab puts the device's data back (removing the marker)
    data.delete(SB);
    listeners["window:storage"]({ key: SB });
    assert.equal(api.readSaved("pbs").status, "ok");
    // and another tab signs that account in again
    data.set(SB, "uid-a");
    listeners["window:storage"]({ key: SB });
    assert.equal(api.readSaved("pbs").status, "hidden");
    assert.deepEqual(writes, []);
    assert.equal(data.get("pbs"), PBS);
    assert.equal(data.get("profile"), PROFILE);
  });

  test("a claimed marker shows its data only once that same account is confirmed as signed in", () => {
    const { api, listeners } = load({ pbs: PBS, [SB]: "uid-a" }, { page: true });
    api.accountMask.claim(SB);
    listeners["document:DOMContentLoaded"]();
    assert.equal(api.readSaved("pbs").status, "hidden");
    api.accountMask.signedIn(SB, "uid-a");
    assert.equal(api.readSaved("pbs").status, "ok");
  });

  test("a marker that can't be read hides nothing (the values can't be read either)", () => {
    const { api } = load({ pbs: PBS, [FB]: '"uid-a"' }, { throwOnRead: true });
    assert.equal(api.accountMask.hides("pbs"), false);
    assert.equal(api.readSaved("pbs").status, "unavailable");
  });
});
