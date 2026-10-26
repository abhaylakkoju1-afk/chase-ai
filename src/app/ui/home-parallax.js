window.addEventListener("scroll", () => {

    /* no scroll-linked movement for visitors who ask for reduced motion */
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const scrollY = window.scrollY;

    const overlay =
        document.querySelector(".overlay");

    const video =
        document.getElementById("bgVideo");

    if (!overlay || !video) return;

    overlay.style.transform =
        `translate(-50%, calc(-50% + ${scrollY * 0.35}px))`;

    overlay.style.opacity =
        Math.max(0, 1 - scrollY / 500);

    video.style.transform =
        `scale(${1 + scrollY * 0.0002})`;

});
