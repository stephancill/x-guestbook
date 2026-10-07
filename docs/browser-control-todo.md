# Browser Control observations

- Version: browser-control v0.6.0.
- Context: session-owned X Developer Console tab during OAuth app provisioning.
- Reproduction: snapshot listed a `Create App` button; clicking it returned without opening a visible dialog. A subsequent `getByRole("button", { name: "Create App", exact: true }).evaluate(...)` timed out after 30 seconds, although a fresh snapshot again listed the button.
- Expected: the visible button should resolve and open the app-creation dialog.
- Actual error: `locator.evaluate: Timeout 30000ms exceeded` waiting for the exact role/name locator.
- Recovery: fetched a fresh snapshot, then used snapshot refs / detailed accessibility inspection to distinguish the rendered button from the compact snapshot label.
- No credentials or private form values are recorded here.

## OAuth popup observation

- Version: browser-control v0.6.0; session-owned, locally intercepted X-origin iframe harness.
- Reproduction: wait for `page.waitForEvent("popup")` while clicking the embedded guestbook's sign-in button. The app opens a new tab and clears its opener.
- Actual error: popup-event wait timed out after 30 seconds; the new sign-in tab nevertheless opened and the guestbook showed its pending-login status. The tab was absent from `context.pages()`.
- Expected: Browser Control should expose the openerless tab or explicitly identify the tracking limitation.
- Recovery: the authorization was completed manually in the new tab; the original iframe's polling then displayed the verified account and sign form. This confirmed application success independently of the missing popup event.
- Developer Console navigation also occurred during provisioning, so failures to resolve old controls were recovered using a fresh view rather than retrying stale locators.
