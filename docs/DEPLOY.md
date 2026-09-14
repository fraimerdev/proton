# Deploying Proton to a single Ubuntu VPS

Target: one Ubuntu 24.04 LTS host serving `prtn.xyz`, with nginx terminating TLS in front of the
dashboard and pm2 supervising the five Bun processes. Postgres and Redis run natively on the same
box — `docker-compose.yml` is a development file and is not used here.

Everything below assumes the repository lives at `/srv/proton`, owned by a `proton` user.

## What runs

| pm2 name             | Process        | Listens on       | Public |
| -------------------- | -------------- | ---------------- | ------ |
| `proton-rest-proxy`  | Discord REST egress | `127.0.0.1:9001` | no |
| `proton-api`         | Hono; all domain logic | `127.0.0.1:9002` | no |
| `proton-gateway`     | Shards, normaliser, publisher | — | no |
| `proton-worker`      | Bus consumers, module runtime | — | no |
| `proton-dashboard`   | TanStack Start SSR | `127.0.0.1:9000` | via nginx |

Only the dashboard is reachable from the internet. The api trusts anything holding
`API_SHARED_SECRET`, and the rest-proxy authenticates nothing at all and holds the bot token — both
bind loopback by default (`HOST` in their env schemas) and nginx never proxies them.

Sizing: 2 vCPU / 4 GB is comfortable. The dashboard build is the memory peak; on a 2 GB box add
swap before building.

## 1. Host preparation

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git unzip ca-certificates ufw
sudo adduser --disabled-password --gecos "" proton
sudo mkdir -p /srv/proton && sudo chown proton:proton /srv/proton
```

Firewall — nothing but SSH and nginx:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw --force enable
```

Optional but worth it on a 2 GB box:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 2. Postgres 17

Ubuntu 24.04 ships Postgres 16, so use the PGDG repository:

```bash
sudo install -d /usr/share/postgresql-common/pgdg
sudo curl -fsSLo /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  https://www.postgresql.org/media/keys/ACCC4CF8.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
  | sudo tee /etc/apt/sources.list.d/pgdg.list
sudo apt update && sudo apt install -y postgresql-17
```

Create the role and database. Generate the password first and keep it — it goes into `DATABASE_URL`:

```bash
openssl rand -base64 24
sudo -u postgres psql -c "CREATE ROLE proton LOGIN PASSWORD 'THE_PASSWORD_YOU_JUST_GENERATED';"
sudo -u postgres createdb -O proton proton
```

Postgres listens on localhost only by default and authenticates 127.0.0.1 with `scram-sha-256`.
Leave both alone. Confirm:

```bash
psql "postgres://proton:THE_PASSWORD@127.0.0.1:5432/proton" -c 'select version()'
```

## 3. Redis 7

```bash
sudo apt install -y redis-server
```

Three settings in `/etc/redis/redis.conf`:

```
appendonly yes
maxmemory-policy noeviction
bind 127.0.0.1 -::1
```

`noeviction` is deliberate. Proton uses eight logical Redis databases and only one of them —
`REDIS_DB_MESSAGES` — holds data that may be dropped, and every key in it is written with a TTL
already. `maxmemory-policy` is server-wide, so an eviction policy chosen for that one database
would also throw away event-bus streams, dedupe keys and gateway session state.

Silence the background-save warning and restart:

```bash
echo 'vm.overcommit_memory = 1' | sudo tee /etc/sysctl.d/99-redis.conf
sudo sysctl --system
sudo systemctl restart redis-server
redis-cli ping
```

A password is optional while Redis is loopback-only. If you set `requirepass`, write the URL as
`redis://:PASSWORD@127.0.0.1:6379`.

## 4. Bun, Node and pm2

Bun runs the services; pm2 is itself a Node program and needs Node to exist.

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

Bun goes in the `proton` user's home, which is where `deploy/ecosystem.config.cjs` expects it
(`/home/proton/.bun/bin/bun`). Pin the version the repo declares in `packageManager`:

```bash
sudo -u proton -H bash -lc 'curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14"'
sudo -u proton -H bash -lc '~/.bun/bin/bun --version'
```

## 5. Code and configuration

As `proton` (`sudo -u proton -i`):

```bash
git clone YOUR_REPO_URL /srv/proton
cd /srv/proton
cp deploy/proton.env.example .env
chmod 600 .env
```

Fill in `.env`. The three secrets each want their own value:

```bash
openssl rand -base64 32   # BETTER_AUTH_SECRET
openssl rand -base64 32   # API_SHARED_SECRET
openssl rand -base64 32   # VERIFY_LINK_SECRET
```

`VERIFY_LINK_SECRET` now signs two things: verification links, which live 15 minutes, and **appeal
links, which live 30 days**. Rotating it therefore invalidates up to a month of outstanding appeal
links — every banned member holding one is told the link is no longer valid, with no way to mint
them a new one short of the punishing module catching them again. Rotate it deliberately, and only
alongside a decision about the appeals in flight. The worker and the dashboard must always hold the
same value; the API never sees a token at all.

`PORT` and `HOST` are intentionally absent from `.env` — three services listen and they cannot
share one `PORT`, so pm2 sets both per process. Bun's `--env-file` does not override a real
environment variable, so the pm2 values win.

Install, build, migrate:

```bash
bun install --frozen-lockfile
bun run build
bun --env-file=.env packages/db/src/migrate.ts
```

`bun run build` produces `apps/dashboard/dist/client` (served by nginx) and
`apps/dashboard/dist/server/server.js` (a fetch handler with no listener — `apps/dashboard/serve.ts`
is the process that serves it).

## 6. pm2

Still as `proton`:

```bash
cd /srv/proton
pm2 start deploy/ecosystem.config.cjs
pm2 status
pm2 logs --lines 50
```

Once everything is up, persist the process list and install the boot unit:

```bash
pm2 save
pm2 startup systemd -u proton --hp /home/proton
```

That last command prints a `sudo env PATH=... pm2 startup ...` line. Run it as root — pm2 does not
install the systemd unit itself.

Log rotation, otherwise `~/.pm2/logs` grows without limit:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 20M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
```

Check the services answer before putting nginx in front:

```bash
curl -fsS http://127.0.0.1:9001/healthz && echo
curl -fsS http://127.0.0.1:9002/healthz && echo
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9000/
```

## 7. DNS

Before requesting a certificate:

| Record | Name | Value |
| ------ | ---- | ----- |
| A      | `prtn.xyz` | the VPS IPv4 |
| A      | `www` | the VPS IPv4 |
| AAAA   | `prtn.xyz`, `www` | the VPS IPv6, if it has one |

`dig +short prtn.xyz` must return the VPS before continuing.

## 8. nginx and TLS

```bash
sudo apt install -y nginx certbot
sudo mkdir -p /var/www/certbot
```

The shipped config references certificates that do not exist yet, so nginx cannot load it until
they do. Serve the ACME challenge from a temporary site first:

```bash
sudo tee /etc/nginx/sites-available/prtn.xyz.conf >/dev/null <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name prtn.xyz www.prtn.xyz;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 404; }
}
EOF
sudo ln -sf /etc/nginx/sites-available/prtn.xyz.conf /etc/nginx/sites-enabled/prtn.xyz.conf
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

Issue the certificate over that webroot, which is also how it will renew:

```bash
sudo certbot certonly --webroot -w /var/www/certbot \
  -d prtn.xyz -d www.prtn.xyz \
  --agree-tos --no-eff-email -m you@example.com
```

Now install the real config:

```bash
sudo cp /srv/proton/deploy/nginx/prtn.xyz.conf /etc/nginx/sites-available/prtn.xyz.conf
sudo nginx -t && sudo systemctl reload nginx
```

nginx serves `apps/dashboard/dist/client` directly, so every directory on that path must be
traversable by `www-data`:

```bash
sudo chmod o+x /srv /srv/proton /srv/proton/apps /srv/proton/apps/dashboard \
  /srv/proton/apps/dashboard/dist /srv/proton/apps/dashboard/dist/client
curl -fsS -o /dev/null -w '%{http_code}\n' https://prtn.xyz/favicon.ico
```

Renewal is installed by the `certbot` package as a systemd timer. Confirm it works, including the
reload hook:

```bash
sudo certbot renew --dry-run
printf '#!/bin/sh\nsystemctl reload nginx\n' | sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx
```

## 9. Discord application

In the developer portal, for the same application whose ids are in `.env`:

- **OAuth2 → Redirects**: add `https://prtn.xyz/api/auth/callback/discord`. Sign-in fails with
  `invalid_redirect_uri` until this exact string is registered.
- **Bot → Privileged Gateway Intents**: enable **Server Members** and **Message Content**. Leave
  **Presence** off — Proton does not use it, and the gateway identifies with an intents bitfield
  that does not include it.
- **Emojis**: upload the Server Logs tree emoji as *application* emoji and put their ids in
  `PROTON_EMOJI_STEM` / `PROTON_EMOJI_REPLY`. A guild emoji id renders as broken text in every
  other server; the worker checks ownership at boot and falls back to `├` and `└`.

`COMMAND_REGISTRATION_SCOPE=global` in production. Global commands can take up to an hour to appear
after a deploy that changed them — this is Discord's propagation, not a Proton failure. The worker
logs `registered N command(s) at <path>` when it succeeds.

`DISCORD_TEST_GUILD_ID` is the development safety rail from `CLAUDE.md` and stays unset here.

## 10. Verify

```bash
pm2 status                                   # five processes, all online
pm2 logs proton-gateway --lines 30           # expect "gateway connected"
pm2 logs proton-worker --lines 30            # expect "registered N command(s) at ..."
curl -fsS -o /dev/null -w '%{http_code}\n' https://prtn.xyz/
```

Then sign in at `https://prtn.xyz`, invite the bot to a guild from the dashboard, and confirm a
slash command answers.

## 11. Updating

```bash
sudo -u proton -i
bash /srv/proton/deploy/deploy.sh
```

That pulls, installs, builds, migrates, reloads and smoke-tests. It deliberately leaves the gateway
alone — every restart is a pause in event intake — so restart it only when its own code changed:

```bash
bash /srv/proton/deploy/deploy.sh --with-gateway
```

A gateway restart resumes; it does not identify. On `SIGINT` or `SIGTERM` the gateway stops taking
new events, closes its connection with a code that keeps the Discord session alive, waits up to 7
seconds for events still on their way to the bus, and exits without deleting its session from
Redis — well inside pm2's 15-second `kill_timeout`. The new process resumes after the newest event
that reached the bus together with every event before it, and Discord replays everything after that,
including what happened while the gateway was down. An event that did not reach the bus within those 7 seconds is logged as
`still unpublished` and replayed too, so the worker may see it twice, which it already assumes.

That spends none of the 1000 session starts Discord allows per day, with two exceptions: Discord has
invalidated the session, or the gateway stayed down longer than the few minutes Discord keeps a
closed session resumable. Either way the new process identifies, spends one, and whatever happened in
the gap is not replayed.

pm2 runs these in fork mode, so a reload is a restart — expect a second or two of 502s on the
dashboard. The api and worker are stopped before migrations run and start again on the new code, so
neither can write back a config shape or rule a migration has just moved; Discord events wait on the
bus until the worker is back. The rest-proxy, gateway and dashboard keep running through the
migrations, so a release must stay backwards-compatible with those. A dashboard tab opened before the
deploy keeps the old page until it is reloaded.

After the migrations the script moves the warn escalation rate windows in Redis from Cases to
Moderation, which migration 0032 re-keyed, so a member's warnings inside the window still count.
Later deploys find nothing to move.

If either step fails, the api and worker stay stopped. Fix the cause and run the script again, or roll
back as below.

Rollback:

```bash
cd /srv/proton && git checkout <previous-sha>
bash deploy/deploy.sh --no-pull
```

Migrations do not roll back. A release that changed the schema needs a forward fix, not a checkout.

Rolling back past the `branding` module is one case where a checkout is not enough. Proton wears
a per-server nickname, avatar, banner and bio that live on Discord, not in this repo, and removing
the code that sets them does not remove them — it removes the only thing that could. Switch the
module off in each affected server first, let the teardown run, and only then roll back.

Rolling back past the `afk` module is the other. The `[AFK]` tags it adds to members' nicknames live
on Discord too, and once the code is gone nothing is left to take them off. Switch AFK off in
each affected server first, let the teardown end every AFK status and put the nicknames back, and
only then roll back.

## 12. Backups

```bash
sudo mkdir -p /var/backups/proton && sudo chown postgres:postgres /var/backups/proton
sudo tee /etc/cron.daily/proton-backup >/dev/null <<'EOF'
#!/bin/sh
set -e
su -s /bin/sh postgres -c "pg_dump -Fc proton -f /var/backups/proton/proton-$(date +%F).dump"
find /var/backups/proton -name 'proton-*.dump' -mtime +14 -delete
EOF
sudo chmod +x /etc/cron.daily/proton-backup
sudo /etc/cron.daily/proton-backup && ls -lh /var/backups/proton
```

Copy those dumps off the box. Restore with
`pg_restore -d proton --clean --if-exists proton-YYYY-MM-DD.dump`.

Redis needs no backup schedule: everything in it is either derivable (guild state, caches, rate
windows) or short-lived. The append-only file is there so a restart does not lose the event-bus
backlog.

## 13. Troubleshooting

**A service exits immediately.** Env validation runs at boot and names the offending variable —
`pm2 logs proton-api --lines 40`. Nothing is redacted into that message except the values
themselves.

**`Invalid environment` for everything at once.** pm2 is not passing the env file. Check the
command it actually runs: `pm2 describe proton-api` should show
`--env-file=/srv/proton/.env` before the script. If your pm2 drops `interpreter_args`, replace
`script`/`interpreter` in `deploy/ecosystem.config.cjs` with
`script: '/home/proton/.bun/bin/bun', args: 'run start', interpreter: 'none'` — each app's `start`
script already loads the same file.

**502 from nginx.** `proton-dashboard` is down, or `apps/dashboard/dist` was never built.
`pm2 logs proton-dashboard` and `ls apps/dashboard/dist/server/server.js`.

**403 on `/assets/...` but the SSR page renders.** `www-data` cannot traverse to
`/srv/proton/apps/dashboard/dist/client`. Re-run the `chmod o+x` line in section 8.

**414 on a dashboard action.** A server-function id outgrew the header buffers. That is what
`large_client_header_buffers 4 32k` in the site config is for — confirm the deployed file has it.

**Sign-in redirects to Discord and comes back to an error.** Either the redirect URI is not
registered exactly as `https://prtn.xyz/api/auth/callback/discord`, or nginx is not passing
`Host`/`X-Forwarded-Proto`, or `BETTER_AUTH_URL` is not `https://prtn.xyz`.

**Gateway reconnect loop.** Every restart resumes the session stored in Redis and spends no
identify, so restarts alone do not burn session starts. A loop that keeps losing the session does —
Discord invalidated it, or the process stays down past the resume window — because each of those
boots identifies, and session starts are capped at 1000/day. Once they run out the gateway will not
even boot to resume: it fails at startup with `Not enough sessions remaining to spawn`. Stop it
(`pm2 stop proton-gateway`), fix the cause, then start it once. Do not delete
`proton:gateway:session:*` from Redis to get a clean start: that forces an identify and gives up the
events Discord would have replayed.

**Gateway exits with `gave up publishing`.** An event could not reach the bus after every retry — six
attempts of up to 5 seconds each, with 51 seconds of backoff between them. Rather than carry on past
it, the gateway logs the event's type, id, shard and sequence and exits with code 1, keeping its
session. pm2 starts it again, the new process resumes from before that event, and Discord replays it
and everything after it. The bus is Redis, so start there (`redis-cli ping`); until it accepts
writes, every run ends the same way.

**Slow `bun install` on the VPS.** `bunfig.toml` pins `backend = "copyfile"` for Windows. It is
correct but slower on Linux; you can override per-run with `bun install --backend=hardlink`.

Integration tests are not run on this host — see `CLAUDE.md`. They need Docker and belong in CI.
