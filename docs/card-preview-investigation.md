# Native X timeline preview investigation

## Finding

The reported native-app behavior matches the historical Player Card implementation: the card appears in tweet detail after opening the tweet, rather than as a preview in the native timeline. This differs from the web client's inline presentation.

In a January 2018 developer-forum response, a then-Twitter staff member stated:

> On mobile, player cards require a click to the Tweet detail view.

The follow-up clarified:

> It's simply an implementation difference between the web and the native mobile apps.

Source: [Player Cards Not Displaying As Expected, responses 3 and 5](https://devcommunity.x.com/t/player-cards-not-displaying-as-expected/99522/3).

A June 2018 forum post also quotes the former Player Card documentation as specifying native-app detail view, not timeline, followed by opening `twitter:player` in a simulated browser: [native Player Card behavior](https://devcommunity.x.com/t/why-is-a-player-card-behavior-on-mobile-ios-app-inferior-to-desktop/106806).

These are historical sources, not a new 2026 guarantee. The reported current native-app behavior matches them. The former documentation URL now redirects to the general developer documentation home.

## Live checks

- Root HTML returns 200 with `text/html` for both a simulated `Twitterbot/1.0` request and an iPhone X-app user agent.
- Both receive identical, server-rendered metadata: one `twitter:card=player`, absolute HTTPS image/player URLs, and 480 × 480 player dimensions.
- The preview image is a publicly accessible PNG: 200, 960 × 960, 26,085 bytes. Its aspect ratio matches the player and its dimensions exceed the historical minimum.
- The player URL returns 200 without an iframe/referrer requirement. No X-Frame-Options header is present; CSP permits X/Twitter frame ancestors.
- No X-Robots-Tag restriction is present. The served robots response contains Cloudflare's content-signal explanation but no crawler-disallow rule.
- Simulated crawler requests verify server behavior, not the actual crawler's network access or a tweet's cached card. The card being visible in tweet detail independently supports successful card recognition.
- An authenticated CLI attempt to inspect recent posts returned no parsed timeline instructions, so it was not used as evidence about tweet-level card caching.

The same-view OAuth deployment changed client navigation and callback behavior, not the card type or image/player metadata. Those client scripts do not control native timeline layout.

## Product implications

A `summary_large_image` share card is the appropriate candidate for a visible native timeline link preview. Tapping it opens the standalone guestbook, which now supports same-view OAuth. It should be tested in the actual native timeline before changing the primary share URL's metadata.

Changing a shared URL from `player` to `summary_large_image` also replaces its interactive web Player Card with a static link preview. Serving different metadata based on the viewing webview's user agent does not reliably select separate card types for native versus web viewers, because card discovery/caching occurs through X's crawler. A separate share URL permits an isolated comparison.
