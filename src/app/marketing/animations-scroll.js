/* =========================================================
   SCROLL PROGRESS
   ========================================================= */

function createScrollProgress(doc) {

    if (
        doc.getElementById(
            "swimticsScrollProgress"
        )
    ) return;


    const progress =
        doc.createElement("div");

    progress.id =
        "swimticsScrollProgress";


    const bar =
        doc.createElement("span");


    progress.appendChild(bar);

    doc.body.appendChild(progress);


    const scrollContainer =
        doc.scrollingElement ||
        doc.documentElement;


    function updateProgress() {

        const max =
            scrollContainer.scrollHeight -
            scrollContainer.clientHeight;


        const percentage =
            max > 0
                ? (scrollContainer.scrollTop / max) * 100
                : 0;


        bar.style.height =
            `${percentage}%`;

    }


    doc.addEventListener(
        "scroll",
        updateProgress,
        { passive: true }
    );


    updateProgress();

}


/* =========================================================
   FEATURE CARDS
   ========================================================= */

function setupFeatureCards(doc) {

    const cards =
        doc.querySelectorAll(
            ".feature-card"
        );


    if (!cards.length) return;


    cards.forEach((card, index) => {

        /* -------------------------------------------------
   PERFORMANCE SYSTEM METADATA
   ------------------------------------------------- */

const number =
    String(index + 1).padStart(2, "0");

card.setAttribute(
    "data-index",
    number
);

card.setAttribute(
    "data-system",
    index + 1
); 

/* -------------------------------------------------
   TECHNICAL CORNER
   ------------------------------------------------- */

if (
    !card.querySelector(
        ".swimtics-tech-corner"
    )
) {

    const corner =
        doc.createElement("div");

    corner.className =
        "swimtics-tech-corner";

    corner.style.top =
        "0";

    corner.style.left =
        "0";

    card.appendChild(corner);

}


        /* -------------------------------------------------
           BORDER SWEEP
           ------------------------------------------------- */

        if (
            !card.querySelector(
                ".swimtics-border-sweep"
            )
        ) {

            const sweep =
                doc.createElement("div");

            sweep.className =
                "swimtics-border-sweep";

            card.appendChild(sweep);

        }


        /* -------------------------------------------------
           MOUSE LIGHT
           ------------------------------------------------- */

        const light =
            doc.createElement("div");

        light.className =
            "swimtics-card-light";

        card.appendChild(light);


        card.addEventListener(
            "mousemove",
            event => {

                const rect =
                    card.getBoundingClientRect();


                const x =
                    event.clientX -
                    rect.left;


                const y =
                    event.clientY -
                    rect.top;


                light.style.left =
                    `${x}px`;

                light.style.top =
                    `${y}px`;

                light.style.opacity =
                    "1";


                const rotateX =
                    ((y / rect.height) - .5)
                    * -5;


                const rotateY =
                    ((x / rect.width) - .5)
                    * 5;


                swimticsGSAP.to(
                    card,
                    {

                        rotateX,
                        rotateY,

                        scale: 1.018,

                        duration: .45,

                        ease:
                            "power3.out",

                        overwrite: true

                    }
                );

            }
        );


        card.addEventListener(
            "mouseleave",
            () => {

                light.style.opacity =
                    "0";


                swimticsGSAP.to(
                    card,
                    {

                        rotateX: 0,

                        rotateY: 0,

                        scale: 1,

                        duration: .7,

                        ease:
                            "power3.out",

                        overwrite: true

                    }
                );

            }
        );


        /* -------------------------------------------------
           CARD ENTRANCE
           ------------------------------------------------- */

        swimticsGSAP.fromTo(

    card,

    {

        opacity: 0,

        y: 90,

        rotateX: 8,

        scale: .94,

        filter:
            "blur(10px)"

    },

    {

        opacity: 1,

        y: 0,

        rotateX: 0,

        scale: 1,

        filter:
            "blur(0px)",

        duration: 1.15,

        delay:
            index * .14,

        ease:
            "power4.out",

        scrollTrigger: {

            trigger: card,

            start:
                "top 88%",

            toggleActions:
                "play none none reverse"

        }

    }

);



    });

    /* =================================================
   GIANT SYSTEM NUMBERS
   ================================================= */

cards.forEach((card) => {

    swimticsGSAP.to(

        card,

        {

            backgroundPosition:
                "20% 80%",

            ease:
                "none",

            scrollTrigger: {

                trigger: card,

                start:
                    "top bottom",

                end:
                    "bottom top",

                scrub: true

            }

        }

    );

});

}


/* =========================================================
   GENERAL SCROLL REVEALS
   ========================================================= */

function setupScrollReveals(doc) {

    const selectors = [

        ".features-title",

        ".features-subtitle",

        ".glass",

        ".page h1",

        ".page h2",

        ".page h3",

        ".analyzer-container",

        ".pb-item",

        ".report-card",

        ".metric-box",

        ".profile-card",

        ".account-card",

        ".warroom-card",

        ".dashboard-card"

    ];


    const elements =
        doc.querySelectorAll(
            selectors.join(",")
        );


    elements.forEach(
        (element, index) => {

            if (
                element.dataset
                    .swimticsAnimated
            ) {

                return;

            }


            element.dataset
                .swimticsAnimated =
                "true";


            swimticsGSAP.fromTo(

                element,

                {

                    opacity: 0,

                    y: 45,

                    filter:
                        "blur(7px)"

                },

                {

                    opacity: 1,

                    y: 0,

                    filter:
                        "blur(0px)",

                    duration: 1,

                    delay:
                        (index % 5) * .08,

                    ease:
                        "power4.out",

                    scrollTrigger: {

                        trigger: element,

                        start:
                            "top 90%",

                        toggleActions:
                            "play none none reverse"

                    }

                }

            );

        }
    );

}


/* =========================================================
   PARALLAX
   ========================================================= */

function setupParallax(doc) {

    const targets =
        doc.querySelectorAll(
            "#bgVideo, .hero-title, .features-section"
        );


    targets.forEach(
        (element, index) => {

            swimticsGSAP.to(
            element,

                {

                    y:
                        index === 0
                            ? -80
                            : -35,

                    ease:
                        "none",

                    scrollTrigger: {

                        trigger:
                            element,

                        start:
                            "top top",

                        end:
                            "bottom top",

                        scrub: true

                    }

                }

            );

        }
    );

}


/* =========================================================
   PAGE OBSERVER
   ========================================================= */

function setupPageObserver(doc) {

    const pages =
        doc.querySelectorAll(
            ".page"
        );


    if (!pages.length) return;


    pages.forEach(page => {

        const observer =
            new MutationObserver(
                mutations => {

                    mutations.forEach(
                        mutation => {

                            if (
                                mutation.attributeName !==
                                "class"
                            ) return;


                            if (
                                page.classList.contains(
                                    "active"
                                )
                            ) {

                                animatePageEntrance(
                                    page
                                );

                            }

                        }
                    );

                }
            );


        observer.observe(
            page,
            {
                attributes: true
            }
        );

    });

}


/* =========================================================
   PAGE ENTRANCE
   ========================================================= */

function animatePageEntrance(page) {

    if (!window.swimticsGSAP) return;


    const elements =
        page.querySelectorAll(
            "h1, h2, h3, .glass, button, input, select, textarea, .pb-item"
        );


    swimticsGSAP.fromTo(

        elements,

        {

            opacity: 0,

            y: 25

        },

        {

            opacity: 1,

            y: 0,

            duration: .65,

            stagger: .035,

            ease:
                "power3.out",

            clearProps:
                "transform"

        }

    );

}


/* =========================================================
   MICRO INTERACTIONS
   ========================================================= */

function setupMicroInteractions(doc) {


    /* -----------------------------------------------------
       BUTTON MAGNETIC EFFECT
       ----------------------------------------------------- */

    const buttons =
        doc.querySelectorAll(
            ".btn, .premium-upload"
        );


    buttons.forEach(button => {

        button.addEventListener(
            "mousemove",
            event => {

                const rect =
                    button.getBoundingClientRect();


                const x =
                    event.clientX -
                    rect.left -
                    rect.width / 2;


                const y =
                    event.clientY -
                    rect.top -
                    rect.height / 2;


                swimticsGSAP.to(
                 button,

                    {

                        x:
                            x * .08,

                        y:
                            y * .08,

                        duration:
                            .35,

                        ease:
                            "power3.out"

                    }

                );

            }
        );


        button.addEventListener(
            "mouseleave",
            () => {

                swimticsGSAP.to(
                   button,

                    {

                        x: 0,

                        y: 0,

                        duration:
                            .5,

                        ease:
                            "elastic.out(1,.5)"

                    }

                );

            }
        );

    });

}


/* =========================================================
   FALLBACK
   ========================================================= */

function initialiseFallbackAnimations(doc) {

    const elements =
        doc.querySelectorAll(
            ".feature-card, .glass, .features-title"
        );


    const observer =
        new IntersectionObserver(

            entries => {

                entries.forEach(
                    entry => {

                        if (
                            entry.isIntersecting
                        ) {

                            entry.target.classList.add(
                                "visible"
                            );

                            observer.unobserve(
                                entry.target
                            );

                        }

                    }
                );

            },

            {
                threshold: .12
            }

        );


    elements.forEach(
        element =>
            observer.observe(element)
    );

}


