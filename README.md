# Defaulterr

**Set the right audio and subtitle track for every user in your Plex server — automatically.**

Plex remembers a default audio and subtitle track per user, per file. Getting those defaults right
across a whole library is normally a manual, file-by-file chore. Defaulterr does it in bulk, using
rules you write once.

Because the rules are **per group of users**, different people can get different defaults on the very
same file:

> On your anime library, *you* get the Japanese audio track with English subtitles. Your partner, who
> hates subtitles, gets the English dub with subtitles switched off. Neither of you touches a setting.

Defaulterr applies rules to your existing library, then keeps up with new media automatically via a
Tautulli webhook.

> **This is a maintained fork** of [varthe/Defaulterr](https://github.com/varthe/Defaulterr), kept
> current on dependencies and CVEs. Use the image `ghcr.io/swshong/defaulterr:latest`
> (multi-arch: `linux/amd64`, `linux/arm64`). See [Fork notes](#fork-notes) at the bottom.

---

## Contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
  - [Server settings](#1-server-settings)
  - [Run modes](#2-run-modes)
  - [Groups](#3-groups)
  - [Managed (Home) accounts](#4-managed-home-accounts)
  - [Filters](#5-filters)
- [Keeping up with new media (Tautulli)](#keeping-up-with-new-media-tautulli)
- [Running it](#running-it)
- [Troubleshooting](#troubleshooting)
- [Fork notes](#fork-notes)

---

## How it works

Three concepts, and that's the whole model:

| Concept | What it is |
| --- | --- |
| **Group** | A named set of Plex users, e.g. `weebs`, `no_subtitles`. |
| **Filter** | A rule describing the track you want, e.g. *English, not TrueHD, not commentary*. |
| **Library** | Which Plex library the rules apply to, by name. |

You write filters per library, per group. For each media item, Defaulterr picks the first filter that
matches an available track, then sets that track as the default **for every user in that group**.

If nothing matches, the item is left alone — Defaulterr never guesses.

---

## Requirements

- A Plex Media Server, and its owner token
- Docker (or Node.js 20+ if running from source)
- Optional but recommended: [Tautulli](https://tautulli.com/), so new media is handled automatically

---

## Quick start

The safest path is to write your rules, watch them run in **dry run** mode, and only then let
Defaulterr write to Plex.

### 1. Create the config directory

```bash
mkdir -p ~/defaulterr/config ~/defaulterr/logs
```

### 2. Get your Plex credentials

**Owner token** — follow Plex's guide:
[Finding an authentication token](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/).

**Server client identifier** — open this in a browser, replacing `YOUR_TOKEN`:

```
https://plex.tv/api/resources?X-Plex-Token=YOUR_TOKEN
```

Find your server in the list and copy its `clientIdentifier`. It **must** be the *server's*
identifier, not your account's.

### 3. Write a minimal config

Save as `~/defaulterr/config/config.yaml`:

```yaml
plex_server_url: http://192.168.1.100:32400
plex_owner_name: yourPlexUsername
plex_owner_token: YOUR_TOKEN
plex_client_identifier: YOUR_SERVER_CLIENT_IDENTIFIER

# Start in dry run so nothing is written to Plex yet
dry_run: true

groups:
  everyone:
    - $ALL

filters:
  Movies:                    # must match your Plex library name exactly
    everyone:
      audio:
        - include:
            language: English
          exclude:
            extendedDisplayTitle: commentary
```

### 4. Start it

```bash
docker run -d --name defaulterr \
  -p 3184:3184 \
  -v ~/defaulterr/config:/config \
  -v ~/defaulterr/logs:/logs \
  -e TZ=America/Los_Angeles \
  --restart unless-stopped \
  ghcr.io/swshong/defaulterr:latest
```

Or use the [Docker Compose example](#docker-compose) below.

### 5. Check the logs and confirm your rules

```bash
docker logs -f defaulterr
```

In dry run you'll see which track each rule *would* select, with nothing written to Plex:

```
[INFO]: STARTING DRY RUN. NO CHANGES WILL BE MADE.
[INFO]: Part ID 12345 ('Blade Runner 2049'): match found for audio stream English (AAC Stereo)
```

If a rule matches nothing, you'll see `no match found for audio streams` — adjust and restart.

### 6. Go live

Once the matches look right, set `dry_run: false` and pick a run mode (below), then restart.

---

## Configuration

Everything lives in `config.yaml`. A full worked example ships as
[config.yaml](config.yaml) in this repo.

> **Unknown settings are rejected.** The config is schema-validated at startup. A typo in a key name
> (or a stray extra setting) makes Defaulterr log the validation error and exit, rather than silently
> ignoring it. If the container won't start, read the first few log lines.

### 1. Server settings

| Setting | Required | Description |
| --- | --- | --- |
| `plex_server_url` | **yes** | Your Plex URL, e.g. `http://192.168.1.100:32400`. A trailing `/` is fine. |
| `plex_owner_token` | **yes** | The server owner's token. |
| `plex_client_identifier` | **yes** | The **server's** `clientIdentifier` (see [step 2](#2-get-your-plex-credentials)). |
| `plex_owner_name` | no | Your own Plex username. Required only if you want to include *yourself* in a group. |

### 2. Run modes

Defaulterr can sweep your library on startup, on a schedule, or not at all.

| Setting | Type | What it does |
| --- | --- | --- |
| `dry_run` | bool | Logs what *would* change, writes nothing. Overrides every other mode. |
| `partial_run_on_start` | bool | On startup, process only items added or changed since the last successful run. |
| `clean_run_on_start` | bool | On startup, reprocess the **entire** library, ignoring past runs. |
| `partial_run_cron_expression` | string | Run a partial sweep on a schedule, e.g. `0 3 * * *`. Build one at [crontab.guru](https://crontab.guru/). |

**These are checked in priority order,** and the first one that applies wins:

```
dry_run  >  partial_run_on_start  >  clean_run_on_start  >  no startup sweep
```

So if `partial_run_on_start` is `true`, `clean_run_on_start` is ignored entirely.

**Which should I use?**

- **Most setups:** `partial_run_on_start: true`, plus the [Tautulli webhook](#keeping-up-with-new-media-tautulli).
  New media is handled the moment it's added, and the startup sweep just catches anything added while
  Defaulterr was offline. **No cron needed.**
- **No Tautulli:** set a `partial_run_cron_expression` so new media gets picked up on a schedule.
- **`clean_run_on_start`:** only when you've rewritten your filters and want them re-applied to
  everything. See the warning below.

> **A clean run is slow.** Defaulterr deliberately paces itself to avoid hammering Plex (roughly a
> 100 ms pause between each episode, and again between each per-user update). On a large multi-library
> server a full sweep can run for **many hours or even days**. A partial run over a normal day's new
> media takes seconds.

> **Progress is saved only when a run finishes.** The `last_run_timestamps.json` file is written after
> all libraries complete. Restarting mid-sweep means the next run starts over. Let long runs finish.

### 3. Groups

A group is a name plus a list of Plex usernames.

```yaml
groups:
  weebs:                      # name it whatever you like
    - alice
    - UserWithCapitals        # must match Plex EXACTLY, including case
  no_subtitles:
    - bob
  everyone:
    - $ALL                    # every user with access to your server
```

- Usernames must match Plex **exactly** — capitalisation and special characters included.
- `$ALL` expands to every user shared on your server.
- To include yourself, set `plex_owner_name` and use that name here.
- [Managed/Home accounts](#4-managed-home-accounts) need one extra step.

### 4. Managed (Home) accounts

Managed accounts (Plex Home profiles) don't appear in the normal shared-user list, so you supply their
tokens directly. Regular tokens won't work — follow
[this walkthrough](https://www.reddit.com/r/PleX/comments/18ihi91/comment/kddct4k/) to get them.

```yaml
managed_users:
  kids_profile: TOKEN_HERE
  guest_profile: TOKEN_HERE
```

Then use the key (`kids_profile`) anywhere you'd use a username:

```yaml
groups:
  kids:
    - kids_profile
```

### 5. Filters

Filters are where the real work happens. The shape is:

```
filters
└── Library name          ← exactly as it appears in Plex
    └── Group name        ← from your groups block
        ├── audio         ← a list of rules, tried in order
        └── subtitles     ← a list of rules, tried in order
```

Each rule has `include` and/or `exclude`, matched against the track's properties. Rules are tried
**top to bottom, and the first one that matches wins** — so order them most specific first, with
broader fallbacks beneath.

#### How matching actually works

These rules are worth reading once, because two of them surprise people:

1. **Matching is case-insensitive and partial.** `language: engl` matches `English`. You're checking
   whether the value appears *somewhere* in the field, not whether it's equal.

2. **In `include`, multiple values mean AND — all of them must be present.**

   ```yaml
   # ✗ WRONG — matches nothing. No track's language contains BOTH words.
   - include:
       language: [English, Spanish]

   # ✓ RIGHT — "English or Spanish" is two rules, tried in order
   - include:
       language: English
   - include:
       language: Spanish
   ```

   To express *"any of these"*, write one rule per option and let the fallback order do the work.

3. **In `exclude`, multiple values mean OR** — any match rejects the track. This is the behaviour
   you'd expect:

   ```yaml
   exclude:
     codec: [truehd, dts]      # reject if the codec is either one
   ```

4. **A track missing the field is treated differently by each.** If a track has no `language` field
   at all, an `include: {language: ...}` rule will never match it, while an `exclude: {language: ...}`
   rule won't reject it.

5. **Every value must be a string — quote anything that isn't obviously text.** YAML reads `true` as a
   boolean and `2` as a number, and the config validator rejects both, so Defaulterr won't start:

   ```yaml
   hearingImpaired: true      # ✗ fails validation — YAML boolean
   hearingImpaired: "true"    # ✓ quoted, matches an SDH track
   channels: "2"              # ✓ quoted number
   ```

6. **Any property Plex returns is fair game** — `language`, `languageCode`, `codec`, `channels`,
   `extendedDisplayTitle`, `hearingImpaired`, and so on. See [example.json](example.json) for a real
   track object.

7. **If no rule matches, the item is left untouched.**

#### A worked example

```yaml
filters:
  Movies:
    serialTranscoders:
      audio:
        # 1. Preferred: English, but not lossless formats, and not a commentary track
        - include:
            language: English      # the language as Plex shows it, e.g. Español
          exclude:
            codec: [truehd, dts]
            extendedDisplayTitle: commentary
        # 2. Fallback: any English track at all
        - include:
            language: English

    deafPeople:
      subtitles:
        - include:
            language: English
            hearingImpaired: "true"   # SDH — note the quotes
```

#### Linking audio and subtitles with `on_match`

`on_match` lets a matched audio track decide the subtitles (or vice versa). This is what makes the
sub-vs-dub split work:

```yaml
filters:
  Anime:
    weebs:
      audio:
        # If an English dub exists, use it and turn subtitles OFF
        - include:
            language: English
          on_match:
            subtitles: disabled

        # Otherwise Japanese audio, and pick the best English subtitles
        - include:
            languageCode: jpn
          on_match:
            subtitles:
              - include:                        # prefer "full" subtitles
                  language: English
                  extendedDisplayTitle: full
              - include:                        # then "dialogue"
                  language: English
                  extendedDisplayTitle: dialogue
              - include:                        # then anything that isn't signs-only
                  language: English
                exclude:
                  extendedDisplayTitle: signs
              - disabled                        # nothing suitable? turn them off
```

#### Turning subtitles off

Use `disabled` to explicitly set subtitles to **Off** in Plex:

- As a whole rule set: `subtitles: disabled`
- As the **last item** in a list: `- disabled`

The second form is the useful one. Without it, when none of your subtitle rules match, Plex keeps
whatever was selected before — often a random foreign-language or signs-only track. Ending your list
with `- disabled` guarantees a clean fallback.

---

## Keeping up with new media (Tautulli)

With this configured, newly added media is processed within seconds of landing in Plex — no schedule
required.

1. In Tautulli, go to **Settings → Notifications & Newsletters**.
2. Set **Recently Added Notification Delay** to `60` seconds. (Raise it if Tautulli fires before Plex
   has finished analysing the file.)
3. Go to **Settings → Notification Agents → Add a new notification agent → Webhook**.
4. **Webhook URL:** `http://defaulterr:3184/webhook` — use a hostname or IP your Tautulli container can
   actually reach.
5. **Webhook Method:** `POST`
6. Under **Triggers**, enable **Recently Added**.
7. Under **Data → Recently Added**, paste this into **JSON Data**:

```json
<movie>
{
  "type": "movie",
  "libraryId": "{section_id}",
  "mediaId": "{rating_key}"
}
</movie>

<show>
{
  "type": "show",
  "libraryId": "{section_id}",
  "mediaId": "{rating_key}"
}
</show>

<season>
{
  "type": "season",
  "libraryId": "{section_id}",
  "mediaId": "{rating_key}"
}
</season>

<episode>
{
  "type": "episode",
  "libraryId": "{section_id}",
  "mediaId": "{rating_key}"
}
</episode>
```

To confirm it's wired up, add something to Plex and watch `docker logs -f defaulterr` for
`Tautulli webhook received`.

---

## Running it

### Docker Compose

```yaml
services:
  defaulterr:
    image: ghcr.io/swshong/defaulterr:latest
    container_name: defaulterr
    hostname: defaulterr
    ports:
      - 3184:3184
    volumes:
      - /path/to/config:/config
      - /path/to/logs:/logs
    environment:
      - TZ=Europe/London
      - LOG_LEVEL=info
    restart: unless-stopped
```

### Unraid

Download the [Unraid template](https://raw.githubusercontent.com/swshong/Defaulterr/refs/heads/main/defaulterr.xml)
and drop it in `/boot/config/plugins/dockerMan/templates-user/`, or add the container manually with
the settings above.

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `TZ` | UTC | Timezone for log timestamps and cron schedules. |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, or `debug`. Use `debug` when tuning filters — it logs every non-match. |
| `PORT` | `3184` | Port for the webhook and health endpoints. |

### Volumes

| Path | Contents |
| --- | --- |
| `/config` | `config.yaml`, plus `last_run_timestamps.json` which Defaulterr writes itself. |
| `/logs` | Daily rotated logs, kept 7 days, 500 KB each. |

### File permissions — read this one

The container runs as a **non-root user (UID 1000)**, so both mounted directories must be writable by
UID 1000. If you're migrating from an older image that ran as root, fix ownership once:

```bash
chown -R 1000:1000 /path/to/config /path/to/logs
```

If you skip this, Defaulterr starts, runs an entire sweep, and only then fails with
`EACCES: permission denied, open '/config/last_run_timestamps.json'` — because that file is written at
the *end* of a run. It's an easy failure to miss.

### Health check

The image ships a Docker `HEALTHCHECK`. You can also query it directly:

```bash
curl http://localhost:3184/health
# {"status":"ok"}
```

This reports that the process is up and serving. A long sweep runs in the background, so `ok` doesn't
mean idle.

### Restart policy

Use `restart: unless-stopped`. On unrecoverable errors — such as Plex being unreachable through ten
retries — Defaulterr exits deliberately rather than sitting in a broken state, and relies on your
container runtime to bring it back.

> **Unraid note:** Unraid's autostart only starts containers when the array starts; it does **not**
> restart a container that has crashed. Add `--restart=unless-stopped` to Extra Parameters.

---

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| Container exits immediately, logs show `Error loading or validating YAML` | A malformed or misspelled setting. The message names the offending path — remember unknown keys are rejected outright. |
| Validation error ending in `must be string` | An unquoted boolean or number in a filter, e.g. `hearingImpaired: true`. Quote it: `hearingImpaired: "true"`. |
| `Library '<name>' not found in Plex response` | The library name in `filters` must match Plex **exactly**, including spaces and capitalisation. |
| `No users with access to libraries detected` | Usernames don't match Plex exactly, or `plex_client_identifier` is your account's ID rather than the **server's**. |
| `User X can't access library Y. They will be skipped` | That user genuinely lacks access — check library sharing in Plex. |
| A rule never matches | Run with `LOG_LEVEL=debug` and `dry_run: true` to see every candidate track. The usual culprit is [multiple values in an `include`](#how-matching-actually-works), which means AND, not OR. |
| `EACCES: permission denied` | Ownership of `/config` or `/logs`. See [File permissions](#file-permissions--read-this-one). |
| Nothing happens when new media is added | The Tautulli webhook isn't reaching Defaulterr. Check the URL is resolvable from Tautulli's container and that **Recently Added** is enabled. |
| Updates fail with HTTP 403 | Usually Plex age ratings — the affected user can't see every item in that library. |
| Runs seem to start over each time | The previous run never finished, so timestamps were never written. Let a full run complete. |

---

## Fork notes

This fork tracks [varthe/Defaulterr](https://github.com/varthe/Defaulterr) and focuses on dependency
currency, CVE patching, and runtime hardening. Images publish to
[`ghcr.io/swshong/defaulterr`](https://github.com/swshong/Defaulterr/pkgs/container/defaulterr).

Changes vs upstream: removed a placeholder `fs` dependency; patched CVE advisories across the
dependency tree; fixed runtime crashes in the Plex retry, `on_match`, and managed-users paths; added
the `- disabled` subtitle fallback; added a `/health` endpoint; and rebased the image on
`node:24-alpine` running as a non-root user. Full detail in [CHANGELOG.md](CHANGELOG.md).

> **Review notes:** This fork is maintained with recurring review passes by Claude (Anthropic). Each pass
> audits the dependency tree for advisories, checks upstream drift and base-image/CI currency, and reviews
> the source for correctness. Fixes are verified with live smoke runs before release.
>
> | Date | Reviewer | Outcome |
> | --- | --- | --- |
> | 2026-06-06 | Claude Opus 4.8 | Initial audit, secret/PII scan, removed a placeholder `fs` dependency |
> | 2026-07-10 | Claude Fable 5 | Patched `form-data` (high) and `js-yaml` (moderate); fixed 3 runtime bugs |
> | 2026-08-05 | Claude Opus 5 | Patched `fast-uri` (2× high) and `brace-expansion` (high) |
>
> `npm audit` is kept at **0 known vulnerabilities**. Per-pass detail in [CHANGELOG.md](CHANGELOG.md).

### Credits

Original project by [varthe](https://github.com/varthe). Licensed under the terms in
[LICENSE](LICENSE).
