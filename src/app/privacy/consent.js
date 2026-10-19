/* =========================================================
   ANALYTICS CONSENT — notice, Privacy & cookies dialog, and the
   only place Google Analytics is loaded.

   Google Analytics loads only after the visitor accepts, on this visit
   or from a saved, current-version "accept". Microsoft Clarity is
   paused and not loaded anywhere. Markup: #consentBanner and
   #privacyDialog in index.html; styles: styles/consent.css; pure
   logic: consent-store.js.
   ========================================================= */

import {
    CONSENT_KEY, createRecord, parseRecord, analyticsAllowed, expiryCookies,
} from "./consent-store.js";

const GA_ID = "G-VSLDBW2PYM";

function readRecord() {
    try { return parseRecord(localStorage.getItem(CONSENT_KEY)); } catch { return null; }
}

function writeRecord(record) {
    try { localStorage.setItem(CONSENT_KEY, JSON.stringify(record)); return true; } catch { return false; }
}

/* ---------- Google Analytics ---------- */

let gaLoaded = false;
let analyticsBlocked = false;

/* gtag.js's ga-disable flag doesn't stop everything: its automatic events
   (e.g. "scroll") can still be sent after the flag is set. So once Google
   Analytics has been loaded on this page, requests to Google's analytics
   hosts are refused while analytics is withdrawn, through the ways gtag
   sends or loads things: sendBeacon, fetch, XMLHttpRequest, and the src
   of <img> and <script> elements. A refused send is reported to gtag as
   a success, so it doesn't fall back to another way of sending. Every
   other request passes through untouched. Installed only when Google
   Analytics loads. Not covered: anything set via setAttribute("src"),
   iframes, CSS, or <link> hints (gtag wasn't seen using these). */
const ANALYTICS_HOST = /^https?:\/\/([a-z0-9-]+\.)*(google-analytics\.com|analytics\.google\.com|googletagmanager\.com|doubleclick\.net)(:\d+)?(\/|$)/i;

function isBlockedAnalyticsUrl(url) {
    if (!analyticsBlocked) return false;
    try { return ANALYTICS_HOST.test(new URL(String(url), location.href).href); } catch { return false; }
}

function guardSrc(Element) {
    const proto = Element && Element.prototype;
    const desc = proto && Object.getOwnPropertyDescriptor(proto, "src");
    if (!desc || !desc.set || !desc.configurable) return;
    Object.defineProperty(proto, "src", {
        ...desc,
        set(value) {
            if (isBlockedAnalyticsUrl(value)) return;   // never assigned, so never requested
            desc.set.call(this, value);
        },
    });
}

function installAnalyticsGuard() {
    if (navigator.sendBeacon) {
        const sendBeacon = navigator.sendBeacon.bind(navigator);
        navigator.sendBeacon = (url, data) => (isBlockedAnalyticsUrl(url) ? true : sendBeacon(url, data));
    }
    if (window.fetch) {
        const fetch = window.fetch.bind(window);
        window.fetch = (input, init) => {
            const url = input && typeof input === "object" && "url" in input ? input.url : input;
            return isBlockedAnalyticsUrl(url)
                ? Promise.resolve(new Response(null, { status: 204 }))
                : fetch(input, init);
        };
    }
    guardSrc(window.HTMLImageElement);
    guardSrc(window.HTMLScriptElement);
    if (window.XMLHttpRequest) {
        const open = XMLHttpRequest.prototype.open;
        const send = XMLHttpRequest.prototype.send;
        /* the URL is remembered at open() and checked again at send(), so a
           request opened while analytics was allowed can't be sent after
           a withdrawal */
        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
            this.swimticsRequestUrl = url;
            return open.call(this, method, url, ...rest);
        };
        XMLHttpRequest.prototype.send = function (...args) {
            if (isBlockedAnalyticsUrl(this.swimticsRequestUrl)) return undefined;
            return send.apply(this, args);
        };
    }
}

function loadGoogleAnalytics() {
    window[`ga-disable-${GA_ID}`] = false;
    analyticsBlocked = false;
    if (gaLoaded) return;
    gaLoaded = true;
    installAnalyticsGuard();
    window.dataLayer = window.dataLayer || [];
    window.gtag = function gtag() { window.dataLayer.push(arguments); };
    window.gtag("js", new Date());
    window.gtag("config", GA_ID);
    const script = document.createElement("script");
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
    document.head.appendChild(script);
}

/* Withdrawal: gtag.js honours this flag for new events, the guard above
   refuses what it sends anyway, and the analytics cookies this site can
   reach are removed. */
function stopGoogleAnalytics() {
    window[`ga-disable-${GA_ID}`] = true;
    analyticsBlocked = true;
    removeAnalyticsCookies();
}

function removeAnalyticsCookies() {
    for (const c of expiryCookies(document.cookie, location.hostname)) document.cookie = c;
}

/* ---------- UI ---------- */

const banner = document.getElementById("consentBanner");
const dialog = document.getElementById("privacyDialog");
const statusLine = document.getElementById("privacyStatus");
const resultLine = document.getElementById("privacyResult");
let opener = null;

function formatDate(iso) {
    try {
        return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
    } catch { return iso; }
}

function renderStatus() {
    if (!statusLine) return;
    const record = readRecord();
    if (!record) statusLine.textContent = "You haven't made a choice yet, so Google Analytics is off.";
    else if (record.choice === "accept") statusLine.textContent = `You accepted optional analytics on ${formatDate(record.at)}. Google Analytics is on.`;
    else statusLine.textContent = `You declined optional analytics on ${formatDate(record.at)}. Google Analytics is off.`;
}

/* While the notice is up, reserve room for it at the bottom of the page
   (styles/consent.css lifts the floating buttons and pads the page). */
let resizeObserver = null;

function setBannerVisible(visible) {
    if (!banner) return;
    banner.hidden = !visible;
    document.body.classList.toggle("consent-pending", visible);
    const update = () => document.documentElement.style.setProperty(
        "--consent-banner-height", visible ? `${banner.offsetHeight}px` : "0px");
    update();
    if (visible && !resizeObserver && "ResizeObserver" in window) {
        resizeObserver = new ResizeObserver(update);
        resizeObserver.observe(banner);
    }
    if (!visible && resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
}

function choose(choice, source) {
    const saved = writeRecord(createRecord(choice));
    if (choice === "accept") loadGoogleAnalytics(); else stopGoogleAnalytics();
    setBannerVisible(false);
    renderStatus();
    if (source === "dialog" && resultLine) {
        resultLine.textContent = (choice === "accept"
            ? "Saved: Google Analytics is on."
            : "Saved: Google Analytics is off, and its cookies on this site have been removed where the browser allows.")
            + (saved ? "" : " This browser couldn't store your choice, so you'll be asked again next time.");
    }
    if (source === "banner") {
        /* the notice is gone: keep keyboard focus somewhere sensible */
        const tools = document.getElementById("siteNavToolsButton");
        if (tools) tools.focus();
    }
}

function openPrivacySettings(trigger) {
    if (!dialog) return;
    opener = trigger || document.activeElement;
    if (resultLine) resultLine.textContent = "";
    renderStatus();
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    const first = dialog.querySelector("[data-consent-choice]");
    if (first) first.focus();
}

function closePrivacySettings() {
    if (!dialog) return;
    if (typeof dialog.close === "function") dialog.close(); else dialog.removeAttribute("open");
}

document.addEventListener("click", (event) => {
    const choiceBtn = event.target.closest("[data-consent-choice]");
    if (choiceBtn) {
        choose(choiceBtn.dataset.consentChoice, choiceBtn.closest("#privacyDialog") ? "dialog" : "banner");
        return;
    }
    const settingsBtn = event.target.closest("[data-privacy-settings]");
    if (settingsBtn) {
        /* opened from the Tools menu: return focus to Tools, which stays visible */
        const fromMenu = settingsBtn.closest(".site-nav-menu");
        openPrivacySettings(fromMenu ? document.getElementById("siteNavToolsButton") : settingsBtn);
        return;
    }
    if (event.target.closest("[data-privacy-close]")) closePrivacySettings();
});

if (dialog) {
    dialog.addEventListener("close", () => {
        if (opener && typeof opener.focus === "function") opener.focus();
        opener = null;
    });
}

/* ---------- startup ---------- */

/* Without a current "accept" (no choice, a corrupt or outdated record, or
   "decline"), nothing is loaded and any first-party Google Analytics or
   Clarity cookies left from earlier visits are removed. */
const saved = readRecord();
if (analyticsAllowed(saved)) loadGoogleAnalytics();
else removeAnalyticsCookies();
setBannerVisible(!saved);
renderStatus();

window.swimticsPrivacy = { open: openPrivacySettings };
