/* =========================================================
   ECOSYSTEM INTRO
   ========================================================= */

function setupEcosystemIntro(doc) {

    const section =
        doc.querySelector(
            "#homeFeatures"
        );

    if (!section) return;


    const title =
        section.querySelector(
            ".features-title"
        );

    const subtitle =
        section.querySelector(
            ".features-subtitle"
        );


    if (!title) return;


    /*
       Wrap the existing title/subtitle
       without changing their content.
    */

    if (
        !title.parentElement.classList.contains(
            "swimtics-ecosystem-intro"
        )
    ) {

        const wrapper =
            doc.createElement("div");

        wrapper.className =
            "swimtics-ecosystem-intro";


        title.parentNode.insertBefore(
            wrapper,
            title
        );


        wrapper.appendChild(title);


        if (subtitle) {

            wrapper.appendChild(
                subtitle
            );

        }

    }


    const wrapper =
        title.parentElement;


    /*
       Initial state.
    */

    swimticsGSAP.set(

    wrapper,

    {

        opacity: 0,

        y: 100,

        clipPath:
            "inset(0 0 25% 0)",

        filter:
            "blur(12px)"

    }

);

    /*
       Scroll animation.
    */

    swimticsGSAP.to(

    wrapper,

    {

        opacity: 1,

        y: 0,

        clipPath:
            "inset(0 0 0% 0)",

        filter:
            "blur(0px)",

        duration: 1.35,

        ease:
            "power4.out",

        scrollTrigger: {

            trigger:
                section,

            start:
                "top 82%",

            toggleActions:
                "play none none reverse"

        }

    }

);

}

/* =========================================================
   CHASE AI SHOWCASE
   ========================================================= */

function setupChaseAIShowcase(doc) {

    const ecosystem =
        doc.querySelector("#homeFeatures");

    if (!ecosystem) return;


    /* Prevent duplicate creation */

    if (
        doc.querySelector(".swimtics-chase-showcase")
    ) return;


    /* -----------------------------------------------------
       CREATE SECTION
       ----------------------------------------------------- */

    const section =
        doc.createElement("section");

    section.className =
        "swimtics-chase-showcase";


    section.innerHTML = `

        <div class="chase-showcase-inner">

            <div class="chase-showcase-header">


                <h2>
                    CHASE AI
                </h2>

                <p>
                    See what the eye misses with Chase AI, the epitome of motion analysis.
                </p>

            </div>


            <div class="chase-analysis-stage">

                <div class="chase-analysis-grid"></div>


                <div class="chase-analysis-number">
                    01
                </div>


                <div class="chase-analysis-center">

                    <div class="chase-analysis-label">
                        SWIMTICS / MOTION ANALYSIS
                    </div>

                    <div class="chase-analysis-line"></div>

                    <div class="chase-analysis-status">
                        VIDEO ANALYSIS SYSTEM
                    </div>

                </div>


                <div class="chase-analysis-corner
                            chase-corner-tl">
                </div>

                <div class="chase-analysis-corner
                            chase-corner-tr">
                </div>

                <div class="chase-analysis-corner
                            chase-corner-bl">
                </div>

                <div class="chase-analysis-corner
                            chase-corner-br">
                </div>


                <div class="chase-analysis-meta
                            chase-meta-left">

                    <span>01</span>
                    MOTION

                </div>


                <div class="chase-analysis-meta
                            chase-meta-right">

                    <span>02</span>
                    TECHNIQUE

                </div>


                <div class="chase-analysis-bottom">

                    <span>
                        UPLOAD
                    </span>

                    <span>
                        ANALYZE
                    </span>

                    <span>
                        IMPROVE
                    </span>

                </div>

            </div>


            <div class="chase-showcase-footer">

                <div>
                    PERFORMANCE INTELLIGENCE
                </div>

                <div>
                    PRECISION / POWER / PROGRESS
                </div>

            </div>

        </div>

    `;


    /*
       Place after ecosystem.
    */

    ecosystem.appendChild(section);
    


    /* -----------------------------------------------------
       ENTRANCE ANIMATION
       ----------------------------------------------------- */

    swimticsGSAP.fromTo(

        section,

        {
            opacity: 0,
            y: 100
        },

        {
            opacity: 1,
            y: 0,
            duration: 1.2,
            ease: "power4.out",

            scrollTrigger: {

                trigger: section,

                start: "top 80%",

                toggleActions:
                    "play none none reverse"

            }

        }

    );


    /* -----------------------------------------------------
       ANALYSIS STAGE
       ----------------------------------------------------- */

    const stage =
        section.querySelector(
            ".chase-analysis-stage"
        );


    swimticsGSAP.fromTo(

        stage,

        {
            opacity: 0,
            scale: .94,
            filter: "blur(8px)"
        },

        {
            opacity: 1,
            scale: 1,
            filter: "blur(0px)",
            duration: 1.4,
            ease: "power4.out",

            scrollTrigger: {

                trigger: stage,

                start: "top 85%",

                toggleActions:
                    "play none none reverse"

            }

        }

    );


    /* -----------------------------------------------------
       GIANT NUMBER PARALLAX
       ----------------------------------------------------- */

    const number =
        section.querySelector(
            ".chase-analysis-number"
        );


    swimticsGSAP.to(

        number,

        {
            y: -80,

            ease: "none",

            scrollTrigger: {

                trigger: section,

                start: "top bottom",

                end: "bottom top",

                scrub: true

            }

        }

    );

}


