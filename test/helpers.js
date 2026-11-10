// Test harness: a fake Plex server (which also stands in for plex.tv) and a spawner that runs
// the real main.js against it as a child process. No test talks to a real Plex or to the internet.
const http = require("http")
const net = require("net")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { spawn } = require("child_process")

const ROOT = path.join(__dirname, "..")

const stream = (id, streamType, extra = {}) => ({ id, streamType, ...extra })
const englishAudio = (id, extra = {}) =>
    stream(id, 2, { language: "English", languageCode: "eng", codec: "aac", extendedDisplayTitle: "English (AAC)", ...extra })
const subtitle = (id, language, extra = {}) =>
    stream(id, 3, { language, extendedDisplayTitle: `${language} (SRT)`, ...extra })

// A leaf item (movie or episode) with one part.
const leaf = (ratingKey, title, streams, extra = {}) => ({
    ratingKey: String(ratingKey),
    title,
    type: "movie",
    updatedAt: 1000,
    addedAt: 1000,
    partId: Number(ratingKey) * 10,
    streams,
    ...extra,
})

const createFakePlex = async (state = {}) => {
    const fake = {
        requests: [],
        libraries: state.libraries || [{ key: "1", title: "Movies", type: "movie" }],
        // sectionKey -> array of top-level items (movies or shows)
        items: state.items || {},
        // sectionKey -> array of episodes (leaf items with grandparentRatingKey)
        episodes: state.episodes || {},
        // ratingKey -> array of child ratingKeys (show -> seasons, season -> episodes)
        children: state.children || {},
        sharedUsers: state.sharedUsers || [{ username: "friend", accessToken: "friend-token" }],
        // hooks: return a status code (or { status, headers }) to override a response
        onRequest: state.onRequest || (() => null),
    }

    const allLeaves = () => [...Object.values(fake.items).flat(), ...Object.values(fake.episodes).flat()]
    const findLeaf = (ratingKey) => allLeaves().find((x) => x.ratingKey === String(ratingKey) && x.streams)

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://fake")
        const record = {
            method: req.method,
            path: url.pathname,
            query: Object.fromEntries(url.searchParams),
            token: req.headers["x-plex-token"],
        }
        fake.requests.push(record)

        const override = fake.onRequest(record)
        if (override) {
            const { status, headers = {} } = typeof override === "number" ? { status: override } : override
            res.writeHead(status, headers)
            return res.end()
        }

        const json = (body) => {
            res.writeHead(200, { "Content-Type": "application/json" })
            res.end(JSON.stringify(body))
        }
        let m

        if ((m = url.pathname.match(/^\/api\/servers\/[^/]+\/shared_servers$/))) {
            res.writeHead(200, { "Content-Type": "application/xml" })
            const rows = fake.sharedUsers
                .map((u) => `<SharedServer username="${u.username}" accessToken="${u.accessToken}"/>`)
                .join("")
            return res.end(`<MediaContainer>${rows}</MediaContainer>`)
        }
        if (url.pathname === "/library/sections") {
            return json({ MediaContainer: { Directory: fake.libraries } })
        }
        if ((m = url.pathname.match(/^\/library\/sections\/(\d+)$/))) {
            return json({ MediaContainer: {} })
        }
        if ((m = url.pathname.match(/^\/library\/sections\/(\d+)\/all$/))) {
            const wantEpisodes = url.searchParams.get("type") === "4"
            let rows = (wantEpisodes ? fake.episodes[m[1]] : fake.items[m[1]]) || []
            const since = url.searchParams.get("updatedAt>>")
            if (since !== null) rows = rows.filter((x) => x.updatedAt > Number(since))
            // list responses never include Stream data, matching real Plex
            return json({ MediaContainer: { Metadata: rows.map(({ streams: _s, ...rest }) => rest) } })
        }
        if ((m = url.pathname.match(/^\/library\/metadata\/(\d+)\/children$/))) {
            const kids = (fake.children[m[1]] || []).map((k) => ({ ratingKey: String(k), title: `child ${k}`, index: 1 }))
            return json({ MediaContainer: { Metadata: kids } })
        }
        if ((m = url.pathname.match(/^\/library\/metadata\/(\d+)$/))) {
            const item = findLeaf(m[1])
            if (!item) {
                res.writeHead(404)
                return res.end()
            }
            const { streams, partId, ...meta } = item
            return json({ MediaContainer: { Metadata: [{ ...meta, Media: [{ Part: [{ id: partId, Stream: streams }] }] }] } })
        }
        if (req.method === "POST" && url.pathname.match(/^\/library\/parts\/\d+$/)) {
            res.writeHead(200)
            return res.end()
        }
        res.writeHead(404)
        res.end()
    })

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    fake.url = `http://127.0.0.1:${server.address().port}`
    fake.close = () => new Promise((resolve) => server.close(resolve))
    fake.updates = () => fake.requests.filter((r) => r.method === "POST" && r.path.startsWith("/library/parts/"))
    fake.reset = () => (fake.requests.length = 0)
    return fake
}

const freePort = () =>
    new Promise((resolve) => {
        const srv = net.createServer()
        srv.listen(0, "127.0.0.1", () => {
            const { port } = srv.address()
            srv.close(() => resolve(port))
        })
    })

const baseConfig = (fake, overrides = {}) => ({
    plex_server_url: fake.url,
    plex_owner_name: "owner",
    plex_owner_token: "owner-token",
    plex_client_identifier: "client-id",
    groups: { everyone: ["$ALL"] },
    filters: {
        Movies: {
            everyone: {
                audio: [{ include: { language: "English" } }],
                subtitles: [{ include: { language: "English" } }, "disabled"],
            },
        },
    },
    ...overrides,
})

// Spawns the real app. Resolves once the app reports it is listening (or has exited).
const startApp = async (fake, { config, env = {}, timestamps, rawTimestamps } = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "defaulterr-test-"))
    const configPath = path.join(dir, "config.yaml")
    const tsPath = path.join(dir, "last_run_timestamps.json")
    fs.writeFileSync(configPath, JSON.stringify(config || baseConfig(fake))) // JSON is valid YAML
    if (timestamps) fs.writeFileSync(tsPath, JSON.stringify(timestamps))
    if (rawTimestamps !== undefined) fs.writeFileSync(tsPath, rawTimestamps)

    const port = await freePort()
    const child = spawn(process.execPath, ["main.js", path.join(dir, "logs"), configPath, tsPath], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(port),
            NODE_ENV: "production",
            DEFAULTERR_PLEX_TV_URL: fake.url,
            DEFAULTERR_STEP_DELAY_MS: "1",
            DEFAULTERR_RETRY_DELAY_MS: "20",
            ...env,
        },
    })
    // never leave an app behind if a test is cancelled by its timeout
    const reap = () => child.kill("SIGKILL")
    process.once("exit", reap)
    child.once("exit", () => process.removeListener("exit", reap))
    let output = ""
    child.stdout.on("data", (d) => (output += d))
    child.stderr.on("data", (d) => (output += d))
    const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })))

    const app = {
        url: `http://127.0.0.1:${port}`,
        dir,
        tsPath,
        child,
        exited,
        output: () => output,
        waitFor: async (pattern, ms = 8000) => {
            const start = Date.now()
            while (Date.now() - start < ms) {
                if (pattern.test(output)) return true
                await new Promise((r) => setTimeout(r, 15))
            }
            throw new Error(`timed out waiting for ${pattern}\n--- app output ---\n${output}`)
        },
        post: (body, headers = {}) =>
            fetch(`${app.url}/webhook`, {
                method: "POST",
                headers: { "Content-Type": "application/json", ...headers },
                body: typeof body === "string" ? body : JSON.stringify(body),
            }),
        stop: async () => {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
            await exited
            fs.rmSync(dir, { recursive: true, force: true })
        },
    }
    await Promise.race([app.waitFor(/Server is running on port/), exited])
    return app
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

module.exports = { createFakePlex, startApp, baseConfig, leaf, stream, englishAudio, subtitle, sleep }
