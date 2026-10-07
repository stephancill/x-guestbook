# X-authenticated guestbook

## Goal

Turn the working Player Card proof of concept into a guestbook. Visitors sign in with X OAuth 2.0, then publish a signature with their verified profile and an optional message.

## Implementation

- OAuth 2.0 Authorization Code with S256 PKCE, requesting only `tweet.read users.read` required by `/2/users/me`.
- A first-party login page runs authorization outside the iframe. Embedded cards use a separate tab and polling; standalone visits use the same viewer and automatically return to their original book. The book claims a short-lived login attempt using a separate secret to receive an app session; no third-party cookies or trusting postMessage payloads.
- Prepare the OAuth launch URL before the sign-in tap. Use native new-tab links for embedded cards and same-view links for standalone visits, with no asynchronous popup navigation.
- Save standalone pending/return context synchronously in sessionStorage before navigation. The completion page returns only to validated local root/room/player paths bound to the callback state and saved pending attempt; both success and denial return to the book, which obtains the authoritative result from the backend.
- Persist the complete expiring attempt for resumption, offer continue/check/cancel controls, and restart polling on visibility, focus and BFCache restoration.
- X access tokens remain on the backend and are used only to read the profile. App sessions are independent and revocable.
- D1 persists guestbook signatures and manages expiring, single-use OAuth transactions and hashed session tokens. A database is now needed for shared entries and login state.
- One signature per X account per book; submitting again updates the message and current profile.
- `https://guestbook.stupidtech.net/` is the share URL, pointing to the existing default book through a server-rendered 480 × 480 Player Card. Sharing controls always use the root URL.
- Recent signatures appear before the login controls, with relative timestamps updated when the book refreshes. The inspector and postMessage observation UI are removed.
- Fit the layout to the iframe's actual height, including smaller square mobile cards. Keep signing and sharing controls visible, let recent signatures use the remaining space and scroll independently, and use compact spacing for short cards.
- Host on `guestbook.stupidtech.net`; workers.dev and preview URLs are disabled.
- The root share page, `/r/:room`, and `/play/:room` serve the full guestbook for standalone visits, including links opened by the native X app. No X referrer or iframe fetch headers are required. CSP permits X/Twitter ancestors for the embedded version.
- Guestbook APIs require an expiring hashed page credential issued by every guestbook page. Signatures additionally require a verified app session. OAuth launch/callback pages use their own single-use credentials.
- Bun and Vite compile the client. Hono runs on Cloudflare Workers and serves the HTML and JSON API.
- Link the footer to `/about`, a static explanation of Player Cards, web/native presentation, OAuth navigation, public signatures, sessions and the implementation stack.

## Verification

The separate X mobile webview investigation is described in `docs/webview-probe.md`. Deploy it with its own Worker config and database; use mock completion flows to observe popup context, host-dependent dismissal and same-view return.

1. Format, lint, typecheck and build.
2. Test pending/completed/expired login state, authorization rejection, callback replay, session authentication and guestbook writes using a mocked X provider with real local D1.
3. Verify root/room/player standalone access without referrer headers, valid page credentials, authenticated signing, and mobile OAuth alongside the embedded flow.
4. Preserve server-rendered metadata and iframe-compatible response headers. X card acceptance of the original proof of concept has been confirmed manually.

## Scope

Identity observations are local diagnostics and never authenticate visitors. Configure an X developer app with the exact deployed `/auth/callback` URL. Credentials must be stored as Worker secrets and never printed or committed.

Standalone visits are intentionally supported because the native X app may open the share link instead of loading an iframe. Neither referrer nor browser headers are used to authenticate identity; only the verified OAuth profile authenticates a signature.
