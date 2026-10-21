/* =========================================================
   USER DATA — Profile + Personal Bests, per Firebase UID
   ---------------------------------------------------------
   The existing UI keeps reading/writing its working copy in
   localStorage ("profile", "pbs"). This module:
     - defines the cloud shape under /users/{uid} (see database.rules.json),
     - converts between the working copy and the cloud shape,
     - merges PB histories without losing records,
     - and provides a repository whose Firebase functions are injected
       (the browser passes the CDN SDK, tests pass the npm SDK).
   Photos are deliberately NOT part of the cloud shape in this stage:
   profile.photo and strokeData stay on the device.
   ========================================================= */

export const PROFILE_FIELDS = Object.freeze([
    "name", "dob", "gender", "nationality", "club",
    "primaryStroke", "secondaryStroke", "eventsPref", "distanceType",
    "height", "weight", "wingspan",
    "strengths", "weaknesses",
    "level", "hours", "coach", "facility",
    "shortGoal", "longGoal", "competition",
    "lastComp", "bestMeet", "medals",
]);

export const PROFILE_FIELD_MAX = 200;

/* ---------- small pure helpers ---------- */

export function timeToSeconds(t) {
    if (typeof t !== "string" && typeof t !== "number") return NaN;
    const s = String(t).trim();
    if (s.includes(":")) {
        const [m, rest] = s.split(":");
        return Number(m) * 60 + parseFloat(rest);
    }
    return parseFloat(s);
}

/* Realtime Database keys may not contain . $ # [ ] / — encode them. */
export function pbKey(event, course) {
    const enc = (v) => encodeURIComponent(String(v)).replace(/\./g, "%2E");
    return `${enc(event)}__${enc(course)}`;
}

/* Stable, short, dependency-free string hash (FNV-1a, 32-bit, hex). */
export function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
}

/* Only known profile fields, as strings, trimmed and length-capped.
   Empty values are dropped; profile.photo is never included. */
export function sanitizeProfile(profile) {
    const out = {};
    if (!profile || typeof profile !== "object") return out;
    for (const field of PROFILE_FIELDS) {
        const v = profile[field];
        if (v === undefined || v === null) continue;
        const s = String(v).trim().slice(0, PROFILE_FIELD_MAX);
        if (s) out[field] = s;
    }
    return out;
}

/* A valid local PB entry from the working copy, or null. */
export function cleanLocalPb(pb) {
    if (!pb || typeof pb.event !== "string" || typeof pb.course !== "string") return null;
    if (!pb.event || !pb.course) return null;
    const history = Array.isArray(pb.history)
        ? pb.history.map(Number).filter((s) => Number.isFinite(s) && s > 0 && s < 100000)
        : [];
    const time = typeof pb.time === "string" ? pb.time.trim() : String(pb.time ?? "").trim();
    const best = timeToSeconds(time);
    if (!history.length && Number.isFinite(best) && best > 0) history.push(best);
    if (!history.length) return null;
    return { event: pb.event, course: pb.course, time: time || String(Math.min(...history)), history };
}

/* Fingerprint of the device's local data — identifies "this set of local
   data" so the same data is never imported twice. */
export function fingerprintLocal(local) {
    const profile = sanitizeProfile(local && local.profile);
    const pbs = ((local && local.pbs) || []).map(cleanLocalPb).filter(Boolean)
        .map((p) => [p.event, p.course, p.time, p.history])
        .sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
    return hash(JSON.stringify({ profile, pbs }));
}

/* Deterministic history-entry ids for imported local data: re-importing the
   same local data writes the same ids, so it can never create duplicates. */
function importEntryId(fingerprint, key, index) {
    return `imp_${fingerprint}_${hash(key)}_${index}`;
}

/* Id for a history entry recorded on a device. Deterministic for the same
   device, PB, position and time, so retrying a sync that partly failed
   (or replaying a pending backup) can never add the same swim twice;
   the device id keeps different devices' entries distinct. */
export function deviceEntryId(deviceId, key, index, seconds) {
    return `h_${hash(String(deviceId))}_${hash(key)}_${index}_${hash(String(seconds))}`;
}

/* ---------- cloud <-> working-copy conversion ---------- */

/* Cloud pb node -> working-copy pb object (the shape the existing UI uses),
   plus historyIds so later local changes can be synced precisely. */
export function cloudPbToLocal(node) {
    const entries = Object.entries((node && node.history) || {})
        .filter(([, e]) => e && Number.isFinite(e.s))
        .sort((a, b) => (a[1].n - b[1].n) || a[0].localeCompare(b[0]));
    return {
        event: node.event,
        course: node.course,
        time: node.time,
        history: entries.map(([, e]) => e.s),
        historyIds: entries.map(([id]) => id),
    };
}

export function cloudPbsToLocal(pbsNode) {
    return Object.values(pbsNode || {})
        .filter((n) => n && n.event && n.course)
        .map(cloudPbToLocal);
}

/* Best-time string: whichever candidate has the lower time in seconds. */
function betterTime(a, b) {
    if (!a) return b;
    if (!b) return a;
    return timeToSeconds(b) < timeToSeconds(a) ? b : a;
}

/* Merge history entries into a cloud pb node (union by entry id — nothing
   existing is ever removed) and keep the best time consistent with them. */
export function mergeIntoCloudPb(current, { event, course, time, entries }) {
    const node = current && current.event
        ? { event: current.event, course: current.course, time: current.time, history: { ...(current.history || {}) } }
        : { event, course, time, history: {} };
    for (const [id, e] of Object.entries(entries || {})) {
        if (!node.history[id]) node.history[id] = e;
    }
    const all = Object.values(node.history).map((e) => e.s);
    const minS = Math.min(...all);
    let best = betterTime(node.time, time);
    if (Number.isFinite(minS) && timeToSeconds(best) > minS) best = String(minS);
    node.time = best;
    return node;
}

/* ---------- import preview + plan ---------- */

/* What importing this device's local data into an account would do.
   cloud = { profile, pbs } as stored under /users/{uid}. */
export function planImport(local, cloud) {
    const fingerprint = fingerprintLocal(local);
    const localProfile = sanitizeProfile(local && local.profile);
    const cloudProfile = (cloud && cloud.profile) || {};

    const profileFill = {};      // empty in the account -> taken from this device
    const profileKept = [];      // already set in the account -> account value kept
    for (const [field, value] of Object.entries(localProfile)) {
        if (cloudProfile[field] === undefined || cloudProfile[field] === "") profileFill[field] = value;
        else if (cloudProfile[field] !== value) profileKept.push(field);
    }

    const pbs = [];
    const cloudPbs = (cloud && cloud.pbs) || {};
    for (const raw of (local && local.pbs) || []) {
        const pb = cleanLocalPb(raw);
        if (!pb) continue;
        const key = pbKey(pb.event, pb.course);
        const entries = {};
        pb.history.forEach((s, i) => { entries[importEntryId(fingerprint, key, i)] = { s, n: i }; });
        const existing = cloudPbs[key];
        const newIds = Object.keys(entries).filter((id) => !(existing && existing.history && existing.history[id]));
        pbs.push({
            key, event: pb.event, course: pb.course, time: pb.time, entries,
            newEntries: newIds.length,
            existsInAccount: !!existing,
        });
    }

    const pbEntries = pbs.reduce((n, p) => n + p.newEntries, 0);
    return {
        fingerprint,
        profileFill,
        profileKept,
        pbs,
        pbEntries,
        isEmpty: !Object.keys(profileFill).length && pbEntries === 0,
        hasLocalData: Object.keys(localProfile).length > 0 || pbs.length > 0,
    };
}

/* ---------- repository (Firebase functions injected) ---------- */

/*
 * fb = { db, ref, get, set, update, remove, runTransaction, serverTimestamp? }
 * Works with the modular Firebase Database SDK (v9+), browser or Node.
 */
export function createUserDataRepository(fb) {
    const { db, ref, get, set, update, remove, runTransaction } = fb;
    const userRef = (uid, path = "") => ref(db, `users/${uid}${path ? "/" + path : ""}`);
    const now = () => Date.now();

    async function load(uid) {
        const snap = await get(userRef(uid));
        const val = snap.exists() ? snap.val() : {};
        return {
            profile: val.profile || {},
            pbs: val.pbs || {},
            imports: (val.meta && val.meta.imports) || {},
        };
    }

    async function saveProfile(uid, profile) {
        const clean = sanitizeProfile(profile);
        await set(userRef(uid, "profile"), { ...clean, updatedAt: now() });
        return clean;
    }

    /* Add history entries to one PB atomically (safe with other devices). */
    async function addPbEntries(uid, { event, course, time, entries }) {
        const key = pbKey(event, course);
        const result = await runTransaction(userRef(uid, `pbs/${key}`),
            (current) => mergeIntoCloudPb(current, { event, course, time, entries }));
        if (!result.committed) throw new Error("PB update was not committed");
        return cloudPbToLocal(result.snapshot.val());
    }

    async function deletePb(uid, event, course) {
        await remove(userRef(uid, `pbs/${pbKey(event, course)}`));
    }

    /*
     * Sync the working copy's PB changes since the last sync:
     *  - history entries beyond pb.historyIds are new -> added with fresh ids,
     *  - PBs present at the last sync but gone from the working copy -> deleted.
     * Returns the refreshed working-copy PB list.
     */
    async function syncPbs(uid, workingPbs, lastSyncedKeys = [], deviceId = "device") {
        const keysNow = new Set();
        const out = [];
        for (const pb of workingPbs || []) {
            const clean = cleanLocalPb(pb);
            if (!clean) continue;
            const key = pbKey(clean.event, clean.course);
            keysNow.add(key);
            const known = Array.isArray(pb.historyIds) ? pb.historyIds.slice(0, clean.history.length) : [];
            const entries = {};
            clean.history.slice(known.length).forEach((s, i) => {
                const index = known.length + i;
                entries[deviceEntryId(deviceId, key, index, s)] = { s, n: now() + i };
            });
            if (Object.keys(entries).length || !known.length) {
                out.push(await addPbEntries(uid, { ...clean, entries }));
            } else {
                out.push({ ...clean, historyIds: known });
            }
        }
        for (const key of lastSyncedKeys) {
            if (!keysNow.has(key)) await remove(userRef(uid, `pbs/${key}`));
        }
        return out;
    }

    /* Import this device's local data (plan from planImport). Profile: only
       fills fields that are empty in the account. PBs: union by id. */
    async function importLocal(uid, plan) {
        if (Object.keys(plan.profileFill).length) {
            const cur = (await get(userRef(uid, "profile"))).val() || {};
            await set(userRef(uid, "profile"), { ...cur, ...plan.profileFill, updatedAt: now() });
        }
        for (const p of plan.pbs) {
            await addPbEntries(uid, { event: p.event, course: p.course, time: p.time, entries: p.entries });
        }
        await set(userRef(uid, `meta/imports/${plan.fingerprint}`), {
            at: now(),
            pbEntries: plan.pbEntries,
            profileFields: Object.keys(plan.profileFill).length,
        });
        return load(uid);
    }

    return { load, saveProfile, addPbEntries, deletePb, syncPbs, importLocal, pbKey };
}
