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

Which process reads which database. A database shared by two processes must have the same number
for both, which the single `.env` guarantees as long as nobody overrides one per process:

| Variable | Default | Read by |
| --- | --- | --- |
| `REDIS_DB_BUS` | 0 | gateway, worker, api |
| `REDIS_DB_DEDUPE` | 1 | worker |
| `REDIS_DB_SESSIONS` | 2 | gateway |
| `REDIS_DB_JOBS` | 3 | worker |
| `REDIS_DB_MODULES` | 4 | worker, api (the anti-nuke maintenance window) |
| `REDIS_DB_STATE` | 5 | worker |
| `REDIS_DB_USERS` | 6 | worker |
| `REDIS_DB_MESSAGES` | 7 | worker |

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

`COMMAND_REGISTRATION_SCOPE=every-guild` in production. Proton registers its commands in each server
separately, because each server can rename, re-describe and switch off its own commands on the
dashboard's Commands page, so there are no global commands. Server commands change in Discord at
once. The old value `global` still works: it is read as `every-guild` and the worker (and the api)
warn about it at boot.

`DISCORD_TEST_GUILD_ID` is the development safety rail from `CLAUDE.md` and stays unset here. The
worker refuses to start with `every-guild` while it is set, and with `guild` while it is not.

How the worker keeps each server's commands in step:

- **At boot** it asks Discord which servers Proton is in and checks each one. A server whose command
  set (the code definitions, its Commands page settings and its module switches) hashes the same as
  its last successful registration is skipped, so only a deploy that changes a command definition
  sends anything. Every server's PUT goes through one queue in the rest-proxy, because Discord
  rate-limits this route per application rather than per server: a definition-changing deploy costs
  about one request per server, one after another, and dashboard saves and newly added servers are
  sent ahead of that backlog.
- **While running** a dashboard save, a module switched on or off, and a server adding Proton are
  synced within seconds. Every 10 minutes a sweep (BullMQ queue `proton-command-sync`) picks up any
  server whose settings changed after its last check, in case the event was lost, and any whose
  retry time has come.
- **Failures** are shown on the server's Commands page in words, with Discord's own text beneath.
  Missing access (50001 or a 403) is retried only when Discord next announces the server to the
  gateway (Proton added again, or the gateway identifying) or Proton finds its commands out of step
  there, so it does not spend Discord's invalid-request budget; Discord's
  limit of 200 command creates per server per day (30034) is retried after 24 hours; a 5xx, a network
  error or a PUT with no answer after 60 seconds is retried with backoff up to 10 minutes, then by
  the sweep.

The first deploy of this release moves every server from the global commands to its own:

- Until the global set is retired, members may see each command twice in the picker. Both work.
- Before touching a server, the worker reads which global commands had their own permissions in that
  server's Server Settings → Integrations. Discord deletes those permissions with the global commands,
  and a bot cannot set them again, so the server's Commands page shows a banner naming the commands
  whose Integrations permissions an admin has to set again. Permissions set on Proton as a whole
  carry over.
- The worker removes the global commands, once, only when every server Proton is in has registered
  its own current set and has had its permissions read. Servers where Proton can't manage commands
  (50001 or 403) do not hold this up and are named in the log. Until then each sweep logs which
  servers are holding it up, by id and Discord code.
- Later, renaming a command, switching it off and on, or switching its module off and on clears the
  Integrations permissions set on that one command too. The dashboard says so beside those controls.

What the worker logs:

- `checking the commands of N server(s)` and, once the boot check has drained,
  `finished checking the commands of N server(s)`;
- `registered N command(s) in server <id>` for each server whose commands changed;
- `could not register commands in server <id>: …` with the readable reason and Discord's text;
- `kept Proton's N global command(s), because M server(s) are not synced yet: …` until the move is
  complete, then `retired Proton's N global command(s): every server now has its own commands`.

## 10. Verify

```bash
pm2 status                                   # five processes, all online
pm2 logs proton-gateway --lines 30           # expect "gateway connected"
pm2 logs proton-worker --lines 30            # expect "finished checking the commands of N server(s)"
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

Migration 0037 adds the user report tables (`reports`, `report_events`, `report_automation_runs`)
and the ones Moderation keeps for timeouts and case messages (`moderation_timeouts`,
`moderation_case_messages`). It must run before the new worker starts — the script's order already
ensures that. A worker started by hand against the older schema fails on its first report or timeout.

0037 must be applied after 0036, never instead of it. Drizzle skips any migration older than the
newest one it has recorded, so a release that carries 0037 without 0036 leaves 0036 unapplied for
good — ship them together, or 0036 first.

The same release adds the global module job `moderation:purge-evidence`. It runs hourly at :35 on the
`proton-module-jobs` queue, for every server whether or not Moderation is on, and removes report
evidence and case message snapshots whose time is up (the privacy page promises both). Nothing to set
up: the worker schedules it at boot, and `declared N module job(s)` counts it. The worker refuses to
start if the job is declared without its handler.

Migration 0040 adds `guild_commands` (each server's command settings) and
`guild_command_registrations` (what the worker last registered in each server, and why it failed if
it did). The api and the worker both need them, and the script's order runs the migration before
either starts. The first worker on this release registers every server's own commands at boot and
then retires the global ones, as described in section 9. Option changes to a command should stay
backwards-compatible for the length of that fan-out: a server not yet re-registered still sends the
old options, and Proton refuses those as "updating" rather than running a handler on options it no
longer has.

Migration 0041 adds the Applications tables (`application_form_versions`, `applications`,
`application_events`, `application_thread`, `application_notes`, `application_votes`,
`application_effects`, `application_role_grants`), and two nullable columns on `tickets`,
`source_module` and `source_ref`, with a partial unique index (`tickets_source_open_uq`) that
allows one open ticket per source. It is additive, so the gateway, rest-proxy and dashboard running
through the migration are unaffected: none of them reads the new tables, and existing ticket rows
keep both columns null, which leaves them outside the index. The api and the worker need the tables,
and the script's order runs the migration before either starts.

The same release adds the global module job `applications:purge`. It runs hourly at :15 on the
`proton-module-jobs` queue, for every server whether or not Applications is on, deletes drafts left
unchanged past their server's draft expiry and removes answers whose keep-for period has ended.
Nothing to set up: the worker schedules it at boot, and `declared N module job(s)` counts it. The
worker refuses to start if the job is declared without its handler.

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

Rolling back past the `afk` module is another. The `[AFK]` tags it adds to members' nicknames live
on Discord too, and once the code is gone nothing is left to take them off. Switch AFK off in
each affected server first, let the teardown end every AFK status and put the nicknames back, and
only then roll back.

Rolling back past per-server commands is the third. An older release registers the global commands
at boot and never touches server commands, so every server would keep its own commands next to the
global ones, and any it renamed would answer that it isn't working. Remove them first, with the
worker stopped so it cannot register them again:

```bash
pm2 stop proton-worker
set -o pipefail
bun --env-file=.env apps/worker/src/commands-rollback.ts 2>&1 | tee -a ~/rollbacks.log
bun --env-file=.env apps/worker/src/commands-rollback.ts --confirm 2>&1 | tee -a ~/rollbacks.log
```

Without `--confirm` it only lists the servers. With it, it sends an empty command list to every
server that has a registration record (only `DISCORD_TEST_GUILD_ID` when the scope is `guild`) and
deletes each record once Discord accepts. A server Discord refuses keeps its record and is printed as
`FAILED:` with Discord's reason, and the exit status is 1; run it again once the cause is fixed.
Then check out and deploy the older release as above, and its worker registers the global commands
again. Renames, descriptions and switches set on the Commands page do not carry back, and
Integrations permissions set on the per-server commands are lost with them.

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

## 13. Deleting a server's or a person's data

The privacy page tells server owners and members to ask in the support server, with a server id or
a Discord user id. Two scripts carry out those requests. Both are dry runs unless told otherwise,
both print a report meant to be kept, and both run as `proton` from `/srv/proton` against the
`.env` there. Run them only for a request someone actually made, and never point them at a database
you were not asked to change.

Removing Proton from a server deletes nothing by itself. The worker clears the backup layout and
remembered message text, then asks Discord whether Proton is really gone, because a removal can be
handled after the same server added Proton back. Only once Discord confirms it does the worker
record `guilds.left_at`, clear the cached server details and stop the server's cron rules (they come
back if Proton is added again). If Discord cannot be asked, the removal is retried. Pending scheduled
actions (reminders, temporary-ban lifts, giveaway draws, AFK expiries and the like) are kept: the
ones that need Discord fail harmlessly while Proton is gone, and they still run if it is added back
in time. The website refuses appeal and verification links for the server. Everything, the
`scheduled_actions` rows included, stays until it is purged.

Run both scripts from a shell with `set -o pipefail` and pipe them through
`2>&1 | tee -a ~/purges.log`, as below. Without `pipefail` the shell reports `tee`'s exit status, so
a refusal or a crash reads as success; without `2>&1` the error that explains a crash reaches the
terminal but not the log.

### A server

Dry run first. It changes nothing (the Postgres half runs in a read-only transaction, and the
BullMQ schedules are read from their id set without loading or tidying any of them) and answers
"what does Proton hold for this server":

```bash
cd /srv/proton
set -o pipefail
bun --env-file=.env apps/worker/src/purge-guild.ts 123456789012345678 2>&1 | tee -a ~/purges.log
```

The report header (the server id, the start time and the operator) is printed before any database
work, so a run that is refused or fails still leaves who ran it and when in the log. Then the
server's `guilds` row, then every Postgres table holding its rows with a count and how each goes: `cascade`
with the `guilds` row, or `direct` for tables with a `guild_id` but no foreign key to it
(`message_logs` and `giveaway_events` today). Then the rule cron schedules in BullMQ, and the Redis
keys it would delete. The table list is read from the live schema's foreign keys on every run, so a
table added by a later migration is included without editing the script.

To delete, add `--delete` and type the id a second time:

```bash
bun --env-file=.env apps/worker/src/purge-guild.ts 123456789012345678 \
  --delete --confirm 123456789012345678 2>&1 | tee -a ~/purges.log
```

It refuses, deleting nothing, when:

- Proton is still in the server (`guilds.left_at` is empty). This is checked again under a lock on
  the row, so a server that re-added Proton after the dry run is refused too, and the `guilds` row
  is only deleted while `left_at` is set, so a server that re-adds Proton during the purge keeps
  its new row and the whole transaction is rolled back. `--force` overrides both; use it only for a
  server Discord has deleted, where no removal was ever recorded.
- `--delete` comes without `--confirm`, or the `--confirm` id is a different one.
- A foreign key into a table the server owns is not `ON DELETE CASCADE`. Such a table would block
  the delete or keep rows behind, so the script names it and stops.
- A table still holds rows for the server after the deletes. The whole Postgres transaction is
  rolled back and the table is named.

What it deletes, in this order: every Postgres row for the server in one transaction; the BullMQ
rule cron schedules filed under the server; the Redis keys Proton keeps for it with no expiry
(verification quarantine records and panel, the honeypot notice book, counters and caught lists,
giveaway counts waiting for a refresh, the backup layout), plus the cached server details,
remembered message text and the Join Roles sync records (the running sync, the last result and
member count, and when the scheduled sync is due — kept up to 180 days, so not left to expire). Redis is searched with `SCAN MATCH` on the server id, never `KEYS`.
Keys that expire by themselves (captchas, locks, rate windows, voice sessions and similar) are
left to run out, and events already on the bus age out within about a day. If a step after
Postgres fails, run the same command again: Postgres then has nothing left and the rest is retried.

The report gives the start time (and, for a deletion, the finish time), the operator (the OS user,
the `sudo` caller if there was one, and the host) and a count for every table, schedule and key
pattern. A refusal prints `REFUSED:` and the reason under the header. Exit status is 0 when it
finished, 2 when it refused, and 1 on any other error.

### A person's sign-in data

```bash
set -o pipefail
bun --env-file=.env apps/worker/src/purge-user.ts 234567890123456789 2>&1 | tee -a ~/purges.log
bun --env-file=.env apps/worker/src/purge-user.ts 234567890123456789 \
  --delete --confirm 234567890123456789 2>&1 | tee -a ~/purges.log
```

Its report, header first as above, gives the Better Auth user id, the Discord id and the counts,
never the person's name.

This deletes the Better Auth `user` row whose Discord account has that id. Its `account` row, with
the Discord tokens, and every `session` go with it by cascade, which signs the person out
everywhere. The tokens are deleted here, not revoked at Discord. What servers hold about the person
(cases, XP, tickets, appeals and so on) belongs to those servers and is not touched, and neither is
the record of dashboard changes naming them. A server's data goes only with that server's purge.

### Backups

Neither script can reach the database dumps. A deleted row stays in every dump taken before the
purge until the backup job above deletes that dump after 15 days, so up to 16 days in all, which is
what the privacy page promises. Copies taken off the box must be deleted on the same schedule for
that promise to hold.

## 14. Troubleshooting

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
