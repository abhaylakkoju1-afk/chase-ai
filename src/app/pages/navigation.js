        function showPage(pageId) {
    console.log("Navigating to:", pageId);

    const pages = document.querySelectorAll(".page");

    pages.forEach(page => {
        page.style.display = "none";
        page.classList.remove("active");
    });

    const selectedPage = document.getElementById(pageId);

    if (!selectedPage) {
        console.error("No page found with ID:", pageId);
        return;
    }

    const homeFeatures = document.getElementById("homeFeatures");

    if (homeFeatures) {
        if (pageId === "home") {
            homeFeatures.style.display = "block";
        } else {
            homeFeatures.style.display = "none";
        }
    }

    selectedPage.style.display = "block";
    selectedPage.classList.add("active");

    window.scrollTo({
        top: 0,
        behavior: "smooth"
    });

    // ...
}

window.showPage = showPage;

        window.currentUser = null;
