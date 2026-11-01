# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Pinnery: self-hosted image boards with accounts, sharing, a Chrome extension (`extension/`) and an installable web app. README.md covers behaviour and env vars.

## Commands

- Run: `PINNERY_ADMIN_EMAIL=admin@example.com PINNERY_PASSWORD=test-pass-1 DATA_DIR=<tmp> PORT=<port> node src/server.js`
- No build step: check syntax with `node --check <file>` and exercise changes against a throwaway instance.
- `node scripts/icons.mjs` regenerates extension/app icons from `src/public/icon.svg`.

## Releases

Use Conventional Commits; release-please derives versions and CHANGELOG.md from them. Merging its Release PR tags, releases and pushes the GHCR image (all in `.github/workflows/release.yml`). Don't tag or bump versions by hand.

The extension isn't versioned separately: the server fingerprints `extension/` at startup, reports it in `/healthz` and stamps it into the downloaded zip's `manifest.json` `version_name`; the options page compares the two to offer updates.

## Architecture

- `src/server.js` wires modules and lists every route.
- `src/access.js` is the only place access is decided (owner / viewer / editor). All board, pin and image queries go through it, and foreign ids return 404.
- `src/db.js` `migrate()` upgrades existing databases in place. Schema changes go there.
- Originals are content-addressed by SHA-256 and shared across pins and users; deletes are refcounted.
- Server-side URL fetches go through the SSRF guard in `src/fetch.js`.
- Extension and share-target saves upload first to `/api/pick/*`, where the image is parked in memory (`src/pending.js`). The server-hosted `/pick/<token>` page then chooses the board; its token is the page's only credential.
- Mail is optional. Every emailed link needs a copy-the-link fallback.
- Frontend is vanilla ES modules with no framework. Reuse `js/ui.js` (`el()`, dialogs, toasts), `js/icons.js` (MDI paths copied from `@mdi/js`) and the `css/app.css` tokens.

## Conventions

- Size full-screen views with `height: 100%`, not `100dvh`, which overshoots in an installed Android app.
