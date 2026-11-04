# Jumpseat

The social and job platform for Roblox aviation. Follow airlines, post and discover what crews are up to, and apply to open roles, all in one place. Applications are forwarded to the airline's Discord.

Jumpseat is an independent fan project. It is not affiliated with or endorsed by Roblox Corporation or any airline.

## What's in it

- **Home.** A dashboard: the setup checklist for new members, open roles, organisations, popular posts, and trending tags.
- **Feed.** Posts from the organisations and people you follow, plus a popular feed for everyone else.
- **Posts.** Text up to 500 characters, `#hashtags`, one media item (image, video, or YouTube/Vimeo link), likes, comments, and reports.
- **Direct messages.** Message requests, one-message-until-accepted, blocking, declining, and reporting. Thread view updates every 3 seconds.
- **Video.** Post a direct `.mp4` or `.webm` link, or a YouTube or Vimeo link. Embeds use privacy-enhanced hosts (youtube-nocookie.com). Jumpseat does not host or upload video.
- **Motion.** Views cross-fade where supported, content rises in, likes pop, and loading uses skeleton placeholders. All motion is disabled when the OS asks for reduced motion.
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

## Accounts, confirmation and badges

1. **Sign in** with Discord (or Roblox, if configured). Sessions are random tokens stored as hashes in an HttpOnly cookie.
2. **Confirm your Roblox account** (the green house). Enter your Roblox username, and Jumpseat gives you a one-time code like `JS-7K2M9Q`. Paste it into the About section of your Roblox profile, save, and press Check. The server reads your public Roblox profile and confirms the link. A Roblox account can only be confirmed on one Jumpseat account. Codes expire after 24 hours.
3. **Set up an organisation** (airline, Roblox store, or other). This needs a confirmed account, and the server refuses it otherwise (`confirm_required`). Anyone confirmed can set up up to three.
4. **Verify the organisation** (the blue check). Sign in with Roblox as the account that owns the group. The server checks that you are confirmed, that you are the group owner, and that the Roblox account matches your confirmed one.
5. **Owners** post as the organisation, post and close roles, and edit settings from its page.

Badges:

| Badge | Meaning | Who gets it |
| --- | --- | --- |
| Green house | Confirmed account | Anyone who finishes the Roblox code check |
| Gold clover check | Jumpseat verified member | Granted by an admin |
| Red tools | Admin | Usernames listed in `ADMIN_USERNAMES` |
| Blue check | Verified organisation | Group owner has verified the organisation |

Unverified organisations are visible but marked as unverified. Their roles are hidden from public listings and can't receive applications.

## Admin tools

Set `ADMIN_USERNAMES` to a comma-separated list. Admins see **Admin tools** on their profile. They can review reported posts (restore or remove them), see conversation reports (reason and reporter only, never message content), and grant or remove the gold check.

Admin status is set in configuration, not in the UI, so there is no way to make yourself an admin from the site.

## API

All routes are under `/api` and return JSON. Writes need a signed-in session.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/me` | Current user, organisations, pending confirmation, admin flag |
| POST | `/api/me/roblox/start` | `{ username }`. Returns a one-time code to put in your Roblox About |
| POST | `/api/me/roblox/check` | Reads your Roblox About and confirms the account if the code is there |
| POST | `/api/me/roblox/cancel` | Clears a pending code |
| GET | `/api/admin/reports` | Admins only. Reported posts and conversation reports |
| POST | `/api/admin/posts/:id/restore` | Admins only |
| POST | `/api/admin/posts/:id/remove` | Admins only |
| GET | `/api/admin/users?q=` | Admins only. Member search |
| POST | `/api/admin/users/:id/member` | Admins only. `{ verified }` grants or removes the gold check |
| PATCH | `/api/me` | `{ displayName?, bio? }` |
| GET | `/api/users/:username` | Profile, follower counts, posts |
| GET | `/api/feed` | Posts from people and airlines you follow |
| GET | `/api/posts?sort=new\|top&tag=&airline=` | Public post list |
| POST | `/api/posts` | `{ body, media?, airlineSlug? }`. `media` is an image, video, or YouTube/Vimeo link. `airlineSlug` requires ownership |
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
| GET | `/api/conversations` | Your inbox and requests, with unread counts |
| POST | `/api/conversations` | `{ username }`. Starts a request, or returns the existing conversation |
| GET | `/api/conversations/:id` | Thread (last 200 messages). Marks it read. Participants only |
| POST | `/api/conversations/:id/messages` | `{ body }`. Enforces the request rules below |
| POST | `/api/conversations/:id/accept` | Recipient accepts a request |
| POST | `/api/conversations/:id/decline` | Recipient declines a request |
| POST | `/api/conversations/:id/report` | `{ reason? }`. Recorded for moderators |
| POST | `/api/users/:id/block` | Toggles a block. Stops messages in both directions |

**Message rules** (enforced on the server, not the browser):

1. Starting a conversation creates a *request*. The recipient can't reply until they accept.
2. Before acceptance, the sender can send one message and must wait.
3. A declined request closes for both people.
4. Blocking stops messages both ways. It does not hide public posts.
5. Non-participants get a 404 for a conversation, so you can't probe for IDs.

Roles are `pilot`, `cabin-crew`, and `ground`.

## Before going live

These are not done yet:

- **Discord setup.** Register the redirect URI `${PUBLIC_URL}/auth/discord/callback`. Discord sign-in is written but hasn't been tested against a live app.
- **Roblox confirmation.** The code check calls Roblox's public `users.roblox.com` API and has been tested against a real profile (it rejects a missing code). The full success path needs someone to paste a code into a real About section.

- **Confirm the Roblox endpoints.** The OAuth URLs, the `sub` claim, the `preferred_username` field, and the group lookup in `server.js` came from the docs and haven't been tested against a real app. Check them in the Open Cloud reference. If `sub` doesn't match the group owner's user ID, verification will fail for everyone.
- **Replace the JSON store.** `src/store.js` rewrites one file on every change. Move to SQLite or Postgres before real traffic.
- **Move rate limits to shared storage.** They are in memory, so they reset on restart and don't work across several servers.
- **Review image hosting.** Image links are https-only but can point anywhere. Consider proxying or allow-listing hosts, since embedded images reveal viewer IPs and can serve unsafe content.
- **Encrypt webhooks.** Discord webhook URLs are stored in plain text and act like passwords.
- **Add a moderator tool.** Reports currently hide posts automatically, with no review queue or appeal. Conversation reports are stored but nothing reviews them yet.
- **Child safety. This is the most important item.** Roblox's audience includes many minors. Direct messages and linked video are exactly where grooming and harassment happen. Before launch you need: age-appropriate defaults (for example, DMs off for accounts that look young, or limited to people who already follow each other), parental controls, a way to report that reaches a human within a set time, and clear obligations under your jurisdiction's rules (COPPA in the US, the UK Online Safety Act, and similar). This prototype does not meet those requirements.
- **Link safety.** Messages are plain text and are not linkified, which avoids phishing links in DMs. Video links from arbitrary `.mp4` hosts can serve anything, so consider allow-listing hosts or proxying files.
- **Hosting video.** Direct uploads would need storage, transcoding, size limits, and scanning. None of that exists yet.
- **Realtime.** Messages poll every 3 seconds. Replace with server-sent events or WebSockets once traffic justifies it.
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
