/* SCCF website site-wide configuration.
   Edit this file to turn features on/off or update contact details. */
window.SCCF_CONFIG = {
  foundationName: "Sickle Cell Child Care Foundation",
  phones: ["0724 888 057", "0798 511 366"],
  email: "info@sicklecellchildcare.org",
  chatbotEnabled: false, // chatbot stays off per standing instruction
  social: {
    facebook: "#",
    twitter: "#",
    instagram: "#",
    youtube: "#",
    whatsapp: "https://wa.me/254724888057"
  },
  // Portal = the backend's live account system, served at /portal/* from
  // this same application once deployed together (see README "Running the
  // integrated system"). Locally/standalone these just point at a relative
  // path, so linking works automatically once both halves run as one app.
  portal: {
    login: "/portal/login.html",
    signup: "/portal/signup.html",
    donorDashboard: "/portal/donor-dashboard.html"
  },
  // Payment rails: everything here is a placeholder until the Foundation
  // supplies live credentials (Till number, Paybill, merchant keys, etc).
  // Each shows "(soon)" in the UI and never pretends to process a real
  // payment -- see payments.js.
  payments: {
    mpesaTill: "",      // Till number, once issued
    paybill: "",        // Paybill number + account ref, once issued
    paypalClientId: "",
    stripePublishableKey: "", // Note: Stripe is currently not usable in Kenya -- keep this
                              // channel disabled in the admin dashboard regardless of
                              // whether a key is set here.
    visaMerchantId: "",
    cryptoWalletAddress: ""
  }
  // Which of the methods above actually show on the donate page is controlled
  // by the admin dashboard (Admin > Payment Channels), not by this file --
  // see website/public-website/js/payments.js.
};
