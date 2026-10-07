# Implementation notes

## Initial scaffold

- Created a Bun/Vite vanilla-TypeScript project for a Cloudflare-hosted Player Card experiment.
- Project instructions and the reproduction plan live in this directory and the root AGENTS.md.

## Deployed proof of concept

- Cloudflare Worker `tweet-miniapp` serves a Vite-built vanilla-TypeScript app using Hono. There is no database or server-side user state. The temporary D1 database created during setup was deleted when the scope was simplified.
- `/r/:room` and `/play/:room` render absolute Player Card and Open Graph URLs server-side via HTMLRewriter. The player size is 480 × 480. Room identifiers are validated with Zod and provide fresh URLs for card-cache experiments; the tap counter is local to each page.
- Added tap/reset controls, share-link copying, an X composer link, a new-tab link and an iframe harness at `/test/:room`.
- Inspector shows frame status, document referrer, ancestor origins where supported, query parameters, localStorage availability and selected request headers. Incoming postMessage previews are bounded and displayed as text; they do not authenticate anyone or trigger commands.
- HTML responses use a frame-compatible CSP with `frame-ancestors *` and no X-Frame-Options. Diagnostic responses are not cached. Preview and favicon PNGs are public static assets generated with ImageMagick.
- Removed Vite demonstration code and images. Added Bun check/build/deploy scripts with TypeScript, Oxlint and Oxfmt.

## Verification

- Lint, typecheck, formatting and production build passed.
- Deployed with Wrangler; HTTP checks confirmed Player Card metadata, preview-image availability and iframe-compatible headers.
- Browser checks verified tap increments and reset in a direct tab, interaction in a sandboxed 480 × 480 iframe, no horizontal overflow, frame/referrer detection and observation of a parent postMessage.
- Newly deployed workers.dev routing briefly returned a Cloudflare 404 before propagation completed; the same URL subsequently served the app.
- X acceptance of the original proof of concept was confirmed manually. The observed frame had an X referrer, two X ancestor origins, autoplay query parameters, available storage and no postMessage identity payloads.

## OAuth guestbook

- Replaced the tap demo with a guestbook: sign in with X, optionally leave a message, then sign. Each verified X account has one entry per room; signing again updates its profile/message. Entries are read from shared D1 storage.
- Created a confidential X OAuth 2.0 app and configured its callback and website for the custom domain. Client credentials are stored as Worker secrets; local environment files are ignored and protected with owner-only permissions.
- OAuth requests `tweet.read users.read`, required by `/2/users/me`. The backend exchanges the code, validates the profile and discards the provider token after use. No provider token is sent to the browser or used as an app session.
- OAuth attempts expire after ten minutes. Launch and poll credentials are separate from state, hashed at rest, and single-use. A Secure/HttpOnly/SameSite=Lax first-party cookie binds the callback to the authorization browser. State consumption is atomic and callback replays fail.
- The card polls using its private polling credential, receives an independent 30-day app session and stores it in the embedded origin's localStorage when available. Session tokens are hashed in D1 and revoked on sign-out.
- Added first-party launch/completion pages, Zod-validated API schemas, origin checks for mutations, small JSON request limits, and text-only rendering for user messages. The existing context inspector never includes app or embedding credentials.

## Custom domain and X-only browser access

- Deployed on `guestbook.stupidtech.net`; workers.dev and preview URLs are disabled.
- `/r/:room` serves server-rendered Player Card metadata and an X-only notice. Interactive `/play/:room` requires an iframe fetch destination and an X/Twitter HTTPS referrer.
- CSP permits only X/Twitter frame ancestors for the guestbook. Direct and non-X browser access is rejected. The old local iframe harness and raw HTML asset routes are removed.
- The player issues a random 24-hour embedding credential, stored hashed in D1. Guestbook and session APIs require it. OAuth authorization/callback pages remain first-party top-level flows and use their own single-use credentials.
- This is a browser access restriction, not platform attestation: custom HTTP clients can spoof referrer/fetch headers. X supplies no cryptographically signed iframe context.

## Guestbook verification

- Formatting, lint, all three TypeScript checks and production build passed.
- Six integration tests passed with 58 assertions against a real local Miniflare D1 binding and mocked X responses. Coverage includes PKCE, hashed/separate credentials, callback replay, expired/declined logins, profile lookup errors, verified signature ownership, updates, session revocation, concurrent single-use login claims and embed gates.
- Applied both D1 migrations remotely and deployed the custom-domain Worker. HTTP checks confirmed share metadata (200), direct player/API access rejection (403), non-X iframe rejection (403), and observed X iframe-header acceptance (200).
- Completed a real X authorization round-trip on the custom domain, verified the resulting profile-backed app session and its revocation.
- Browser UI testing used a locally intercepted X-origin test page, rather than posting a new tweet. The 480 × 480 guestbook loaded and its actual sign-in button opened the X flow. After authorization, backend polling automatically displayed the verified identity and signature form in the card. No horizontal overflow was observed. No production signature was submitted by the automation.

## Sandboxed signature action

- Reproduced the reported inert signing button in an iframe with scripts/popups enabled but without `allow-forms`. Chrome rejected native form submission before dispatching the submit handler; no signature API request occurred.
- Replaced the form with ordinary controls and bound the API mutation directly to a `type="button"` click. Added a visible `Signing…` state while the request is pending.
- Added a project instruction requiring direct button handlers for card mutations because X controls the sandbox permissions.
- Browser regression verification confirmed that clicking the new button sends the signature mutation and refreshes the displayed entry in a sandbox without `allow-forms`. Signature API responses were intercepted for this UI test, so no artificial production signature was created.

## Root sharing and guestbook presentation

- The root URL is now the canonical share URL and renders Player Card metadata for the existing default book, keeping its signatures together. Both sharing controls use the root URL.
- Removed the inspector, header/referrer diagnostics, storage probes and postMessage observer. Client configuration contains only the room and necessary embedding credential.
- Recent signatures are shown above the sign-in controls and load without authentication. Timestamps use relative labels and expose the full date/time as a tooltip. Periodic book refreshes also refresh the relative labels.
- Production root metadata was verified to point to the existing default book, with the root Open Graph URL and the X-only player gate intact. Browser checks confirmed recent signatures were visible while sign-in was still shown, relative labels rendered as `2 minutes ago`/`just now`, sharing used the root URL, and the inspector/form were absent.
- Formatting, lint, typechecks, all six integration tests and production build passed; the updated Worker was deployed to the custom domain.

## Mobile Safari sign-in recovery

- The reported new tab remained on the placeholder's `Preparing sign-in` screen. Aggregate server state confirmed that the active attempt was still pending and had not reached authorization. The old flow opened a placeholder first, then awaited work in the iframe before navigating it; Safari suspension could strand that navigation.
- Removed the placeholder route and asynchronous popup navigation. The card now prepares a launch URL in advance; its native new-tab link navigates directly on tap, with pending state saved synchronously beforehand.
- Persist the complete attempt, including launch URL and expiry. Incomplete stored attempts are cleared with an interrupted-sign-in message; expired attempts prepare a new login instead of leaving the card disabled.
- Added continue/check/cancel controls. The server reports pending/authorizing/exchanging progress and a polling-secret-authenticated cancellation endpoint invalidates unused launch/callback credentials. Cancellation is also checked before completing an in-flight profile exchange.
- Polling is single-flight, resumes on pageshow/focus/visibility, and pauses/aborts when the card leaves the foreground. Transient network errors preserve pending state; requests have bounded waits. Session claims received after cancellation are revoked.
- Added Playwright WebKit tests with an iPhone device configuration. These use intercepted provider/API responses and do not authorize real accounts or write signatures. They verify direct native OAuth launch, restored-page polling, continuation/cancellation after closing a tab and refreshing, and incomplete/expired attempt recovery.
- Added a backend regression test for progress phases, cancellation secret validation, and rejection of authorization/callbacks after cancellation. Seven D1 integration tests and three WebKit mobile tests passed.
- Formatting, lint, typechecks, ten tests (80 assertions), and production build passed. Deployed Worker version `c41658a5-7748-48b4-b864-0edb68da6ce9`; production smoke checks verified root share metadata, direct-player blocking, and the updated mobile controls/client asset.

## Mobile card layout

- The mobile square card clipped the signing buttons because the page's accumulated spacing and fixed list-height allowance exceeded the iframe viewport.
- Bound the guestbook layout to the iframe height with a flexible, independently scrolling signature list. Signing, status and sharing controls retain their own space; exceptionally short frames can still scroll the overall card.
- Removed the redundant timeline tagline, combined the signature heading/count into one compact row, tightened spacing and added a short-viewport layout. Kept textarea text at 16px to avoid Safari focus zoom and scoped card styling separately from OAuth pages.
- Added WebKit regression coverage at 320 × 320, 360 × 360 and 480 × 480, with one signature and twenty long signatures. Geometry checks verify signing/sharing controls are inside the viewport before and after signing, no document overflow, and the final signature remains reachable by scrolling the list. All requests are intercepted; no production entries are created.
- Formatting, lint, typechecks and all eleven tests (122 assertions) passed.
- Production build passed and Worker version `d3372528-a3b5-4851-8c87-2156c3b1a647` was deployed. Live smoke checks confirmed the compact markup and responsive stylesheet are served.

## Standalone guestbook and native X link support

- The native X link-opening flow displayed the X-only notice instead of loading an iframe. Standalone page access was approved to support that flow and ordinary browser visits.
- Root, room share and player routes now render the full app and issue expiring page credentials without requiring iframe/referrer headers. Removed the notice-only rendering and client frame requirement. The root retains Player Card metadata pointing to the existing default book; CSP still permits X/Twitter embeds.
- The existing hashed credential storage and internal `embedToken`/`embed_access` names now serve both standalone and embedded pages. X OAuth, session validation, single-use state, origin checks and authenticated signing remain enforced.
- Standalone layout uses the dynamic viewport height; embedded cards retain their compact fixed-viewport layout and independent signature scrolling.
- Added backend coverage for root/room/player rendering without an X referrer, metadata, page credential issuance and rejection of unauthenticated signatures. Added mobile WebKit coverage for standalone OAuth and signing with no iframe or referrer, using intercepted responses.
- Formatting, lint, typechecks and all thirteen tests (154 assertions) passed.
- Production build passed and Worker version `98c47118-0d93-4334-ae9e-e384ee15f3ac` was deployed. Live root/player checks without referrer headers confirmed full app rendering, signature listing and rejection of unauthenticated signing. No signatures were created by verification.

## Separate X mobile webview probe

- Added a diagnostic app with its own `x-webview-probe` Worker, D1 database, hourly expiry cleanup and custom domains `x-webview.stupidtech.net` / `x-webview-hop.stupidtech.net`. The existing guestbook is not redeployed by the diagnostic deployment command.
- Added an independent Vite HTML/client entry with root Player Card metadata, static favicon and a dedicated preview image. The app is usable as a fullscreen page and an X iframe.
- The probe uses prepared native links and mock sign-in/callback pages to compare openerless launch, preserved opener, automatic close, same-view sign-in/return and same-popup return. A second-origin hop supports cross-origin navigation tests without real authorization or provider credentials.
- Capture browser/request context, storage access/sharing, opener/parent readability, native global/handler names, history/navigation, viewport, lifecycle/BFCache, heartbeat timing and messaging observations. Native handlers are inspected only by name; incoming messages remain untrusted observations.
- Saved reports use hashed run credentials, authenticated reads/writes, bounded validated event batches and a 1,000-event cap. Credentials travel in fragments/request headers and are excluded from displayed/copied reports. Reports expire after 24 hours and expired data is removed hourly.
- Added D1/API and iPhone-configured WebKit checks for private/expired reports, invalid inputs/origins, separate metadata, completion logging before openerless cross-origin auto-close, opener messaging and same-view return. Manual native X testing is required to determine how its host delegates actually behave.
- Formatting, lint, typechecks, seventeen tests (173 assertions) and production build passed. Applied the probe schema remotely and deployed Worker version `aa67cc2c-d297-4f0d-8823-e91ed87e9450` to both diagnostic domains with hourly cleanup.
- Live iPhone-configured WebKit verification confirmed viewer collection, prepared popup launch, second-origin callback, completion persisted before automatic close, and private report access. These are ordinary WebKit observations; native X results will come from manual device runs.
- Inspected a supplied native-device run: same-view mock completion automatically replaced the callback with the viewer while preserving readable storage and history length. Opener access was absent, no enumerable native message handlers were observed, and both automatic/manual close attempts emitted still-open events. The native test used same-origin completion; cross-origin same-view completion and real OAuth still need device verification.

## Same-view standalone OAuth

- A subsequent native-device probe confirmed same-view completion through the second origin returned automatically to the viewer. Session/local storage remained readable and callback replacement preserved history length. Applying the observed pattern to the guestbook was approved.
- Standalone guestbook sign-in and continuation links now navigate in the same viewer. Pending credentials and a validated local return path are saved synchronously before leaving; unavailable session storage blocks navigation with a visible error. Embedded cards use the existing native new-tab flow.
- The backend includes the consumed OAuth state on its completion redirect. The completion client requires matching saved return/pending state and expiry metadata, then replaces itself with the original root/room/player route on success or denial. Return URLs cannot be external. The book claims the actual result/session from the authenticated backend poll; completion query parameters never authenticate anyone.
- Added a native return link for launch errors and context-aware completion hints. Same-view launch does not poll from the departing page, avoiding a session-claim race before navigation.
- Added mobile WebKit regression coverage for cross-origin same-view authorization/return, original room preservation, decline/retry, unavailable storage and external return rejection. Existing embed, layout, D1/OAuth and diagnostic tests pass.
- Formatting, lint, typechecks and nineteen tests (188 assertions) passed. Browser tests intercept X/API responses and do not authorize accounts or create production signatures.
- Production build passed; deployed guestbook Worker version `113f69c2-5e6f-4e09-bbc3-992c903d52ba`. Live WebKit smoke verified same-view launch through the real authorization preparation endpoint, cancellation, state-bound automatic return and retry with one browsing context. The outbound X authorization page was intercepted, so no account authorization or production signature was performed. Real authorization in the native X app remains the manual end-to-end check.

## Native timeline card preview investigation

- Verified live root metadata, player availability and preview image using simulated crawler/native-app requests. Both request contexts receive the same valid Player Card metadata; the image is publicly accessible, square, and sufficiently sized. No crawler-disallow or X-Frame-Options restriction was found.
- Historical developer-forum staff responses explicitly describe Player Cards as requiring native tweet detail view, with differing web/native implementations. The reported current behavior matches that design. The former Player Card documentation URL now redirects to the general developer documentation home.
- Recorded evidence, limitations and the `summary_large_image` tradeoff in `docs/card-preview-investigation.md`. Static summary sharing is a candidate for a native timeline A/B test but changes the shared URL's interactive web-card presentation.

## Public how-it-works page

- Added a static `/about` page explaining Player Card metadata, native versus web presentation, verified X OAuth, same-view/separate-tab navigation, signature updates, public entry fields, session storage/revocation and the frontend/backend stack.
- Added a “How it works” footer link. It opens outside embedded cards and navigates in the same view for standalone visits, with a return link on the explanation page.
- Reused the existing minimal typography and added a compact scrollable metadata example. The page needs no client JavaScript, login, database writes or page credential.
- Extended the existing square-card geometry checks to include the new footer link.
- Formatting, lint, typechecks and nineteen tests (188 assertions) passed, including footer visibility in 320 × 320, 360 × 360 and 480 × 480 cards.
- Production build passed and Worker version `aea35204-73a5-46fc-8f7b-70b8f718001d` was deployed. Live mobile WebKit checks verified the footer navigation, explanation content/styles, no horizontal overflow and a script-free HTML response.

## GitHub publication

- Prepared the project for publication as `x-guestbook`, including application source, the diagnostic app, migrations, public assets, tests and documentation.
- Added repository links and clone/deployment setup instructions to the documentation README. Existing ignore rules exclude credentials, local environment files, dependencies, build output and Wrangler state.
- Reviewed the staged file set and confirmed that local credential values and private-key/token patterns are absent. Verified that local environment files, dependencies, build output and Wrangler state are ignored.
