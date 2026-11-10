// Integration tests: the real main.js, spawned as a child process, against a fake Plex.
const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("fs")
const zlib = require("zlib")
const http = require("http")
const { createFakePlex, startApp, baseConfig, leaf, englishAudio, subtitle, sleep } = require("./helpers")

const movie = (key, extra = {}) =>
    leaf(key, `Movie ${key}`, [englishAudio(key * 100 + 1), subtitle(key * 100 + 2, "English"), subtitle(key * 100 + 3, "Español")], extra)

const withApp = async (state, opts, fn) => {
    const fake = await createFakePlex(state)
    const app = await startApp(fake, typeof opts === "function" ? opts(fake) : opts)
    try {
        await fn({ fake, app })
    } finally {
        await app.stop()
        await fake.close()
    }
}
const ready = (app) => app.waitFor(/Fetched and mapped libraries|FINISHED (PARTIAL|CLEAN) RUN|DRY RUN COMPLETE/)
const validHook = { type: "movie", libraryId: "1", mediaId: "5" }

// ---------------------------------------------------------------- webhook input handling

test("webhook: a non-numeric mediaId is rejected and never reaches Plex", async () => {
    await withApp({ items: { 1: [movie(5)] } }, {}, async ({ fake, app }) => {
        await ready(app)
        fake.reset()
        for (const mediaId of ["../../identity", "5/children", "5?x=1", { a: 1 }, ["5"], "5\nforged"]) {
            const res = await app.post({ type: "movie", libraryId: "1", mediaId })
            assert.equal(res.status, 400, `mediaId ${JSON.stringify(mediaId)}`)
        }
        await sleep(150)
        assert.deepEqual(fake.requests, [], "no outbound request may result from a rejected payload")
    })
})

test("webhook: an unknown type or a non-numeric libraryId is rejected", async () => {
    await withApp({ items: { 1: [movie(5)] } }, {}, async ({ fake, app }) => {
        await ready(app)
        fake.reset()
        assert.equal((await app.post({ ...validHook, type: "artist" })).status, 400)
        assert.equal((await app.post({ ...validHook, libraryId: "1\n2026-01-01 00:00:00 [INFO]: forged" })).status, 400)
        assert.equal((await app.post("[1,2,3]")).status, 400)
        await sleep(100)
        assert.deepEqual(fake.requests, [])
        assert.doesNotMatch(app.output(), /forged/, "attacker-controlled text must not reach the log")
    })
})

test("webhook: a valid payload is accepted, queued and applied for every user", async () => {
    await withApp({ items: { 1: [movie(5)] } }, {}, async ({ fake, app }) => {
        await ready(app)
        fake.reset()
        const res = await app.post(validHook)
        assert.equal(res.status, 202)
        await app.waitFor(/Tautulli webhook finished/)
        const updates = fake.updates()
        assert.deepEqual(updates.map((u) => u.token).sort(), ["friend-token", "owner-token"])
        assert.ok(updates.every((u) => u.path === "/library/parts/50"))
        assert.ok(updates.every((u) => u.query.audioStreamID === "501" && u.query.subtitleStreamID === "502"))
    })
})

test("webhook: oversized and compressed bodies are refused", async () => {
    await withApp({ items: { 1: [movie(5)] } }, {}, async ({ fake, app }) => {
        await ready(app)
        fake.reset()
        const big = await app.post({ ...validHook, pad: "x".repeat(20000) })
        assert.equal(big.status, 413)
        const gz = await fetch(`${app.url}/webhook`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" },
            body: zlib.gzipSync(JSON.stringify(validHook)),
        })
        assert.equal(gz.status, 415)
        await sleep(100)
        assert.deepEqual(fake.requests, [])
    })
})

test("webhook: with webhook_secret set, requests without the right secret get 401", async () => {
    const opts = (fake) => ({ config: baseConfig(fake, { webhook_secret: "correct-horse-battery" }) })
    await withApp({ items: { 1: [movie(5)] } }, opts, async ({ fake, app }) => {
        await ready(app)
        fake.reset()
        assert.equal((await app.post(validHook)).status, 401)
        assert.equal((await app.post(validHook, { "X-Defaulterr-Secret": "wrong" })).status, 401)
        assert.equal((await app.post(validHook, { "X-Defaulterr-Secret": "correct-horse-battery-and-more" })).status, 401)
        await sleep(100)
        assert.deepEqual(fake.requests, [], "an unauthenticated request must not cause any Plex traffic")
        assert.equal((await app.post(validHook, { "X-Defaulterr-Secret": "correct-horse-battery" })).status, 202)
        await app.waitFor(/Tautulli webhook finished/)
        assert.equal(fake.updates().length, 2)
        assert.doesNotMatch(app.output(), /correct-horse-battery/, "the secret must never be logged")
        // /health stays open so the Docker HEALTHCHECK keeps working
        assert.equal((await fetch(`${app.url}/health`)).status, 200)
    })
})

test("webhook: dry_run really means no writes, including from the webhook", async () => {
    const opts = (fake) => ({ config: baseConfig(fake, { dry_run: true }) })
    await withApp({ items: { 1: [movie(5)] } }, opts, async ({ fake, app }) => {
        await app.waitFor(/DRY RUN COMPLETE/)
        const res = await app.post(validHook)
        assert.equal(res.status, 202)
        await app.waitFor(/Tautulli webhook finished/)
        assert.equal(fake.updates().length, 0, "dry_run must not write to Plex")
        assert.match(app.output(), /DRY RUN: would set/)
    })
})

test("webhook: a burst is serialised, and the queue is bounded", async () => {
    const state = { items: { 1: [movie(5), movie(6), movie(7), movie(8)] } }
    await withApp(state, { env: { DEFAULTERR_MAX_QUEUE: "2", DEFAULTERR_STEP_DELAY_MS: "25" } }, async ({ fake, app }) => {
        await ready(app)
        fake.reset()
        const statuses = []
        for (const mediaId of ["5", "6", "7", "8", "5", "6"]) {
            statuses.push((await app.post({ ...validHook, mediaId })).status)
        }
        assert.ok(statuses.includes(503), `expected the bounded queue to refuse some of the burst, got ${statuses}`)
        assert.equal(statuses[0], 202)
        await sleep(1500)
        // serialised: all traffic for one part finishes before traffic for the next part starts
        const order = fake.updates().map((u) => u.path)
        const firstSeen = [...new Set(order)]
        assert.deepEqual(order, [...order].sort((a, b) => firstSeen.indexOf(a) - firstSeen.indexOf(b)), `interleaved: ${order}`)
    })
})

// ---------------------------------------------------------------- outbound requests

test("outbound: the Plex token is not carried across a redirect", async () => {
    const seen = []
    const other = http.createServer((req, res) => {
        seen.push(req.headers["x-plex-token"])
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ MediaContainer: { Directory: [] } }))
    })
    await new Promise((r) => other.listen(0, "127.0.0.1", r))
    const target = `http://127.0.0.1:${other.address().port}/library/sections`
    const state = {
        onRequest: (r) => (r.path === "/library/sections" ? { status: 302, headers: { Location: target } } : null),
    }
    try {
        await withApp(state, { env: { DEFAULTERR_RETRY_DELAY_MS: "5" } }, async ({ app }) => {
            await Promise.race([app.exited, sleep(1500)])
            assert.deepEqual(seen, [], "the redirect target must never be contacted")
        })
    } finally {
        await new Promise((r) => other.close(r))
    }
})

// ---------------------------------------------------------------- update retries

test("updates: a permanent 4xx on one user does not retry forever or kill the app", async () => {
    const state = {
        items: { 1: [movie(5), movie(6)] },
        onRequest: (r) => (r.method === "POST" && r.path === "/library/parts/50" && r.token === "friend-token" ? 403 : null),
    }
    const opts = (fake) => ({ config: baseConfig(fake, { partial_run_on_start: true }) })
    await withApp(state, opts, async ({ fake, app }) => {
        await app.waitFor(/FINISHED PARTIAL RUN/)
        assert.equal(app.child.exitCode, null, "the app must stay up")
        const denied = fake.updates().filter((u) => u.path === "/library/parts/50" && u.token === "friend-token")
        assert.equal(denied.length, 1, "a 403 is not retryable")
        // everything else still got applied
        assert.equal(fake.updates().filter((u) => u.path === "/library/parts/60").length, 2)
        assert.equal(fake.updates().filter((u) => u.path === "/library/parts/50" && u.token === "owner-token").length, 1)
    })
})

test("updates: a transient 5xx is retried and a successful retry is not logged as an error", async () => {
    let failures = 2
    const state = {
        items: { 1: [movie(5)] },
        onRequest: (r) => (r.method === "POST" && r.token === "owner-token" && failures-- > 0 ? 503 : null),
    }
    const opts = (fake) => ({ config: baseConfig(fake, { partial_run_on_start: true }) })
    await withApp(state, opts, async ({ fake, app }) => {
        await app.waitFor(/FINISHED PARTIAL RUN/)
        assert.equal(fake.updates().filter((u) => u.token === "owner-token").length, 3)
        assert.doesNotMatch(app.output(), /Cannot read properties of undefined/)
        assert.doesNotMatch(app.output(), /\[ERROR\]: Error posting update/)
    })
})

// ---------------------------------------------------------------- change detection

test("partial run: an episode changed after the watermark is processed even if its show was not", async () => {
    const ep = (key, updatedAt) =>
        leaf(key, `Episode ${key}`, [englishAudio(key * 100 + 1), subtitle(key * 100 + 2, "English"), subtitle(key * 100 + 3, "Čeština")], {
            type: "episode",
            updatedAt,
            grandparentRatingKey: "900",
            grandparentTitle: "Some Show",
            parentTitle: "Season 1",
            index: key,
        })
    const state = {
        libraries: [{ key: "2", title: "Series", type: "show" }],
        items: { 2: [{ ratingKey: "900", title: "Some Show", type: "show", updatedAt: 1000 }] },
        episodes: { 2: [ep(1, 900), ep(2, 5000), ep(3, 950)] },
        children: { 900: [901], 901: [1, 2, 3] },
    }
    const opts = (fake) => ({
        config: baseConfig(fake, {
            partial_run_on_start: true,
            filters: { Series: { everyone: { subtitles: [{ include: { language: "English" } }, "disabled"] } } },
        }),
        timestamps: { Series: 2000 },
    })
    await withApp(state, opts, async ({ fake, app }) => {
        await app.waitFor(/FINISHED PARTIAL RUN/)
        const parts = [...new Set(fake.updates().map((u) => u.path))]
        assert.deepEqual(parts, ["/library/parts/20"], "only the changed episode is touched")
        assert.equal(JSON.parse(fs.readFileSync(app.tsPath, "utf8")).Series, 5000, "watermark advances to the episode's updatedAt")
        // and the change filter was pushed to the server rather than pulling the whole library
        const list = fake.requests.find((r) => r.path === "/library/sections/2/all")
        assert.equal(list.query.type, "4")
        assert.equal(list.query["updatedAt>>"], "2000")
    })
})

test("partial run: nothing changed means no metadata fetches and no writes", async () => {
    const opts = (fake) => ({ config: baseConfig(fake, { partial_run_on_start: true }), timestamps: { Movies: 5000 } })
    await withApp({ items: { 1: [movie(5), movie(6)] } }, opts, async ({ fake, app }) => {
        await app.waitFor(/FINISHED PARTIAL RUN/)
        assert.equal(fake.updates().length, 0)
        assert.equal(fake.requests.filter((r) => r.path.startsWith("/library/metadata/")).length, 0)
    })
})

// ---------------------------------------------------------------- startup robustness

test("startup: one library missing from Plex does not hide the libraries listed after it", async () => {
    const opts = (fake) => ({
        config: baseConfig(fake, {
            filters: {
                "Renamed Away": { everyone: { subtitles: "disabled" } },
                Movies: { everyone: { subtitles: "disabled" } },
            },
        }),
    })
    await withApp({ items: { 1: [movie(5)] } }, opts, async ({ fake, app }) => {
        await ready(app)
        assert.match(app.output(), /Library 'Renamed Away' not found/)
        fake.reset()
        assert.equal((await app.post(validHook)).status, 202)
        await app.waitFor(/Tautulli webhook finished/)
        assert.equal(fake.updates().length, 2, "Movies is still mapped and served")
    })
})

test("startup: a filter that names an undefined group fails fast with a clear message", async () => {
    const opts = (fake) => ({
        config: baseConfig(fake, { filters: { Movies: { typo_group: { subtitles: "disabled" } } } }),
    })
    await withApp({}, opts, async ({ app }) => {
        const { code } = await app.exited
        assert.equal(code, 1)
        assert.match(app.output(), /group 'typo_group'.*not defined under 'groups'/)
    })
})

test("startup: on_match.audio: disabled is rejected instead of silently picking the first track", async () => {
    const opts = (fake) => ({
        config: baseConfig(fake, {
            filters: { Movies: { everyone: { subtitles: [{ include: { language: "English" }, on_match: { audio: "disabled" } }] } } },
        }),
    })
    await withApp({}, opts, async ({ app }) => {
        const { code } = await app.exited
        assert.equal(code, 1)
        assert.match(app.output(), /Error loading or validating YAML/)
    })
})

test("startup: a corrupt timestamps file is tolerated, and saves are atomic", async () => {
    const opts = (fake) => ({ config: baseConfig(fake, { partial_run_on_start: true }), rawTimestamps: '{"Movies": 12' })
    await withApp({ items: { 1: [movie(5)] } }, opts, async ({ fake, app }) => {
        await app.waitFor(/FINISHED PARTIAL RUN/)
        assert.match(app.output(), /timestamps file .* is unreadable/i)
        assert.equal(fake.updates().length, 2)
        assert.deepEqual(JSON.parse(fs.readFileSync(app.tsPath, "utf8")), { Movies: 1000 })
        assert.deepEqual(fs.readdirSync(app.dir).filter((f) => f.includes(".tmp")), [], "no temp file left behind")
    })
})

test("users: someone added to the server after startup is picked up without a restart", async () => {
    await withApp({ items: { 1: [movie(5)] } }, { env: { DEFAULTERR_USER_REFRESH_MS: "0" } }, async ({ fake, app }) => {
        await ready(app)
        fake.sharedUsers.push({ username: "newcomer", accessToken: "newcomer-token" })
        fake.reset()
        assert.equal((await app.post(validHook)).status, 202)
        await app.waitFor(/Tautulli webhook finished/)
        assert.ok(fake.updates().some((u) => u.token === "newcomer-token"))
    })
})

test("shutdown: SIGTERM exits cleanly and promptly", async () => {
    await withApp({ items: { 1: [movie(5)] } }, {}, async ({ app }) => {
        await ready(app)
        const started = Date.now()
        app.child.kill("SIGTERM")
        const { code } = await app.exited
        assert.equal(code, 0)
        assert.ok(Date.now() - started < 3000)
    })
})

test("logging: control characters in Plex metadata cannot forge log lines", async () => {
    const evil = leaf(5, "Nice\n2026-01-01 00:00:00 [ERROR]: forged entry", [englishAudio(501), subtitle(502, "English")])
    await withApp({ items: { 1: [evil] } }, {}, async ({ app }) => {
        await ready(app)
        await app.post(validHook)
        await app.waitFor(/Tautulli webhook finished/)
        assert.doesNotMatch(app.output(), /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \[ERROR\]: forged entry/m)
    })
})
