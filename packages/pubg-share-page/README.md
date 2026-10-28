# @rine-kit/pubg-share-page

The page behind a PUBG report's 🔗 link: a read-only tactical analysis view (squad cards, per-match life line, fights, route and circles; opposing teams anonymised).

- `createShareHandler({ store, story, mapDirectory, allow })` turns a request (`path`, `cookie`, `https`, `remote`) into a response, so any HTTP server can host it. It answers `/s/<token>`, `/share`, `/assets/*`, `/api/share/view`, `/api/share/matches/<id>/story` and `/api/maps/<name>`, and returns `null` for any other path.
- The host injects a `ShareStore` (`findShare(tokenHash)`, `loadContent(share)`): RINE reads Postgres, Lab can read SQLite. Nothing in here touches a database, OpenClaw or a secret.
- `StoryContext` holds the raw-telemetry archive, a worker-thread pool and the analysis cache.

Access: the only way in is a token. `/s/<token>` opens the page and sets a share-only cookie; every data route reads that cookie and re-checks the share (unknown, malformed, expired and revoked all answer alike, immediately). A link opens exactly the matches it lists. `/assets/*` (the page's program) is the only public path.

`pnpm build` builds the page (`dist/client`, vite) and the server code (`dist/server`).
