/* =========================================================
   SAVED DATA CHECK — the personal bests ("pbs") and Profile
   ("profile") saved in this browser's localStorage.
   ---------------------------------------------------------
   Reads each value and says whether it can be used:
     missing       nothing saved yet (the app starts empty, as before)
     ok            valid JSON in the shape the app writes
     invalid-json  the saved text isn't valid JSON
     wrong-shape   valid JSON, but not the shape the app writes
     unavailable   browser storage couldn't be read at all

   When a value can't be used, the Wall of Records and Profile show a
   recovery message (renderSavedDataRecovery) instead of crashing or
   quietly showing an empty list or blank profile. Nothing here writes
   to storage on its own: the saved text is kept exactly as it is until
   the person chooses "Start fresh" and confirms it. The backup actions
   (download a file, copy to the clipboard) stay in the browser and send
   nothing anywhere.

   Start fresh only removes the value from this browser. It never calls
   account sync, and it isn't offered while the saved copy belongs to a
   signed-in account: account sync treats PBs missing from the local list
   as deleted, so a later change could remove the account's own PBs.

   Signed-in accounts (account.js, supabase-accounts-core.js): while an
   account is signed in, "pbs" and "profile" hold that account's working
   copy, and this device's own copy is set aside exactly as saved. When
   the account code is about to replace an account working copy that
   can't be read (reload, log out, switching account, reloading the
   account), it first keeps the exact text under a key for that account
   only (keepUnreadableCopies). Profile shows those copies, with backup and
   Discard, only while that account is signed in again
   (renderAccountCopyRecovery); Discard removes only the local copy.

   If browser storage refuses a write (full, blocked, or unavailable), the
   account code never replaces text it couldn't first preserve: a copy or a
   set-aside value only counts once it has been written and read back
   exactly (writeSavedText, preserveUnreadableCopies). The sign-in, log-out,
   switch or restore step that needed it stops, the original is left
   untouched, and the page says what happened and what to do next
   (showStorageProblem) without claiming anything was backed up.

   A classic script (not a module) so index.html's main script can use it
   while it starts up. The checks are pure functions, also run by
   test/saved-data-check.test.js.
   ========================================================= */

(function (root) {
    "use strict";

    /* the Profile fields the page shows, plus the photo (user-data.js
       PROFILE_FIELDS; kept in step by hand, checked by the unit test) */
    const PROFILE_TEXT_FIELDS = [
        "name", "dob", "nationality", "club",
        "primaryStroke", "secondaryStroke", "eventsPref", "distanceType",
        "height", "weight", "wingspan",
        "strengths", "weaknesses",
        "level", "hours", "coach", "facility",
        "shortGoal", "longGoal", "competition",
        "lastComp", "bestMeet", "medals",
    ];

    const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
    const isText = (v) => typeof v === "string";
    const isNothing = (v) => v === undefined || v === null;
    const typeName = (v) => (v === null ? "null" : Array.isArray(v) ? "a list" : typeof v === "object" ? "an object" : `a ${typeof v}`);

    /* null if the list is in the shape the app writes, else what's wrong.
       Each PB: { event: text, course: text, time: text, history?: list }.
       History entries and the time's format aren't checked here: the Wall
       of Records already flags those row by row. */
    function pbsProblem(value) {
        if (!Array.isArray(value)) return `it's ${typeName(value)}, not a list of personal bests`;
        for (let i = 0; i < value.length; i++) {
            const pb = value[i];
            const n = i + 1;
            if (!isPlainObject(pb)) return `entry ${n} is ${typeName(pb)}, not a personal best`;
            if (!isText(pb.event)) return `entry ${n} has no event name`;
            if (!isText(pb.course)) return `entry ${n} has no course`;
            if (!isText(pb.time)) return `entry ${n}'s time isn't text`;
            if (!isNothing(pb.history) && !Array.isArray(pb.history)) return `entry ${n}'s history isn't a list`;
        }
        return null;
    }

    /* null if the profile is in the shape the app writes, else what's wrong.
       Text fields may also be numbers; gender and the photo must be text
       (the page reads them as text). Other keys are ignored. */
    function profileProblem(value) {
        if (!isPlainObject(value)) return `it's ${typeName(value)}, not a profile`;
        for (const field of PROFILE_TEXT_FIELDS) {
            const v = value[field];
            if (isNothing(v) || isText(v) || (typeof v === "number" && Number.isFinite(v))) continue;
            return `the "${field}" field is ${typeName(v)}`;
        }
        for (const field of ["gender", "photo"]) {
            const v = value[field];
            if (!isNothing(v) && !isText(v)) return `the "${field}" field is ${typeName(v)}`;
        }
        return null;
    }

    const CHECKS = { pbs: pbsProblem, profile: profileProblem };

    /* What a saved raw string holds. `value` is usable only when status is
       "ok"; `raw` is always the saved text, untouched. */
    function classifySaved(key, raw) {
        if (raw === null || raw === undefined) return { key, status: "missing", raw: null, value: undefined, problem: null };
        let value;
        try {
            value = JSON.parse(raw);
        } catch {
            return { key, status: "invalid-json", raw, value: undefined, problem: "it isn't valid saved data" };
        }
        const problem = CHECKS[key](value);
        if (problem) return { key, status: "wrong-shape", raw, value: undefined, problem };
        return { key, status: "ok", raw, value, problem: null };
    }

    function readSaved(key) {
        let raw;
        try {
            raw = root.localStorage.getItem(key);
        } catch {
            return { key, status: "unavailable", raw: null, value: undefined, problem: null };
        }
        return classifySaved(key, raw);
    }

    /* the saved value can't be used and is kept until the person acts */
    const needsRecovery = (result) => result.status === "invalid-json" || result.status === "wrong-shape";

    /* The saved list if it can be used, else an empty one (in memory only:
       storage is not touched). Used where the page used to do
       `JSON.parse(localStorage.getItem("pbs")) || []`. */
    function usablePbs() {
        const r = readSaved("pbs");
        return r.status === "ok" ? r.value : [];
    }

    function usableProfile() {
        const r = readSaved("profile");
        return r.status === "ok" ? r.value : {};
    }

    /* ---------- per-account copies of unreadable text ----------
       `prefix` names one account in one account system, for example
       "swimtics:unreadableCopy:<uid>:". Each copy is its own key,
       `${prefix}${"pbs"|"profile"}:${time}`, whose value is the saved text
       exactly as it was (no wrapper that could itself become unreadable). */

    const COPY_KEYS = ["pbs", "profile"];

    function listUnreadableCopies(prefix) {
        const out = [];
        try {
            const ls = root.localStorage;
            for (let i = 0; i < ls.length; i++) {
                const storageKey = ls.key(i);
                if (!storageKey || !storageKey.startsWith(prefix)) continue;
                const m = /^(pbs|profile):(\d+)$/.exec(storageKey.slice(prefix.length));
                if (!m) continue;
                const raw = ls.getItem(storageKey);
                if (raw !== null) out.push({ storageKey, key: m[1], at: Number(m[2]), raw });
            }
        } catch {
            return [];
        }
        return out.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
    }

    /* Stores `raw` under `key` exactly (null removes the key) and reads it
       back. true only if storage now holds exactly `raw`; a write the
       browser refused (storage full, blocked or unavailable) is false. */
    function writeSavedText(key, raw) {
        try {
            if (raw === null || raw === undefined) root.localStorage.removeItem(key);
            else root.localStorage.setItem(key, raw);
            return root.localStorage.getItem(key) === (raw === undefined ? null : raw);
        } catch (err) {
            if (root.console) root.console.error("SWIMTICS storage:", err);
            return false;
        }
    }

    /* Before account code replaces the working copy of an account: keep any
       of "pbs" / "profile" (or just `keys`) that can't be read under that
       account's prefix (once per distinct text), each written and read back
       exactly. Returns { made: storage keys of the copies made, failed: the
       keys ("pbs" / "profile") whose copy couldn't be kept }. While `failed`
       isn't empty, that working copy must not be replaced. */
    function preserveUnreadableCopies(prefix, keys = COPY_KEYS) {
        const made = [];
        const failed = [];
        for (const key of COPY_KEYS) {
            if (!keys.includes(key)) continue;
            const r = readSaved(key);
            if (!needsRecovery(r)) continue;
            if (listUnreadableCopies(prefix).some((c) => c.key === key && c.raw === r.raw)) continue;
            const storageKey = `${prefix}${key}:${Date.now()}`;
            if (writeSavedText(storageKey, r.raw)) made.push(storageKey);
            else failed.push(key);
        }
        return { made, failed };
    }

    /* the storage keys of the copies made (preserveUnreadableCopies) */
    function keepUnreadableCopies(prefix, keys = COPY_KEYS) {
        return preserveUnreadableCopies(prefix, keys).made;
    }

    function removeUnreadableCopy(storageKey) {
        try {
            root.localStorage.removeItem(storageKey);
            return true;
        } catch {
            return false;
        }
    }

    /* ---------- the recovery message ---------- */

    const WORDS = {
        pbs: {
            title: "Your saved personal bests can't be read",
            what: "personal bests",
            paused: "Adding, editing and deleting PBs is paused so the saved copy can't be overwritten.",
            file: "swimtics-personal-bests-backup",
            fresh: "start an empty personal bests list",
            done: "The unreadable personal bests were removed from this browser. Your PB list is now empty.",
        },
        profile: {
            title: "Your saved profile can't be read",
            what: "profile",
            paused: "Saving the profile and changing its photo is paused so the saved copy can't be overwritten.",
            file: "swimtics-profile-backup",
            fresh: "start a blank profile",
            done: "The unreadable profile was removed from this browser. Your profile is now blank.",
        },
    };

    function reasonText(result) {
        return result.status === "invalid-json"
            ? `The copy saved in this browser is damaged: ${result.problem}.`
            : `The copy saved in this browser isn't in the format SWIMTICS expects: ${result.problem}.`;
    }

    function today() {
        const d = new Date();
        const p = (n) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }

    function make(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function button(text, className) {
        const b = make("button", className ? `recovery-btn ${className}` : "recovery-btn", text);
        b.type = "button";
        return b;
    }

    /* "Download a backup" and "Copy backup" for `raw` (the saved text
       exactly as it is), added to `actions`. `say(text, kind)` reports the
       outcome; onBackedUp() runs after a successful backup. */
    function addBackupButtons(actions, raw, fileBase, say, onBackedUp) {
        const download = button("Download a backup");
        const copy = button("Copy backup");
        actions.append(download, copy);

        download.addEventListener("click", () => {
            try {
                const url = URL.createObjectURL(new Blob([raw], { type: "text/plain" }));
                const a = document.createElement("a");
                a.href = url;
                a.download = `${fileBase}-${today()}.txt`;
                document.body.append(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                onBackedUp();
                say(`Backup downloaded as ${a.download}. Keep it somewhere safe.`, "ok");
            } catch {
                say("Couldn't download the backup in this browser. Try Copy backup instead.", "error");
            }
        });

        copy.addEventListener("click", async () => {
            try {
                if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") throw new Error("no clipboard");
                await navigator.clipboard.writeText(raw);
                onBackedUp();
                say("Backup copied. Paste it somewhere safe, such as a note, before you start fresh.", "ok");
            } catch {
                say("Couldn't copy the backup (the browser blocked it). Try Download a backup instead.", "error");
            }
        });
    }

    function statusLine() {
        const status = make("p", "saved-data-recovery-status");
        status.setAttribute("role", "status");
        status.setAttribute("aria-live", "polite");
        const say = (text, kind) => {
            status.textContent = text;
            status.dataset.kind = kind || "";
        };
        return { status, say };
    }

    /* Draws the recovery message for `result` into `container`.
       options.accountOwned(): true while the saved copy belongs to a
         signed-in account (Start fresh isn't offered then).
       options.afterReset(message): redraw the page once the value has been
         removed. */
    function renderSavedDataRecovery(container, result, options = {}) {
        const words = WORDS[result.key];
        const raw = result.raw;
        const accountOwned = typeof options.accountOwned === "function" ? options.accountOwned : () => false;
        let backedUp = false;

        const box = make("section", "saved-data-recovery");
        box.dataset.savedKey = result.key;
        box.setAttribute("role", "alert");
        const titleId = `savedDataRecoveryTitle-${result.key}`;
        box.setAttribute("aria-labelledby", titleId);

        const title = make("h4", "saved-data-recovery-title", words.title);
        title.id = titleId;
        box.append(
            title,
            make("p", "", reasonText(result)),
            make("p", "", `Nothing has been changed or deleted. The saved copy is kept exactly as it is until you choose what to do. ${words.paused}`),
            make("p", "", "First save a backup: download it as a file, or copy it and paste it somewhere safe. The backup is the saved data exactly as it is.")
        );

        const actions = make("div", "saved-data-recovery-actions");
        const { status, say } = statusLine();
        addBackupButtons(actions, raw, words.file, say, () => { backedUp = true; });

        box.append(actions);

        if (accountOwned()) {
            box.append(make("p", "saved-data-recovery-note",
                `You're signed in, so this copy belongs to your account. Starting fresh isn't available while you're signed in yet: account sync could send the empty ${words.what} to your account and remove what's stored there. You can still save a backup.`));
            box.append(status);
            container.append(box);
            return box;
        }

        const freshBtn = button("Start fresh…", "recovery-btn-danger");
        actions.append(freshBtn);

        const confirmBox = make("div", "saved-data-recovery-confirm");
        confirmBox.hidden = true;
        const confirmText = make("p", "");
        confirmText.id = `savedDataRecoveryConfirm-${result.key}`;
        const confirmYes = button("Remove and start fresh", "recovery-btn-danger");
        const confirmNo = button("Cancel");
        confirmYes.setAttribute("aria-describedby", confirmText.id);
        const confirmActions = make("div", "saved-data-recovery-actions");
        confirmActions.append(confirmYes, confirmNo);
        confirmBox.append(confirmText, confirmActions);

        freshBtn.addEventListener("click", () => {
            confirmText.textContent =
                `Start fresh removes the unreadable ${words.what} from this browser and will ${words.fresh}. This can't be undone.` +
                (backedUp ? "" : " You haven't downloaded or copied a backup yet.");
            confirmBox.hidden = false;
            freshBtn.hidden = true;
            say("");
            confirmYes.focus();
        });

        confirmNo.addEventListener("click", () => {
            confirmBox.hidden = true;
            freshBtn.hidden = false;
            say("Nothing was changed.");
            freshBtn.focus();
        });

        confirmYes.addEventListener("click", () => {
            /* re-checked now: the person may have signed in, or the saved
               value may have changed (another tab), since this was drawn */
            if (accountOwned()) {
                say("You're signed in now, so starting fresh isn't available. Nothing was changed.", "error");
                return;
            }
            const now = readSaved(result.key);
            if (now.raw !== raw) {
                say("The saved data changed since this message appeared, so nothing was removed. Reload the page to see it.", "error");
                return;
            }
            try {
                root.localStorage.removeItem(result.key);
            } catch {
                say("Couldn't change browser storage, so nothing was removed.", "error");
                return;
            }
            if (typeof options.afterReset === "function") options.afterReset(words.done);
        });

        box.append(confirmBox, status);
        container.append(box);
        return box;
    }

    /* Draws the message for one per-account copy (from
       listUnreadableCopies) into `container`. Shown only while that account
       is signed in. Discard removes only that local copy, after
       confirmation; nothing is sent anywhere.
       options.onDiscarded(message): redraw once the copy is removed. */
    function renderAccountCopyRecovery(container, copy, options = {}) {
        const words = WORDS[copy.key];
        let backedUp = false;

        const box = make("section", "saved-data-recovery saved-data-account-copy");
        box.dataset.copyKey = copy.storageKey;
        const titleId = `savedDataAccountCopy-${copy.key}-${copy.at}`;
        box.setAttribute("aria-labelledby", titleId);

        const title = make("h4", "saved-data-recovery-title", `An unreadable copy of your account's ${words.what} was kept`);
        title.id = titleId;
        box.append(
            title,
            make("p", "", `This browser had a copy of your account's ${words.what} that couldn't be read. It was kept here, exactly as it was, instead of being replaced. Your account's own ${words.what} were loaded from your account and haven't been changed.`),
            make("p", "", "You can save a backup of the unreadable copy, then discard it. Discarding only removes it from this browser; nothing is sent to your account.")
        );

        const actions = make("div", "saved-data-recovery-actions");
        const { status, say } = statusLine();
        addBackupButtons(actions, copy.raw, `${words.file}-unreadable-account-copy`, say, () => { backedUp = true; });

        const discardBtn = button("Discard this copy…", "recovery-btn-danger");
        actions.append(discardBtn);

        const confirmBox = make("div", "saved-data-recovery-confirm");
        confirmBox.hidden = true;
        const confirmText = make("p", "");
        confirmText.id = `${titleId}-confirm`;
        const confirmYes = button("Discard", "recovery-btn-danger");
        const confirmNo = button("Cancel");
        confirmYes.setAttribute("aria-describedby", confirmText.id);
        const confirmActions = make("div", "saved-data-recovery-actions");
        confirmActions.append(confirmYes, confirmNo);
        confirmBox.append(confirmText, confirmActions);

        discardBtn.addEventListener("click", () => {
            confirmText.textContent =
                `Discard removes this unreadable copy of your account's ${words.what} from this browser. Your account isn't changed. This can't be undone.` +
                (backedUp ? "" : " You haven't downloaded or copied a backup yet.");
            confirmBox.hidden = false;
            discardBtn.hidden = true;
            say("");
            confirmYes.focus();
        });

        confirmNo.addEventListener("click", () => {
            confirmBox.hidden = true;
            discardBtn.hidden = false;
            say("Nothing was changed.");
            discardBtn.focus();
        });

        confirmYes.addEventListener("click", () => {
            if (!removeUnreadableCopy(copy.storageKey)) {
                say("Couldn't change browser storage, so nothing was removed.", "error");
                return;
            }
            if (typeof options.onDiscarded === "function") {
                options.onDiscarded(`The unreadable copy of your account's ${words.what} was removed from this browser.`);
            }
        });

        box.append(actions, confirmBox, status);
        container.append(box);
        return box;
    }

    /* The signed-in note for this device's own set-aside data that can't be
       read (`keys`: some of "pbs", "profile"). Text only: while an account
       is shown, the device's data isn't offered for backup or reset. */
    function deviceDataNoteText(keys) {
        const both = keys.includes("pbs") && keys.includes("profile");
        const what = both ? "personal bests and profile" : keys.includes("pbs") ? "personal bests" : "profile";
        const kept = keys.includes("pbs") ? "They're" : "It's";
        return `This device's own saved ${what} can't be read. ${kept} kept on this device exactly as saved and will come back when you log out, where you can save a backup or start fresh.`;
    }

    /* ---------- when storage refuses a write the account code needs ----------
       `step`:
         "sign-in"       this device's own data couldn't be set aside, so the
                         account wasn't loaded over it
         "leave"         an unreadable copy of the account last signed in
                         here couldn't be kept, so it wasn't replaced
                         (switching account, a sign-out from elsewhere, or
                         start-up after either)
         "leave-restore" this device's own data couldn't be put back, so the
                         account last signed in here was left in place
         "reload"        an unreadable copy of the signed-in account's own
                         data couldn't be kept, so it wasn't refreshed
         "sign-out"      Log Out: an unreadable copy of the account couldn't
                         be kept, so the user stays signed in (nothing replaced)
         "sign-out-restore"  Log Out: this device's own data couldn't be put
                         back, so the user stays signed in (nothing replaced)
       `keys`: the "pbs" / "profile" values concerned (for "leave" / "reload" /
       "sign-out"). */

    const STORAGE_PROBLEM_TITLE = {
        "sign-in": "Your account wasn't loaded: browser storage is full or blocked",
        "leave": "Switching accounts didn't finish: browser storage is full or blocked",
        "leave-restore": "Switching accounts didn't finish: browser storage is full or blocked",
        "reload": "Your account's data wasn't refreshed: browser storage is full or blocked",
        "sign-out": "You're still signed in: logging out didn't finish because browser storage is full or blocked",
        "sign-out-restore": "You're still signed in: logging out didn't finish because browser storage is full or blocked",
    };

    function whatText(keys) {
        const list = keys || [];
        if (list.includes("pbs") && list.includes("profile")) return "personal bests and profile";
        return list.includes("profile") ? "profile" : "personal bests";
    }

    function storageProblemText(step, keys) {
        const what = whatText(keys);
        const lead = {
            "sign-in": "You're signed in, but this browser wouldn't store a safe copy of this device's own saved profile and personal bests, so your account's data wasn't loaded over them. This device's data is still shown, unchanged, and nothing from it was sent to your account.",
            "leave": `The account last signed in here has saved ${what} that can't be read, and this browser wouldn't store a copy of it, so it was left in place instead of being replaced. This page may still show that account's data, even after logging out. This device's own data is kept and hasn't been put back yet.`,
            "leave-restore": "This browser wouldn't store this device's own saved profile and personal bests again, so the account last signed in here was left in place instead of being replaced. This page may still show that account's data, even after logging out. This device's own data is kept and hasn't been put back yet.",
            "reload": `Your account's ${what} saved in this browser can't be read, and this browser wouldn't store a copy of it, so it wasn't replaced with your account's data. Your account itself wasn't changed.`,
            "sign-out": `Your account's ${what} saved in this browser can't be read, and this browser wouldn't store a copy of it, so you weren't logged out and nothing was replaced. You're still signed in, and your account's data is still shown only because you are.`,
            "sign-out-restore": "This browser wouldn't store this device's own saved profile and personal bests again, so you weren't logged out and nothing was replaced. You're still signed in, and your account's data is still shown only because you are.",
        }[step];
        if (step === "sign-out" || step === "sign-out-restore") {
            return {
                title: STORAGE_PROBLEM_TITLE[step],
                lead,
                next: "Nothing was deleted, but no backup was made either. To log out, free up browser storage (for example, remove data other websites have saved in this browser), then choose Log Out again. On a shared device, don't leave it signed in. Until then, you can save your own copy of anything that can't be read with \"Download a backup\" in its message on Personal Bests or Profile.",
            };
        }
        return {
            title: STORAGE_PROBLEM_TITLE[step],
            lead,
            next: "Nothing was deleted, but no backup was made either. To finish, free up browser storage (for example, remove data other websites have saved in this browser), then reload this page. Until then, you can save your own copy of anything that can't be read with \"Download a backup\" in its message on Personal Bests or Profile.",
        };
    }

    /* Shows (or updates) one message at the top of the page, under the main
       navigation, so it's seen whichever page is open. Text only. */
    function showStorageProblem(step, keys) {
        const text = storageProblemText(step, keys);
        try {
            let box = document.getElementById("savedDataStorageAlert");
            if (!box) {
                /* a div: a global section rule (profile-pb-cards.css) removes section margins */
                box = make("div", "saved-data-recovery saved-data-storage-alert");
                box.id = "savedDataStorageAlert";
                box.setAttribute("role", "alert");
                box.setAttribute("aria-labelledby", "savedDataStorageAlertTitle");
                const nav = document.querySelector("nav.site-nav");
                if (nav && nav.parentNode) nav.after(box);
                else document.body.prepend(box);
            }
            box.dataset.step = step;
            const title = make("h4", "saved-data-recovery-title", text.title);
            title.id = "savedDataStorageAlertTitle";
            box.replaceChildren(title, make("p", "", text.lead), make("p", "", text.next));
        } catch (err) {
            if (root.console) root.console.error("SWIMTICS:", text.title, err);
        }
        return text;
    }

    root.swimticsSavedData = Object.freeze({
        PROFILE_TEXT_FIELDS,
        pbsProblem,
        profileProblem,
        classifySaved,
        readSaved,
        needsRecovery,
        usablePbs,
        usableProfile,
        renderSavedDataRecovery,
        listUnreadableCopies,
        keepUnreadableCopies,
        preserveUnreadableCopies,
        writeSavedText,
        removeUnreadableCopy,
        renderAccountCopyRecovery,
        deviceDataNoteText,
        storageProblemText,
        showStorageProblem,
    });
})(typeof window !== "undefined" ? window : globalThis);
