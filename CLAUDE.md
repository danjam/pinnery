# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Pinnery: self-hosted image boards with accounts, sharing, a Chrome extension (`extension/`) and an installable web app. README.md covers behaviour and env vars.

## Commands

- Build: `npm run build` (`scripts/build.ts`) bundles the web app (`src/public`) and the extension (`extension/`) into `dist/` with esbuild; the server serves `dist/`, so rebuild after changing either. `npm start` and `npm test` build first. Entry points come from the pages' `<script src>` tags and the extension manifest, so a new script needs no build change.
- Run: `PINNERY_ADMIN_EMAIL=admin@example.com PINNERY_PASSWORD=test-pass-1 DATA_DIR=<tmp> PORT=<port> node src/server.ts`
- Type-check: `npm run typecheck` (tsc, no output; one tsconfig each for the server and tests, `src/public`, its service worker (`tsconfig.sw.json`) and `extension`). CI runs it before the tests.
- Test: `npm test` (node --test). Tests live in `test/<area>/` (accounts, auth, boards, pins), plus a few at the top level. Each file boots its own server with `startServer()` from `test/helpers/server.ts`; its header explains the clients and the sign-in throttle budget the tests share. Exercise UI changes against a throwaway instance.
- Coverage: `npm run coverage` runs the tests under c8 and prints coverage of `src/` (server only; config in `.c8rc.json`). CI shows it in the job summary and uploads it to Coveralls (history, PR changes, the README badge).
- `node scripts/icons.ts` regenerates extension/app icons from `src/public/icon.svg`.

## TypeScript

Node runs the server's `.ts` files directly by stripping the types, so only erasable syntax is allowed: no enums, namespaces or parameter properties. Import types with `import type`, and write relative imports with the real extension (`./db.ts`). The browser code is bundled by esbuild, which also only strips types; `tsc` is what checks them.

## Releases

Use Conventional Commits; release-please derives versions and CHANGELOG.md from them. Merging its Release PR tags, releases and pushes the GHCR image (all in `.github/workflows/release.yml`). Don't tag or bump versions by hand.

The extension isn't versioned separately: the server fingerprints the built extension (`dist/extension`) at startup, reports it in `/healthz` and stamps it into the downloaded zip's `manifest.json` `version_name`; the options page compares the two to offer updates.

## Pull requests

- PR titles are Conventional Commits too: the squash merge uses the title, so it becomes the changelog line. The `pr-title` check enforces it, and the master ruleset requires it (with `test`). Keep one change per PR, so each gets its own line.
- Every check on a PR should be green, optional ones (CodeQL) included. Fix the cause; only dismiss a proven false positive, with the reason.

## Architecture

- `src/server.ts` wires modules and lists every route.
- Fields the middleware sets on `req` (`session`, `user`, `pick`) are declared once, in `src/express.d.ts`.
- `src/access.ts` is the only place access is decided (owner / viewer / editor). All board, pin and image queries go through it, and foreign ids return 404.
- `src/db.ts` `migrate()` upgrades existing databases in place. Schema changes go there.
- Originals are content-addressed by SHA-256 and shared across pins and users; deletes are refcounted.
- Server-side URL fetches go through the SSRF guard in `src/fetch.ts`.
- Extension and share-target saves upload first to `/api/pick/*`, where the image is parked in memory (`src/pending.ts`). The server-hosted `/pick/<token>` page then chooses the board; its token is the page's only credential.
- Mail is optional. Every emailed link needs a copy-the-link fallback. Links emailed to someone who isn't signed in (forgot password) must use `PINNERY_PUBLIC_URL`, never the request's Host header.
- Redirects to a `?next=` path go through `safeNext` (`src/auth.ts`) or `js/next.ts` in pages; never redirect to it raw.
- The image runs on distroless Node as uid 1000, with a read-only filesystem except `/data`: no shell or npm at runtime, so never shell out (`child_process`) and only write under `DATA_DIR`.
- Frontend is vanilla TypeScript with no framework, bundled per page by esbuild. Reuse `js/ui.ts` (`el()`, dialogs, toasts), `js/icons.ts` (MDI paths copied from `@mdi/js`) and the `css/app.css` tokens.
- The CSP (`src/server.ts`) only allows scripts from our own files: no inline `<script>` blocks or `on…=` attributes in pages. Put a page's script in `public/js/<page>.ts` (pages still load `/js/<page>.js`, the bundle), and load `/js/boot.js` (from `js/boot.ts`) first in `<head>` for the theme. `test/headers.test.ts` fails on inline scripts.

## Conventions

- Size full-screen views with `height: 100%`, not `100dvh`, which overshoots in an installed Android app.
