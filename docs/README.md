# X Guestbook

An X OAuth guestbook available as a normal page and an interactive Player Card at `https://guestbook.stupidtech.net`.

- [Live guestbook](https://guestbook.stupidtech.net/)
- [How it works](https://guestbook.stupidtech.net/about)
- [Source code](https://github.com/stephancill/x-guestbook)

## Getting started

Requires Bun and a Cloudflare account for local D1 development or deployment.

```sh
git clone https://github.com/stephancill/x-guestbook.git
cd x-guestbook
bun install
bunx playwright install webkit
```

The included Wrangler configuration targets the existing deployment. For your own deployment, configure your custom domain, `APP_ORIGIN`, and D1 binding in `wrangler.jsonc`, and update the absolute metadata URLs in `index.html` and `about.html`. Register an X OAuth app with your origin's `/auth/callback` URL and set its client credentials as Worker secrets. Apply the D1 migrations before running the app against a new database.

Planning, implementation history and browser findings are documented in this directory.

## Commands

```sh
bun install
bunx playwright install webkit
bun run format
bun run check
bun run test
bun run db:local
bun run dev
bun run db:remote
bun run deploy
```

## X app configuration

- Confidential client: **Web App, Automated App or Bot**.
- Callback: `https://guestbook.stupidtech.net/auth/callback`.
- Website: `https://guestbook.stupidtech.net`.
- OAuth scopes: `tweet.read users.read`, the scopes required by `/2/users/me`. No write, email or offline access.
- Store `X_CLIENT_ID` and `X_CLIENT_SECRET` in `.env.local` locally and Worker secrets in production. `.env.local` is ignored; Bun loads it automatically. Wrangler local development reads `.dev.vars`, which is also ignored.

## Routes and access

- `/`: share `https://guestbook.stupidtech.net/` directly on X. Metadata points to the existing default book, and opening the link displays the full guestbook, including from the native X app.
- `/r/:room` and `/play/:room`: room-specific guestbook pages; the player works both embedded on X and as a standalone page without an X referrer.
- `/about`: public, static “How it works” page linked from the guestbook footer.
- `/auth/launch`, `/auth/callback`, `/auth/done`: first-party OAuth pages. Embedded cards open a separate tab; standalone pages authorize in the same viewer and automatically return to the original book.
- Guestbook APIs require an expiring page credential; signatures additionally require an authenticated app session. Embedding is permitted for X/Twitter ancestors by CSP.

Each X account has one signature per book. Submitting again updates its message and profile. Signatures are public to visitors inside the book. Sessions last 30 days and sign-out revokes them. X provider tokens are used only on the backend to retrieve the verified profile and are not sent to the card or stored as app sessions.

Sign-in URLs are prepared before the tap so native link navigation works even if mobile Safari suspends the card. Standalone visits save the pending attempt and a state-bound local return path before same-view navigation; after success or denial, the completion page replaces itself with the original book. The book polls for the authoritative result and session. This flow requires writable sessionStorage; unavailable storage is reported before leaving the book. Embedded cards continue to use separate-tab sign-in. Pending attempts retain their launch URL and expiry across refreshes. An unlaunched attempt can be continued; check/cancel controls let visitors recover from a closed tab. Polling resumes on focus, visibility and BFCache restoration. Interrupted network checks preserve the pending attempt.

Recent signatures load before sign-in and display relative timestamps. The inspector has been removed. Only the room and page credential are provided to the client as app configuration. The internal `embedToken` and `embed_access` names also cover standalone pages.

## Verification

Tests use a real local D1 binding via Miniflare and a mock X provider. They cover PKCE, distinct launch/poll/browser credentials, single-use state, callback replay, authorization denial, expired attempts, profile lookup errors, session revocation, signature ownership, concurrent login claims, page credential expiry, and standalone root/room/player rendering with preserved metadata.

Mobile browser regression tests use Playwright WebKit with an iPhone device configuration and completely intercepted test responses. They verify native launch without a placeholder popup, polling after page restoration, resume/cancel after a closed tab and refresh, recovery of incomplete/expired attempts, square-card layout, and standalone OAuth/signing without an iframe or referrer. `bun run test` builds the browser assets before running these tests.

Cloudflare creates the custom-domain DNS/certificate through the Worker route configuration. workers.dev and preview URLs are disabled. Direct browser access is intentional; X authentication is required to sign.

## Separate webview diagnostic app

`https://x-webview.stupidtech.net/` provides a mock sign-in and navigation probe for X's native mobile viewer. It has its own Worker, D1 database and deployment command (`bun run deploy:webview`). See [webview-probe.md](webview-probe.md) for test steps, collected context and private report inspection.
