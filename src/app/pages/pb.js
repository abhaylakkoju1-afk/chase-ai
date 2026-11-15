        /* ===== PB SYSTEM ===== */
        let editIndex = -1;

        function timeToSeconds(t) {
            if (t.includes(":")) {
                let p = t.split(":");
                return p[0] * 60 + parseFloat(p[1]);
            }
            return parseFloat(t);
        }

        function savePB() {

            const event = document.getElementById("event").value;
            const course = document.getElementById("course").value;
            const time = document.getElementById("time").value;

            const newTime = timeToSeconds(time);

            /* same check as before; it now says why nothing was saved */
            const timeInput = document.getElementById("time");
            const timeError = document.getElementById("pbTimeError");

            if (!event || !course || !newTime) {
                if (timeError) timeError.hidden = false;
                if (timeInput) timeInput.setAttribute("aria-invalid", "true");
                return;
            }

            if (timeError) timeError.hidden = true;
            if (timeInput) timeInput.removeAttribute("aria-invalid");

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


        function deletePB(i) {
            pbs.splice(i, 1);
            localStorage.setItem("pbs", JSON.stringify(pbs));
            displayPBs();

            if (window.auth.currentUser) {
                saveUserData(window.auth.currentUser.uid);
            }
        }

        function editPB(i) {
            let pb = pbs[i];
            document.getElementById("event").value = pb.event;
            document.getElementById("course").value = pb.course;
            document.getElementById("time").value = pb.time;
            editIndex = i;

            if (window.auth.currentUser) {
                saveUserData(window.auth.currentUser.uid);
            }
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

            pbs.forEach((pb, i) => {

                let d = pbEl("div", "pb-item");

                const header = pbEl("div", "pb-header");

                const title = pbEl("div", "pb-title");
                title.append(`${pb.event} (${pb.course}) - `, pbEl("span", "pb-time", `${pb.time}`));

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
                        data: pb.history,

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



