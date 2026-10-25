/* =========================================================
   SITE NAV — Tools disclosure menu and Sign In
   Page switching itself stays in showPage() (navigation.js);
   this file only opens/closes the Tools menu and wires Sign In.
   ========================================================= */

(function setupSiteNav() {

    const toggle = document.getElementById("siteNavToolsButton");
    const menu = document.getElementById("siteNavToolsMenu");
    const signIn = document.querySelector(".site-nav-signin");

    if (!toggle || !menu) return;

    const items = () => [...menu.querySelectorAll("button")];

    function openMenu(focusItem) {
        menu.hidden = false;
        toggle.setAttribute("aria-expanded", "true");
        if (focusItem === "first") items()[0].focus();
        if (focusItem === "last") items()[items().length - 1].focus();
    }

    function closeMenu(returnFocus) {
        if (menu.hidden) return;
        menu.hidden = true;
        toggle.setAttribute("aria-expanded", "false");
        if (returnFocus) toggle.focus();
    }

    toggle.addEventListener("click", () => {
        if (menu.hidden) openMenu(); else closeMenu();
    });

    toggle.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown") { event.preventDefault(); openMenu("first"); }
        if (event.key === "ArrowUp") { event.preventDefault(); openMenu("last"); }
    });

    menu.addEventListener("keydown", (event) => {
        const list = items();
        const index = list.indexOf(document.activeElement);
        if (event.key === "ArrowDown") { event.preventDefault(); list[(index + 1) % list.length].focus(); }
        if (event.key === "ArrowUp") { event.preventDefault(); list[(index - 1 + list.length) % list.length].focus(); }
        if (event.key === "Home") { event.preventDefault(); list[0].focus(); }
        if (event.key === "End") { event.preventDefault(); list[list.length - 1].focus(); }
    });

    /* choosing a page: showPage() runs from the item's onclick, then close.
       Items marked data-keep-open (the theme toggle) act in place: the menu
       stays open with focus on the item, which shows its new label. */
    menu.addEventListener("click", (event) => {
        const item = event.target.closest("button");
        if (item && !item.hasAttribute("data-keep-open")) closeMenu();
    });

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !menu.hidden) closeMenu(true);
    });

    /* outside click / tap, or focus leaving the menu (e.g. Tab) */
    document.addEventListener("pointerdown", (event) => {
        if (!event.target.closest(".site-nav-tools")) closeMenu();
    });

    document.addEventListener("focusin", (event) => {
        if (!event.target.closest(".site-nav-tools")) closeMenu();
    });

    /* account.js sets window.swimticsAccountAction when accounts are
       available (signed out: open the sign-in dialog; signed in: Profile).
       Without accounts, Sign In opens Profile as before. */
    if (signIn) {
        signIn.addEventListener("click", () => {
            closeMenu();
            if (typeof window.swimticsAccountAction === "function") window.swimticsAccountAction();
            else window.showPage(signIn.dataset.page);
        });
    }

})();
