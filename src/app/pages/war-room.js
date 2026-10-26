        function generateWarRoomPlan() {

            try {

                // =====================================================
                // CORE INPUTS
                // =====================================================
                const days = parseInt(document.getElementById("meetDays")?.value) || 0;
                const fatigue = parseInt(document.getElementById("fatigue")?.value) || 1;
                const sleep = parseInt(document.getElementById("sleep")?.value) || 1;
                const soreness = parseInt(document.getElementById("soreness")?.value) || 1;
                const season = document.getElementById("season").value;
                const nutrition = parseInt(document.getElementById("nutrition")?.value) || 1;
                const training = parseInt(document.getElementById("trainingIntensity")?.value) || 1;
                const mental = parseInt(document.getElementById("mentalReadiness")?.value) || 1;
                const raceType = document.getElementById("raceType")?.value || "mid";

                // =====================================================
                // ADVANCED NUTRITION INPUTS
                // =====================================================
                const carbs = parseInt(document.getElementById("carbs")?.value) || 1;
                const protein = parseInt(document.getElementById("protein")?.value) || 1;
                const fats = parseInt(document.getElementById("fats")?.value) || 1;
                const hydration = parseInt(document.getElementById("hydration")?.value) || 1;
                const micros = parseInt(document.getElementById("micros")?.value) || 1;

                // =====================================================
                // SORENESS MAP
                // =====================================================
                let soreParts = [];

                for (const part in sorenessMap) {
                    if (sorenessMap[part] > 0) {
                        soreParts.push({
                            part: part,
                            level: sorenessMap[part]
                        });
                    }
                }


                // =====================================================
                // SCORE SYSTEM
                // =====================================================
                let score = 100;

                score -= fatigue * 3;
                score -= sleep * 3;
                score -= soreness * 2;
                score -= nutrition * 2;
                score -= training * 2;
                score -= mental * 2;

                score -= carbs * 1;
                score -= protein * 1;
                score -= fats * 1;
                score -= hydration * 1;
                score -= micros * 1;

                soreParts.forEach(p => {
                    score -= p.level * 1;
                });

                score = Math.max(0, Math.min(100, score));

                // =====================================================
                // OUTPUT ARRAYS
                // =====================================================
                let performancePlan = [];
                let recoveryPlan = [];
                let nutritionPlan = [];
                let seasonAdvice = "";
                let sorenessPlan = [];

                // =====================================================
                // RACE TYPE
                // =====================================================
                if (raceType === "sprint") {
                    performancePlan.push("Sprint priority: explosive speed, neural sharpness, starts, turns, power output.");
                }
                else if (raceType === "mid") {
                    performancePlan.push("Mid-distance priority: race pace control, lactate tolerance, aerobic speed.");
                }
                else {
                    performancePlan.push("Distance priority: aerobic conditioning, pacing precision, efficiency.");
                }

                // =====================================================
                // TAPER
                // =====================================================
                if (days > 21) {
                    performancePlan.push("Maintain progressive overload with full performance build.");
                }
                else if (days > 14) {
                    performancePlan.push("Controlled taper initiated: reduce volume ~15–20%, maintain speed.");
                }
                else if (days > 7) {
                    performancePlan.push("Performance taper: reduce volume 25–35%, sharpen race skills.");
                }
                else {
                    performancePlan.push("Peak taper mode: maximize freshness, power, and nervous system readiness.");
                }

                // =====================================================
                // GENERAL RECOVERY
                // =====================================================
                if (fatigue >= 2)
                    recoveryPlan.push("Elevated fatigue: prioritize sleep extension, mobility, sauna, and active flush sessions.");

                if (sleep >= 2)
                    recoveryPlan.push("Sleep deficit: target 8.5–10 hrs, naps, magnesium, and blue-light reduction.");

                if (training >= 2)
                    recoveryPlan.push("Heavy training load: include ice baths, massage, compression, and glycogen restoration.");

                if (mental >= 2)
                    recoveryPlan.push("Mental fatigue: emphasize visualization, meditation, and emotional reset protocols.");

                // =====================================================
                // BATH THERAPY
                // =====================================================
                if (score < 75) {
                    recoveryPlan.push("Recommended: Ice bath (8–12 min) for inflammation control.");
                }

                if (score < 85) {
                    recoveryPlan.push("Recommended: Sauna (15–20 min) to improve circulation and recovery.");
                }

                // =====================================================
                // TARGETED SORENESS MAP RECOVERY
                // =====================================================
                soreParts.forEach(item => {

                    switch (item.part) {

                        case "Shoulders":
                            sorenessPlan.push("Shoulders: Rotator cuff band work, sleeper stretch, scapular stability, shoulder flossing.");
                            break;

                        case "Chest":
                            sorenessPlan.push("Chest: Pec mobility, doorway stretch, thoracic opening, light activation.");
                            break;

                        case "Biceps":
                            sorenessPlan.push("Biceps: Soft tissue massage, eccentric release, elbow mobility.");
                            break;

                        case "Forearms":
                            sorenessPlan.push("Forearms: Wrist mobility, grip decompression, forearm rolling.");
                            break;

                        case "Upper Core":
                            sorenessPlan.push("Upper Core: Thoracic mobility, breathing drills, trunk activation.");
                            break;

                        case "Lower Core":
                            sorenessPlan.push("Lower Core: Deep core activation, pelvic control, trunk stabilization.");
                            break;

                        case "Hips":
                            sorenessPlan.push("Hips: Hip CARs, mobility flows, glute activation, banded openers.");
                            break;

                        case "Hip Flexors":
                            sorenessPlan.push("Hip Flexors: Couch stretch, psoas release, mobility sequencing.");
                            break;

                        case "Adductors":
                            sorenessPlan.push("Adductors: Copenhagen mobility, groin stretching, lateral activation.");
                            break;

                        case "IT Band":
                            sorenessPlan.push("IT Band: Foam rolling, TFL release, lateral glute strengthening.");
                            break;

                        case "Quads":
                            sorenessPlan.push("Quads: Quad rolling, compression, flush bike, stretch.");
                            break;

                        case "Hamstrings":
                            sorenessPlan.push("Hamstrings: Nordic mobility, posterior chain release, neural flossing.");
                            break;

                        case "Calves":
                            sorenessPlan.push("Calves: Soleus stretch, calf raises, ankle mobility.");
                            break;

                        case "Tibialis":
                            sorenessPlan.push("Tibialis: Toe raises, shin release, ankle dorsiflexion.");
                            break;

                        case "Achilles Tendons":
                            sorenessPlan.push("Achilles: Eccentric calf raises, tendon loading, ankle recovery.");
                            break;

                        case "Traps":
                            sorenessPlan.push("Traps: Neck decompression, trap release, posture reset.");
                            break;

                        case "Lats":
                            sorenessPlan.push("Lats: Lat stretch, overhead mobility, scapular release.");
                            break;

                        case "Upper Back":
                            sorenessPlan.push("Upper Back: Thoracic extension, mobility, scapular mechanics.");
                            break;

                        case "Lower Back":
                            sorenessPlan.push("Lower Back: Spinal decompression, glute activation, McGill core protocol.");
                            break;

                        case "Glutes":
                            sorenessPlan.push("Glutes: Activation drills, rolling, posterior chain restoration.");
                            break;

                        case "Rear Delts":
                            sorenessPlan.push("Rear Delts: Posterior cuff activation, shoulder balancing.");
                            break;

                        case "Supraspinatus":
                            sorenessPlan.push("Supraspinatus: Controlled cuff rehab, shoulder stability.");
                            break;

                        case "Triceps":
                            sorenessPlan.push("Triceps: Overhead mobility, soft tissue release.");
                            break;

                        default:
                            sorenessPlan.push(`${item.part}: Targeted mobility, blood flow, and tissue restoration.`);
                    }
                });

                if (season === "summer") {
                    seasonAdvice = `
    ☀️ SUMMER PERFORMANCE STRATEGY:
    - Prioritize hydration aggressively (electrolytes, coconut water, lemon water, ORS)
    - Increase cooling foods:
      • Watermelon
      • Cucumber
      • Yogurt/curd
      • Bananas
      • Coconut water
      • Muskmelon
    - Pre-training:
      • Oats + banana
      • Peanut butter toast
      • Fruit smoothies
    - Recovery:
      • Rice + lean protein
      • Curd rice
      • Eggs + vegetables
    - Avoid:
      • Heavy oily foods
      • Excess fried meals
      • Dehydrating soft drinks
    - Focus:
      Heat management, electrolyte balance, recovery speed.
    `;
                }

                else if (season === "monsoon") {
                    seasonAdvice = `
    🌧️ MONSOON PERFORMANCE STRATEGY:
    - Focus on immunity and digestion.
    - Best foods:
      • Ginger tea
      • Turmeric milk
      • Soups
      • Steamed vegetables
      • Seasonal fruits
      • Khichdi
      • Dry fruits
    - Protein:
      • Eggs
      • Chicken
      • Dal
      • Paneer
    - Avoid:
      • Street food
      • Excess raw salads
      • Unsafe water
    - Focus:
      Immune defense, gut health, infection prevention.
    `;
                }

                else if (season === "winter") {
                    seasonAdvice = `
    ❄️ WINTER PERFORMANCE STRATEGY:
    - Prioritize strength, muscle recovery, and warmth.
    - Best foods:
      • Oatmeal
      • Nuts
      • Dates
      • Sweet potatoes
      • Ghee in moderation
      • Eggs
      • Chicken/fish
      • Soups
      • Millet rotis
    - Pre-training:
      • Banana + peanut butter
      • Warm oats
    - Recovery:
      • High-protein meals
      • Complex carbs
    - Avoid:
      • Under-eating
      • Poor hydration
    - Focus:
      Strength building, endurance, immune resilience.
    `;
                }

                else if (season === "precompetition") {
                    seasonAdvice = `
    🏆 COMPETITION SEASON STRATEGY:
    - Precision fueling only.
    - Prioritize:
      • Lean proteins
      • Rice/pasta
      • Potatoes
      • Bananas
      • Sports drinks
      • Easily digestible carbs
    - Taper nutrition:
      • Lower junk food
      • Controlled fiber before races
      • Glycogen optimization
    - Race-day:
      • Toast
      • Banana
      • Honey
      • Electrolytes
    - Avoid:
      • Heavy meals
      • New foods
      • Excess sugar crashes
    - Focus:
      Peak readiness, race energy, optimal body composition.
    `;
                }

                // =====================================================
                // NUTRITION SYSTEM
                // =====================================================

                // CARBS
                if (carbs >= 2) {
                    nutritionPlan.push("Carbohydrates low: Increase rice, oats, sweet potatoes, bananas, pasta, whole grains.");
                } else {
                    nutritionPlan.push("Carbs optimized: Maintain glycogen with oats, fruit, rice, potatoes.");
                }

                // PROTEIN
                if (protein >= 2) {
                    nutritionPlan.push("Protein low: Increase eggs, chicken, fish, Greek yogurt, whey, lean beef.");
                } else {
                    nutritionPlan.push("Protein adequate: Maintain muscle repair intake.");
                }

                // FATS
                if (fats >= 2) {
                    nutritionPlan.push("Healthy fats low: Increase salmon, avocado, nuts, olive oil, seeds.");
                } else {
                    nutritionPlan.push("Healthy fats balanced.");
                }

                // HYDRATION
                if (hydration >= 2) {
                    nutritionPlan.push("Hydration low: Increase water, electrolytes, sodium, coconut water.");
                } else {
                    nutritionPlan.push("Hydration strong.");
                }

                // MICRONUTRIENTS
                if (micros >= 2) {
                    nutritionPlan.push("Micronutrients low: Increase berries, spinach, citrus, dairy, magnesium foods.");
                } else {
                    nutritionPlan.push("Micronutrients balanced.");
                }

                // =====================================================
                // PERFORMANCE TIER
                // =====================================================
                let status = "";

                if (score >= 90) status = "ELITE";
                else if (score >= 80) status = "HIGH";
                else if (score >= 70) status = "MODERATE";
                else status = "RECOVERY PRIORITY";

                // =====================================================
                // DISPLAY OUTPUT
                // =====================================================
                const dashboard = document.getElementById("dashboardOutput");

                if (!dashboard) {
                    alert("Dashboard output section missing.");
                    return;
                }

                let barColor = "";
                if (score >= 80) {
                    barColor = "linear-gradient(90deg, #00ff88, #00c851)";
                } else if (score >= 60) {
                    barColor = "linear-gradient(90deg, #ffd54f, #ff9800)";
                } else if (score >= 45) {
                    barColor = "linear-gradient(90deg, #ffb74d, #ff5722)";
                } else {
                    barColor = "linear-gradient(90deg, #ff4d4d, #b71c1c)";
                }

                dashboard.innerHTML = `
            <div class="metric-box">

                <h2>🏊 WAR ROOM REPORT</h2>

                <div class="readiness-container">        
                    
                    <div class="readiness-label">            
                    <span>Meet Readiness Score</span>            
                    <span>${score}/100</span>        
                </div>        
                
                <div class="readiness-bar">            
                <div class="readiness-fill"                 
                style="                    
                width: ${score}%;                    
                background: ${barColor};                 
                ">            
                </div>        
                </div>    
                </div>    
                
                <p><strong>Status:</strong> ${status}</p>

                <h3>⚔ Performance Plan</h3>
                <ul>
                    ${performancePlan.map(item => `<li>${item}</li>`).join("")}
                </ul>

                <h3>🛠 Recovery Protocol</h3>
                <ul>
                    ${recoveryPlan.map(item => `<li>${item}</li>`).join("")}
                </ul>

                <h3>🎯 Targeted Soreness Recovery</h3>
                <ul>
                    ${sorenessPlan.length
                        ? sorenessPlan.map(item => `<li>${item}</li>`).join("")
                        : "<li>No major soreness detected.</li>"
                    }
                </ul>

                <div class="metric-box">
                <h3>Seasonal Performance Fueling</h3>
                <p>${seasonAdvice}</p>
                </div>

                <h3>🍽 Nutrition Optimization</h3>
                <ul>
                    ${nutritionPlan.map(item => `<li>${item}</li>`).join("")}
                </ul>

            </div>
        `;

            } catch (error) {
                console.error("War Room Generation Error:", error);
                // shown where the plan would appear, not as a browser alert
                const output = document.getElementById("dashboardOutput");
                if (output) {
                    output.innerHTML = `<p class="tool-message" data-kind="error" role="alert">War Room generation failed. Please try again.</p>`;
                } else {
                    alert("War Room generation failed. Check console.");
                }
            }
        }

function toggleCoach() {

    const panel =
        document.getElementById("aiCoachPanel");

    if (panel.style.display === "flex") {

        panel.style.display = "none";

    } else {

        panel.style.display = "flex";

    }
}

        function sendCoachMessage() {

            const input =
                document.getElementById("coachInput");

            const msg = input.value.trim();

            if (!msg) return;

            const chat =
                document.getElementById("coachMessages");

            chat.innerHTML +=
                `<div class="coach-msg"><b>You:</b> ${msg}</div>`;

            let reply =
                generateCoachResponse(msg);

            chat.innerHTML +=
                `<div class="coach-msg"><b>ATLAS:</b> ${reply}</div>`;

            input.value = "";

            chat.scrollTop = chat.scrollHeight;
        }

        function generateCoachResponse(msg) {

            msg = msg.toLowerCase();

            // ===== WORLD RECORD LOOKUP =====
            if (
                msg.includes("world record") ||
                msg.includes("record holder") ||
                msg.includes("fastest time") ||
                pendingWorldRecordEvent ||
                pendingWorldRecordCategory
            ) {

                let category = pendingWorldRecordCategory;
                let detectedEvent = pendingWorldRecordEvent;

                // ===== CATEGORY =====
                if (
                    msg.includes("men") ||
                    msg.includes("male") ||
                    msg.includes("boys")
                ) {
                    category = "men";
                }

                if (
                    msg.includes("women") ||
                    msg.includes("female") ||
                    msg.includes("girls")
                ) {
                    category = "women";
                }

                // ===== EVENT ALIASES =====
                const eventAliases = {
                    "50 free": "50 freestyle",
                    "50m freestyle": "50 freestyle",
                    "100 free": "100 freestyle",
                    "100m freestyle": "100 freestyle",
                    "200 free": "200 freestyle",
                    "200m freestyle": "200 freestyle",
                    "400 free": "400 freestyle",
                    "400m freestyle": "400 freestyle",
                    "800 free": "800 freestyle",
                    "1500 free": "1500 freestyle",

                    "50 back": "50 backstroke",
                    "100 back": "100 backstroke",
                    "200 back": "200 backstroke",

                    "50 breast": "50 breaststroke",
                    "100 breast": "100 breaststroke",
                    "200 breast": "200 breaststroke",

                    "50 fly": "50 butterfly",
                    "100 fly": "100 butterfly",
                    "200 fly": "200 butterfly",

                    "200 im": "200 individual medley",
                    "400 im": "400 individual medley"
                };

                for (const alias in eventAliases) {
                    if (msg.includes(alias)) {
                        detectedEvent = eventAliases[alias];
                        break;
                    }
                }

                if (!detectedEvent) {
                    for (const gender in swimmingWorldRecords) {
                        for (const event in swimmingWorldRecords[gender]) {
                            if (msg.includes(event)) {
                                detectedEvent = event;
                                break;
                            }
                        }
                    }
                }

                // ===== STORE PARTIAL CONTEXT =====
                pendingWorldRecordEvent = detectedEvent;
                pendingWorldRecordCategory = category;

                // ===== RESPONSES =====
                if (!detectedEvent) {
                    return "Please specify the stroke and distance for the world record you want.";
                }

                if (!category) {
                    return `Please specify whether you want the men's or women's ${detectedEvent} world record.`;
                }

                // ===== FINAL ANSWER =====
                const answer =
                    `${category.toUpperCase()} ${detectedEvent} world record: ${swimmingWorldRecords[category][detectedEvent]}.`;

                // Reset memory
                pendingWorldRecordEvent = null;
                pendingWorldRecordCategory = null;

                return answer;
            }

            // ===== FREESTYLE =====
            if (msg.includes("freestyle") || msg.includes("free") || msg.includes("crawl")) {
                return "Freestyle performance improves through high-elbow catch, early vertical forearm, efficient body rotation, kick timing, breathing control, and maximizing distance per stroke. Sprint swimmers need higher stroke rate and explosive power, while distance swimmers prioritize efficiency and aerobic sustainability.";
            }

            // ===== BACKSTROKE =====
            if (msg.includes("backstroke") || msg.includes("back")) {
                return "Backstroke success depends on shoulder rotation, clean hand entry, stable head position, strong catch mechanics, underwater dolphin efficiency, and turn execution.";
            }

            // ===== BREASTSTROKE =====
            if (msg.includes("breaststroke") || msg.includes("breast")) {
                return "Breaststroke requires elite timing between pull, kick, and glide, efficient pullouts, narrow propulsion, drag reduction, and explosive hip-generated kicking.";
            }

            // ===== BUTTERFLY =====
            if (msg.includes("butterfly") || msg.includes("fly")) {
                return "Butterfly performance relies on relaxed yet powerful recovery, strong front catch, rhythm consistency, sustainable dolphin timing, and minimizing wasted vertical movement.";
            }

            // ===== INDIVIDUAL MEDLEY =====
            if (msg.includes("im") || msg.includes("individual medley")) {
                return "IM success requires balanced stroke proficiency, smooth transitions, efficient pacing, and strategic energy distribution across all four strokes.";
            }

            // ===== STARTS / DIVES =====
            if (msg.includes("start") || msg.includes("dive") || msg.includes("block")) {
                return "Elite starts require explosive block power, fast reaction time, streamlined entry, underwater momentum preservation, and aggressive breakout timing.";
            }

            // ===== TURNS =====
            if (msg.includes("turn") || msg.includes("flip turn") || msg.includes("open turn")) {
                return "Fast turns require maximal approach speed, compact mechanics, explosive push-offs, tight streamline, and optimized breakout efficiency.";
            }

            // ===== UNDERWATER =====
            if (msg.includes("underwater") || msg.includes("dolphin kick") || msg.includes("breakout")) {
                return "Underwater speed depends on core stiffness, dolphin power, low drag streamline, ankle mobility, and breakout precision.";
            }

            // ===== KICK =====
            if (msg.includes("kick") || msg.includes("flutter kick") || msg.includes("breast kick")) {
                return "Kicking efficiency improves with ankle mobility, hip power, timing precision, propulsion mechanics, and minimizing drag.";
            }

            // ===== PULL =====
            if (msg.includes("pull") || msg.includes("catch")) {
                return "A powerful pull requires early vertical forearm, high-elbow positioning, water feel, lat engagement, and propulsion efficiency.";
            }

            // ===== BREATHING =====
            if (msg.includes("breathing") || msg.includes("breath control")) {
                return "Breathing should minimize drag, maintain rhythm, preserve stroke mechanics, and support oxygen delivery without disrupting efficiency.";
            }

            // ===== SPRINT =====
            if (msg.includes("sprint") || msg.includes("50m") || msg.includes("100m")) {
                return "Sprint swimming emphasizes stroke rate, power, anaerobic conditioning, explosive starts, aggressive turns, and technical precision under fatigue.";
            }

            // ===== DISTANCE =====
            if (msg.includes("distance") || msg.includes("400") || msg.includes("800") || msg.includes("1500")) {
                return "Distance success requires pacing strategy, aerobic conditioning, stroke economy, efficiency, and fatigue resistance.";
            }

            // ===== PACING =====
            if (msg.includes("pace") || msg.includes("splits") || msg.includes("race strategy")) {
                return "Optimal pacing balances energy output, lactate control, stroke tempo, and event-specific race execution.";
            }

            // ===== ENDURANCE =====
            if (msg.includes("endurance") || msg.includes("stamina") || msg.includes("aerobic")) {
                return "Endurance improves through aerobic development, threshold work, stroke economy, and strategic fatigue management.";
            }

            // ===== STRENGTH =====
            if (msg.includes("strength") || msg.includes("gym") || msg.includes("weights") || msg.includes("dryland")) {
                return "Swim-specific strength focuses on explosiveness, posterior chain development, shoulder resilience, core stability, and mobility.";
            }

            // ===== FLEXIBILITY / MOBILITY =====
            if (msg.includes("mobility") || msg.includes("flexibility") || msg.includes("stretch")) {
                return "Mobility should prioritize shoulders, thoracic spine, hips, ankles, and tissue quality to maximize mechanics and reduce injury risk.";
            }

            // ===== RECOVERY =====
            if (msg.includes("recovery") || msg.includes("fatigue") || msg.includes("foam roll")) {
                return "Recovery should include sleep, hydration, mobility, foam rolling, glycogen restoration, nervous system management, and active regeneration.";
            }

            // ===== SLEEP =====
            if (msg.includes("sleep") || msg.includes("rest")) {
                return "High-level swimmers should target 8–9+ hours of sleep for hormonal recovery, nervous system restoration, and performance optimization.";
            }

            // ===== NUTRITION =====
            if (msg.includes("nutrition") || msg.includes("diet") || msg.includes("food") || msg.includes("hydration")) {
                return "Performance nutrition requires strategic carbohydrate intake, lean protein, hydration, electrolytes, and recovery fueling.";
            }

            // ===== SUPPLEMENTS =====
            if (msg.includes("supplement") || msg.includes("creatine") || msg.includes("electrolytes")) {
                return "Useful swim supplementation may include creatine, electrolytes, omega-3s, and evidence-based recovery aids when appropriate.";
            }

            // ===== INJURY =====
            if (msg.includes("injury") || msg.includes("pain") || msg.includes("shoulder") || msg.includes("rehab")) {
                return "Injury prevention prioritizes technique efficiency, load management, rotator cuff resilience, mobility, and early intervention.";
            }

            // ===== TAPER =====
            if (msg.includes("taper") || msg.includes("meet week") || msg.includes("competition")) {
                return "Tapering reduces fatigue while preserving race sharpness through reduced volume, maintained intensity, optimized recovery, and mental freshness.";
            }

            // ===== MENTAL =====
            if (msg.includes("mental") || msg.includes("motivation") || msg.includes("confidence") || msg.includes("anxiety")) {
                return "Mental performance improves through visualization, confidence development, emotional control, competitive focus, and race rehearsal.";
            }

            // ===== PLATEAU =====
            if (msg.includes("plateau") || msg.includes("stuck") || msg.includes("improve faster")) {
                return "Breaking plateaus requires evaluating technique, strength, recovery, training structure, and progressive overload.";
            }

            // ===== GOALS =====
            if (msg.includes("goal") || msg.includes("pb") || msg.includes("personal best")) {
                return "PB progression depends on race specificity, technical gains, strength, recovery consistency, and strategic periodization.";
            }

            // ===== CAREER IN SWIMMING =====
            if (
                msg.includes("career") ||
                msg.includes("professional swimmer") ||
                msg.includes("make it in swimming") ||
                msg.includes("college swimming") ||
                msg.includes("scholarship")
            ) {
                return "Building a swimming career requires progressive competition success, elite-level training, strong national rankings, strategic coaching, scholarship opportunities, and long-term development. Pathways include state, national, collegiate, international, and professional circuits. Prioritize performance progression, visibility, networking, and event specialization.";
            }

            // ===== OLYMPICS =====
            if (
                msg.includes("olympics") ||
                msg.includes("olympic swimmer") ||
                msg.includes("qualify for olympics")
            ) {
                return "Olympic swimming requires years of elite progression, national qualification standards, international-level times, and exceptional physical and mental preparation.";
            }

            // ===== FAMOUS SWIMMERS =====
            if (
                msg.includes("best swimmer") ||
                msg.includes("famous swimmer") ||
                msg.includes("greatest swimmer")
            ) {
                return "Notable elite swimmers include Michael Phelps, Caeleb Dressel, Katie Ledecky, Adam Peaty, Sarah Sjöström, and many others depending on event specialization.";
            }

            // ===== RULES =====
            if (
                msg.includes("rules") ||
                msg.includes("disqualification") ||
                msg.includes("dq")
            ) {
                return "Swimming rules vary by stroke and event. Common DQs involve illegal turns, false starts, improper stroke mechanics, or illegal finishes.";
            }

            // ===== MEETS =====
            if (
                msg.includes("meet") ||
                msg.includes("competition format") ||
                msg.includes("heats") ||
                msg.includes("finals")
            ) {
                return "Competitive swim meets often include heats, semifinals, and finals depending on level. Success requires pacing strategy, recovery between swims, and race management.";
            }

            // ===== COACHING =====
            if (
                msg.includes("coach") ||
                msg.includes("become a coach")
            ) {
                return "A coaching career in swimming involves technical expertise, athlete development knowledge, certifications, leadership, and competitive experience.";
            }

            // ===== HISTORY =====
            if (
                msg.includes("history of swimming") ||
                msg.includes("swimming history")
            ) {
                return "Swimming has evolved from survival skill to highly technical Olympic sport, with major advances in biomechanics, training science, and competition structure.";
            }

            // ===== GENERAL KNOWLEDGE =====
            if (
                msg.includes("who") ||
                msg.includes("what") ||
                msg.includes("when") ||
                msg.includes("where")
            ) {
                return "For swimming-related general knowledge, provide a more specific question regarding events, athletes, records, rules, or career pathways.";
            }

            // ===== DEFAULT =====
            return "For elite swimming performance, optimize stroke mechanics, race strategy, strength, recovery, mobility, nutrition, and psychological readiness together. Ask a more specific question for advanced personalized coaching.";
        }

        function cycleSoreness(part, element) {

            if (!sorenessMap[part]) {
                sorenessMap[part] = 1;
            } else {
                sorenessMap[part]++;

                if (sorenessMap[part] > 3) {
                    sorenessMap[part] = 0;
                }
            }

            const colors = {
                0: "rgba(180,190,220,0.16)", // None
                1: "limegreen",               // Light
                2: "orange",                  // Moderate
                3: "red"                      // High
            };

            element.style.fill =
                colors[sorenessMap[part]];
        }

        function showBodyView(view) {

            document.getElementById("bodyFront")
                .classList.remove("active");

            document.getElementById("bodyBack")
                .classList.remove("active");

            if (view === "front") {
                document.getElementById("bodyFront")
                    .classList.add("active");
            }

            if (view === "back") {
                document.getElementById("bodyBack")
                    .classList.add("active");
            }
        }

        function showTooltip(event, name) {
            const tooltip = document.getElementById("bodyTooltip");
            tooltip.style.display = "block";
            tooltip.innerText = name;
            moveTooltip(event);
        }

        function moveTooltip(event) {
            const tooltip = document.getElementById("bodyTooltip");
            tooltip.style.left = (event.pageX + 15) + "px";
            tooltip.style.top = (event.pageY - 15) + "px";
        }

        function hideTooltip() {
            document.getElementById("bodyTooltip").style.display = "none";
        }

        function resetSorenessMap() {

            for (const part in sorenessMap) {
                sorenessMap[part] = 0;
            }

            document.querySelectorAll(".body-part")
                .forEach(part => {
                    part.style.fill =
                        "rgba(180,190,220,0.16)";
                });
        }


        
