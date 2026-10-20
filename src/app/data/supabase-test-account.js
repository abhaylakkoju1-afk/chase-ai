/* =========================================================
   SUPABASE TEST MODE — test-only accounts against swimtics-test
   Active only with ?supabase in the URL on a local development host or a
   login-protected Vercel preview URL of swimtics-web (see
   isSupabaseTestMode); everywhere else — swimtics.com and the public
   swimtics-web.vercel.app included — this file does nothing and makes no
   network request. Firebase (account.js) is untouched: without
   ?emulator or a databaseURL it already runs its "accounts not
   available" branch, and this module then takes over the sign-in modal
   and the Profile account card for the test project.

   Covers: sign up with email confirmation, log in / out, session kept
   across reloads, password reset, the user's own `profiles` row and
   personal bests, and a first-sign-in import of this device's data
   (protected by Row Level Security — supabase/sql/001_profiles.sql and
   002_personal_bests.sql). Photos are not synced.
   Uses only the project URL and publishable key: locally from the
   untracked src/app/data/supabase-config.local.js (npm run
   supabase:test-config); on a preview from /api/supabase-test-config,
   which reads Vercel Preview-only environment variables.
   ========================================================= */

import {
    isSupabaseTestMode, testModeHost, checkPublicConfig, redirectUrl, cleanedSearch,
    profileToRow, rowToProfile, friendlyError,
} from "./supabase-test-core.js";
import { planImport, pbKey } from "./user-data.js";

const SUPABASE_JS = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm";
const PREVIEW_CONFIG_URL = "/api/supabase-test-config";
const STORAGE_KEY = "swimtics-test-auth";

/* While a test account is signed in, the profile form and the PB list
   (localStorage "profile" and "pbs", read by loadProfile() and
   displayPBs()) show THAT account's data. This device's own profile and
   PBs are set aside under KEY_GUEST / KEY_GUEST_PBS and put back when the
   account signs out or another account signs in, so one person's data is
   never shown to another person or while signed out. KEY_ACTIVE marks
   that the working copy currently belongs to an account. Test mode only;
   the Firebase path (account.js) keeps its own, separate keys. */
const KEY_ACTIVE = "swimtics-test:activeUid";
const KEY_GUEST = "swimtics-test:guestProfile";
const KEY_GUEST_PBS = "swimtics-test:guestPbs";
const KEY_DEVICE = "swimtics-test:deviceId";
const KEY_DISMISSED = (uid, fingerprint) => `swimtics-test:importDismissed:${uid}:${fingerprint}`;

if (isSupabaseTestMode(location.hostname, location.search)) start();

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

function parseJson(raw, fallback) {
    try { const v = JSON.parse(raw); return v ?? fallback; } catch { return fallback; }
}

/* The PB list: localStorage plus index.html's in-memory `pbs` array (used
   by pb.js), kept in step the same way account.js does. */
function setWorkingPbs(list) {
    lsSet("pbs", JSON.stringify(list || []));
    if (typeof pbs !== "undefined" && Array.isArray(pbs)) {
        pbs.length = 0;
        pbs.push(...(list || []));
    }
    try { if (typeof displayPBs === "function") displayPBs(); } catch { /* ignore */ }
    try { if (typeof renderStrokeCards === "function") renderStrokeCards(); } catch { /* ignore */ }
}

/* Put this device's own profile and PBs back (or none, if it had none) and
   forget which account the working copy belonged to. Returns true if it did. */
function restoreDeviceData() {
    if (lsGet(KEY_ACTIVE) === null) return false;
    lsSet("profile", lsGet(KEY_GUEST));
    const devicePbs = lsGet(KEY_GUEST_PBS);
    lsSet(KEY_GUEST, null);
    lsSet(KEY_GUEST_PBS, null);
    lsSet(KEY_ACTIVE, null);
    setWorkingPbs(parseJson(devicePbs, []));
    if (devicePbs === null) lsSet("pbs", null);
    return true;
}

/* Set this device's own profile and PBs aside (only once, when no account
   was shown yet) and mark the working copy as this account's. */
function setAsideDeviceData(uid) {
    if (lsGet(KEY_ACTIVE) === null) {
        lsSet(KEY_GUEST, lsGet("profile"));
        lsSet(KEY_GUEST_PBS, lsGet("pbs"));
    }
    lsSet(KEY_ACTIVE, uid);
}

function showAccountProfile(uid, profile) {
    setAsideDeviceData(uid);
    lsSet("profile", JSON.stringify(profile || {}));
    redrawProfileForm();
}

function showAccountPbs(uid, list) {
    setAsideDeviceData(uid);
    setWorkingPbs(list);
}

/* This device's own (set-aside) data, the source of a first-sign-in import. */
function deviceData() {
    return { profile: parseJson(lsGet(KEY_GUEST), {}) || {}, pbs: parseJson(lsGet(KEY_GUEST_PBS), []) || [] };
}

function deviceId() {
    let id = lsGet(KEY_DEVICE);
    if (!id) {
        id = (crypto.randomUUID && crypto.randomUUID()) || `d${Date.now()}${Math.random().toString(16).slice(2)}`;
        lsSet(KEY_DEVICE, id);
    }
    return id;
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

/* For the "can't start" states: show why, and keep showing it when the
   profile page redraws the account card (loadProfile() calls this hook). */
function testNotice(text) {
    const draw = () => {
        const card = el("accountDetails");
        if (card) card.innerHTML = `<p class="account-note"><strong>Supabase test mode:</strong> ${escapeHtml(text)}</p>`;
    };
    window.updateProfileAccountSection = draw;
    draw();
}

/* The project URL and publishable key: { config } when found,
   { missing } when there is none, { bad } when it was refused. */
async function loadConfig() {
    if (testModeHost(location.hostname) === "local") {
        try {
            return { config: (await import("./supabase-config.local.js")).default };
        } catch {
            return { missing: "no local test configuration. Create .env.supabase.local and run npm run supabase:test-config." };
        }
    }
    let res;
    try {
        res = await fetch(PREVIEW_CONFIG_URL, { cache: "no-store", credentials: "same-origin" });
    } catch {
        return { missing: "couldn't reach this preview's test configuration." };
    }
    if (res.status === 404) {
        return { missing: "not configured for this preview. Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY for the Preview environment in Vercel." };
    }
    if (!res.ok) {
        let reason = "";
        try { reason = (await res.json()).error || ""; } catch { /* ignore */ }
        return { bad: reason || "this preview's test configuration was refused." };
    }
    try { return { config: await res.json() }; } catch { return { bad: "this preview's test configuration couldn't be read." }; }
}

async function start() {
    document.documentElement.dataset.supabaseTest = "starting";

    /* The page was closed while an account was shown: hide that account's
       profile straight away. It is shown again only if the same account is
       still signed in once the session has been checked. */
    if (restoreDeviceData()) redrawProfileForm();

    const loaded = await loadConfig();
    if (loaded.missing) {
        document.documentElement.dataset.supabaseTest = "no-config";
        testNotice(loaded.missing);
        return;
    }
    if (loaded.bad) {
        document.documentElement.dataset.supabaseTest = "bad-config";
        testNotice(loaded.bad);
        return;
    }
    const config = loaded.config;
    const check = checkPublicConfig(config);
    if (!check.ok) {
        document.documentElement.dataset.supabaseTest = "bad-config";
        testNotice(check.reason);
        return;
    }

    let createClient, pbModule;
    try {
        /* the PB module is loaded only once test mode is active, so other
           pages never fetch it; in parallel with the library */
        [{ createClient }, pbModule] = await Promise.all([import(SUPABASE_JS), import("./supabase-test-pbs.js")]);
    } catch {
        document.documentElement.dataset.supabaseTest = "no-library";
        testNotice("couldn't load the Supabase library. Check your connection.");
        return;
    }

    const supabase = createClient(config.url, config.publishableKey, {
        auth: { flowType: "pkce", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: STORAGE_KEY },
    });

    const { createTestPbRepository, rowsToLocalPbs, rowsToCloudPbs } = pbModule;
    const pbRepo = createTestPbRepository(supabase);
    let currentUser = null;
    let cloudRow = undefined;        // undefined = not loaded yet, null = no row
    let accountPbsLoaded = false;
    let lastSyncedKeys = [];         // the account's PB keys at the last load / sync
    let importPlan = null;           // this device's data not yet in the account, if offered
    let recovering = false;
    const here = () => ({ origin: location.origin, pathname: location.pathname });
    const authMessage = (t, k) => setStatus("authMessage", t, k);
    const val = (id) => (el(id)?.value || "").trim();

    /* ----- the set-new-password view (only exists in test mode) ----- */
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
    window.showSignup = () => { showView("signup"); authMessage(""); };
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && el("authModal")?.style.display === "flex") window.closeLoginModal();
    });
    window.swimticsAccountAction = () => {
        if (currentUser) window.showPage && window.showPage("profile");
        else window.openLoginModal();
    };

    /* ----- sign up / in / out / reset ----- */
    window.signupUser = async function () {
        const email = val("signupEmail");
        const password = el("signupPassword")?.value || "";
        if (!email) return authMessage("Please enter your email address.", "error");
        if (password.length < 8) return authMessage("Please choose a password of at least 8 characters.", "error");
        authMessage("Creating your test account…");
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

    window.logoutUser = async function () {
        await supabase.auth.signOut({ scope: "local" });
        if (currentUser) leaveAndReload();          // normally the SIGNED_OUT event already did
    };

    /* ----- the user's own profiles row ----- */
    const stillUser = (uid) => currentUser && currentUser.id === uid;

    async function loadRow(uid) {
        const { data, error } = await supabase.from("profiles").select("*").eq("user_id", uid).maybeSingle();
        if (!stillUser(uid)) return;                                   // signed out meanwhile
        cloudRow = error ? undefined : data;
        if (error) setStatus("profileSaveStatus", "Couldn't load your test account's profile.", "error");
        else showAccountProfile(uid, rowToProfile(data));
        render();
    }

    /* The account's PBs, then whether this device has data to offer for import. */
    async function loadPbsAndOffer(uid) {
        let rows;
        try {
            rows = await pbRepo.loadRows(uid);
        } catch {
            if (stillUser(uid)) setStatus("pbSyncStatus", "Couldn't load your test account's personal bests.", "error");
            return;
        }
        if (!stillUser(uid)) return;
        const list = rowsToLocalPbs(rows);
        lastSyncedKeys = list.map((pb) => pbKey(pb.event, pb.course));
        accountPbsLoaded = true;
        showAccountPbs(uid, list);
        importPlan = null;
        const local = deviceData();
        const plan = planImport(local, { profile: rowToProfile(cloudRow), pbs: rowsToCloudPbs(rows) });
        if (plan.hasLocalData && !plan.isEmpty && lsGet(KEY_DISMISSED(uid, plan.fingerprint)) === null) {
            let imported;
            try { imported = await pbRepo.importedFingerprints(uid); } catch { imported = new Set([plan.fingerprint]); }
            if (stillUser(uid) && !imported.has(plan.fingerprint)) importPlan = { uid, ...plan };
        }
        render();
    }

    async function loadAccount(uid) {
        await loadRow(uid);
        if (stillUser(uid) && cloudRow !== undefined) await loadPbsAndOffer(uid);
    }

    /* ----- personal bests: sync each change made in pb.js ----- */
    let pbChain = Promise.resolve();
    function syncPbsSoon() {
        if (!currentUser || !accountPbsLoaded) return;
        const uid = currentUser.id;
        pbChain = pbChain.then(async () => {
            if (!stillUser(uid)) return;
            const before = lsGet("pbs");
            setStatus("pbSyncStatus", "Saving to your test account…");
            try {
                const list = await pbRepo.syncPbs(uid, parseJson(before, []), lastSyncedKeys, deviceId());
                if (!stillUser(uid)) return;
                lastSyncedKeys = list.map((pb) => pbKey(pb.event, pb.course));
                if (lsGet("pbs") === before) setWorkingPbs(list);           // else a newer change follows
                else syncPbsSoon();
                setStatus("pbSyncStatus", "Saved to your test account.", "ok");
            } catch {
                if (stillUser(uid)) setStatus("pbSyncStatus", "Not saved to your test account — this change will be lost when you log out. Please try again.", "error");
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
    window.testImportDeviceData = async function () {
        const plan = importPlan;
        if (!plan || !stillUser(plan.uid)) return;
        importPlan = null;
        render();
        setStatus("profileSaveStatus", "Importing this device's data into your test account…");
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
            `Imported into your test account: ${plan.pbEntries} PB time(s) and ${Object.keys(plan.profileFill).length} profile field(s). This device's own copy is unchanged.`, "ok");
    };

    window.testDismissImport = function () {
        const plan = importPlan;
        if (!plan) return;
        lsSet(KEY_DISMISSED(plan.uid, plan.fingerprint), "1");
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
                <p>This device has data your test account doesn't have yet: ${parts.join("; ")}.
                Importing adds it to your account; nothing in your account is overwritten or removed, and this device keeps its own copy.</p>
                <button type="button" class="auth-link" onclick="testImportDeviceData()">Import into my test account</button>
                <button type="button" class="auth-link" onclick="testDismissImport()">Not now</button>
            </div>`;
    }

    const saveLocally = window.saveProfile;                            // account.js: save on this device
    window.saveProfile = async function () {
        const saved = typeof saveLocally === "function" ? saveLocally() : null;
        if (!currentUser || !saved) return saved;
        const uid = currentUser.id;
        setStatus("profileSaveStatus", "Saving to your test account…");
        const { data, error } = await supabase.from("profiles")
            .upsert(profileToRow(uid, saved), { onConflict: "user_id" })
            .select().single();
        if (!currentUser || currentUser.id !== uid) return saved;
        if (error) {
            setStatus("profileSaveStatus", "Not saved to your test account — this change will be lost when you log out. Please try again.", "error");
        } else {
            cloudRow = data;
            setStatus("profileSaveStatus", "Saved to your test account.", "ok");
            render();
        }
        return saved;
    };

    /* Leaving an account (logout, expiry, another account signing in, or a
       logout in another tab): put this device's own profile back and reload,
       so nothing of that account stays in memory or in the form. */
    let leaving = false;
    function leaveAndReload() {
        if (leaving) return;                    // logout and its SIGNED_OUT event both ask; reload once
        leaving = true;
        currentUser = null;
        cloudRow = undefined;
        restoreDeviceData();
        location.reload();
    }

    /* ----- the Profile account card ----- */
    function render() {
        document.querySelectorAll(".login-btn").forEach((b) => { b.hidden = !!currentUser; });
        document.querySelectorAll("button[onclick='logoutUser()']").forEach((b) => { b.hidden = !currentUser; });
        const nav = document.querySelector(".site-nav-signin");
        if (nav) nav.textContent = currentUser ? "Account" : "Sign In";
        const card = el("accountDetails");
        if (!card) return;
        const banner = `<p class="account-line warn"><strong>Supabase test mode</strong> — ${escapeHtml(new URL(config.url).hostname)}. Test accounts only; not the live site.</p>`;
        if (!currentUser) {
            card.innerHTML = `<div class="account-card">${banner}<p class="account-line">You're not signed in to a test account.</p></div>`;
            return;
        }
        let rowLine = "Loading your test account's profile…";
        if (cloudRow === null) rowLine = "No profile saved to your test account yet. Fill in the form and choose Save Profile.";
        else if (cloudRow) rowLine = `Showing your test account's profile (last saved ${escapeHtml(new Date(cloudRow.updated_at).toLocaleString())}).`;
        card.innerHTML = `
            <div class="account-card">
                ${banner}
                <p class="account-line">Signed in as <strong>${escapeHtml(currentUser.email || "")}</strong></p>
                <p class="account-line" id="testAccountRow">${rowLine}</p>
                ${importOffer()}
                <p class="account-line notice"><strong>You stay signed in on this browser until you log out.</strong> On a shared device, use Log Out below when you're done.</p>
            </div>`;
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
            showAccountProfile(user.id, {});                // nothing shown until this account's own data loads
            showAccountPbs(user.id, []);
            setTimeout(() => loadAccount(user.id), 0);      // not inside the callback
        }
        render();
        /* only the recovery link itself opens the set-new-password form (not
           the USER_UPDATED event that changing the password produces) */
        if (recoveryLink && user) setTimeout(() => window.openLoginModal(), 0);
    });

    /* another tab logged out, or signed in as someone else */
    window.addEventListener("storage", (e) => {
        if (e.key !== STORAGE_KEY || !currentUser) return;
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
    else if (hadCode && session && !recovering) setStatus("profileSaveStatus", "Email confirmed — you're signed in to your test account.", "ok");
    history.replaceState(null, "", location.pathname + cleanedSearch(location.search) + location.hash);
    if (recovering && session) window.openLoginModal();

    render();
    document.documentElement.dataset.supabaseTest = "ready";
    window.swimticsSupabaseTest = { ready: true, project: new URL(config.url).hostname };
}
