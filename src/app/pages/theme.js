        // ===============================
        // THEME TOGGLE SYSTEM
        // ===============================
        function toggleTheme() {
            const body = document.body;
            const toggleBtn = document.getElementById("themeToggle");

            body.classList.toggle("light-mode");

            if (body.classList.contains("light-mode")) {
                localStorage.setItem("theme", "light");
                toggleBtn.innerHTML = "🌙 Dark Mode";
            } else {
                localStorage.setItem("theme", "dark");
                toggleBtn.innerHTML = "☀️ Light Mode";
            }
        }

        // ===============================
        // LOAD SAVED THEME
        // ===============================
        window.addEventListener("DOMContentLoaded", () => {
            // Restore the saved theme first: loadProfile() currently throws
            // (updateProfileAccountSection is undefined), which used to stop
            // this handler before the theme was applied.
            const savedTheme = localStorage.getItem("theme");
            const toggleBtn = document.getElementById("themeToggle");

            if (savedTheme === "light") {
                document.body.classList.add("light-mode");

                if (toggleBtn) {
                    toggleBtn.innerHTML = "🌙 Dark Mode";
                }
            } else {
                if (toggleBtn) {
                    toggleBtn.innerHTML = "☀️ Light Mode";
                }
            }

            loadProfile();
            renderStrokeCards();
        });

