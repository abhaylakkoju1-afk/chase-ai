        /* startMetrics()/autoStartRace()/onRaceResults() and the
           dead-data "ended" listener that used to summarize them have
           been removed here — Stage 4D.6 replaces this entire automatic
           path with the tested Race Pipeline (see the separate ES module
           script block further down this file, after this file's main
           script ends). This was confirmed dead code before removal: racePose was
           declared but never assigned to a MediaPipe Pose instance
           anywhere, onRaceResults() was consequently never invoked
           (docs/CHRONOS_ARCHITECTURE.md §23), and startTimer() (bound to
           the manual "▶ Start" button below) was never defined at all.
           The new pipeline is the sole automatic race-timing path;
           #splits/#timer/#raceMetrics are no longer written by any
           automatic code — #splits/#timer remain owned solely by the
           manual controls below (Stage 4D.6 §16), and #raceMetrics is
           left unused in the DOM rather than removed. */

        function pauseTimer() { document.getElementById("racePlayer").pause(); running = false; }

        function updateTimer() {
            if (!running) return;
            const v = document.getElementById("racePlayer");
            document.getElementById("timer").innerText = (v.currentTime - startTime).toFixed(2) + " s";
            requestAnimationFrame(updateTimer);
        }

        function split() {
            const v = document.getElementById("racePlayer");
            let t = (v.currentTime - startTime).toFixed(2);
            let d = document.createElement("div");
            d.innerText = t + " s";
            document.getElementById("splits").appendChild(d);
        }

        function reset() {
            const v = document.getElementById("racePlayer");
            v.pause(); v.currentTime = 0; running = false;
            document.getElementById("timer").innerText = "0.00 s";
            document.getElementById("splits").innerHTML = "";
        }

