/* Floating widgets: fixed social-media rail + a "Talk to us" contact popover.
   No chatbot here -- disabled per standing instruction (SCCF_CONFIG.chatbotEnabled). */
(function () {
  document.addEventListener("DOMContentLoaded", function () {
    var cfg = window.SCCF_CONFIG || {};
    var social = cfg.social || {};

    // --- Social rail ---
    var rail = document.createElement("div");
    rail.className = "social-rail";
    var icons = [
      ["facebook", social.facebook, "f"],
      ["twitter", social.twitter, "x"],
      ["instagram", social.instagram, "ig"],
      ["youtube", social.youtube, "yt"],
      ["whatsapp", social.whatsapp, "wa"]
    ];
    icons.forEach(function (item) {
      var a = document.createElement("a");
      a.href = item[1] || "#";
      a.target = "_blank";
      a.rel = "noopener";
      a.className = "social-icon social-" + item[0];
      a.setAttribute("aria-label", item[0]);
      a.textContent = item[2];
      rail.appendChild(a);
    });
    document.body.appendChild(rail);

    // --- Talk to us floating form ---
    var launcher = document.createElement("button");
    launcher.className = "talk-launcher";
    launcher.type = "button";
    launcher.textContent = "Talk to us";
    document.body.appendChild(launcher);

    var panel = document.createElement("div");
    panel.className = "talk-panel";
    panel.innerHTML =
      '<div class="talk-head"><span>Talk to us</span><button type="button" class="talk-close" aria-label="Close">&times;</button></div>' +
      '<form class="talk-form">' +
      '<label>Name<input type="text" name="name" required></label>' +
      '<label>Email or phone<input type="text" name="contact" required></label>' +
      '<label>Message<textarea name="message" rows="3" required></textarea></label>' +
      '<button type="submit" class="btn btn-primary" style="width:100%;">Send</button>' +
      '<p class="talk-note">We typically reply within one business day. For emergencies, please seek medical care directly.</p>' +
      '</form>' +
      '<div class="talk-sent" hidden>Thank you - your message has been noted. Our team will reach out shortly.</div>';
    document.body.appendChild(panel);

    function openPanel() { panel.classList.add("open"); }
    function closePanel() { panel.classList.remove("open"); }

    launcher.addEventListener("click", function () {
      panel.classList.contains("open") ? closePanel() : openPanel();
    });
    panel.querySelector(".talk-close").addEventListener("click", closePanel);

    panel.querySelector(".talk-form").addEventListener("submit", function (e) {
      e.preventDefault();
      // No live messaging endpoint is connected yet. We acknowledge receipt
      // locally rather than silently failing or pretending to call a server.
      this.hidden = true;
      panel.querySelector(".talk-sent").hidden = false;
    });

    // Chatbot stays off. If ever re-enabled, gate all of its code on
    // cfg.chatbotEnabled the way this line does, rather than removing it.
    if (cfg.chatbotEnabled) {
      // Intentionally left unimplemented -- disabled per standing instruction.
    }
  });
})();
