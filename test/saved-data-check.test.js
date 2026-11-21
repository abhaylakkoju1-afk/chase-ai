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
function load(items = {}, { throwOnRead = false } = {}) {
  const data = new Map(Object.entries(items));
  const writes = [];
  const localStorage = {
    getItem(k) {
      if (throwOnRead) throw new Error("blocked");
      return data.has(k) ? data.get(k) : null;
    },
    setItem(k, v) { writes.push(["set", k, v]); data.set(k, String(v)); },
    removeItem(k) { writes.push(["remove", k]); data.delete(k); },
    get length() { return data.size; },
    key(i) { return [...data.keys()][i] ?? null; },
  };
  const sandbox = { localStorage };
  vm.runInNewContext(SOURCE, sandbox);
  return { api: sandbox.swimticsSavedData, writes, data };
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
