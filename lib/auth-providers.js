"use strict";

/**
 * Which ways of proving who you are does Agently accept?
 *
 * V1 accepts exactly one: an email address and a password, followed by an
 * emailed one-time code. Google sign-in is deliberately not offered.
 *
 * WHY NOT GOOGLE, AND WHY THIS FILE EXISTS
 *
 * Signing up for Agently is not just creating a login. It creates an
 * organization, a knowledge base, a voice agent and a chatbot, and that needs a
 * business name we can put in an agent's greeting. Google hands back a name,
 * an email and a picture — no company. Supporting it in V1 would mean two
 * registration paths collecting different data, and the Google one would still
 * have to stop and ask for the workspace details, which is the interstitial
 * nobody wants.
 *
 * There was never any Google code in this repository: no dependency in either
 * package.json, no route, no callback handler, no button. So there is nothing
 * to tear out, and this file is not a demolition — it is the seam that makes
 * adding Google later a contained change instead of a redesign.
 *
 * TO ADD A PROVIDER LATER
 *
 *   1. Add its id to PROVIDERS below with enabled: true.
 *   2. Add routes under /api/auth/oauth/<id>/... — start and callback.
 *   3. On callback, resolve or create the user, then call
 *      createSession() from lib/auth-sessions.js. Everything downstream —
 *      session lifetime, idle timeout, revocation, bootstrap — already works
 *      and does not care how the person authenticated.
 *   4. Decide what a federated signup does about the missing company name.
 *      The honest options are to ask for it on a short post-callback step, or
 *      to only allow Google on ACCOUNTS THAT ALREADY EXIST (linking), which
 *      sidesteps the problem entirely and is the recommended first move.
 *   5. GET /api/auth/config starts advertising it; the web client renders the
 *      button from that response and needs no separate release.
 *
 * Nothing else in the codebase should hardcode "password" as the only option.
 * Ask this module instead.
 */

const PROVIDERS = {
  password: {
    id: "password",
    label: "Email and password",
    enabled: true,
    // Whether a brand-new account can be created through this provider.
    allowsSignup: true,
    // Whether a successful authentication still has to clear the emailed
    // one-time code. Federated providers would set this to false: Google has
    // already proven mailbox control, and asking again is friction with no
    // security gain.
    requiresEmailOtp: true,
  },
  google: {
    id: "google",
    label: "Google",
    enabled: false,
    allowsSignup: false,
    requiresEmailOtp: false,
    disabledReason:
      "Not offered in V1. Agently signup must collect a workspace name, which a Google profile does not provide.",
  },
};

/** Provider ids a client may actually use right now. */
function enabledProviders() {
  return Object.values(PROVIDERS)
    .filter((provider) => provider.enabled)
    .map((provider) => provider.id);
}

function isProviderEnabled(id) {
  const provider = PROVIDERS[String(id || "").toLowerCase()];
  return Boolean(provider && provider.enabled);
}

function getProvider(id) {
  return PROVIDERS[String(id || "").toLowerCase()] || null;
}

/**
 * Reject a disabled provider with a real error rather than a 404, so a client
 * that still has a stale button gets an explanation it can show the user
 * instead of "something went wrong".
 */
function assertProviderEnabled(id) {
  const provider = getProvider(id);
  if (provider && provider.enabled) return provider;

  const error = new Error(
    provider
      ? `${provider.label} sign-in is not available. ${provider.disabledReason || ""}`.trim()
      : "That sign-in method is not supported.",
  );
  error.status = 400;
  error.code = "AUTH_PROVIDER_DISABLED";
  throw error;
}

/** The public shape served by GET /api/auth/config. */
function publicAuthConfig() {
  return {
    providers: enabledProviders(),
    passwordMinLength: 8,
    // Named so a client does not have to infer the flow from trial and error.
    signupRequiresEmailVerification: true,
    loginRequiresEmailOtp: true,
    // Retired in V1. Kept in the payload, explicitly false, so a cached older
    // web bundle hides the button instead of calling an endpoint that is gone.
    magicLinkSignInEnabled: false,
  };
}

module.exports = {
  PROVIDERS,
  enabledProviders,
  isProviderEnabled,
  getProvider,
  assertProviderEnabled,
  publicAuthConfig,
};
