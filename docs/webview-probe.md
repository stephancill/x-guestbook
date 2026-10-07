# X mobile webview probe

## Purpose

Investigate the fullscreen viewer and native popup used by X's mobile app. This is a separate Worker and D1 database at `https://x-webview.stupidtech.net/`. It uses a mock sign-in/callback sequence rather than real OAuth. Post the root URL manually to test its Player Card inside X.

Apple delegates popup creation and closure to the embedding app. A JavaScript API being present does not mean X implements its native UI behavior. The probe records attempted actions and subsequent events so native-device observations can be compared with ordinary WebKit behavior.

## Test procedure

1. Open the posted card using the native X app. Copy the displayed run ID.
2. Try **Match guestbook (manual close)** first. Complete the mock sign-in and inspect **Try window.close()**, **Try history.back()**, and **Return to viewer in this window**, using separate attempts if navigation changes the page.
3. Try **Auto-close after completion**. Note whether the native popup dismisses and restores the original viewer.
4. Try **Preserve opener** to compare opener access and message delivery with the openerless guestbook flow. This is a diagnostic comparison, not a recommendation to change production OAuth isolation.
5. Try **Sign in within this viewer**. Completion automatically replaces the callback with the viewer in the same browsing context.
6. Try **Return in popup automatically**. This replaces the callback with a usable viewer within the popup without relying on dismissal.
7. On any mock sign-in page, **Complete through a second origin** adds a cross-origin hop through `https://x-webview-hop.stupidtech.net/` before the callback. This tests cross-origin navigation, not X OAuth's exact headers or behavior.
8. Share the run ID and observations, or use **Copy report**. Repeat in Safari to compare.

An automatic same-view return and an automatic popup return display the saved completions through server polling. They demonstrate navigation behavior; they do not create an authenticated session.

## Collected observations

- User agent, language, platform, viewport and visual viewport.
- Selected request headers: user agent, referrer origin, fetch destination/mode/site/user, and language.
- Frame/parent/ancestor origins, opener presence/readability, history length/state key names, navigation type and redirect count.
- Local/session storage availability and sharing of a probe-only marker; a probe-only cookie and storage access status.
- Names/types of exposed native globals and enumerable WebKit message handler names. Native handlers are never invoked.
- Visibility, focus, pagehide/pageshow and BFCache signals; per-page elapsed time/heartbeats to compare suspension and resumption.
- Probe-only BroadcastChannel/storage notifications and bounded observations of incoming postMessage origins, source categories and payload key names. Messages never authenticate identities or issue commands.
- Completion, notification, back-navigation and close attempts. A still-open event follows an ineffective `window.close()` attempt.

Run credentials remain in URL fragments and authenticated request headers. Reports exclude those credentials, raw referrer URLs, cookies, existing storage contents, OAuth data and IP addresses. Read/write access requires the run credential. Each run accepts at most 1,000 events; the UI retains the most recent 300 received events. Access expires after 24 hours, and hourly cleanup removes expired runs/events.

## Development and operator inspection

```sh
bun run format
bun run check
bun run test
bun run deploy:webview
bunx wrangler d1 migrations apply x-webview-probe --remote --config wrangler.webview.jsonc
```

To inspect a supplied UUID through authenticated Cloudflare tooling:

```sh
bunx wrangler d1 execute x-webview-probe --remote --config wrangler.webview.jsonc --command "SELECT id, received_at, event FROM probe_events WHERE run_id = '<run-id>' ORDER BY id"
```

Only the probe Worker is deployed by `deploy:webview`. The production guestbook's runtime and OAuth credentials are not used by the probe.

## References

- [WKUIDelegate.webViewDidClose](<https://developer.apple.com/documentation/webkit/wkuidelegate/webviewdidclose(_:)>): native closure delegate.
- [WKScriptMessageHandler](https://developer.apple.com/documentation/webkit/wkscriptmessagehandler): message handlers are installed by the host app.

Headless iPhone-configured WebKit regression tests verify collection, private reports, openerless cross-origin completion/close, opener messaging and same-view return. Actual X native behavior must be established using the deployed probe on a device.

## Native-device findings

- In the observed native X viewer, the page was top-level, had no JavaScript opener, and exposed no enumerable WebKit message handler names.
- Both automatic and button-triggered `window.close()` attempts left the page open; subsequent still-open events and heartbeats confirmed continued execution.
- The same-view mock completion returned to the viewer with `location.replace()`. Session/local storage remained readable across that navigation, and history length did not increase during the replacement.
- A subsequent native-device same-view test used **Complete through a second origin** and successfully returned to the viewer. Session/local storage survived the round trip, and replacing the callback did not add a history entry.
- The guestbook now applies this same-view pattern to standalone OAuth, with state-bound local return paths and backend session claiming. Real authorization in the native X viewer remains the end-to-end verification step.
