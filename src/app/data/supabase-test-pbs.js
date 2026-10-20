/* =========================================================
   SUPABASE TEST MODE — personal bests (swimtics-test only)
   Maps between the app's existing PB shape (localStorage "pbs":
   { event, course, time, history[seconds], historyIds? }) and the
   swimtics-test tables in supabase/sql/002_personal_bests.sql, reusing the
   existing pure logic in user-data.js (pbKey, cleanLocalPb, deviceEntryId,
   planImport). The pure helpers are tested in Node; the repository takes
   a supabase-js client as an argument. Used only by supabase-test-account.js.
   ========================================================= */

import { pbKey, cleanLocalPb, deviceEntryId, timeToSeconds } from "./user-data.js";
import { profileToRow } from "./supabase-test-core.js";

export const PB_SELECT = "pb_key,event,course,best_time,pb_entries(entry_id,seconds,ord)";

/* A personal_bests row (with its nested pb_entries) -> the working-copy PB
   the existing UI uses, plus historyIds so later changes sync precisely
   (the same output as cloudPbToLocal() for the Firebase shape). */
export function rowToLocalPb(row) {
    const entries = [...((row && row.pb_entries) || [])]
        .filter((e) => e && Number.isFinite(Number(e.seconds)))
        .sort((a, b) => (Number(a.ord) - Number(b.ord)) || String(a.entry_id).localeCompare(String(b.entry_id)));
    return {
        event: row.event,
        course: row.course,
        time: row.best_time,
        history: entries.map((e) => Number(e.seconds)),
        historyIds: entries.map((e) => e.entry_id),
    };
}

export function rowsToLocalPbs(rows) {
    return (rows || []).filter((r) => r && r.event && r.course).map(rowToLocalPb);
}

/* Rows -> the cloud shape planImport() already understands:
   { [pbKey]: { event, course, time, history: { [entryId]: { s, n } } } } */
export function rowsToCloudPbs(rows) {
    const out = {};
    for (const row of rows || []) {
        if (!row || !row.event || !row.course) continue;
        const history = {};
        for (const e of row.pb_entries || []) history[e.entry_id] = { s: Number(e.seconds), n: Number(e.ord) };
        out[row.pb_key || pbKey(row.event, row.course)] = { event: row.event, course: row.course, time: row.best_time, history };
    }
    return out;
}

/* Seconds at millisecond precision: the app's own parsing leaves float
   noise (60 + 8.04 = 68.03999999999999 for "1:08.04"); the database stores
   at most 3 decimals and compares at that precision. */
export function toMs(seconds) {
    return Math.round(Number(seconds) * 1000);
}

/* { [entryId]: { s, n } } -> the p_entries array add_pb_entries() takes. */
export function entriesToRpc(entries) {
    return Object.entries(entries || {}).map(([entry_id, e]) => ({ entry_id, seconds: toMs(e.s) / 1000, ord: e.n }));
}

/* add_pb_entries() accepts at most this many entries per call. */
export const RPC_MAX_ENTRIES = 500;

/* The best-time rule add_pb_entries() applies in SQL (and mergeIntoCloudPb()
   applies for Firebase): the better of the stored and incoming time; if that
   is still slower than the fastest recorded swim, that swim's seconds —
   compared at millisecond precision, as in SQL. Times that aren't "ss.xx"
   or "m:ss.xx" count as unknown. */
const TIME_RE = /^\s*(?:\d+(?:\.\d+)?|\d+:\d+(?:\.\d+)?)\s*$/;
function strictSeconds(t) {
    return typeof t === "string" && TIME_RE.test(t) ? timeToSeconds(t.trim()) : null;
}
export function bestTimeAfterMerge(storedTime, incomingTime, entrySeconds) {
    const stored = strictSeconds(storedTime);
    const incoming = strictSeconds(incomingTime);
    let best;
    if (stored === null) best = incomingTime ?? storedTime;
    else if (incoming !== null && incoming < stored) best = incomingTime;
    else best = storedTime;
    const all = (entrySeconds || []).map(Number).filter(Number.isFinite);
    if (all.length) {
        const minMs = Math.min(...all.map(toMs));
        const bestS = strictSeconds(best);
        if (bestS === null || toMs(bestS) > minMs) best = String(minMs / 1000);
    }
    return best;
}

/* What syncing the working copy would do — the same rules as
   createUserDataRepository().syncPbs() for Firebase: history entries
   beyond pb.historyIds are new (deterministic ids from deviceEntryId, so a
   retried sync never adds a swim twice); a PB with no historyIds yet is
   sent whole; PBs present at the last sync but gone now are deleted. */
export function planPbSync(workingPbs, lastSyncedKeys = [], deviceId = "device", now = Date.now()) {
    const keysNow = new Set();
    const items = [];
    for (const pb of workingPbs || []) {
        const clean = cleanLocalPb(pb);
        if (!clean) continue;
        const key = pbKey(clean.event, clean.course);
        keysNow.add(key);
        const known = Array.isArray(pb.historyIds) ? pb.historyIds.slice(0, clean.history.length) : [];
        const entries = {};
        clean.history.slice(known.length).forEach((s, i) => {
            const index = known.length + i;
            entries[deviceEntryId(deviceId, key, index, s)] = { s, n: now + i };
        });
        if (Object.keys(entries).length || !known.length) {
            items.push({ type: "add", key, event: clean.event, course: clean.course, time: clean.time, entries });
        } else {
            items.push({ type: "keep", pb: { ...clean, historyIds: known } });
        }
    }
    const deletes = (lastSyncedKeys || []).filter((key) => !keysNow.has(key));
    return { items, deletes };
}

/* ---------- repository: a supabase-js client is passed in ---------- */

export function createTestPbRepository(client) {
    async function loadRows(uid) {
        const { data, error } = await client.from("personal_bests").select(PB_SELECT).eq("user_id", uid);
        if (error) throw error;
        return data || [];
    }

    /* In calls of at most RPC_MAX_ENTRIES entries; the last answer holds
       the PB with all its entries. */
    async function addPbEntries({ key, event, course, time, entries }) {
        const all = entriesToRpc(entries);
        let data = null;
        for (let i = 0; i === 0 || i < all.length; i += RPC_MAX_ENTRIES) {
            const res = await client.rpc("add_pb_entries", {
                p_pb_key: key, p_event: event, p_course: course, p_time: time,
                p_entries: all.slice(i, i + RPC_MAX_ENTRIES),
            });
            if (res.error) throw res.error;
            data = res.data;
        }
        return rowToLocalPb(data);
    }

    async function deletePb(uid, key) {
        const { error } = await client.from("personal_bests").delete().eq("user_id", uid).eq("pb_key", key);
        if (error) throw error;
    }

    /* Returns the refreshed working-copy PB list (with historyIds). */
    async function syncPbs(uid, workingPbs, lastSyncedKeys, deviceId) {
        const plan = planPbSync(workingPbs, lastSyncedKeys, deviceId);
        const out = [];
        for (const item of plan.items) {
            out.push(item.type === "add" ? await addPbEntries(item) : item.pb);
        }
        for (const key of plan.deletes) await deletePb(uid, key);
        return out;
    }

    async function importedFingerprints(uid) {
        const { data, error } = await client.from("device_imports").select("fingerprint").eq("user_id", uid);
        if (error) throw error;
        return new Set((data || []).map((r) => r.fingerprint));
    }

    /* Import this device's data (a plan from planImport()). Profile: fills
       only fields that are empty in the account. PBs: union by entry id.
       The import is recorded so the same device data is never offered or
       imported twice. Nothing in the account is overwritten or removed. */
    async function importLocal(uid, plan, accountProfile) {
        if (Object.keys(plan.profileFill).length) {
            const { error } = await client.from("profiles")
                .upsert(profileToRow(uid, { ...(accountProfile || {}), ...plan.profileFill }), { onConflict: "user_id" });
            if (error) throw error;
        }
        for (const p of plan.pbs) {
            if (p.newEntries > 0 || !p.existsInAccount) {
                await addPbEntries({ key: p.key, event: p.event, course: p.course, time: p.time, entries: p.entries });
            }
        }
        const { error } = await client.from("device_imports").upsert({
            user_id: uid,
            fingerprint: plan.fingerprint,
            pb_entries: plan.pbEntries,
            profile_fields: Object.keys(plan.profileFill).length,
        }, { onConflict: "user_id,fingerprint", ignoreDuplicates: true });
        if (error) throw error;
    }

    return { loadRows, addPbEntries, deletePb, syncPbs, importedFingerprints, importLocal };
}
