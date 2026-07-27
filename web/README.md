# Nexus Dashboard — PWA companion

Browser/mobile companion to the Electron desktop app. No shared backend holds
anyone's personal data — to-dos/habits/conferences and Google OAuth tokens
live only in each visitor's own browser (`localStorage`), per device. The
only server-side code is a single stateless function that relays one step of
the OAuth token exchange (see below) — it never logs or stores anything.

## Phase 4.0 spike result (resolved)

Tested whether Google's token endpoint accepts a PKCE-only authorization-code
exchange (no `client_secret`) for a "Web application" OAuth client type.

**Result: no — `client_secret` is required.** Google returned:
```
400 invalid_request
"client_secret is missing."
```
even with a valid PKCE `code_verifier`. So the token exchange (both the
initial code exchange and refresh-token calls, since they hit the same
authenticated endpoint) goes through `functions/api/token-exchange.js`, a
stateless Cloudflare Pages Function that holds the client secret as an
encrypted environment variable and forwards the request to Google — the
secret never reaches the browser, and nothing is stored server-side.

## Google Cloud Console setup

One OAuth Client ID, type **Web application**, in the same Google Cloud
project as the desktop app's Calendar client:
- Authorized JavaScript origins: your Pages URL(s) (e.g. `http://localhost:8788`, `https://<project>.pages.dev`)
- Authorized redirect URIs: same URLs + `/` (must match exactly what `auth.js` sends)
- Scopes requested: `https://www.googleapis.com/auth/calendar.events` + `https://www.googleapis.com/auth/gmail.modify` + `https://www.googleapis.com/auth/drive.appdata` (the last one powers cross-device sync — see below; it only grants access to a hidden per-app storage folder, never the user's visible Drive files)
- Publishing status: **Testing** (same as the desktop app) — each user's Google
  account needs to be added to the test-user allowlist in Cloud Console
  before they can sign in, and external testers' refresh tokens expire after
  about a week, requiring an occasional re-sign-in. Surfaced in the settings
  panel UI so it doesn't read as a bug.

## Cross-device sync

`js/driveSync.js` syncs to-dos/habits/conferences with the Electron desktop
app (and any other device signed into the same Google account) by storing
one JSON file (`nexus-sync-v1.json`) in the user's own Google Drive
`appDataFolder` — a hidden, per-app storage space invisible in their normal
Drive UI. No server holds this data; it rides the same OAuth connection as
Calendar/Gmail above. Merge is per-item (with tombstones for deletes) for
todos/conferences/habit definitions, and whole-category last-write-wins for
the habit-checkoff log and daily stats. See `src/driveSync.js` in the
Electron app for the (hand-ported, kept-in-sync) twin of this logic and a
fuller writeup of the merge rules and known limitations.

## Local dev

```
cd web
npx wrangler pages dev public --port 8788
```

`GOOGLE_OAUTH_CLIENT_SECRET` must be set for the Function to work locally —
create `web/.dev.vars` (gitignored) with:
```
GOOGLE_OAUTH_CLIENT_SECRET=<the client secret>
```

## Deploy (Cloudflare Pages)

- Root directory: `web`
- Build output directory: `public`
- Build command: (none — static files)
- Environment variable `GOOGLE_OAUTH_CLIENT_SECRET` set as an **encrypted**
  secret in the Pages dashboard (Settings → Environment variables) — never
  committed to git.
