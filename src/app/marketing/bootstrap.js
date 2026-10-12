/* =========================================================
   PREMIUM STYLE INJECTION
   ========================================================= */


/* =========================================================
   SWIMTICS PREMIUM EXPERIENCE — DIRECT MODE
   Merged from premium.html into index.html.
   ========================================================= */

(function initialiseSwimticsPremium() {

    const start = () => {

        if (typeof gsap === "undefined") {
            console.warn("SWIMTICS premium: GSAP unavailable.");
            initialiseFallbackAnimations(document);
            return;
        }

        if (typeof ScrollTrigger === "undefined") {
            console.warn("SWIMTICS premium: ScrollTrigger unavailable.");
            initialiseFallbackAnimations(document);
            return;
        }

        window.swimticsGSAP = gsap;
        window.swimticsScrollTrigger = ScrollTrigger;

        gsap.registerPlugin(ScrollTrigger);

        const doc = document;

        createScrollProgress(doc);
        setupEcosystemIntro(doc);
        setupFeatureCards(doc);
        setupScrollReveals(doc);
        setupChaseAIShowcase(doc);
        setupParallax(doc);
        setupPageObserver(doc);
        setupMicroInteractions(doc);

        ScrollTrigger.refresh();

    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
        start();
    }

})();


/* =========================================================
   SWIMTICS CINEMATIC ENTRY GATE — DIRECT MODE
   ========================================================= */

(function setupSwimticsEntryGate() {

    const entryGate = document.getElementById("entryGate");
    const enterButton = document.getElementById("enterButton");
    const entryBackground = document.getElementById("entryBackground");

    if (!entryGate || !enterButton || !entryBackground) return;

    function enterSwimtics() {

        if (entryGate.classList.contains("exit")) return;

        entryGate.classList.add("exit");

        /* Return control of scrolling to the actual application. */
        document.documentElement.style.overflowY = "auto";
        document.body.style.overflowY = "auto";

        window.setTimeout(() => {
            entryGate.style.visibility = "hidden";
            entryGate.style.pointerEvents = "none";
        }, 1200);

        if (window.gsap) {
            window.gsap.fromTo(
                "#home .overlay",
                { opacity: 0, y: 18 },
                { opacity: 1, y: 0, duration: 1.1, ease: "power4.out", delay: .15 }
            );
        }

    }

    enterButton.addEventListener("click", enterSwimtics);

    document.addEventListener("keydown", event => {
        if (event.key === "Enter" && !entryGate.classList.contains("exit")) {
            enterSwimtics();
        }
    });

    document.addEventListener("mousemove", event => {
        if (entryGate.classList.contains("exit")) return;

        const x = (event.clientX / window.innerWidth) - .5;
        const y = (event.clientY / window.innerHeight) - .5;

        entryBackground.style.transform = `
            scale(1.075)
            translate3d(${x * -12}px, ${y * -8}px, 0)
        `;
    });

    document.addEventListener("mouseleave", () => {
        if (entryGate.classList.contains("exit")) return;
        entryBackground.style.transform = "scale(1.10)";
    });

})();

