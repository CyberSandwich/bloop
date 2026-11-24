// The page a phone sees when /auth/callback fails. The callback is a top-level navigation, so a problem+json
// body would show as raw JSON; this is the design voice instead (design.md section 7, "sign-in failed").
// Strings are fixed: nothing from the request reaches the markup.
import { ERRORS } from "../../../public/js/shared/errors.js";
import { withPolicy } from "../headers.ts";
import type { SignInError } from "./oauth.ts";

interface Words {
  title: string;
  body: string;
  retry: boolean;
}

const DEFAULT: Words = {
  title: "Couldn't sign you in.",
  body: "Scan the code on the screen to try again, or sign in to the PC as usual.",
  retry: true,
};

export const WORDS: Readonly<Record<SignInError, Words>> = {
  state: DEFAULT,
  issuer: DEFAULT,
  exchange: DEFAULT,
  consent_declined: {
    title: "bloop wasn't given access.",
    body: "bloop can't read your slides without it. Scan the code on the screen to try again.",
    retry: true,
  },
  admin_consent_required: {
    title: "Your organization needs to approve bloop.",
    body: "Ask your IT team, or sign in to the PC as usual.",
    retry: false,
  },
};

const STATUS: Readonly<Record<SignInError, number>> = {
  state: ERRORS.bad_request.status,
  issuer: ERRORS.unauthorized.status,
  exchange: ERRORS.source_unavailable.status,
  consent_declined: ERRORS.consent_declined.status,
  admin_consent_required: ERRORS.admin_consent_required.status,
};

export function callbackErrorPage(failure: SignInError): Response {
  const { title, body, retry } = WORDS[failure];
  const action = retry ? '<a class="btn primary" href="/code">Enter a Code</a>' : "";
  const html = `<!DOCTYPE html>
<html lang="en-US">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="color-scheme" content="light">
    <meta name="robots" content="noindex">
    <title>bloop: sign in</title>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml">
    <link rel="stylesheet" href="/css/base.css">
    <link rel="stylesheet" href="/css/site.css">
  </head>
  <body class="page-site">
    <main id="main" class="doc notfound">
      <h1>${title}</h1>
      <p>${body}</p>
      ${action}
    </main>
  </body>
</html>
`;
  return withPolicy(
    new Response(html, {
      status: STATUS[failure],
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    }),
    "app",
  );
}
