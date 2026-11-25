// The page a phone sees when /auth/callback fails. The callback is a top-level navigation, so a problem+json
// body would show as raw JSON; this is the design voice instead (design.md section 7, "sign-in failed").
// Strings are fixed: nothing from the request reaches the markup, the support mail included.
import { ERRORS, orEmail, SUPPORT } from "../../../public/js/shared/errors.js";
import { supportMail } from "../../../public/js/shared/support.js";
import type { ErrorCode } from "../../shared/protocol.ts";
import { withPolicy } from "../headers.ts";
import type { SignInError } from "./oauth.ts";

interface Words {
  title: string;
  body: string;
  retry: boolean;
}

const DEFAULT: Words = {
  title: "Couldn't sign you in.",
  body: orEmail("Scan the code on the screen to try again"),
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
    body: "Ask your IT team to approve it, then scan again.",
    retry: false,
  },
};

const CODE: Readonly<Record<SignInError, ErrorCode>> = {
  state: "bad_request",
  issuer: "unauthorized",
  exchange: "source_unavailable",
  consent_declined: "consent_declined",
  admin_consent_required: "admin_consent_required",
};

export function callbackErrorPage(failure: SignInError, now = new Date()): Response {
  const { title, body, retry } = WORDS[failure];
  const action = retry ? '<a class="btn primary" href="/code">Enter the Code</a>' : "";
  const mail = supportMail(title, {
    Page: "/auth/callback",
    State: failure,
    Error: CODE[failure],
    Time: now.toISOString(),
    Browser: "",
  });
  const line = body.replace(SUPPORT, `<a href="${mail.replaceAll("&", "&amp;")}">${SUPPORT}</a>`);
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
      <p>${line}</p>
      ${action}
    </main>
  </body>
</html>
`;
  return withPolicy(
    new Response(html, {
      status: ERRORS[CODE[failure]].status,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    }),
    "app",
  );
}
