        /* ===== UPGRADE loadProfile() ===== */

        function loadProfile() {

            /* a saved profile that can't be read is left exactly as saved:
               the form starts blank and a recovery message says why
               (saved-data-check.js) */
            const saved = swimticsSavedData.readSaved("profile");
            const profile = saved.status === "ok" ? saved.value : {};
            renderProfileDataRecovery(saved);

            /* ===== BASIC INFO ===== */
            document.getElementById("name").value = profile.name || "";
            document.getElementById("dob").value = profile.dob || "";
            document.getElementById("gender").value = profile.gender || "";
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

            /* the saved photo is set as a property, never as HTML */
            if (profile.photo) {
                const img = document.createElement("img");
                img.src = profile.photo;
                img.alt = "Profile";
                imgBox.replaceChildren(img);
            } else {
                imgBox.textContent = "Upload Image";
            }

            /* ===== REFRESH STROKE CARDS ===== */
            renderStrokeCards();
            updateProfileAccountSection();

        }

        /* The recovery message at the top of Profile: for a saved profile
           that can't be read, and a short note when the saved PBs can't be
           read (the stroke cards then show no times). Empty otherwise. */
        function renderProfileDataRecovery(saved) {
            const box = document.getElementById("profileDataRecovery");
            if (!box) return;
            box.replaceChildren();

            if (swimticsSavedData.needsRecovery(saved)) {
                swimticsSavedData.renderSavedDataRecovery(box, saved, {
                    /* the same account markers own the profile and the PBs */
                    accountOwned: pbListBelongsToAccount,
                    /* the form is left as it is, so anything already typed
                       into it can now be saved with Save Profile */
                    afterReset: (message) => {
                        renderProfileDataRecovery(swimticsSavedData.readSaved("profile"));
                        renderStrokeCards();
                        const status = document.getElementById("profileSaveStatus");
                        if (status) {
                            status.textContent = message;
                            status.dataset.kind = "ok";
                        }
                        document.getElementById("name").focus();
                    },
                });
            }

            if (swimticsSavedData.needsRecovery(swimticsSavedData.readSaved("pbs"))) {
                const note = document.createElement("p");
                note.className = "tool-message saved-data-pbs-note";
                note.dataset.kind = "error";
                note.append("Your saved personal bests can't be read, so the stroke cards show no times. ");
                const go = document.createElement("button");
                go.type = "button";
                go.className = "recovery-btn";
                go.textContent = "Go to Wall of Records";
                go.addEventListener("click", () => window.showPage("pb"));
                note.append(go);
                box.append(note);
            }

            renderAccountSavedDataNotes(box);
        }

        /* While an account is signed in (account.js or the Supabase account
           code sets window.swimticsAccountSavedData): unreadable copies of
           THIS account's working copy that were kept instead of being
           replaced, and a note when this device's own set-aside data can't
           be read. Nothing here sends anything to the account. */
        function renderAccountSavedDataNotes(box) {
            const account = window.swimticsAccountSavedData;
            if (!account || typeof account.status !== "function") return;
            let status;
            try { status = account.status(); } catch (e) { console.error(e); return; }
            if (!status) return;

            for (const copy of status.copies || []) {
                swimticsSavedData.renderAccountCopyRecovery(box, copy, {
                    onDiscarded: (message) => {
                        renderProfileDataRecovery(swimticsSavedData.readSaved("profile"));
                        const statusLine = document.getElementById("profileSaveStatus");
                        if (statusLine) {
                            statusLine.textContent = message;
                            statusLine.dataset.kind = "ok";
                        }
                    },
                });
            }

            const unreadable = status.deviceUnreadable || [];
            if (unreadable.length) {
                const note = document.createElement("p");
                note.className = "tool-message saved-data-device-note";
                note.dataset.kind = "info";
                note.textContent = swimticsSavedData.deviceDataNoteText(unreadable);
                box.append(note);
            }
        }

        /* true (and says why) when the saved profile can't be read: nothing
           is written over it until the person chooses a recovery action */
        function profileSaveBlocked(what) {
            const saved = swimticsSavedData.readSaved("profile");
            if (!swimticsSavedData.needsRecovery(saved)) return false;
            const status = document.getElementById("profileSaveStatus");
            if (status) {
                status.textContent = `${what} wasn't saved, because your saved profile can't be read. Save a backup or start fresh using the message at the top of Profile first.`;
                status.dataset.kind = "error";
            }
            renderProfileDataRecovery(saved);
            return true;
        }

        /* Save Profile (whichever account code defines saveProfile()) is
           held back while the saved profile can't be read. Checked before
           the button's own handler runs, which then doesn't run at all. */
        document.addEventListener("click", (e) => {
            const btn = e.target instanceof Element ? e.target.closest("button[onclick='saveProfile()']") : null;
            if (btn && profileSaveBlocked("Your profile")) {
                e.preventDefault();
                e.stopPropagation();
            }
        }, true);

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

            const saved = swimticsSavedData.readSaved("profile");
            if (saved.status !== "ok") return;
            const profile = saved.value;

            /* saved profile text is set as text, never parsed as HTML */
            const line = (text) => {
                const div = document.createElement("div");
                div.textContent = text;
                return div;
            };

            document.getElementById("summaryContent").replaceChildren(
                line(`Name: ${profile.name || "—"}`),
                line(`Stroke: ${profile.primaryStroke || "—"}`),
                line(`Level: ${profile.level || "—"}`),
                document.createElement("br"),
                line(`Height: ${profile.height || "-"} cm`),
                line(`Weight: ${profile.weight || "-"} kg`),
                document.createElement("br"),
                line(`🎯 ${profile.shortGoal || "No goal set"}`)
            );
        }

        function renderStrokeCards() {

            const profile = swimticsSavedData.usableProfile();

            const clubName = profile.club || "Club";
            const nationality = profile.nationality || "🌍";
            const athleteGender = (profile.gender || "male").toLowerCase();
            const enteredGender = (profile.gender || "").trim();
            const genderLabel =
                enteredGender === "" ? "--"
                : enteredGender.toLowerCase() === "female" ? "♀ Female"
                : enteredGender.toLowerCase() === "male" ? "♂ Male"
                : enteredGender;   // set as text below, so no escaping is needed

            const container = document.getElementById("strokeCards");
            if (!container) return;

            container.replaceChildren();

            /* Saved values (nationality, club, gender, PB times, card photo)
               come from localStorage and, with accounts on, from synced
               account data. They are always set as text or as a property,
               never parsed as HTML. */
            const el = (tag, className, text) => {
                const node = document.createElement(tag);
                if (className) node.className = className;
                if (text !== undefined) node.textContent = text;
                return node;
            };
            /* text lines separated by <br>, as the cards have always shown them */
            const linesEl = (className, lines) => {
                const node = el("div", className);
                lines.forEach((text, i) => {
                    if (i > 0) node.append(document.createElement("br"));
                    node.append(`${text}`);
                });
                return node;
            };

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

                if (score >= 95) card.append(el("div", "fire-overlay"));

                const bg = el("div", "card-bg-image");
                const bgImg = document.createElement("img");
                bgImg.src = data.photo ? data.photo : "https://via.placeholder.com/500";
                bg.append(bgImg);

                const top = el("div", "top-content");
                top.append(
                    el("div", "stroke-score", `${score || "--"}`),
                    el("div", "stroke-name", stroke.toUpperCase()),
                    linesEl("stroke-meta", [nationality, clubName, genderLabel])
                );

                const content = el("div", "card-content");
                content.append(
                    top,
                    linesEl("stroke-times", [`50m: ${t50}`, `100m: ${t100}`, `200m: ${t200}`])
                );

                card.append(bg, content);

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

            let pbs = swimticsSavedData.usablePbs();
            const profile = swimticsSavedData.usableProfile();

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
                    /* shown as the Wall of Records shows it (pb.js) */
                    return displayPBTime(pb.time);
                }
            }

            return "--";
        }

        

        function uploadProfileImage() {

            if (profileSaveBlocked("The photo")) return;

            const input = document.createElement("input");
            input.type = "file";
            input.accept = "image/*";

            input.onchange = function (e) {

                const file = e.target.files[0];
                if (!file) return;

                const reader = new FileReader();

                reader.onload = function (event) {

                    /* checked again: the saved profile may have changed
                       while the picker was open */
                    if (profileSaveBlocked("The photo")) return;
                    let profile = swimticsSavedData.usableProfile();

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

