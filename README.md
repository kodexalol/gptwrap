# Jumpseat

The social and job platform for Roblox aviation. Follow airlines, post and discover what crews are up to, and apply to open roles, all in one place. Applications are forwarded to the airline's Discord.

Jumpseat is an independent fan project. It is not affiliated with or endorsed by Roblox Corporation or any airline.

## What's in it

- **Home feed.** Posts from the airlines and people you follow, plus a popular feed for everyone else.
- **Posts.** Text up to 500 characters, `#hashtags`, an optional https image, likes, comments, and reports.
- **Discover.** Search across airlines, people, posts, and roles. Browse popular tags.
- **Airlines.** Public profiles with followers, posts, and open roles. Verified airlines can post as the airline.
- **Jobs.** Filterable open roles with a one-step application.
- **Profiles.** Bio, display name, follower counts, and the airlines a person runs.
- **Moderation.** Reports are counted, and a post is hidden automatically once three different people report it. Posts can also be deleted by their author.

## Quick start

```bash
npm install
ALLOW_DEV_LOGIN=1 npm start    # http://localhost:3000
```

With `ALLOW_DEV_LOGIN=1`, the "Sign in" page asks for any username and signs you in without Roblox. This is for local testing only. It refuses to run when `NODE_ENV=production`.

The first run creates `data/db.json` with sample airlines, roles, and posts. Anything marked `sample` is fake.

## Configuration

Copy `.env.example` to `.env`, or export the variables in your shell.

| Variable | Purpose |
| --- | --- |
| `PORT` | Port to listen on (default `3000`) |
| `PUBLIC_URL` | Public base URL. Use `https://` in production so cookies are marked Secure |
| `ROBLOX_CLIENT_ID` | Open Cloud OAuth app client ID |
| `ROBLOX_CLIENT_SECRET` | Open Cloud OAuth app secret |
| `ROBLOX_REDIRECT_URI` | Optional. Defaults to `${PUBLIC_URL}/auth/roblox/callback` |
| `ALLOW_DEV_LOGIN` | Set to `1` to enable dev sign-in. Never set it in production |

Register the redirect URI in your Open Cloud OAuth app exactly as configured here.

## Accounts and verification

1. **Sign in with Roblox.** A Roblox sign-in creates your Jumpseat account. The username comes from Roblox. Sessions are random tokens stored as hashes in an HttpOnly cookie.
2. **List an airline** at `#/claim` with its Roblox group ID. Anyone signed in can list up to three airlines.
3. **Verify it.** Click "Verify with Roblox" on the airline page. The server signs you in with Roblox and checks that your Roblox user ID matches the owner of the group. If it does, the airline is verified and you become its owner.
4. **Owners** post as the airline, post and close roles, and edit the description and Discord settings from the airline page.

Unverified airlines are visible but marked as unverified. Their roles are hidden from public listings and can't receive applications.

## API

All routes are under `/api` and return JSON. Writes need a signed-in session.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/me` | Current user, owned airlines, or `null` |
| PATCH | `/api/me` | `{ displayName?, bio? }` |
| GET | `/api/users/:username` | Profile, follower counts, posts |
| GET | `/api/feed` | Posts from people and airlines you follow |
| GET | `/api/posts?sort=new\|top&tag=&airline=` | Public post list |
| POST | `/api/posts` | `{ body, imageUrl?, airlineSlug? }` (`airlineSlug` requires ownership) |
| GET | `/api/posts/:id` | Post with comments |
| DELETE | `/api/posts/:id` | Author or airline owner only |
| POST | `/api/posts/:id/like` | Toggles like |
| POST | `/api/posts/:id/comments` | `{ body }` |
| DELETE | `/api/comments/:id` | Author only |
| POST | `/api/posts/:id/report` | `{ reason? }`. Three reporters hide the post |
| POST | `/api/follows` | `{ targetType: "airline" \| "user", targetId }`. Toggles follow |
| GET | `/api/tags` | Popular hashtags |
| GET | `/api/discover?q=` | Airlines, people, posts, and roles that match |
| GET | `/api/airlines` | Airline directory |
| GET | `/api/airlines/:slug` | Airline with its roles and posts |
| POST | `/api/airlines` | `{ name, robloxGroupId, description?, discordInvite?, discordWebhook? }` |
| PATCH | `/api/airlines/:slug` | Owner only. `{ description?, discordInvite?, discordWebhook? }` |
| POST | `/api/airlines/:slug/jobs` | Owner only. `{ title, role, description }` |
| POST | `/api/airlines/:slug/jobs/:jobId/close` | Owner only |
| GET | `/api/jobs?role=&q=` | Open roles from verified airlines |
| GET | `/api/jobs/:id` | One role |
| POST | `/api/jobs/:id/applications` | `{ robloxUsername, message? }`. Forwarded to Discord if a webhook is set |

Roles are `pilot`, `cabin-crew`, and `ground`.

## Before going live

These are not done yet:

- **Confirm the Roblox endpoints.** The OAuth URLs, the `sub` claim, the `preferred_username` field, and the group lookup in `server.js` came from the docs and haven't been tested against a real app. Check them in the Open Cloud reference. If `sub` doesn't match the group owner's user ID, verification will fail for everyone.
- **Replace the JSON store.** `src/store.js` rewrites one file on every change. Move to SQLite or Postgres before real traffic.
- **Move rate limits to shared storage.** They are in memory, so they reset on restart and don't work across several servers.
- **Review image hosting.** Image links are https-only but can point anywhere. Consider proxying or allow-listing hosts, since embedded images reveal viewer IPs and can serve unsafe content.
- **Encrypt webhooks.** Discord webhook URLs are stored in plain text and act like passwords.
- **Add a moderator tool.** Reports currently hide posts automatically, with no review queue or appeal.
- **Check the name.** "Jumpseat" is a working name. Search for trademark and app-store conflicts before launch. Don't use the Roblox name or logo in the brand.
- **Add real content rules.** Write terms of use and a community guideline, and make sure the report flow works for each post.

## Layout

```
server.js          Express app: API, Roblox sign-in, verification, moderation
src/auth.js        Session cookies and hashed session tokens
src/store.js       JSON-file store and sample data
src/util.js        Helpers: escaping, hashtags, rate limiting
public/            Single-page frontend (index.html, app.js, styles.css)
data/              Created at runtime (gitignored)
```
