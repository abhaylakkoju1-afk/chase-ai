        /* ===== UPGRADE loadProfile() ===== */

        function loadProfile() {

            const profile = JSON.parse(localStorage.getItem("profile")) || {};

            /* ===== BASIC INFO ===== */
            document.getElementById("name").value = profile.name || "";
            document.getElementById("dob").value = profile.dob || "";
            document.getElementById("gender").value = profile.gender || "male";
            document.getElementById("nationality").value = profile.nationality || "";
            document.getElementById("club").value = profile.club || "";

            /* ===== SWIMMING PROFILE ===== */
            document.getElementById("primaryStroke").value = profile.primaryStroke || "";
            document.getElementById("secondaryStroke").value = profile.secondaryStroke || "";
            document.getElementById("eventsPref").value = profile.eventsPref || "";
            document.getElementById("distanceType").value = profile.distanceType || "";

            /* ===== PHYSICAL DATA ===== */
            document.getElementById("height").value = profile.height || "";
            document.getElementById("weight").value = profile.weight || "";
            document.getElementById("wingspan").value = profile.wingspan || "";

            /* ===== PERFORMANCE ===== */
            document.getElementById("strengths").value = profile.strengths || "";
            document.getElementById("weaknesses").value = profile.weaknesses || "";

            /* ===== TRAINING ===== */
            document.getElementById("level").value = profile.level || "";
            document.getElementById("hours").value = profile.hours || "";
            document.getElementById("coach").value = profile.coach || "";
            document.getElementById("facility").value = profile.facility || "";

            /* ===== GOALS ===== */
            document.getElementById("shortGoal").value = profile.shortGoal || "";
            document.getElementById("longGoal").value = profile.longGoal || "";
            document.getElementById("competition").value = profile.competition || "";

            /* ===== HISTORY ===== */
            document.getElementById("lastComp").value = profile.lastComp || "";
            document.getElementById("bestMeet").value = profile.bestMeet || "";
            document.getElementById("medals").value = profile.medals || "";

            /* ===== OVERVIEW CARD ===== */
            document.getElementById("displayName").innerText =
                profile.name || "Athlete Name";

            document.getElementById("displayStroke").innerText =
                profile.primaryStroke || "--";

            document.getElementById("displayLevel").innerText =
                profile.level || "--";

            document.getElementById("displayHeight").innerText =
                profile.height || "--";

            document.getElementById("displayWeight").innerText =
                profile.weight || "--";

            document.getElementById("displayGoal").innerText =
                profile.shortGoal || "--";

            // ===== PROFILE IMAGE =====
            const imgBox = document.getElementById("profileImageBox");

            if (profile.photo) {
                imgBox.innerHTML = `<img src="${profile.photo}" alt="Profile">`;
            } else {
                imgBox.innerHTML = "Upload Image";
            }

            /* ===== REFRESH STROKE CARDS ===== */
            renderStrokeCards();
            updateProfileAccountSection();

        }

        window.addEventListener("load", () => {
            const btn = document.getElementById("save-profile-btn");
            if (btn) {
                btn.addEventListener("click", saveProfile);
                console.log("Save Profile listener attached");
            } else {
                console.log("Save Profile button not found");
            }
        });

        function updateProfileSummary() {

            const profile = JSON.parse(localStorage.getItem("profile"));
            if (!profile) return;

            document.getElementById("summaryContent").innerHTML = `
<div>Name: ${profile.name || "—"}</div>
<div>Stroke: ${profile.primaryStroke || "—"}</div>
<div>Level: ${profile.level || "—"}</div>

<br>

<div>Height: ${profile.height || "-"} cm</div>
<div>Weight: ${profile.weight || "-"} kg</div>

<br>

<div>🎯 ${profile.shortGoal || "No goal set"}</div>
`;
        }

        function renderStrokeCards() {

            const profile = JSON.parse(localStorage.getItem("profile")) || {};

            const clubName = profile.club || "Club";
            const nationality = profile.nationality || "🌍";
            const athleteGender = (profile.gender || "male").toLowerCase();

            const container = document.getElementById("strokeCards");
            if (!container) return;

            container.innerHTML = "";

            const strokes = ["freestyle", "backstroke", "breaststroke", "butterfly"];

            strokes.forEach(stroke => {

                let t50 = "--", t100 = "--", t200 = "--";

                if (stroke === "freestyle") {
                    t50 = getPB("Freestyle 50m");
                    t100 = getPB("Freestyle 100m");
                    t200 = getPB("Freestyle 200m");
                }

                if (stroke === "backstroke") {
                    t50 = getPB("Backstroke 50m");
                    t100 = getPB("Backstroke 100m");
                    t200 = getPB("Backstroke 200m");
                }

                if (stroke === "breaststroke") {
                    t50 = getPB("Breaststroke 50m");
                    t100 = getPB("Breaststroke 100m");
                    t200 = getPB("Breaststroke 200m");
                }

                if (stroke === "butterfly") {
                    t50 = getPB("Butterfly 50m");
                    t100 = getPB("Butterfly 100m");
                    t200 = getPB("Butterfly 200m");
                }

                /* ===== GENDER-SPECIFIC STROKE DATA ===== */
                let data = {};

                if (
                    strokeData[athleteGender] &&
                    strokeData[athleteGender][stroke]
                ) {
                    data = strokeData[athleteGender][stroke];
                } else {
                    data = strokeData[stroke] || {};
                }

                /* ===== GENDER-BASED SCORE ===== */
                const score = calculateStrokeScore(stroke, athleteGender);

                let rarityClass = "";

                if (score >= 95) rarityClass = "elite";
                else if (score >= 85) rarityClass = "gold";
                else if (score >= 75) rarityClass = "silver";
                else if (score >= 50) rarityClass = "bronze";
                else rarityClass = "normal";

                const card = document.createElement("div");
                card.className = `stroke-card ${rarityClass}`;

                card.ondblclick = () => changeStrokeImage(stroke);

                card.innerHTML = `

${score >= 95 ? '<div class="fire-overlay"></div>' : ''}

<div class="card-bg-image">
    <img src="${data.photo ? data.photo : 'https://via.placeholder.com/500'}">
</div>

<div class="card-content">

    <div class="top-content">

        <div class="stroke-score">
            ${score || "--"}
        </div>

        <div class="stroke-name">
            ${stroke.toUpperCase()}
        </div>

        <div class="stroke-meta">
            ${nationality}<br>
            ${clubName}<br>
            ${athleteGender === "female" ? "♀ Female" : "♂ Male"}
        </div>

    </div>

    <div class="stroke-times">
        50m: ${t50}<br>
        100m: ${t100}<br>
        200m: ${t200}
    </div>

</div>
`;

                container.appendChild(card);

            });
        }

        function changeStrokeImage(stroke) {

            const input = document.createElement("input");
            input.type = "file";
            input.accept = "image/*";

            input.onchange = function (e) {

                const file = e.target.files[0];
                if (!file) return;

                const reader = new FileReader();

                reader.onload = function (event) {

                    // Load current stroke data
                    let savedStrokeData =
                        JSON.parse(localStorage.getItem("strokeData")) || {};

                    if (!savedStrokeData[stroke])
                        savedStrokeData[stroke] = {};

                    // Save new photo
                    savedStrokeData[stroke].photo = event.target.result;

                    // Store back
                    localStorage.setItem(
                        "strokeData",
                        JSON.stringify(savedStrokeData)
                    );

                    // Update global object
                    strokeData = savedStrokeData;

                    // Re-render cards
                    renderStrokeCards();
                };

                reader.readAsDataURL(file);
            };

            input.click();
        }

        function calculateStrokeScore(stroke, gender = "male") {

            let pbs = JSON.parse(localStorage.getItem("pbs")) || [];
            const profile = JSON.parse(localStorage.getItem("profile")) || {};

            const athleteGender = (profile.gender || "male").toLowerCase();

            const worldRecords = {
                male: {
                    "50 Freestyle": 20.91,
                    "100 Freestyle": 46.86,
                    "200 Freestyle": 101.91,

                    "50 Backstroke": 23.55,
                    "100 Backstroke": 51.60,
                    "200 Backstroke": 111.92,

                    "50 Butterfly": 22.27,
                    "100 Butterfly": 49.45,
                    "200 Butterfly": 110.34,

                    "50 Breaststroke": 25.95,
                    "100 Breaststroke": 56.88,
                    "200 Breaststroke": 126.12,

                    "200 IM": 114.00,
                    "400 IM": 240.84
                },

                female: {
                    "50 Freestyle": 23.61,
                    "100 Freestyle": 51.71,
                    "200 Freestyle": 112.98,

                    "50 Backstroke": 26.86,
                    "100 Backstroke": 57.13,
                    "200 Backstroke": 123.35,

                    "50 Butterfly": 24.43,
                    "100 Butterfly": 55.18,
                    "200 Butterfly": 123.61,

                    "50 Breaststroke": 29.16,
                    "100 Breaststroke": 62.35,
                    "200 Breaststroke": 134.95,

                    "200 IM": 124.32,
                    "400 IM": 255.11
                }
            };

            const WR = worldRecords[gender];

            function getTime(event) {
                for (let pb of pbs) {
                    if (pb.event.toLowerCase() === event.toLowerCase()) {
                        return timeToSeconds(pb.time);
                    }
                }
                return null;
            }

            let scores = [];

            /* ===== 50M ===== */
            let t50 = getTime(`${capitalize(stroke)} 50m`);
            if (t50 && WR[`50 ${capitalize(stroke)}`]) {
                let s = (WR[`50 ${capitalize(stroke)}`] / t50) * 100;
                scores.push({ score: s, weight: 0.3 });
            }

            /* ===== 100M ===== */
            let t100 = getTime(`${capitalize(stroke)} 100m`);
            if (t100 && WR[`100 ${capitalize(stroke)}`]) {
                let s = (WR[`100 ${capitalize(stroke)}`] / t100) * 100;
                scores.push({ score: s, weight: 0.4 });
            }

            /* ===== 200M ===== */
            let t200 = getTime(`${capitalize(stroke)} 200m`);
            if (t200 && WR[`200 ${capitalize(stroke)}`]) {
                let s = (WR[`200 ${capitalize(stroke)}`] / t200) * 100;
                scores.push({ score: s, weight: 0.3 });
            }

            if (scores.length === 0) return "--";

            /* ===== WEIGHTED SCORE ===== */
            let total = 0;
            let totalWeight = 0;

            scores.forEach(s => {
                total += s.score * s.weight;
                totalWeight += s.weight;
            });

            return Math.round(total / totalWeight);
        }

        function capitalize(s) {
            return s.charAt(0).toUpperCase() + s.slice(1);
        }

        
        function getPB(eventName) {

            for (let pb of pbs) {
                if (pb.event === eventName) {
                    return pb.time;
                }
            }

            return "--";
        }

        

        function uploadProfileImage() {

            const input = document.createElement("input");
            input.type = "file";
            input.accept = "image/*";

            input.onchange = function (e) {

                const file = e.target.files[0];
                if (!file) return;

                const reader = new FileReader();

                reader.onload = function (event) {

                    let profile =
                        JSON.parse(localStorage.getItem("profile")) || {};

                    profile.photo = event.target.result;

                    localStorage.setItem(
                        "profile",
                        JSON.stringify(profile)
                    );

                    loadProfile();
                };

                reader.readAsDataURL(file);
            };

            input.click();
        }

