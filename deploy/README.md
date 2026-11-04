# Free launch

This runs Jumpseat on one small Linux VM with HTTPS. Nothing here needs a paid plan.

## Pick a free host

| Option | Cost | Things to know |
| --- | --- | --- |
| **Google Cloud e2-micro** (recommended) | Free within the always-free allowance: one e2-micro in us-west1, us-central1 or us-east1, 30 GB standard disk, 1 GB North America egress a month | Needs a billing account with a card, though nothing is charged inside the allowance. Use **standard** disk (balanced or SSD bills). Snapshot schedules cost money, so skip them. Reserve a static external IP while the VM runs. |
| Oracle Cloud Always Free (Ampere A1) | Free | Reports from June 2026 say Oracle halved the free allowance, and Oracle can reclaim instances that stay lightly loaded for a week. Check the current terms before using it as the only host. |
| Render, Fly, Railway free tiers | Free | Not suitable. The app keeps data in a file on disk, and these services wipe or sleep it. |

Check the live free-tier page of whichever host you pick before you start. Terms change, and I have not confirmed Google's or Oracle's idle rules myself.

## Before you start

You need to create these yourself. The code cannot do it.

1. **A domain.** A free DuckDNS subdomain such as `jumpseat.duckdns.org` works. Point it at the VM's external IP.
2. **A Discord application** at discord.com/developers/applications. Add the redirect URI `https://YOUR-DOMAIN/auth/discord/callback`. Copy the client ID and secret.
3. **A Roblox OAuth app** at create.roblox.com/dashboard/credentials. Add the redirect URI `https://YOUR-DOMAIN/auth/roblox/callback`. Copy the client ID and secret.
4. **Your admin usernames**, for `ADMIN_USERNAMES`.
5. **Open ports 80 and 443** in the host's firewall (on Google Cloud, a VPC firewall rule for tcp:80,443). `setup.sh` opens them inside the VM too.
6. **The repository URL.** If the repo is private, use a deploy key or a token in the URL.

## Install

On the VM, as a user with sudo:

```bash
git clone https://github.com/kodexalol/gptwrap.git   # or any copy of this repo
sudo bash gptwrap/deploy/setup.sh https://github.com/kodexalol/gptwrap.git YOUR-DOMAIN
```

The script installs Node 22 (checksum verified), Caddy (automatic HTTPS), and the app under `/opt/jumpseat`. It creates `/etc/jumpseat.env`, runs the app as a non-root user under systemd, and sets a nightly backup. Running it again is safe.

Then:

1. Edit `/etc/jumpseat.env` and fill in `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `ROBLOX_CLIENT_ID`, `ROBLOX_CLIENT_SECRET` and `ADMIN_USERNAMES`.
2. `sudo systemctl restart jumpseat`
3. Open `https://YOUR-DOMAIN` and sign in with Discord, then Roblox.

Production never offers the test sign-in. `NODE_ENV=production` is set in the service, and `ALLOW_DEV_LOGIN` is not in the template.

## Running it

| Task | Command |
| --- | --- |
| Logs | `journalctl -u jumpseat -f` |
| Restart | `sudo systemctl restart jumpseat` |
| Update to the latest code | `sudo bash /opt/jumpseat/deploy/update.sh` |
| Backups | `/var/backups/jumpseat/`, nightly at 03:15 UTC, kept 14 days |
| Restore | Stop the app, copy a backup over `/opt/jumpseat/data/db.json`, start the app |

## Limits of this setup

- **One VM, one file.** Everything is in `data/db.json`. That is fine for a launch with hundreds of users. It is not built for thousands of concurrent users.
- **Backups stay on the VM.** If the VM is lost, so are the backups. Copy `/var/backups/jumpseat` somewhere else regularly.
- **Free allowances.** The always-free egress is about 1 GB a month. The app serves small pages, but heavy traffic or large videos linked from elsewhere will eventually exceed it.
- **Presence and rate limits live in memory and on disk.** Restarting the app resets rate limits. See the main README for the other known gaps.
- **Moderation and child safety are not finished.** Read the "Before going live" section of the main README before opening sign-ups to the public.
