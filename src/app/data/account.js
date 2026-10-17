/* =========================================================
   ACCOUNT — sign up / in / out, email verification, password
   reset, and Profile + PB sync for the signed-in Firebase UID.
   ---------------------------------------------------------
   Working copy: the existing UI keeps using localStorage "profile",
   "pbs" and "strokeData" (and index.html's in-memory `pbs` /
   `strokeData`). This file decides WHOSE data that working copy holds:
     signed out -> this device's own data (as before)
     signed in  -> that account's data, loaded from the database
   This device's own data is snapshotted on sign-in and restored on
   sign-out, so it is never overwritten or lost.

   Shared-browser rules enforced here:
   - Every account operation is tied to the uid AND the auth "session
     generation" it started in, and re-checks both after each await.
     Results from an old session are never shown or written locally.
   - Unsynced changes are backed up per uid BEFORE the network call, from
     the data being saved — never re-read later — so they can only ever be
     replayed into the same account.
   - Leaving an account (sign-out, switch, expired session) restores this
     device's data and reloads the page, clearing anything still in memory
     (analysis results, race reports, War Room output, form fields).
   - Photos are local-only in this stage; each account's photos are kept
     on this device under that uid and shown only while it is signed in.
   ========================================================= */

import {
    PROFILE_FIELDS, sanitizeProfile, planImport, cloudPbsToLocal,
    createUserDataRepository, pbKey,
} from "./user-data.js";

const fbx = window.swimticsFirebase;

const KEY = {
    active: "swimtics:activeUid",                       // working copy belongs to this uid
    guestProfile: "swimtics:guest:profile",
    guestPbs: "swimtics:guest:pbs",
    guestStroke: "swimtics:guest:strokeData",
    localPhotos: (uid) => `swimtics:localPhotos:${uid}`,  // { photo, strokeData } — exist only on this device
    synced: (uid) => `swimtics:syncedPbKeys:${uid}`,
    pending: (uid) => `swimtics:pendingData:${uid}`,      // { profile?: {data, token}, pbs?: {data, token} }
    dismissed: (uid, fp) => `swimtics:importDismissed:${uid}:${fp}`,
    device: "swimtics:deviceId",
};

const SLOW_SAVE_MS = 8000;

/* ---------- localStorage helpers (never throw) ---------- */

const store = {
    get(key, fallback = null) {
        try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
        catch { return fallback; }
    },
    set(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); return true; }
        catch (err) { console.error("SWIMTICS storage:", err); return false; }
    },
    remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};

function deviceId() {
    let id = store.get(KEY.device);
    if (!id) {
        id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
        store.set(KEY.device, id);
    }
    return id;
}

/* ---------- working copy (what the existing UI reads) ---------- */

function readWorking() {
    return {
        profile: store.get("profile", {}) || {},
        pbs: store.get("pbs", []) || [],
        strokeData: store.get("strokeData", {}) || {},
    };
}

function writeWorking({ profile, pbs: list, strokeData: strokes }) {
    store.set("profile", profile || {});
    store.set("pbs", list || []);
    if (strokes !== undefined) store.set("strokeData", strokes || {});
    /* keep index.html's in-memory copies (used by pb.js / profile.js) in step */
    if (typeof pbs !== "undefined" && Array.isArray(pbs)) {
        pbs.length = 0;
        pbs.push(...(list || []));
    }
    if (strokes !== undefined && typeof strokeData !== "undefined" && strokeData && typeof strokeData === "object") {
        for (const k of Object.keys(strokeData)) delete strokeData[k];
        Object.assign(strokeData, strokes || {});
    }
    rerender();
}

function rerender() {
    try { if (typeof loadProfile === "function") loadProfile(); } catch (e) { console.error(e); }
    try { if (typeof displayPBs === "function") displayPBs(); } catch (e) { console.error(e); }
}

function guestData() {
    return {
        profile: store.get(KEY.guestProfile, {}) || {},
        pbs: store.get(KEY.guestPbs, []) || [],
        strokeData: store.get(KEY.guestStroke, {}) || {},
    };
}

function hasLocalData(local) {
    return Object.keys(sanitizeProfile(local.profile)).length > 0 || (local.pbs || []).length > 0;
}

/* Keep the departing account's local-only photos (they exist nowhere else),
   then put this device's own data back in the working copy. The account's
   profile/PB copy is not kept: it lives in the database. */
function leaveAccount(uid) {
    if (!uid) return;
    const w = readWorking();
    const photos = store.get(KEY.localPhotos(uid), {}) || {};
    if (w.profile.photo) photos.photo = w.profile.photo;
    if (Object.keys(w.strokeData).length) photos.strokeData = w.strokeData;
    if (Object.keys(photos).length) store.set(KEY.localPhotos(uid), photos);
    store.remove(KEY.active);
    writeWorking(guestData());
}

/* loadProfile() calls this; the real version is defined below. */
if (typeof window.updateProfileAccountSection !== "function") window.updateProfileAccountSection = () => {};

/* Startup: if the working copy still holds an account's data (the page was
   closed while signed in), hide it until Firebase confirms who is signed
   in. The data is reloaded from the database if that user is still signed in. */
const startupUid = store.get(KEY.active);
if (startupUid) leaveAccount(startupUid);

/* ---------- status messages ---------- */

function setStatus(id, text, kind = "info") {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.dataset.kind = text ? kind : "";
}

function authMessage(text, kind = "info") { setStatus("authMessage", text, kind); }

function friendlyAuthError(err) {
    const code = (err && err.code) || "";
    if (code.includes("invalid-email")) return "Please enter a valid email address.";
    if (code.includes("email-already-in-use")) return "An account with this email already exists. Try logging in.";
    if (code.includes("weak-password")) return "Please choose a stronger password (at least 8 characters).";
    if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found"))
        return "Email or password is incorrect.";
    if (code.includes("too-many-requests")) return "Too many attempts. Please wait a moment and try again.";
    if (code.includes("network-request-failed")) return "Couldn't reach the server. Check your connection and try again.";
    return "Something went wrong. Please try again.";
}

/* ---------- serialise account operations ---------- */

let chain = Promise.resolve();
function queue(fn) {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
}

/* ---------- Save Profile on this device only ---------- */

function collectProfileForm() {
    const current = store.get("profile", {}) || {};
    const next = { ...current };
    for (const field of PROFILE_FIELDS) {
        const el = document.getElementById(field);
        if (el) next[field] = el.value;
    }
    return next;
}

function saveProfileLocally(message = "Saved on this device.") {
    const next = collectProfileForm();
    if (!store.set("profile", next)) {
        setStatus("profileSaveStatus", "Couldn't save on this device (browser storage is full or blocked).", "error");
        return null;
    }
    rerender();
    setStatus("profileSaveStatus", message, "ok");
    return next;
}

/* ---------- accounts not available (production until set up) ---------- */

if (!fbx || !fbx.available) {
    window.updateProfileAccountSection = function () {
        const el = document.getElementById("accountDetails");
        if (el) {
            el.innerHTML = `<p class="account-note">Accounts aren't available yet. Your profile and personal bests are saved on this device.</p>`;
        }
        document.querySelectorAll(".login-btn").forEach((b) => { b.hidden = true; });
        document.querySelectorAll("button[onclick='logoutUser()']").forEach((b) => { b.hidden = true; });
    };
    window.saveProfile = () => saveProfileLocally();
    window.saveUserData = () => {};
    window.openLoginModal = () => window.showPage && window.showPage("profile");
    window.updateProfileAccountSection();
} else {
    setupAccounts();
}

/* =========================================================
   Accounts available (emulator now; production once configured)
   ========================================================= */

function setupAccounts() {
    const { auth, db, authFns, dbFns } = fbx;
    const repo = createUserDataRepository({ db, ...dbFns });
    let currentUser = null;
    let gen = 0;                 // auth session generation
    let accountLoaded = false;   // working copy holds currentUser's data
    let lastLoadError = null;
    let importPlan = null;

    /* still the same signed-in user, in the same session? */
    const still = (uid, myGen) => gen === myGen && !!currentUser && currentUser.uid === uid;

    /* ----- pending (unsynced) changes, backed up per uid ----- */

    function beginWrite(uid, what, data) {
        const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const p = store.get(KEY.pending(uid), {}) || {};
        p[what] = { data, token };
        store.set(KEY.pending(uid), p);
        return token;
    }

    function endWrite(uid, what, token) {
        const p = store.get(KEY.pending(uid), {}) || {};
        if (p[what] && p[what].token === token) delete p[what];   // a newer change stays pending
        if (Object.keys(p).length) store.set(KEY.pending(uid), p);
        else store.remove(KEY.pending(uid));
    }

    function slowNotice(statusId, uid, myGen) {
        return setTimeout(() => {
            if (still(uid, myGen)) {
                setStatus(statusId, "Still saving — check your connection. The change is kept on this device and will be sent when the connection returns.", "error");
            }
        }, SLOW_SAVE_MS);
    }

    /* ----- modal ----- */

    const modal = () => document.getElementById("authModal");
    let lastFocus = null;

    window.openLoginModal = function () {
        lastFocus = document.activeElement;
        const m = modal();
        if (!m) return;
        m.style.display = "flex";
        authMessage("");
        window.showLogin();
        setTimeout(() => document.getElementById("authEmail")?.focus(), 0);
    };

    window.closeLoginModal = function () {
        const m = modal();
        if (m) m.style.display = "none";
        clearPasswords();
        if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
    };

    window.showLogin = function () {
        document.getElementById("loginView").style.display = "";
        document.getElementById("signupView").style.display = "none";
        authMessage("");
    };

    window.showSignup = function () {
        document.getElementById("loginView").style.display = "none";
        document.getElementById("signupView").style.display = "";
        authMessage("");
    };

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && modal() && modal().style.display === "flex") window.closeLoginModal();
    });

    function clearPasswords() {
        for (const id of ["authPassword", "signupPassword"]) {
            const el = document.getElementById(id);
            if (el) el.value = "";
        }
    }

    const val = (id) => (document.getElementById(id)?.value || "").trim();

    /* ----- sign in / up / out ----- */

    window.loginUser = async function () {
        const email = val("authEmail");
        const password = document.getElementById("authPassword")?.value || "";
        if (!email || !password) { authMessage("Enter your email and password.", "error"); return; }
        authMessage("Signing in…");
        try {
            await authFns.signInWithEmailAndPassword(auth, email, password);
            clearPasswords();
            window.closeLoginModal();
        } catch (err) {
            authMessage(friendlyAuthError(err), "error");
            document.getElementById("authPassword").value = "";
        }
    };

    window.signupUser = async function () {
        const email = val("signupEmail");
        const password = document.getElementById("signupPassword")?.value || "";
        if (!email) { authMessage("Please enter your email.", "error"); return; }
        if (password.length < 8) { authMessage("Please choose a password of at least 8 characters.", "error"); return; }
        /* optional details from the existing sign-up form -> the account profile */
        const details = sanitizeProfile({
            name: val("signupFullName"), gender: val("signupGender"),
            club: val("signupClub"), nationality: val("signupNationality"),
        });
        authMessage("Creating your account…");
        let cred;
        try {
            cred = await authFns.createUserWithEmailAndPassword(auth, email, password);
        } catch (err) {
            authMessage(friendlyAuthError(err), "error");
            document.getElementById("signupPassword").value = "";
            return;
        }
        clearPasswords();
        for (const id of ["signupFullName", "signupGender", "signupClub", "signupNationality"]) {
            const el = document.getElementById(id);
            if (el) el.value = "";
        }
        window.closeLoginModal();
        window.showPage && window.showPage("profile");

        let verificationSent = true;
        try { await authFns.sendEmailVerification(cred.user); }
        catch (e) { verificationSent = false; console.error("verification email:", e); }

        const uid = cred.user.uid;
        if (Object.keys(details).length) {
            try {
                await queue(async () => {
                    if (!currentUser || currentUser.uid !== uid) return;
                    const cur = (await repo.load(uid)).profile;
                    await repo.saveProfile(uid, { ...details, ...stripMeta(cur) });
                    if (currentUser && currentUser.uid === uid) await loadAccount(currentUser, gen);
                });
            } catch (err) {
                console.error("SWIMTICS sign-up details:", err);
                setStatus("profileSaveStatus", "Account created, but your details weren't saved. Please enter them below and choose Save Profile.", "error");
                return;
            }
        }
        setStatus("profileSaveStatus", verificationSent
            ? `Account created. We sent a verification email to ${email}.`
            : "Account created. We couldn't send the verification email — use “Resend email” below.",
            verificationSent ? "ok" : "error");
    };

    window.resetPassword = async function () {
        const email = val("authEmail");
        if (!email) { authMessage("Enter your email above, then choose “Forgot password?”.", "error"); return; }
        try {
            await authFns.sendPasswordResetEmail(auth, email);
        } catch (err) {
            const code = String((err && err.code) || "");
            if (code.includes("invalid-email") || code.includes("network-request-failed") || code.includes("too-many-requests")) {
                authMessage(friendlyAuthError(err), "error");
                return;
            }
            /* user-not-found and similar: fall through to the neutral message */
        }
        /* same message either way, so the form doesn't reveal which emails have accounts */
        authMessage("If an account exists for that email, we've sent a password reset link.", "ok");
    };

    let userSignedOut = false;   // this tab's own Log Out: clear the page at once

    window.logoutUser = async function () {
        userSignedOut = true;
        try { await authFns.signOut(auth); }
        catch (err) {
            userSignedOut = false;
            setStatus("profileSaveStatus", "Couldn't sign out. Please try again.", "error");
        }
    };

    window.resendVerification = async function () {
        if (!currentUser) return;
        try {
            await authFns.sendEmailVerification(currentUser);
            setStatus("profileSaveStatus", "Verification email sent to " + currentUser.email + ".", "ok");
        } catch (err) {
            setStatus("profileSaveStatus", friendlyAuthError(err), "error");
        }
    };

    window.refreshVerification = async function () {
        if (!currentUser) return;
        try { await authFns.reload(currentUser); } catch { /* ignore */ }
        window.updateProfileAccountSection();
    };

    window.retryAccountLoad = () => {
        if (currentUser) queue(() => loadAccount(currentUser, gen));
    };

    /* navbar Sign In: open the dialog when signed out, go to Profile when signed in */
    window.swimticsAccountAction = () => {
        if (currentUser) window.showPage("profile");
        else window.openLoginModal();
    };

    /* ----- loading an account into the working copy ----- */

    function stripMeta(profile) {
        const { updatedAt, ...rest } = profile || {};
        return rest;
    }

    function snapshotGuest() {
        const w = readWorking();
        store.set(KEY.guestProfile, w.profile);
        store.set(KEY.guestPbs, w.pbs);
        store.set(KEY.guestStroke, w.strokeData);
    }

    /* runs inside queue() */
    async function loadAccount(user, myGen) {
        const uid = user.uid;
        const active = store.get(KEY.active);
        if (active && active !== uid) leaveAccount(active);
        if (!store.get(KEY.active)) snapshotGuest();

        let cloud;
        try {
            cloud = await repo.load(uid);
        } catch (err) {
            console.error("SWIMTICS account load:", err);
            if (!still(uid, myGen)) return;
            lastLoadError = err;
            accountLoaded = false;
            setStatus("profileSaveStatus", "Couldn't load your account data. This device's own data is shown and changes stay on this device until your account loads.", "error");
            window.updateProfileAccountSection();
            return;
        }
        if (!still(uid, myGen)) return;
        lastLoadError = null;

        const photos = store.get(KEY.localPhotos(uid), {}) || {};
        const profile = { ...stripMeta(cloud.profile) };
        if (photos.photo) profile.photo = photos.photo;
        const list = cloudPbsToLocal(cloud.pbs);
        store.set(KEY.active, uid);
        store.set(KEY.synced(uid), list.map((p) => pbKey(p.event, p.course)));
        writeWorking({ profile, pbs: list, strokeData: photos.strokeData || {} });
        accountLoaded = true;

        await replayPending(uid, myGen);
        if (!still(uid, myGen)) return;
        maybeOfferImport(uid, myGen, cloud);
        window.updateProfileAccountSection();
    }

    /* Push changes that didn't reach the account earlier (same uid only). */
    async function replayPending(uid, myGen) {
        const p = store.get(KEY.pending(uid), {}) || {};
        if (!p.profile && !p.pbs) return;
        try {
            if (p.profile) {
                await repo.saveProfile(uid, p.profile.data);
                endWrite(uid, "profile", p.profile.token);
            }
            if (p.pbs) {
                await repo.syncPbs(uid, p.pbs.data.pbs, p.pbs.data.syncedKeys, deviceId());
                endWrite(uid, "pbs", p.pbs.token);
            }
            if (!still(uid, myGen)) return;
            const cloud = await repo.load(uid);
            if (!still(uid, myGen)) return;
            const list = cloudPbsToLocal(cloud.pbs);
            const w = readWorking();
            store.set(KEY.synced(uid), list.map((x) => pbKey(x.event, x.course)));
            writeWorking({ profile: { ...stripMeta(cloud.profile), ...(w.profile.photo ? { photo: w.profile.photo } : {}) }, pbs: list });
            setStatus("profileSaveStatus", "Earlier changes from this device have now been saved to your account.", "ok");
        } catch (err) {
            console.error("SWIMTICS replay:", err);
        }
    }

    /* ----- import offer ----- */

    function maybeOfferImport(uid, myGen, cloud) {
        const local = guestData();
        importPlan = null;
        if (!hasLocalData(local)) return;
        const plan = planImport(local, cloud);
        if (plan.isEmpty || cloud.imports[plan.fingerprint]) return;
        importPlan = { uid, plan };
        if (!store.get(KEY.dismissed(uid, plan.fingerprint))) showImportDialog(uid, myGen, plan);
    }

    function showImportDialog(uid, myGen, plan) {
        let dlg = document.getElementById("importDialog");
        if (!dlg) {
            dlg = document.createElement("div");
            dlg.id = "importDialog";
            dlg.className = "auth-modal";
            document.body.appendChild(dlg);
        }
        const fieldList = Object.keys(plan.profileFill);
        const pbLines = plan.pbs.filter((p) => p.newEntries > 0)
            .map((p) => `<li>${escapeHtml(p.event)} (${escapeHtml(p.course)}): ${p.newEntries} time${p.newEntries === 1 ? "" : "s"}${p.existsInAccount ? " — merged with your account's times" : ""}</li>`)
            .join("");
        dlg.innerHTML = `
            <div class="auth-box import-box" role="dialog" aria-modal="true" aria-labelledby="importTitle">
                <h2 id="importTitle">Import this device's data?</h2>
                <p class="import-lead">This device has data saved while no one was signed in. Importing adds it to your account; nothing already in your account is deleted or overwritten. Only import it if it is yours.</p>
                ${fieldList.length ? `<h3>Profile fields to fill in</h3><p class="import-fields">${fieldList.map(escapeHtml).join(", ")}</p>` : ""}
                ${plan.profileKept.length ? `<p class="import-note">Your account already has ${plan.profileKept.map(escapeHtml).join(", ")} — those stay as they are.</p>` : ""}
                ${pbLines ? `<h3>Personal best times to add</h3><ul class="import-pbs">${pbLines}</ul>` : ""}
                <p class="import-note">Photos stay on this device for now. A copy of this device's data is kept here either way.</p>
                <button type="button" id="importConfirm">Import</button>
                <button type="button" id="importLater" class="secondary">Not now</button>
                <p id="importMessage" role="status" aria-live="polite"></p>
            </div>`;
        dlg.style.display = "flex";
        dlg.querySelector("#importConfirm").onclick = () => runImport(uid, myGen, plan);
        dlg.querySelector("#importLater").onclick = () => {
            store.set(KEY.dismissed(uid, plan.fingerprint), true);
            closeImportDialog();
            window.updateProfileAccountSection();
        };
        dlg.querySelector("#importConfirm").focus();
    }

    function closeImportDialog() {
        const dlg = document.getElementById("importDialog");
        if (dlg) dlg.style.display = "none";
    }

    async function runImport(uid, myGen, plan) {
        if (!still(uid, myGen)) { closeImportDialog(); return; }
        const msg = (t, k) => setStatus("importMessage", t, k);
        const btn = document.getElementById("importConfirm");
        if (btn) btn.disabled = true;
        msg("Importing…");
        try {
            await queue(async () => {
                if (!still(uid, myGen)) return;
                await repo.importLocal(uid, plan);
                if (still(uid, myGen)) await loadAccount(currentUser, myGen);
            });
            if (!still(uid, myGen)) return;
            importPlan = null;
            closeImportDialog();
            const n = Object.keys(plan.profileFill).length;
            setStatus("profileSaveStatus",
                `Imported ${plan.pbEntries} PB time${plan.pbEntries === 1 ? "" : "s"} and ${n} profile field${n === 1 ? "" : "s"} into your account. This device's copy is kept.`, "ok");
            window.updateProfileAccountSection();
        } catch (err) {
            console.error("SWIMTICS import:", err);
            if (!still(uid, myGen)) return;
            msg("Import didn't finish. Nothing on this device was changed; anything already added to your account will not be duplicated if you try again.", "error");
            if (btn) btn.disabled = false;
        }
    }

    window.offerDeviceImport = () => {
        if (importPlan && currentUser && importPlan.uid === currentUser.uid) showImportDialog(importPlan.uid, gen, importPlan.plan);
    };

    /* ----- saving ----- */

    window.saveProfile = async function () {
        if (!currentUser) {
            saveProfileLocally("Saved on this device. Sign in to keep it in your account.");
            return;
        }
        if (!accountLoaded || store.get(KEY.active) !== currentUser.uid) {
            saveProfileLocally("Saved on this device only — your account data hasn't loaded.");
            return;
        }
        const uid = currentUser.uid;
        const myGen = gen;
        const next = collectProfileForm();
        store.set("profile", next);                    // working copy first: never lose the edit
        rerender();
        const data = sanitizeProfile(next);
        const token = beginWrite(uid, "profile", data);
        setStatus("profileSaveStatus", "Saving to your account…");
        const slow = slowNotice("profileSaveStatus", uid, myGen);
        try {
            await queue(() => repo.saveProfile(uid, data));
            endWrite(uid, "profile", token);
            if (still(uid, myGen)) setStatus("profileSaveStatus", "Saved to your account.", "ok");
        } catch (err) {
            console.error("SWIMTICS profile save:", err);
            if (still(uid, myGen)) {
                setStatus("profileSaveStatus", "Saved on this device, but couldn't reach your account. It will be sent next time you open SWIMTICS signed in.", "error");
            }
        } finally {
            clearTimeout(slow);
        }
    };

    /* called by pb.js after savePB / deletePB / editPB when signed in */
    window.saveUserData = function (uid) {
        if (!uid || !currentUser || currentUser.uid !== uid) return;
        if (!accountLoaded || store.get(KEY.active) !== uid) {
            /* pb.js has already saved into the working copy, which is still
               this device's own data: say so rather than implying a sync */
            setStatus("pbSyncStatus", "Saved on this device only — your account data hasn't loaded yet.", "error");
            return;
        }
        return syncPbsNow(uid);
    };

    async function syncPbsNow(uid) {
        const myGen = gen;
        const workingPbs = readWorking().pbs;           // the data being saved, captured now
        const syncedKeys = store.get(KEY.synced(uid), []) || [];
        const token = beginWrite(uid, "pbs", { pbs: workingPbs, syncedKeys });
        setStatus("pbSyncStatus", "Saving to your account…");
        const slow = slowNotice("pbSyncStatus", uid, myGen);
        try {
            const done = await queue(async () => {
                if (!still(uid, myGen)) return false;     // stays pending for this uid
                const list = await repo.syncPbs(uid, workingPbs, syncedKeys, deviceId());
                endWrite(uid, "pbs", token);
                if (!still(uid, myGen)) return false;
                store.set(KEY.synced(uid), list.map((p) => pbKey(p.event, p.course)));
                const w = readWorking();
                writeWorking({ profile: w.profile, pbs: list });
                return true;
            });
            if (done && still(uid, myGen)) setStatus("pbSyncStatus", "Saved to your account.", "ok");
        } catch (err) {
            console.error("SWIMTICS PB sync:", err);
            if (still(uid, myGen)) {
                setStatus("pbSyncStatus", "Saved on this device, but couldn't reach your account. It will be sent next time you open SWIMTICS signed in.", "error");
            }
        } finally {
            clearTimeout(slow);
        }
    }

    /* ----- account section on the Profile page ----- */

    window.updateProfileAccountSection = function () {
        const el = document.getElementById("accountDetails");
        const loginBtns = document.querySelectorAll(".login-btn");
        const logoutBtns = document.querySelectorAll("button[onclick='logoutUser()']");
        const navBtn = document.querySelector(".site-nav-signin");
        loginBtns.forEach((b) => { b.hidden = !!currentUser; });
        logoutBtns.forEach((b) => { b.hidden = !currentUser; });
        if (navBtn) navBtn.textContent = currentUser ? "Account" : "Sign In";
        if (!el) return;

        if (!currentUser) {
            el.innerHTML = `<p class="account-note">You're not signed in. Your profile and personal bests are saved on this device only.</p>`;
            return;
        }
        const verified = currentUser.emailVerified;
        const syncNote = lastLoadError
            ? `Couldn't load your account data — changes stay on this device for now. <button type="button" class="auth-link" onclick="retryAccountLoad()">Try again</button>`
            : accountLoaded
                ? "Your profile details and personal bests are saved to your account."
                : "Loading your account…";
        el.innerHTML = `
            <div class="account-card">
                <p class="account-line">Signed in as <strong>${escapeHtml(currentUser.email || "")}</strong></p>
                <p class="account-line ${verified ? "ok" : "warn"}">${verified
                    ? "Email verified."
                    : `Email not verified yet. <button type="button" class="auth-link" onclick="resendVerification()">Resend email</button> <button type="button" class="auth-link" onclick="refreshVerification()">I've verified</button>`}</p>
                <p class="account-line">${syncNote}</p>
                <p class="account-line notice"><strong>You stay signed in on this browser until you log out.</strong> On a shared device, use Log Out below when you're done.</p>
                <p class="account-line muted">Photos stay on this device. Analysis reports, race reports and War Room plans are not saved to your account yet.</p>
                ${importPlan && importPlan.uid === currentUser.uid ? `<button type="button" class="auth-link" onclick="offerDeviceImport()">Import this device's earlier data…</button>` : ""}
            </div>`;
    };

    /* ----- auth state drives everything ----- */

    /* Runs immediately (not queued): a sign-out must take effect even while
       a save is still waiting on the network. Bumping `gen` invalidates any
       in-flight work, which then never touches the working copy. */
    let leaving = null;          // { uid, timer } while a non-user sign-out is being confirmed
    const LEAVE_CONFIRM_MS = 1200;

    function leaveAndReload(uid) {
        leaveAccount(uid);
        location.reload();
    }

    authFns.onAuthStateChanged(auth, (user) => {
        /* Firebase can report the same signed-in user again (e.g. after sign-up
           or a token refresh): same identity, same session — keep everything. */
        if (user && currentUser && user.uid === currentUser.uid && !leaving) {
            currentUser = user;
            window.updateProfileAccountSection();
            return;
        }
        gen += 1;
        const myGen = gen;
        const prev = currentUser ? currentUser.uid : (leaving ? leaving.uid : null);
        currentUser = user;
        accountLoaded = false;
        importPlan = null;
        lastLoadError = null;
        closeImportDialog();

        if (leaving && user && user.uid === leaving.uid) {
            /* the "sign-out" was transient (e.g. another tab starting up):
               stay signed in and reload this account's data */
            clearTimeout(leaving.timer);
            leaving = null;
        } else if (prev && (!user || user.uid !== prev)) {
            /* leaving an account: restore this device's data and start from a
               clean page, so nothing from that session lingers in memory.
               Unsynced changes stay backed up under the old uid only.
               In-flight work is already invalidated by the gen bump above. */
            if (leaving) clearTimeout(leaving.timer);
            if (userSignedOut || user) {
                leaving = null;
                leaveAndReload(prev);
            } else {
                /* signed out elsewhere (another tab, expired session): confirm
                   it isn't a momentary blip before clearing the page */
                leaving = {
                    uid: prev,
                    timer: setTimeout(() => {
                        const now = auth.currentUser;
                        if (now && now.uid === prev) return;   // came back; handled above
                        leaving = null;
                        leaveAndReload(prev);
                    }, LEAVE_CONFIRM_MS),
                };
                window.updateProfileAccountSection();
            }
            return;
        }
        window.updateProfileAccountSection();
        if (user) {
            queue(async () => {
                if (gen !== myGen) return;
                await loadAccount(user, myGen);
                if (gen === myGen) window.updateProfileAccountSection();
            });
        }
    });

    window.updateProfileAccountSection();
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
