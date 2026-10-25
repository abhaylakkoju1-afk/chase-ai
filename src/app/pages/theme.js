        // ===============================
        // THEME TOGGLE SYSTEM
        // The toggle is the Tools menu item #themeToggle; its label names
        // the action for the current theme.
        // ===============================
        function themeToggleLabel(isLight) {
            return isLight ? "Switch to dark mode" : "Switch to light mode";
        }

        function toggleTheme() {
            const body = document.body;
            const toggleBtn = document.getElementById("themeToggle");

            body.classList.toggle("light-mode");

            if (body.classList.contains("light-mode")) {
                localStorage.setItem("theme", "light");
            } else {
                localStorage.setItem("theme", "dark");
            }
            if (toggleBtn) toggleBtn.textContent = themeToggleLabel(body.classList.contains("light-mode"));
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
            }
            if (toggleBtn) toggleBtn.textContent = themeToggleLabel(savedTheme === "light");

            loadProfile();
            renderStrokeCards();
        });

