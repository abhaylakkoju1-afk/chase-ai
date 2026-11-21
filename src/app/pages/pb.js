        /* ===== PB SYSTEM ===== */

        /* Reads a stored time loosely (used for scoring saved PBs). New and
           edited times are checked with parsePBTime() below instead. */
        function timeToSeconds(t) {
            if (t.includes(":")) {
                let p = t.split(":");
                return p[0] * 60 + parseFloat(p[1]);
            }
            return parseFloat(t);
        }

        /* The one check for every time typed into the PB form (new and edited).
           Accepts seconds ("28.45", "65") or minutes:seconds ("1:05.32",
           "1:5.32", "1:05"), with up to two decimal places; seconds after a
           colon must be 0 to 59. The time must be at least 1.00 second, for
           any event (there are no per-event limits). Anything else (negative,
           zero, "0.99", "1:65.00", "28.4x", "99:99", "1:05:32", "28.456")
           returns null. Returns seconds, exact to the hundredth. */
        function parsePBTime(text) {
            const SECONDS = /^(\d+)(?:\.(\d{1,2}))?$/;
            const MIN_SEC = /^(\d+):([0-5]?\d)(?:\.(\d{1,2}))?$/;
            const s = String(text ?? "").trim();
            let m = SECONDS.exec(s);
            let hundredths;
            if (m) {
                hundredths = Number(m[1]) * 100 + Number((m[2] || "").padEnd(2, "0"));
            } else {
                m = MIN_SEC.exec(s);
                if (!m) return null;
                hundredths = (Number(m[1]) * 60 + Number(m[2])) * 100 + Number((m[3] || "").padEnd(2, "0"));
            }
            /* at least 1.00 second (100 hundredths), for any event */
            if (!Number.isFinite(hundredths) || hundredths < 100) return null;
            return hundredths / 100;
        }

        /* The text saved for a valid typed time: as typed (trimmed), except a
           one-digit seconds part after the colon is padded ("1:5.32" becomes
           "1:05.32"). null if the time isn't valid. */
        function normalizePBTime(text) {
            if (parsePBTime(text) === null) return null;
            return String(text).trim().replace(/^(\d+):(\d)(?=\.|$)/, "$1:0$2");
        }

        /* How a saved best time is shown (PB list, edit form, Profile stroke
           cards): a valid time in the same form a new save would store
           ("1:5.32" shows as "1:05.32"); anything else exactly as saved, so
           an invalid value is never hidden. Display only: storage is not
           rewritten. */
        function displayPBTime(text) {
            const normalized = normalizePBTime(text);
            return normalized === null ? text : normalized;
        }

        /* Whether a stored history entry is a usable swim time (older data
           may hold null, negatives, times under the minimum or more than two
           decimal places). */
        function isValidPBSwim(s) {
            if (typeof s !== "number" || !Number.isFinite(s) || s <= 0) return false;
            if (Math.abs(s * 100 - Math.round(s * 100)) > 1e-6) return false;
            return parsePBTime(formatPBTime(s)) !== null; /* same rules as a typed time */
        }

        /* "26.00" or "1:05.32", for when the best time becomes a swim whose
           typed text wasn't kept (history stores seconds only). */
        function formatPBTime(seconds) {
            const hundredths = Math.round(seconds * 100);
            const mins = Math.floor(hundredths / 6000);
            const secs = ((hundredths % 6000) / 100).toFixed(2);
            return mins > 0 ? `${mins}:${secs.padStart(5, "0")}` : secs;
        }

        /* The PB being edited: the record itself (not its list position, so
           re-rendering or deleting another row can't retarget the edit) and
           which swim in its history is being corrected. null when adding. */
        let pbEdit = null;

        /* Whether the PB list on screen is an account's copy. Account sync only
           adds times and can't yet change one already sent, so editing is
           turned off while signed in (adding and deleting still sync). These
           are the markers the Firebase and Supabase account code set while
           the working copy belongs to an account. */
        const PB_ACCOUNT_MARKERS = ["swimtics:activeUid", "swimtics:sb:activeUid", "swimtics-test:activeUid"];

        function pbListBelongsToAccount() {
            if (window.auth && window.auth.currentUser) return true;
            try {
                return PB_ACCOUNT_MARKERS.some((key) => localStorage.getItem(key) !== null);
            } catch {
                return false;
            }
        }

        function setPBEditStatus(text) {
            const status = document.getElementById("pbEditStatus");
            if (!status) return;
            status.textContent = text || "";
            status.hidden = !text;
        }

        function showPBTimeError(show) {
            const timeInput = document.getElementById("time");
            const timeError = document.getElementById("pbTimeError");
            if (timeError) timeError.hidden = !show;
            if (timeInput) {
                if (show) timeInput.setAttribute("aria-invalid", "true");
                else timeInput.removeAttribute("aria-invalid");
            }
        }

        /* The inline message when a save is refused for a reason other than
           the time's format (a PB whose saved time isn't valid). */
        function showPBBlocked(text) {
            const blocked = document.getElementById("pbBlockedError");
            if (!blocked) return;
            blocked.textContent = text || "";
            blocked.hidden = !text;
        }

        /* The message for adding to (or moving an edit onto) a PB whose saved
           best time isn't valid. Nothing is saved: the invalid value must be
           corrected by the user, never overwritten or converted. Signed in,
           Edit isn't available, so the only way offered is deleting it. */
        function invalidBestMessage(pb) {
            const name = `${pb.event} (${pb.course})`;
            if (pbListBelongsToAccount()) {
                return `${name} has a saved time that isn't valid (${pb.time}), so another time can't be added to it. Editing isn't available while you're signed in yet; you can delete that PB (its other times are deleted with it). Nothing was saved.`;
            }
            return `${name} has a saved time that isn't valid (${pb.time}), so another time can't be added to it. Correct that time with Edit, or delete that PB, first. Nothing was saved.`;
        }

        /* true (and says why) when the saved PB list can't be read: nothing
           is written over it until the person chooses a recovery action
           under Your PBs (saved-data-check.js) */
        function pbSavedDataBlocked() {
            if (!swimticsSavedData.needsRecovery(swimticsSavedData.readSaved("pbs"))) return false;
            showPBBlocked("Your saved personal bests can't be read, so nothing can be added, edited or deleted yet. Nothing was saved. Save a backup or start fresh using the message under Your PBs first.");
            displayPBs();
            return true;
        }

        /* Save PB and Delete are also held back BEFORE their click handlers
           run, so the handler (and anything wrapped around it) doesn't run
           at all. The Supabase account code wraps savePB/deletePB and syncs
           after every call, whatever the call did; that sync reads the
           unreadable saved list as an empty one, and account sync deletes
           every account PB missing from the local list. Stopping the click
           keeps that sync from starting. */
        document.addEventListener("click", (e) => {
            const btn = e.target instanceof Element
                ? e.target.closest("button[onclick='savePB()'], #pbList button[onclick^='deletePB(']")
                : null;
            if (btn && pbSavedDataBlocked()) {
                e.preventDefault();
                e.stopPropagation();
            }
        }, true);

        function endPBEdit() {
            pbEdit = null;
            setPBEditStatus("");
            const cancel = document.getElementById("pbCancelEdit");
            if (cancel) cancel.hidden = true;
        }

        function cancelPBEdit() {
            endPBEdit();
            showPBTimeError(false);
            showPBBlocked("");
            document.getElementById("time").value = "";
        }

        /* Which swim in a record's history its best time is: the first swim
           equal to the stored best; if the stored best isn't a valid time,
           the first unusable swim (the one being corrected); else the
           fastest valid swim. 0 if the record has no history yet. */
        function bestSwimIndex(pb) {
            if (!Array.isArray(pb.history) || pb.history.length === 0) return 0;
            const best = parsePBTime(pb.time);
            let index = -1;
            if (best === null) {
                index = pb.history.findIndex((s) => !isValidPBSwim(s));
            } else {
                index = pb.history.findIndex((s) => isValidPBSwim(s) && Math.round(s * 100) === Math.round(best * 100));
            }
            if (index === -1) {
                pb.history.forEach((s, i) => {
                    if (isValidPBSwim(s) && (index === -1 || s < pb.history[index])) index = i;
                });
            }
            return index === -1 ? 0 : index;
        }

        /* After an edit: the best is the fastest valid swim in the history
           (unusable older entries are kept but never become the best). Keep
           a typed time string whose value matches it, otherwise write one. */
        function recalculatePBBest(pb, typedTimes) {
            const fastest = Math.min(...pb.history.filter(isValidPBSwim));
            const match = typedTimes.find((t) => {
                const s = parsePBTime(t);
                return s !== null && Math.round(s * 100) === Math.round(fastest * 100);
            });
            pb.time = match !== undefined ? normalizePBTime(match) : formatPBTime(fastest);
        }

        function savePB() {

            if (pbSavedDataBlocked()) return;

            const event = document.getElementById("event").value;
            const course = document.getElementById("course").value;
            const typed = document.getElementById("time").value;

            const newTime = parsePBTime(typed);
            const time = normalizePBTime(typed);

            /* nothing is saved or changed unless the time is valid */
            if (!event || !course || newTime === null) {
                showPBTimeError(true);
                return;
            }

            showPBTimeError(false);
            showPBBlocked("");
            setPBEditStatus("");

            if (pbEdit) {
                saveEditedPB(event, course, time, newTime);
                return;
            }

            /* a PB whose saved best isn't valid can't take another time: the
               new time would either hide beneath it or replace it */
            const invalid = pbs.find((pb) => pb.event === event && pb.course === course && parsePBTime(pb.time) === null);
            if (invalid) {
                showPBBlocked(invalidBestMessage(invalid));
                return;
            }

            let found = false;

            for (let i = 0; i < pbs.length; i++) {

                if (pbs[i].event === event && pbs[i].course === course) {

                    found = true;

                    // INIT HISTORY IF NOT EXISTS
                    if (!pbs[i].history) pbs[i].history = [];

                    // PUSH NEW TIME
                    pbs[i].history.push(newTime);

                    // UPDATE BEST TIME
                    if (newTime < timeToSeconds(pbs[i].time)) {
                        pbs[i].time = time;
                    }

                }
            }

            if (!found) {
                pbs.push({
                    event,
                    course,
                    time,
                    history: [newTime]
                });
            }

            localStorage.setItem("pbs", JSON.stringify(pbs));
            displayPBs();

            document.getElementById("time").value = "";
            renderStrokeCards();

            if (window.auth.currentUser) {
                saveUserData(window.auth.currentUser.uid);
            }
        }


        /* Save in edit mode: correct the selected swim in place (its time, and
           the record's event/course), keep every other swim, and recalculate
           the best. Changing to an event/course that already has a record
           merges this record's swims into it. Never adds a new record. */
        function saveEditedPB(event, course, time, newTime) {
            const { record, swim } = pbEdit;

            /* an older record with no history: the corrected time becomes its one swim */
            const history = Array.isArray(record.history) ? record.history : [];
            const swimExists = history.length === 0 ? swim === 0 : swim < history.length;
            if (pbListBelongsToAccount() || !pbs.includes(record) || !swimExists) {
                /* signed in since Edit was chosen, or the record is gone:
                   change nothing rather than guess which PB was meant */
                cancelPBEdit();
                setPBEditStatus("That PB could no longer be edited, so nothing was changed.");
                displayPBs();
                return;
            }

            /* moving onto a PB whose saved best isn't valid would replace that
               value when the two merge: refused, the edit stays open */
            if (record.event !== event || record.course !== course) {
                const invalidTarget = pbs.find((pb) => pb !== record && pb.event === event && pb.course === course && parsePBTime(pb.time) === null);
                if (invalidTarget) {
                    showPBBlocked(invalidBestMessage(invalidTarget));
                    return;
                }
            }

            const typedTimes = [time, record.time];
            record.history = history;
            record.history[swim] = newTime;

            let edited = record;
            if (record.event !== event || record.course !== course) {
                const target = pbs.find((pb) => pb !== record && pb.event === event && pb.course === course);
                if (target) {
                    if (!Array.isArray(target.history)) target.history = [];
                    target.history.push(...record.history);
                    typedTimes.push(target.time);
                    pbs.splice(pbs.indexOf(record), 1);
                    edited = target;
                } else {
                    record.event = event;
                    record.course = course;
                }
            }

            recalculatePBBest(edited, typedTimes);

            endPBEdit();
            localStorage.setItem("pbs", JSON.stringify(pbs));
            displayPBs();
            setPBEditStatus(`Updated ${edited.event} (${edited.course}). Best time: ${edited.time}.`);

            document.getElementById("time").value = "";
            renderStrokeCards();
        }


        function deletePB(i) {
            if (pbSavedDataBlocked()) return;
            if (pbEdit && pbEdit.record === pbs[i]) cancelPBEdit();

            pbs.splice(i, 1);
            localStorage.setItem("pbs", JSON.stringify(pbs));
            displayPBs();

            if (window.auth.currentUser) {
                saveUserData(window.auth.currentUser.uid);
            }
        }

        function editPB(i) {
            if (pbSavedDataBlocked()) return;
            let pb = pbs[i];
            if (!pb) return;

            if (pbListBelongsToAccount()) {
                endPBEdit();
                showPBBlocked("");
                setPBEditStatus(parsePBTime(pb.time) === null
                    ? "Editing a saved time isn't available while you're signed in yet, and this PB can't take another time while its saved time isn't valid. You can delete this PB (its other times are deleted with it)."
                    : "Editing a saved time isn't available while you're signed in yet. You can still add a new time or delete a PB.");
                return;
            }

            document.getElementById("event").value = pb.event;
            document.getElementById("course").value = pb.course;
            const shown = displayPBTime(pb.time);
            document.getElementById("time").value = shown ?? "";
            showPBTimeError(false);
            showPBBlocked("");

            /* nothing is changed until Save PB (an older record with no
               history gets one only when the edit is saved) */
            pbEdit = { record: pb, swim: bestSwimIndex(pb) };
            if (parsePBTime(pb.time) === null) {
                setPBEditStatus(`Editing ${pb.event} (${pb.course}). Its saved time, ${shown}, isn't valid. Enter the correct time, then Save PB, or delete this PB. The other times in its history are kept.`);
            } else {
                setPBEditStatus(`Editing ${pb.event} (${pb.course}), ${shown}. Change the event, course or time, then Save PB. The other times in its history are kept.`);
            }
            const cancel = document.getElementById("pbCancelEdit");
            if (cancel) cancel.hidden = false;
            document.getElementById("time").focus();
        }

        /* Builds one element. Saved values (event, course, time) are always
           set as text, never parsed as HTML: they come from localStorage and,
           with accounts on, from the synced account data. */
        function pbEl(tag, className, text) {
            const el = document.createElement(tag);
            if (className) el.className = className;
            if (text !== undefined) el.textContent = text;
            return el;
        }

        function displayPBs() {

            let c = document.getElementById("pbList");
            c.replaceChildren();

            /* a saved list that can't be read: a recovery message instead of
               the list (or an empty-list message), and the saved value is
               left exactly as it is */
            const saved = swimticsSavedData.readSaved("pbs");
            if (swimticsSavedData.needsRecovery(saved)) {
                swimticsSavedData.renderSavedDataRecovery(c, saved, {
                    accountOwned: pbListBelongsToAccount,
                    afterReset: (message) => {
                        pbs.length = 0;
                        endPBEdit();
                        showPBBlocked("");
                        displayPBs();
                        renderStrokeCards();
                        renderProfileDataRecovery(swimticsSavedData.readSaved("profile"));
                        setPBEditStatus(message);
                        document.getElementById("event").focus();
                    },
                });
                return;
            }

            const signedIn = pbListBelongsToAccount();

            pbs.forEach((pb, i) => {

                let d = pbEl("div", "pb-item");

                const header = pbEl("div", "pb-header");

                const title = pbEl("div", "pb-title");
                title.append(`${pb.event} (${pb.course}) - `, pbEl("span", "pb-time", `${displayPBTime(pb.time)}`));
                /* an older saved time that isn't valid stays as saved, and is
                   flagged; it is never rewritten or removed automatically */
                if (parsePBTime(pb.time) === null) {
                    title.append(pbEl("span", "pb-invalid-note", signedIn
                        ? "This saved time isn't valid. Editing isn't available while you're signed in yet; you can Delete this PB."
                        : "This saved time isn't valid. Use Edit to correct it, or Delete."));
                }

                const controls = pbEl("div", "pb-controls");

                /* the handlers stay inline attributes with a numeric index, as
                   before (i is the array index, never saved text) */
                const editBtn = pbEl("button", "pb-action-btn", "Edit");
                editBtn.setAttribute("onclick", `editPB(${i})`);

                const deleteBtn = pbEl("button", "pb-action-btn delete-btn", "Delete");
                deleteBtn.setAttribute("onclick", `deletePB(${i})`);

                const chartBtn = pbEl("button", "pb-action-btn chart-btn", "📊");
                chartBtn.setAttribute("onclick", `toggleChart(${i})`);
                chartBtn.setAttribute("aria-label", `Show or hide the chart for ${pb.event} (${pb.course})`);

                controls.append(editBtn, deleteBtn, chartBtn);
                header.append(title, controls);

                const chartContainer = pbEl("div", "chart-container");
                chartContainer.id = `chart-container-${i}`;
                chartContainer.style.display = "none";

                const chartWrapper = pbEl("div", "chart-wrapper");
                const canvas = document.createElement("canvas");
                canvas.id = `chart-${i}`;
                chartWrapper.append(canvas);

                chartContainer.append(pbEl("div", "chart-title", "Performance Trajectory"), chartWrapper);

                /* saved history entries that aren't valid times are listed
                   under the chart, as saved, and left off the chart itself */
                const invalidSwims = (Array.isArray(pb.history) ? pb.history : [])
                    .map((s, n) => ({ s, n }))
                    .filter(({ s }) => !isValidPBSwim(s));
                if (invalidSwims.length) {
                    const box = pbEl("div", "pb-invalid-history");
                    box.append(pbEl("p", "pb-invalid-history-title", "Not shown on the chart: these saved times aren't valid."));
                    const list = pbEl("ul");
                    invalidSwims.forEach(({ s, n }) => {
                        const readable = (typeof s === "number" && !Number.isNaN(s)) || (typeof s === "string" && s.trim() !== "");
                        list.append(pbEl("li", "", readable
                            ? `Attempt ${n + 1}: saved as ${s}`
                            : `Attempt ${n + 1}: the saved value can't be read`));
                    });
                    box.append(list);
                    chartContainer.append(box);
                }

                d.append(header, chartContainer);

                c.appendChild(d);
            });
        }

        displayPBs();

        function toggleChart(index) {

            const container = document.getElementById(`chart-container-${index}`);

            if (container.style.display === "none") {
                container.style.display = "block";

                // 🔥 render chart ONLY when opened
                renderChart(index);

            } else {
                container.style.display = "none";
            }

        }

        function formatTime(seconds) {
            const mins = Math.floor(seconds / 60);
            const secs = (seconds % 60).toFixed(2);
            return `${mins}:${secs.padStart(5, '0')}`;
        }

        function renderChart(index) {

            const pb = pbs[index];

            if (!pb || !pb.history || pb.history.length === 0) return;

            const canvas = document.getElementById(`chart-${index}`);
            if (!canvas) return;

            const ctx = canvas.getContext("2d");

            // Destroy old chart if exists
            if (window[`chart${index}`]) {
                window[`chart${index}`].destroy();
            }

            window[`chart${index}`] = new Chart(ctx, {
                type: "line",

                data: {
                    labels: pb.history.map((_, i) => `Attempt ${i + 1}`),

                    datasets: [{
                        label: pb.event,
                        /* invalid saved entries are gaps, never plotted as
                           results (they're listed under the chart) */
                        data: pb.history.map((s) => (isValidPBSwim(s) ? s : null)),

                        borderColor: "#ff0033",
                        backgroundColor: "rgba(255,0,51,0.15)",

                        borderWidth: 3,
                        tension: 0.35,
                        fill: true,

                        pointBackgroundColor: "#ffffff",
                        pointBorderColor: "#ff0033",
                        pointRadius: 5,
                        pointHoverRadius: 7
                    }]
                },

                options: {
                    responsive: true,

                    plugins: {
                        legend: {
                            display: false,
                            labels: {
                                color: document.body.classList.contains("light-mode")
                                    ? "#111"
                                    : "#ffffff"
                            }
                        },

                        tooltip: {
                            callbacks: {
                                label: function (context) {
                                    return formatTime(context.raw);
                                }
                            }
                        }
                    },

                    scales: {
                        x: {
                            ticks: {
                                color: document.body.classList.contains("light-mode")
                                    ? "#111"
                                    : "#ffffff"
                            },

                            grid: {
                                color: document.body.classList.contains("light-mode")
                                    ? "rgba(0,0,0,0.08)"
                                    : "rgba(255,255,255,0.08)"
                            }
                        },

                        y: {
                            reverse: true,

                            ticks: {
                                color: document.body.classList.contains("light-mode")
                                    ? "#111"
                                    : "#ffffff",

                                callback: function (value) {
                                    return formatTime(value);
                                }
                            },

                            grid: {
                                color: document.body.classList.contains("light-mode")
                                    ? "rgba(0,0,0,0.08)"
                                    : "rgba(255,255,255,0.08)"
                            }
                        }
                    },

                    animation: {
                        duration: 1200,
                        easing: "easeOutQuart"
                    }
                }
            });

            // 🔴 NEON GLOW (Dark mode only)
            const chart = window[`chart${index}`];

            if (!document.body.classList.contains("light-mode")) {
                chart.ctx.shadowColor = "#ff0033";
                chart.ctx.shadowBlur = 15;
            } else {
                chart.ctx.shadowColor = "transparent";
                chart.ctx.shadowBlur = 0;
            }
        }



