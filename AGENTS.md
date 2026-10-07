# Tweet miniapp

- Read `docs/plan.md` and `docs/implementation-notes.md` before changing implementation.
- Update implementation notes when implementation changes, and always before committing. Keep notes free of personal information.
- Use Bun, Vite, vanilla TypeScript, Hono, Zod and Cloudflare Workers with D1 for the guestbook and OAuth state.
- Prefer simple native HTML controls and minimal styling. Keep the embedded app usable at 480 × 480 and on mobile.
- X player iframes may omit `allow-forms`. Use `type="button"` and direct click handlers for mutations; never rely on native form submission inside a card.
- Prepare OAuth launch URLs before the sign-in tap. Use native new-tab links for embedded cards and same-view links for standalone visits. Save standalone pending/return state synchronously and validate state-bound local return paths. Never open a placeholder popup and navigate it after awaiting iframe work; mobile Safari may suspend the opener.
- Prefer functions and named parameter objects over classes and positional parameters.
- Validate external inputs and API responses with Zod.
- Run `bun run check` and `bun run build` after modifying TypeScript. Use `bun run format` to format changes.
- Player-card metadata must be server-rendered, use absolute HTTPS URLs in production, and point to `/play/:room`.
- Keep iframe embedding enabled. Never add X-Frame-Options or a frame-ancestors restriction that blocks X.
- Treat incoming postMessage payloads as untrusted observations, never as authenticated identities or commands.
- Keep OAuth provider tokens on the backend. Use S256 PKCE, expiring single-use state, separate secret polling credentials and hashed revocable app sessions.
- Serve favicons and preview images from `public/`. Never commit `.env.local`, `.dev.vars`, or credentials.
- Use conventional commit messages.
