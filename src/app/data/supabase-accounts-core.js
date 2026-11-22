/* =========================================================
   SUPABASE ACCOUNTS — the shared account controller
   One controller for both Supabase environments (supabase-env.js):
   - test:       started by supabase-test-account.js (swimtics-test)
   - production: started by production-accounts.js (swimtics-production),
                 only when PRODUCTION_SUPABASE_ACCOUNTS is on — it is OFF.
   Loaded only once an entry point has decided an environment applies, so
   other pages never fetch it. Everything environment-specific — browser
   storage keys, the auth session key, wording, whether Sign Up is offered,
   where the config comes from — comes from the `env` passed in, and the
   config is checked against that environment's project (checkEnvConfig)
   before any request is made.

   Covers: sign up with email confirmation (only where sign-ups are open),
   log in / out, session kept across reloads, password reset, the user's
   own `profiles` row and personal bests, and a first-sign-in import of this
   device's data (protected by Row Level Security — supabase/sql/). Where
   env.photoSync is on (test only), the profile photo too, in a private
   bucket (supabase-test-photos.js); stroke-card photos are not synced.
   Uses only a project URL and a publishable key.
   Firebase (account.js) is untouched: without ?emulator or a databaseURL
   it runs its "accounts not available" branch, and this controller then
   takes over the sign-in modal and the Profile account card.
   ========================================================= */

import { redirectUrl, cleanedSearch, profileToRow, rowToProfile, friendlyError } from "./supabase-test-core.js";
import { checkEnvConfig, storageKeys } from "./supabase-env.js";
import { planImport, pbKey } from "./user-data.js";

const SUPABASE_JS = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm";

function el(id) { return document.getElementById(id); }

function lsGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function lsSet(key, value) {
    try {
        if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
        return true;
    } catch { return false; }
}

function redrawProfileForm() {
    if (typeof window.loadProfile === "function") { try { window.loadProfile(); } catch { /* ignore */ } }
}

/* The saved PBs ("pbs") and profile ("profile") are checked with
   saved-data-check.js (a classic script, loaded before any module): the
   value in `raw` if it is readable saved data of that kind, else `fallback`. */
function usable(key, raw, fallback) {
    const r = window.swimticsSavedData.classifySaved(key, raw);
    return r.status === "ok" ? r.value : fallback;
}

/* The PB list: localStorage plus index.html's in-memory `pbs` array (used
   by pb.js), kept in step the same way account.js does. With `raw`, that
   exact saved text is stored instead (null removes it) and `list` is only
   the in-memory copy. */
function setWorkingPbs(list, raw) {
    lsSet("pbs", raw !== undefined ? raw : JSON.stringify(list || []));
    if (typeof pbs !== "undefined" && Array.isArray(pbs)) {
        pbs.length = 0;
        pbs.push(...(list || []));
    }
    try { if (typeof displayPBs === "function") displayPBs(); } catch { /* ignore */ }
    try { if (typeof renderStrokeCards === "function") renderStrokeCards(); } catch { /* ignore */ }
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
}

function setStatus(id, text, kind = "info") {
    const node = el(id);
    if (!node) return;
    node.textContent = text;
    node.dataset.kind = text ? kind : "";
}

/* While an account is signed in, the profile form and the PB list
   (localStorage "profile" and "pbs", read by loadProfile() and
   displayPBs()) show THAT account's data. This device's own profile and
   PBs are set aside under keys.guest / keys.guestPbs and put back when the
   account signs out or another account signs in, so one person's data is
   never shown to another person or while signed out. keys.active marks
   that the working copy currently belongs to an account. Each environment
   has its own keys; the Firebase path (account.js) keeps its own too.

   The working copy is replaced only once the text it holds has been
   preserved (set aside, or kept as an unreadable account copy), each
   written and read back exactly. If browser storage refuses, the step
   stops, nothing is replaced, and the page says what to do next
   (saved-data-check.js showStorageProblem); the functions below then
   return false. */
function deviceDataStore(keys) {
    const saved = window.swimticsSavedData;

    /* Working keys that still hold this device's own data although it has
       just been set aside (the profile and the PBs are replaced one after
       the other): never kept as the account's copy. */
    const stillDeviceData = new Set();

    /* Before an account's working copy is replaced: if its profile or PBs
       (`which`) can't be read, keep the exact text for that account only
       (saved-data-check.js; shown when that account is signed in again).
       false if browser storage refused a copy (the page says so, as `step`). */
    function keepAccountCopy(which, step) {
        const active = lsGet(keys.active);
        const owned = which.filter((key) => !stillDeviceData.has(key));
        if (active === null || !owned.length) return true;
        const { failed } = saved.preserveUnreadableCopies(keys.unreadableCopy(active), owned);
        if (!failed.length) return true;
        saved.showStorageProblem(step, failed);
        return false;
    }

    /* Put this device's own profile and PBs back (or none, if it had none)
       and forget which account the working copy belonged to. Returns true if
       it did; false if there was no account, or if browser storage refused
       a write (then the account stays and this device's data stays set aside).
       `signingOut`: for Log Out, which then doesn't sign out (the message says so). */
    function restoreDeviceData(signingOut = false) {
        if (lsGet(keys.active) === null) return false;
        if (!keepAccountCopy(["pbs", "profile"], signingOut ? "sign-out" : "leave")) return false;
        const deviceProfile = lsGet(keys.guest);
        const devicePbs = lsGet(keys.guestPbs);
        /* the set-aside copies are removed only once both are back */
        const before = { profile: lsGet("profile"), pbs: lsGet("pbs") };
        if (!saved.writeSavedText("profile", deviceProfile) || !saved.writeSavedText("pbs", devicePbs)) {
            saved.writeSavedText("profile", before.profile);
            saved.writeSavedText("pbs", before.pbs);
            saved.showStorageProblem(signingOut ? "sign-out-restore" : "leave-restore");
            return false;
        }
        stillDeviceData.clear();
        lsSet(keys.guest, null);
        lsSet(keys.guestPbs, null);
        lsSet(keys.active, null);
        /* the saved text goes back exactly as it was set aside (or is
           removed, if there was none): PBs that can't be read are kept, and
           the Wall of Records shows its recovery message for them */
        setWorkingPbs(usable("pbs", devicePbs, []), devicePbs);
        return true;
    }

    /* Before Log Out signs out: put this device's data back if an account's
       is in the working copy. false if browser storage refused (nothing replaced). */
    function restoreBeforeSignOut() {
        return lsGet(keys.active) === null || restoreDeviceData(true);
    }

    /* Set this device's own profile and PBs aside (only once, when no
       account was shown yet) and mark the working copy as this account's.
       false if browser storage refused (each write is read back). */
    function setAsideDeviceData(uid) {
        if (lsGet(keys.active) === null) {
            if (!saved.writeSavedText(keys.guest, lsGet("profile")) || !saved.writeSavedText(keys.guestPbs, lsGet("pbs"))) return false;
            stillDeviceData.add("profile");
            stillDeviceData.add("pbs");
        }
        return saved.writeSavedText(keys.active, uid);
    }

    /* Before the working copy shows account `uid`: keep it (if it is an
       account's and can't be read), set this device's data aside, mark it.
       false, with nothing replaced and the page saying why, if storage refused. */
    function makeRoomFor(uid, which) {
        /* another account's working copy: keep both of its values for THAT
           account now, before the mark moves to `uid` */
        const active = lsGet(keys.active);
        const own = active === null || active === uid;
        if (!keepAccountCopy(own ? which : ["pbs", "profile"], active === uid ? "reload" : "leave")) return false;
        if (setAsideDeviceData(uid)) return true;
        saved.showStorageProblem("sign-in");
        return false;
    }

    function showAccountProfile(uid, profile) {
        if (!makeRoomFor(uid, ["profile"])) return false;
        lsSet("profile", JSON.stringify(profile || {}));
        stillDeviceData.delete("profile");
        redrawProfileForm();
        return true;
    }

    function showAccountPbs(uid, list) {
        if (!makeRoomFor(uid, ["pbs"])) return false;
        setWorkingPbs(list);
        stillDeviceData.delete("pbs");
        return true;
    }

    /* This device's own (set-aside) data, the source of a first-sign-in import. */
    /* (a profile or PB list that can't be read counts as empty here, so it
       is never offered for import) */
    function deviceData() {
        return { profile: usable("profile", lsGet(keys.guest), {}), pbs: usable("pbs", lsGet(keys.guestPbs), []) };
    }

    function deviceId() {
        let id = lsGet(keys.device);
        if (!id) {
            id = (crypto.randomUUID && crypto.randomUUID()) || `d${Date.now()}${Math.random().toString(16).slice(2)}`;
            lsSet(keys.device, id);
        }
        return id;
    }

    /* which of this device's own set-aside profile / PBs can't be read */
    function deviceUnreadable() {
        if (lsGet(keys.active) === null) return [];
        return [["pbs", keys.guestPbs], ["profile", keys.guest]]
            .filter(([key, guestKey]) => window.swimticsSavedData.needsRecovery(window.swimticsSavedData.classifySaved(key, lsGet(guestKey))))
            .map(([key]) => key);
    }

    return { restoreDeviceData, restoreBeforeSignOut, showAccountProfile, showAccountPbs, deviceData, deviceId, deviceUnreadable };
}

/* Put this device's own data back if an account of `env` was still shown
   (used by an entry point whose environment has been switched off). */
export function restoreDeviceDataFor(env) {
    if (deviceDataStore(storageKeys(env)).restoreDeviceData()) redrawProfileForm();
}

/* env: an ENVIRONMENTS entry (supabase-env.js) plus
     loadConfig()  -> { config } | { missing } | { bad }
     signupsOpen   -> whether Sign Up is offered */
export async function startSupabaseAccounts(env) {
    if (window.__swimticsSupabaseEnv) return;         // one environment per page, ever
    window.__swimticsSupabaseEnv = env.name;

    const root = document.documentElement;
    const state = (s) => { root.dataset[env.stateAttr] = s; };
    const A = env.accountLabel;
    const keys = storageKeys(env);
    const store = deviceDataStore(keys);

    /* For the "can't start" states: show why, and keep showing it when the
       profile page redraws the account card (loadProfile() calls this hook). */
    function notice(text) {
        const draw = () => {
            const card = el("accountDetails");
            if (card) card.innerHTML = `<p class="account-note"><strong>${escapeHtml(env.noticeLabel)}:</strong> ${escapeHtml(text)}</p>`;
        };
        window.updateProfileAccountSection = draw;
        draw();
    }

    state("starting");

    /* The page was closed while an account was shown: hide that account's
       profile straight away. It is shown again only if the same account is
       still signed in once the session has been checked. */
    if (store.restoreDeviceData()) redrawProfileForm();

    const loaded = await env.loadConfig();
    if (loaded.missing) {
        state("no-config");
        notice(loaded.missing);
        return;
    }
    if (loaded.bad) {
        state("bad-config");
        notice(loaded.bad);
        return;
    }
    const config = loaded.config || {};
    const check = checkEnvConfig(env.name, config);
    if (!check.ok) {
        state("bad-config");
        notice(check.reason);
        return;
    }

    let createClient, pbModule, photoModule = null;
    try {
        /* the PB (and, where enabled, photo) modules are loaded only once
           an environment is active, so other pages never fetch them; in
           parallel with the library */
        [{ createClient }, pbModule, photoModule] = await Promise.all([
            import(SUPABASE_JS), import("./supabase-test-pbs.js"),
            env.photoSync === true ? import("./supabase-test-photos.js") : null,
        ]);
    } catch {
        state("no-library");
        notice("couldn't load the Supabase library. Check your connection.");
        return;
    }

    const supabase = createClient(config.url, config.publishableKey, {
        auth: { flowType: "pkce", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: env.storageKey },
    });

    const { createTestPbRepository, rowsToLocalPbs, rowsToCloudPbs } = pbModule;
    const pbRepo = createTestPbRepository(supabase);
    const photoRepo = photoModule ? photoModule.createTestPhotoRepository(supabase) : null;
    let currentUser = null;
    let accountPhoto = undefined;    // with photoSync: undefined = not loaded, null = none, else an in-memory blob: URL
    let cloudRow = undefined;        // undefined = not loaded yet, null = no row
    let accountPbsLoaded = false;
    let lastSyncedKeys = [];         // the account's PB keys at the last load / sync
    let importPlan = null;           // this device's data not yet in the account, if offered
    let recovering = false;
    let held = false;                // browser storage refused a write showing the account needs: not loaded

    /* the account isn't shown in the working copy (the page says why) */
    function holdAccount() {
        held = true;
        accountPbsLoaded = false;
        setPbsLoading(false);
        render();
    }
    const here = () => ({ origin: location.origin, pathname: location.pathname });
    const authMessage = (t, k) => setStatus("authMessage", t, k);
    const val = (id) => (el(id)?.value || "").trim();
    const SIGNUPS_CLOSED = "New accounts aren't open yet — Swimtics accounts are invite-only for now.";

    /* ----- the set-new-password view (only exists while this controller runs) ----- */
    const box = document.querySelector("#authModal .auth-box");
    if (box && !el("newPasswordView")) {
        const view = document.createElement("div");
        view.id = "newPasswordView";
        view.style.display = "none";
        view.innerHTML = `
            <h2>Set a new password</h2>
            <input type="password" id="newPassword" placeholder="New password (at least 8 characters)" autocomplete="new-password" aria-label="New password">
            <button type="button" id="setNewPasswordButton">Set new password</button>`;
        box.insertBefore(view, el("authMessage"));
        el("setNewPasswordButton").addEventListener("click", () => window.setNewPassword());
    }

    /* sign-ups closed: no way into the sign-up view */
    if (!env.signupsOpen) {
        document.querySelectorAll("#loginView button[onclick='showSignup()']").forEach((b) => {
            const line = b.closest(".auth-switch");
            if (line) line.hidden = true; else b.hidden = true;
        });
    }

    /* ----- modal ----- */
    let lastFocus = null;
    function showView(name) {
        for (const [id, key] of [["loginView", "login"], ["signupView", "signup"], ["newPasswordView", "recover"]]) {
            const v = el(id);
            if (v) v.style.display = key === name ? "" : "none";
        }
    }
    window.openLoginModal = function () {
        lastFocus = document.activeElement;
        const m = el("authModal");
        if (!m) return;
        m.style.display = "flex";
        authMessage("");
        showView(recovering ? "recover" : "login");
        setTimeout(() => el(recovering ? "newPassword" : "authEmail")?.focus(), 0);
    };
    window.closeLoginModal = function () {
        const m = el("authModal");
        if (m) m.style.display = "none";
        for (const id of ["authPassword", "signupPassword", "newPassword"]) if (el(id)) el(id).value = "";
        if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
    };
    window.showLogin = () => { showView("login"); authMessage(""); };
    window.showSignup = () => {
        if (!env.signupsOpen) { showView("login"); return authMessage(SIGNUPS_CLOSED, "error"); }
        showView("signup"); authMessage("");
    };
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && el("authModal")?.style.display === "flex") window.closeLoginModal();
    });
    window.swimticsAccountAction = () => {
        if (currentUser) window.showPage && window.showPage("profile");
        else window.openLoginModal();
    };

    /* ----- sign up / in / out / reset ----- */
    window.signupUser = async function () {
        if (!env.signupsOpen) return authMessage(SIGNUPS_CLOSED, "error");
        const email = val("signupEmail");
        const password = el("signupPassword")?.value || "";
        if (!email) return authMessage("Please enter your email address.", "error");
        if (password.length < 8) return authMessage("Please choose a password of at least 8 characters.", "error");
        authMessage(`Creating your ${A}…`);
        const { data, error } = await supabase.auth.signUp({
            email, password,
            options: { emailRedirectTo: redirectUrl(here().origin, here().pathname) },
        });
        if (error) return authMessage(friendlyError(error), "error");
        if (el("signupPassword")) el("signupPassword").value = "";
        if (data && data.session) {
            window.closeLoginModal();
        } else {
            showView("login");
            authMessage("Check your email for a confirmation link, then log in. (If this email already has an account, log in instead.)", "ok");
        }
    };

    window.loginUser = async function () {
        const email = val("authEmail");
        const password = el("authPassword")?.value || "";
        if (!email || !password) return authMessage("Please enter your email and password.", "error");
        authMessage("Logging in…");
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (el("authPassword")) el("authPassword").value = "";
        if (error) return authMessage(friendlyError(error), "error");
        window.closeLoginModal();
    };

    window.resetPassword = async function () {
        const email = val("authEmail");
        if (!email) return authMessage("Enter your email above, then choose Forgot password.", "error");
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
            redirectTo: redirectUrl(here().origin, here().pathname, { reset: true }),
        });
        if (error && /rate limit|fetch|network/i.test(String(error.message))) return authMessage(friendlyError(error), "error");
        authMessage("If an account exists for that email, a password-reset link has been sent. Open it in this browser.", "ok");
    };

    window.setNewPassword = async function () {
        const password = el("newPassword")?.value || "";
        if (password.length < 8) return authMessage("Please choose a password of at least 8 characters.", "error");
        const { error } = await supabase.auth.updateUser({ password });
        if (el("newPassword")) el("newPassword").value = "";
        if (error) return authMessage(friendlyError(error), "error");
        recovering = false;
        showView("login");
        window.closeLoginModal();
        setStatus("profileSaveStatus", "Your password has been changed.", "ok");
    };

    /* This device's data is put back before signing out: if browser storage
       refuses what that needs, the user stays signed in with the account's
       data in place (never shown signed out) and the page says why. */
    window.logoutUser = async function () {
        if (leaving) return;
        if (!currentUser) {
            await supabase.auth.signOut({ scope: "local" });
            return;
        }
        if (!store.restoreBeforeSignOut()) {
            render();
            return;
        }
        stopShowingAccount();                        // the SIGNED_OUT event then has nothing to leave
        await supabase.auth.signOut({ scope: "local" });
        location.reload();
    };

    /* ----- the user's own profiles row ----- */
    const stillUser = (uid) => currentUser && currentUser.id === uid;

    async function loadRow(uid) {
        const { data, error } = await supabase.from("profiles").select("*").eq("user_id", uid).maybeSingle();
        if (!stillUser(uid)) return;                                   // signed out meanwhile
        cloudRow = error ? undefined : data;
        if (error) setStatus("profileSaveStatus", `Couldn't load your ${A}'s profile.`, "error");
        else if (!store.showAccountProfile(uid, rowToProfile(data))) return holdAccount();
        render();
    }

    /* <html data-pbs-loading> while an account's PBs are on their way: the
       working list is empty then, but "no personal bests" would be wrong
       (styles/polish.css hides the empty-state line meanwhile). */
    function setPbsLoading(on) {
        if (on) root.dataset.pbsLoading = "true";
        else delete root.dataset.pbsLoading;
    }

    /* The account's PBs, then whether this device has data to offer for import. */
    async function loadPbsAndOffer(uid) {
        let rows;
        try {
            rows = await pbRepo.loadRows(uid);
        } catch {
            if (stillUser(uid)) {
                setPbsLoading(false);
                setStatus("pbSyncStatus", `Couldn't load your ${A}'s personal bests.`, "error");
            }
            return;
        }
        if (!stillUser(uid)) return;
        const list = rowsToLocalPbs(rows);
        if (!store.showAccountPbs(uid, list)) return holdAccount();
        lastSyncedKeys = list.map((pb) => pbKey(pb.event, pb.course));
        accountPbsLoaded = true;
        setPbsLoading(false);
        importPlan = null;
        const local = store.deviceData();
        const plan = planImport(local, { profile: rowToProfile(cloudRow), pbs: rowsToCloudPbs(rows) });
        if (plan.hasLocalData && !plan.isEmpty && lsGet(keys.dismissed(uid, plan.fingerprint)) === null) {
            let imported;
            try { imported = await pbRepo.importedFingerprints(uid); } catch { imported = new Set([plan.fingerprint]); }
            if (stillUser(uid) && !imported.has(plan.fingerprint)) importPlan = { uid, ...plan };
        }
        render();
    }

    async function loadAccount(uid) {
        if (held) return;
        await loadRow(uid);
        if (held) return;
        if (stillUser(uid) && cloudRow !== undefined) await Promise.all([loadPbsAndOffer(uid), loadPhoto(uid)]);
        else if (stillUser(uid)) setPbsLoading(false);              // the profile failed, so the PBs aren't loaded either
        refreshSavedDataNotes();
    }

    /* For Profile's saved-data notes (profile.js renderAccountSavedDataNotes):
       only while this account's own data is shown. */
    window.swimticsAccountSavedData = {
        status() {
            if (!currentUser || !accountPbsLoaded || lsGet(keys.active) !== currentUser.id) return null;
            return {
                copies: window.swimticsSavedData.listUnreadableCopies(keys.unreadableCopy(currentUser.id)),
                deviceUnreadable: store.deviceUnreadable(),
            };
        },
    };
    function refreshSavedDataNotes() {
        try {
            if (typeof window.renderProfileDataRecovery === "function") {
                window.renderProfileDataRecovery(window.swimticsSavedData.readSaved("profile"));
            }
        } catch { /* ignore */ }
    }

    /* ----- profile photo (only where env.photoSync): kept in the account,
       shown from memory, never written to this device ----- */
    let photoVersion = 0;            // bumped on every change, so a slower earlier load can't overwrite a newer photo
    let photoLoadFailed = false;
    async function loadPhoto(uid) {
        if (!photoRepo || accountPhoto !== undefined) return;
        const version = photoVersion;
        let url;
        try {
            url = await photoRepo.load(uid);
        } catch {
            if (stillUser(uid) && version === photoVersion) {
                photoLoadFailed = true;
                setStatus("profileSaveStatus", `Couldn't load your ${A}'s photo.`, "error");
                render();
            }
            return;
        }
        if (!stillUser(uid) || version !== photoVersion) { if (url) URL.revokeObjectURL(url); return; }
        setAccountPhoto(url);
    }

    function setAccountPhoto(url) {
        if (accountPhoto && accountPhoto !== url) URL.revokeObjectURL(accountPhoto);
        accountPhoto = url;
        photoVersion += 1;
        photoLoadFailed = false;
        render();
    }

    /* the overview card's image while signed in: the account's photo or none
       (loadProfile() has drawn the working copy, which holds no photo) */
    function showAccountPhoto() {
        if (!photoRepo || !currentUser) return;
        const box = el("profileImageBox");
        if (box) box.innerHTML = accountPhoto ? `<img src="${accountPhoto}" alt="Profile">` : "Upload Image";
    }

    async function saveAccountPhoto(uid, file) {
        if (!file || !stillUser(uid)) return;
        setStatus("profileSaveStatus", `Saving your photo to your ${A}…`);
        let photo;
        try {
            photo = await photoModule.processPhoto(file);          // resized, re-encoded: no EXIF / location
        } catch (e) {
            if (stillUser(uid)) setStatus("profileSaveStatus", e.message, "error");
            return;
        }
        try {
            await photoRepo.upload(uid, photo.bytes);
        } catch {
            if (stillUser(uid)) setStatus("profileSaveStatus", `Your photo wasn't saved to your ${A}. Please try again.`, "error");
            return;
        }
        if (!stillUser(uid)) return;
        setAccountPhoto(URL.createObjectURL(new Blob([photo.bytes], { type: "image/jpeg" })));
        setStatus("profileSaveStatus", `Photo saved to your ${A}. It isn't kept on this device after you log out.`, "ok");
    }

    if (photoRepo) {
        const uploadLocally = window.uploadProfileImage;          // profile.js: signed out, the photo stays on this device
        window.uploadProfileImage = function () {
            if (!currentUser) return typeof uploadLocally === "function" ? uploadLocally() : undefined;
            const uid = currentUser.id;
            const input = document.createElement("input");
            input.type = "file";
            input.accept = photoModule.PHOTO_SOURCE_TYPES.join(",");
            input.onchange = () => saveAccountPhoto(uid, input.files && input.files[0]);
            input.click();
        };
        window.removeAccountPhoto = async function () {
            if (!currentUser || !accountPhoto) return;
            const uid = currentUser.id;
            try {
                await photoRepo.remove(uid);
            } catch {
                if (stillUser(uid)) setStatus("profileSaveStatus", `Couldn't remove the photo from your ${A}. Please try again.`, "error");
                return;
            }
            if (!stillUser(uid)) return;
            setAccountPhoto(null);
            setStatus("profileSaveStatus", `Photo removed from your ${A}.`, "ok");
        };
    }

    /* ----- personal bests: sync each change made in pb.js ----- */
    let pbChain = Promise.resolve();
    function syncPbsSoon() {
        if (!currentUser || !accountPbsLoaded) return;
        const uid = currentUser.id;
        pbChain = pbChain.then(async () => {
            if (!stillUser(uid)) return;
            const before = lsGet("pbs");
            /* A PB list that can't be read (or is missing) would be sent as an
               empty one, and the sync removes every account PB missing from
               the list: send nothing instead. This also covers a Save PB or
               Delete that pb.js refused, which the wrapper below still follows
               with a sync. */
            const current = window.swimticsSavedData.classifySaved("pbs", before);
            if (current.status !== "ok") {
                setStatus("pbSyncStatus", `Not saved to your ${A}: the personal bests saved on this device can't be read, so nothing was sent.`, "error");
                return;
            }
            setStatus("pbSyncStatus", `Saving to your ${A}…`);
            try {
                const list = await pbRepo.syncPbs(uid, current.value, lastSyncedKeys, store.deviceId());
                if (!stillUser(uid)) return;
                lastSyncedKeys = list.map((pb) => pbKey(pb.event, pb.course));
                if (lsGet("pbs") === before) setWorkingPbs(list);           // else a newer change follows
                else syncPbsSoon();
                setStatus("pbSyncStatus", `Saved to your ${A}.`, "ok");
            } catch {
                if (stillUser(uid)) setStatus("pbSyncStatus", `Not saved to your ${A} — this change will be lost when you log out. Please try again.`, "error");
            }
        });
    }
    for (const name of ["savePB", "deletePB"]) {
        const original = window[name];
        if (typeof original === "function") {
            window[name] = function (...args) {
                const result = original.apply(this, args);
                syncPbsSoon();
                return result;
            };
        }
    }

    /* ----- first-sign-in import of this device's data ----- */
    window[env.importAction] = async function () {
        const plan = importPlan;
        if (!plan || !stillUser(plan.uid)) return;
        importPlan = null;
        render();
        setStatus("profileSaveStatus", `Importing this device's data into your ${A}…`);
        try {
            await pbRepo.importLocal(plan.uid, plan, rowToProfile(cloudRow));
        } catch {
            if (stillUser(plan.uid)) setStatus("profileSaveStatus", "Couldn't import this device's data. Nothing was changed on this device; please try again.", "error");
            importPlan = plan;
            render();
            return;
        }
        if (!stillUser(plan.uid)) return;
        await loadAccount(plan.uid);
        setStatus("profileSaveStatus",
            `Imported into your ${A}: ${plan.pbEntries} PB time(s) and ${Object.keys(plan.profileFill).length} profile field(s). This device's own copy is unchanged.`, "ok");
    };

    window[env.dismissAction] = function () {
        const plan = importPlan;
        if (!plan) return;
        lsSet(keys.dismissed(plan.uid, plan.fingerprint), "1");
        importPlan = null;
        render();
    };

    function importOffer() {
        if (!importPlan || !stillUser(importPlan.uid)) return "";
        const events = importPlan.pbs.filter((p) => p.newEntries > 0).map((p) => `${p.event} (${p.course})`);
        const fields = Object.keys(importPlan.profileFill);
        const parts = [];
        if (importPlan.pbEntries) parts.push(`${importPlan.pbEntries} PB time(s) for ${events.map(escapeHtml).join(", ")}`);
        if (fields.length) parts.push(`${fields.length} profile field(s) that are empty in your account (${fields.map(escapeHtml).join(", ")})`);
        return `
            <div class="account-line" id="testImportOffer">
                <p>This device has data your ${A} doesn't have yet: ${parts.join("; ")}.
                Importing adds it to your account; nothing in your account is overwritten or removed, and this device keeps its own copy.</p>
                <button type="button" class="auth-link" onclick="${env.importAction}()">Import into my ${A}</button>
                <button type="button" class="auth-link" onclick="${env.dismissAction}()">Not now</button>
            </div>`;
    }

    const saveLocally = window.saveProfile;                            // account.js: save on this device
    window.saveProfile = async function () {
        const saved = typeof saveLocally === "function" ? saveLocally() : null;
        if (!currentUser || !saved) return saved;
        if (held) {
            /* the form shows this device's data, not the account's: never sent */
            setStatus("profileSaveStatus", `Saved on this device only. Your ${A} wasn't loaded into this page (see the message at the top of the page), so nothing was sent to it.`, "error");
            return saved;
        }
        const uid = currentUser.id;
        setStatus("profileSaveStatus", `Saving to your ${A}…`);
        const { data, error } = await supabase.from("profiles")
            .upsert(profileToRow(uid, saved), { onConflict: "user_id" })
            .select().single();
        if (!currentUser || currentUser.id !== uid) return saved;
        if (error) {
            setStatus("profileSaveStatus", `Not saved to your ${A} — this change will be lost when you log out. Please try again.`, "error");
        } else {
            cloudRow = data;
            setStatus("profileSaveStatus", `Saved to your ${A}.`, "ok");
            render();
        }
        return saved;
    };

    /* Leaving an account (logout, expiry, another account signing in, or a
       logout in another tab): put this device's own profile back and reload,
       so nothing of that account stays in memory or in the form. */
    let leaving = false;
    function stopShowingAccount() {
        leaving = true;
        currentUser = null;
        cloudRow = undefined;
        if (accountPhoto) URL.revokeObjectURL(accountPhoto);
        accountPhoto = null;
    }
    function leaveAndReload() {
        if (leaving) return;                    // logout and its SIGNED_OUT event both ask; reload once
        stopShowingAccount();
        store.restoreDeviceData();
        location.reload();
    }

    /* ----- the Profile account card ----- */
    function render() {
        document.querySelectorAll(".login-btn").forEach((b) => { b.hidden = !!currentUser; });
        document.querySelectorAll("button[onclick='logoutUser()']").forEach((b) => { b.hidden = !currentUser; });
        const nav = document.querySelector(".site-nav-signin");
        if (nav) nav.textContent = currentUser ? "Account" : "Sign In";
        showAccountPhoto();
        const card = el("accountDetails");
        if (!card) return;
        const banner = env.showProjectBanner
            ? `<p class="account-line warn"><strong>Supabase test mode</strong> — ${escapeHtml(new URL(config.url).hostname)}. Test accounts only; not the live site.</p>`
            : "";
        if (!currentUser) {
            card.innerHTML = `<div class="account-card">${banner}<p class="account-line">${escapeHtml(env.notSignedIn)}</p></div>`;
            return;
        }
        let rowLine = `Loading your ${A}'s profile…`;
        if (held) rowLine = `Your ${A} wasn't loaded into this page because browser storage is full or blocked. See the message at the top of the page.`;
        else if (cloudRow === null) rowLine = `No profile saved to your ${A} yet. Fill in the form and choose Save Profile.`;
        else if (cloudRow) rowLine = `Showing your ${A}'s profile (last saved ${escapeHtml(new Date(cloudRow.updated_at).toLocaleString())}).`;
        card.innerHTML = `
            <div class="account-card">
                ${banner}
                <p class="account-line">Signed in as <strong>${escapeHtml(currentUser.email || "")}</strong></p>
                <p class="account-line" id="testAccountRow">${rowLine}</p>
                ${photoLine()}
                ${importOffer()}
                <p class="account-line notice"><strong>You stay signed in on this browser until you log out.</strong> On a shared device, use Log Out below when you're done.</p>
            </div>`;
    }

    function photoLine() {
        if (!photoRepo) return "";
        if (accountPhoto === undefined && photoLoadFailed) return `<p class="account-line" id="testAccountPhoto">Your ${A}'s photo couldn't be loaded. Reload the page to try again.</p>`;
        if (accountPhoto === undefined) return `<p class="account-line" id="testAccountPhoto">Loading your ${A}'s photo…</p>`;
        if (!accountPhoto) {
            return `<p class="account-line" id="testAccountPhoto">No photo in your ${A}. Choose the image on the overview card to add one; it's resized and its location / camera details are removed before upload.</p>`;
        }
        return `<p class="account-line" id="testAccountPhoto">Your photo is saved privately in your ${A} and isn't kept on this device after you log out.
            <button type="button" class="auth-link" onclick="removeAccountPhoto()">Remove photo</button></p>`;
    }

    /* loadProfile() (profile.js) redraws the account card through this hook */
    window.updateProfileAccountSection = render;

    /* ----- session events ----- */
    supabase.auth.onAuthStateChange((event, session) => {
        const user = session ? session.user : null;
        const recoveryLink = event === "PASSWORD_RECOVERY";
        if (recoveryLink) recovering = true;
        const changed = (user && user.id) !== (currentUser && currentUser.id);
        if (currentUser && changed) {                       // signed out, expired, or a different account
            setTimeout(leaveAndReload, 0);
            return;
        }
        currentUser = user;
        if (user && changed) {
            cloudRow = undefined;
            accountPbsLoaded = false;
            importPlan = null;
            accountPhoto = undefined;
            photoLoadFailed = false;
            held = false;
            /* nothing shown until this account's own data loads */
            if (store.showAccountProfile(user.id, {}) && store.showAccountPbs(user.id, [])) {
                setPbsLoading(true);
                setTimeout(() => loadAccount(user.id), 0);  // not inside the callback
            } else {
                held = true;
            }
        }
        render();
        /* only the recovery link itself opens the set-new-password form (not
           the USER_UPDATED event that changing the password produces) */
        if (recoveryLink && user) setTimeout(() => window.openLoginModal(), 0);
    });

    /* another tab logged out, or signed in as someone else */
    window.addEventListener("storage", (e) => {
        if (e.key !== env.storageKey || !currentUser) return;
        let otherId = null;
        try { otherId = e.newValue ? (JSON.parse(e.newValue)?.user?.id || null) : null; } catch { otherId = null; }
        if (otherId !== currentUser.id) leaveAndReload();
    });

    /* finish any confirmation / reset link, then tidy the address bar */
    const params = new URLSearchParams(location.search);
    const hadCode = params.has("code");
    const linkError = params.get("error_description");
    if (params.has("reset")) recovering = true;
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) recovering = false;
    if (linkError) setStatus("profileSaveStatus", `That link didn't work: ${linkError}`, "error");
    else if (hadCode && !session) setStatus("profileSaveStatus", "If you just confirmed your email, you can log in now.", "ok");
    else if (hadCode && session && !recovering) setStatus("profileSaveStatus", `Email confirmed — you're signed in to your ${A}.`, "ok");
    history.replaceState(null, "", location.pathname + cleanedSearch(location.search) + location.hash);
    if (recovering && session) window.openLoginModal();

    render();
    state("ready");
    window[env.debugGlobal] = { ready: true, project: new URL(config.url).hostname };
}
