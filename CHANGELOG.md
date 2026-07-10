# Changelog

This is a maintained fork of [varthe/Defaulterr](https://github.com/varthe/Defaulterr),
focused on dependency currency, CVE hygiene, and runtime hardening. Images are published
to [`ghcr.io/swshong/defaulterr`](https://github.com/swshong/Defaulterr/pkgs/container/defaulterr).

All notable changes to this fork (relative to upstream) are documented here.
Upstream history prior to the fork lives in the [original project](https://github.com/varthe/Defaulterr).

## 2026-07-10

### Security

- Bumped `axios` `1.16.1` → `1.18.1`, pulling in `form-data` `4.0.6` — fixes
  [GHSA-hmw2-7cc7-3qxx](https://github.com/advisories/GHSA-hmw2-7cc7-3qxx)
  (high — CRLF injection via unescaped multipart field names).
- Bumped `js-yaml` `4.1.1` → `4.3.0` — fixes
  [GHSA-h67p-54hq-rp68](https://github.com/advisories/GHSA-h67p-54hq-rp68)
  (moderate — quadratic-complexity DoS in merge-key handling).
- `npm audit`: 0 known vulnerabilities.

### Dependencies

- `node-cron` `4.2.1` → `4.6.0`
- Lockfile-only refresh of remaining transitive dependencies within existing semver ranges.

### Fixed

- **Plex-unreachable retry loop never ran** (`fetchAllLibraries`): when Plex returned no HTTP
  response at all (connection refused / timeout — e.g. Plex still starting up), `error.response`
  was `undefined` and the retry loop crashed with
  `Cannot read properties of undefined (reading 'status')` after the first 30-second wait,
  leaving the library map empty. The retry loop now genuinely attempts 10 retries at
  30-second intervals regardless of failure mode. Note this makes the designed
  exit-after-all-retries path reachable — pair with a container restart policy.
- **`on_match` sub-filter with no matching stream aborted the whole batch**
  (`identifyStreamsToUpdate`): the `on_match` reassignments of `audio`/`subtitles` lacked the
  `|| {}` fallback the initial assignments have, so a non-matching sub-filter threw on `.id`
  access and every part in the batch was dropped.
- **`managed_users` were silently skipped when the plex.tv shared-servers call failed**
  (`fetchAllUsersListedInFilters`): managed-user tokens come from the config and don't depend
  on plex.tv, but they were registered inside the same `try` block after the plex.tv fetch. They
  are now registered unconditionally; if that call failing left zero users, the app exited at startup.

## 2026-06-06

### Reviewed & patched by Claude Opus 4.8

This fork was reviewed and verified by **Claude Opus 4.8** (Anthropic) on 2026-06-06.
The review covered:

- **Dependency / CVE audit** — `npm audit` against the production dependency tree: **0 known vulnerabilities**.
- **Source review** of `main.js` and `configBuilder.js` for correctness and error handling.
- **Secret / PII scan** of the working tree and full git history — no tokens, credentials, IPs,
  or personal information found; commits are authored under a GitHub privacy `noreply` address.
- **Documentation** — authored this changelog and the README "Fork Notes" section.

The fork's divergence from upstream, as it stands at this review, is catalogued below.

### Security

- Removed the bogus `fs` dependency (`fs@0.0.1-security`, a placeholder/squat package) — Node
  provides `fs` natively, so the third-party package was unnecessary and a supply-chain risk.
- Container image runs as the non-root `node` user.
- `npm audit`: 0 known vulnerabilities.

### Dependencies

- `node-cron` `3.0.3` → `4.2.1`
- `winston` `3.17.0` → `3.19.0`
- `cron-validator` `1.3.1` → `1.4.0`

### Fixed

- Runtime crash in `identifyStreamsToUpdate`: corrected `subtitles.filter.onMatch.audio` →
  `subtitles.onMatch.audio` (the original referenced an undefined property and would throw
  when an `on_match` audio rule was evaluated from a subtitle filter).

### Added

- **`- disabled` subtitle fallback** — a subtitle filter array may end with `- disabled` to
  explicitly turn subtitles off in Plex when no earlier subtitle filter matches. This prevents a
  stale or non-preferred subtitle track from remaining selected when the preferred language is
  absent. Both the schema (`configBuilder.js`) and the runtime (`main.js`) were updated to support it.
- **`/health` endpoint** and a Docker `HEALTHCHECK` for container orchestration / readiness checks.

### Build & CI

- Dockerfile rebased on `node:24-alpine`: `npm ci --omit=dev`, `EXPOSE 3184`,
  `VOLUME ["/config", "/logs"]`, non-root `node` user, and a `HEALTHCHECK`.
- GitHub Actions workflow publishes **multi-arch (linux/amd64, linux/arm64)** images to
  `ghcr.io/swshong/defaulterr` on push to `main`, on tags, and via manual dispatch.
- Added `package.json` metadata (`name`, `version`, `scripts`) and an ESLint flat config
  (`eslint.config.js`).

---

_Reviewed and documented with assistance from Claude Opus 4.8._
