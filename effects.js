/* Subtle motion: scroll progress bar, header shrink-on-scroll, reveal-on-
   scroll for sections, and count-up for stat numbers.
   Intentionally NO "bounce at scroll ends" effect -- that was tried and
   removed earlier because it distorted the sticky header; do not re-add it. */
(function () {
  document.addEventListener("DOMContentLoaded", function () {
    var header = document.querySelector("header");
    var bar = document.createElement("div");
    bar.className = "scroll-progress";
    document.body.appendChild(bar);

    function onScroll() {
      var scrollTop = window.scrollY || document.documentElement.scrollTop;
      var height = document.documentElement.scrollHeight - window.innerHeight;
      var pct = height > 0 ? (scrollTop / height) * 100 : 0;
      bar.style.width = pct + "%";
      if (header) header.classList.toggle("shrink", scrollTop > 40);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    // Reveal sections as they enter the viewport
    var revealEls = document.querySelectorAll("section, .reveal");
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) {
              entry.target.classList.add("in-view");
              io.unobserve(entry.target);
            }
          });
        },
        { threshold: 0.12 }
      );
      revealEls.forEach(function (el) {
        el.classList.add("reveal-init");
        io.observe(el);
      });
    } else {
      revealEls.forEach(function (el) { el.classList.add("in-view"); });
    }

    // Count-up for .stat .num[data-count]
    var counters = document.querySelectorAll(".stat .num[data-count]");
    if (counters.length && "IntersectionObserver" in window) {
      var cio = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (!entry.isIntersecting) return;
            var el = entry.target;
            cio.unobserve(el);
            var target = parseInt(el.getAttribute("data-count"), 10) || 0;
            var start = performance.now();
            var dur = 1100;
            function step(now) {
              var p = Math.min(1, (now - start) / dur);
              el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3))).toLocaleString();
              if (p < 1) requestAnimationFrame(step);
            }
            requestAnimationFrame(step);
          });
        },
        { threshold: 0.4 }
      );
      counters.forEach(function (el) { cio.observe(el); });
    }
  });
})();
