# Jumpseat

A verified job board for Roblox airlines. Airlines post roles, applicants apply once, and applications are forwarded to the airline's Discord.

Jumpseat is an independent fan project. It is not affiliated with or endorsed by Roblox Corporation or any airline.

## Quick start

```bash
npm install
npm start          # http://localhost:3000
```

On first run, the server creates `data/db.json` with two sample airlines and three sample roles. Those records are marked `sample: true` and are fake.

The public pages work without any configuration. Airline verification needs Roblox OAuth credentials (see below).

## Configuration

Copy `.env.example` to `.env`, or export the variables in your shell. Start the server with `node --env-file=.env server.js` if you use a `.env` file.

| Variable | Purpose |
| --- | --- |
| `PORT` | Port to listen on (default `3000`) |
| `PUBLIC_URL` | Public base URL, used for the OAuth redirect |
| `ROBLOX_CLIENT_ID` | Open Cloud OAuth app client ID |
| `ROBLOX_CLIENT_SECRET` | Open Cloud OAuth app secret |
| `ROBLOX_REDIRECT_URI` | Optional. Defaults to `${PUBLIC_URL}/auth/roblox/callback` |

Register the redirect URI in your Open Cloud OAuth app exactly as it is configured here.

## How it works

1. **List an airline** at `#/claim`. Give the Roblox group ID and, optionally, a Discord webhook and invite.
2. **Verify it.** The airline signs in with Roblox at `/auth/roblox?airline=<slug>`. The server exchanges the code, reads the user's ID, and checks that the ID matches the owner of the Roblox group. If it matches, the airline is verified and the server shows a manage token once.
3. **Post roles** with the manage token, either at `#/post` or through the API.
4. **Applicants apply** on the role page. If the airline has a webhook, the application is posted to its Discord. Otherwise it is saved only.

Unverified airlines are listed as unverified. Their roles are hidden from public listings and cannot receive applications.

## API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/airlines` | All airlines, without secrets |
| GET | `/api/airlines/:slug` | One airline with its live roles |
| GET | `/api/jobs?role=&q=` | Live roles. `role` is `pilot`, `cabin-crew` or `ground` |
| GET | `/api/jobs/:id` | One live role |
| POST | `/api/jobs/:id/applications` | Body: `{ robloxUsername, message }` |
| POST | `/api/airlines` | Body: `{ name, robloxGroupId, description?, discordWebhook?, discordInvite? }` |
| POST | `/api/airlines/:slug/jobs` | Header: `Authorization: Bearer <manage token>`. Body: `{ title, role, description }` |
| POST | `/api/airlines/:slug/jobs/:jobId/close` | Same auth. Closes a role |

## Before going live

These items are not done yet:

- **Confirm the Roblox endpoints.** The OAuth URLs and the group lookup in `server.js` (`roblox` object) came from the docs and haven't been tested against a real app. Confirm them in the Open Cloud reference. Also confirm that the `sub` claim from `/oauth/v1/userinfo` is the Roblox user ID that the group `owner.userId` field uses. If they differ, verification will fail for everyone.
- **Check the name and branding.** "Jumpseat" is a working name. Search for trademark and app-store conflicts before launch. The UI uses no Roblox logo or name in the brand. Keep it that way.
- **Replace the JSON store.** `src/store.js` writes the whole database to one file, which is fine for a prototype and bad for concurrent traffic. Move to SQLite or Postgres first.
- **Protect webhooks.** Discord webhook URLs are stored in plain text and act like passwords. Encrypt them at rest.
- **Add rate limits and moderation.** Applications and airline listings have no rate limits or spam controls yet. Add those, plus a way to report fake airlines.
- **Plan for manage tokens.** They are shown once and stored only as a hash. Add a rotation path for owners who lose theirs.

## Layout

```
server.js          Express app: API, Roblox OAuth, verification
src/store.js       JSON-file store and sample data
public/            Single-page frontend (index.html, app.js, styles.css)
data/              Created at runtime (gitignored)
```
