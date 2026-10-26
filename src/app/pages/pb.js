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

            if (!event || !course || !newTime) return;

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

        function displayPBs() {

            let c = document.getElementById("pbList");
            c.innerHTML = "";

            pbs.forEach((pb, i) => {

                let d = document.createElement("div");
                d.className = "pb-item";

                d.innerHTML = `
            <div class="pb-header">
                <div class="pb-title">
                    ${pb.event} (${pb.course}) -
                 <span class="pb-time">${pb.time}</span>
                </div>

                <div class="pb-controls">

    <button
        class="pb-action-btn"
        onclick="editPB(${i})">
        Edit
    </button>

    <button
        class="pb-action-btn delete-btn"
        onclick="deletePB(${i})">
        Delete
    </button>

    <button
        class="pb-action-btn chart-btn"
        onclick="toggleChart(${i})"
        aria-label="Show or hide the chart for ${pb.event} (${pb.course})">
        📊
    </button>

</div>
            </div>

            <div id="chart-container-${i}" class="chart-container" style="display:none;">

                <div class="chart-title">
                    Performance Trajectory
                </div>

                <div class="chart-wrapper">
                    <canvas id="chart-${i}"></canvas>
                </div>

            </div>
        `;

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



