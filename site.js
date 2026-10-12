/* Navigation: mobile menu toggle + active-link highlighting. */
(function () {
  document.addEventListener("DOMContentLoaded", function () {
    // Active link
    var here = location.pathname.split("/").pop() || "index.html";
    document.querySelectorAll("nav a").forEach(function (a) {
      var href = (a.getAttribute("href") || "").split("#")[0];
      if (href && href === here) a.classList.add("active");
    });

    // Mobile menu toggle
    var toggle = document.querySelector(".nav-toggle");
    var nav = document.querySelector("header nav");
    if (toggle && nav) {
      toggle.addEventListener("click", function () {
        nav.classList.toggle("open");
        toggle.setAttribute("aria-expanded", nav.classList.contains("open"));
      });
    }
  });
})();
