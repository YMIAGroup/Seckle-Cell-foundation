/* Donation payment tabs. Which methods appear here is controlled by the
   admin dashboard (Admin > Payment Channels), not hardcoded -- the
   motivating case is Stripe currently being unusable in Kenya, so an admin
   needs to be able to hide it (and show e.g. Crypto once it's ready)
   without a website change. This file fetches the enabled list from the
   backend (GET /payment-channels, same-origin, no auth) and shows only
   those tabs; every tab still shows "(soon)" and submits nothing until the
   Foundation supplies live credentials in config.js. */
(function () {
  // Fallback used only if the backend can't be reached at all (e.g. this
  // file opened directly from disk with no server behind it, or a network
  // hiccup) -- matches the two channels the platform seeds as enabled by
  // default, so the page still looks sensible rather than empty or broken.
  var FALLBACK_ENABLED = ["mpesa", "paybill"];

  function applyEnabledChannels(root, enabledCodes) {
    var tabs = Array.prototype.slice.call(root.querySelectorAll(".pay-tab"));
    var panels = Array.prototype.slice.call(root.querySelectorAll(".pay-panel"));
    var anyVisible = false;
    var firstVisibleTab = null;

    tabs.forEach(function (tab) {
      var show = enabledCodes.indexOf(tab.dataset.tab) !== -1;
      tab.hidden = !show;
      if (show) {
        anyVisible = true;
        if (!firstVisibleTab) firstVisibleTab = tab;
      }
    });
    panels.forEach(function (panel) {
      var show = enabledCodes.indexOf(panel.dataset.panel) !== -1;
      panel.classList.remove("active");
      panel.style.display = show ? "" : "none";
    });

    var emptyNote = root.querySelector(".pay-empty");
    var tabsRow = root.querySelector(".pay-tabs");
    // .pay-tabs sets its own `display: flex` in CSS, which would otherwise
    // out-rank the UA stylesheet's `[hidden] { display: none }` rule at tie
    // specificity -- so this is set directly via style.display rather than
    // the `hidden` IDL property, unlike emptyNote below (which has no
    // competing display rule, so plain `hidden` is enough there).
    if (!anyVisible) {
      if (tabsRow) tabsRow.style.display = "none";
      if (emptyNote) emptyNote.hidden = false;
      return;
    }
    if (tabsRow) tabsRow.style.display = "";
    if (emptyNote) emptyNote.hidden = true;

    tabs.forEach(function (t) { t.classList.remove("active"); });
    firstVisibleTab.classList.add("active");
    var activePanel = root.querySelector('.pay-panel[data-panel="' + firstVisibleTab.dataset.tab + '"]');
    if (activePanel) {
      activePanel.style.display = "";
      activePanel.classList.add("active");
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    var root = document.querySelector(".pay-widget");
    if (!root) return;
    var cfg = (window.SCCF_CONFIG || {}).payments || {};
    var loadingNote = root.querySelector(".pay-loading");

    function finishLoading(enabledCodes) {
      if (loadingNote) loadingNote.hidden = true;
      applyEnabledChannels(root, enabledCodes);
    }

    fetch("/payment-channels")
      .then(function (res) {
        if (!res.ok) throw new Error("payment-channels request failed: " + res.status);
        return res.json();
      })
      .then(function (channels) {
        finishLoading(channels.map(function (c) { return c.code; }));
      })
      .catch(function () {
        // Backend unreachable (static preview, offline, etc.) -- fall back
        // rather than leaving the widget stuck on "Loading...".
        finishLoading(FALLBACK_ENABLED);
      });

    root.querySelectorAll(".pay-tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        if (tab.hidden) return;
        root.querySelectorAll(".pay-tab").forEach(function (t) { t.classList.remove("active"); });
        root.querySelectorAll(".pay-panel").forEach(function (p) { p.classList.remove("active"); p.style.display = "none"; });
        tab.classList.add("active");
        var target = root.querySelector('.pay-panel[data-panel="' + tab.dataset.tab + '"]');
        if (target) {
          target.style.display = "";
          target.classList.add("active");
        }
      });
    });

    root.querySelectorAll("form.pay-form").forEach(function (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var ready = !!cfg[form.dataset.credentialKey];
        var note = form.querySelector(".pay-result");
        if (!note) {
          note = document.createElement("p");
          note.className = "pay-result";
          form.appendChild(note);
        }
        note.textContent = ready
          ? "Processing..."
          : "This payment method is not connected yet. Please check back soon, or use Mobile Money / contact us directly.";
      });
    });
  });
})();
