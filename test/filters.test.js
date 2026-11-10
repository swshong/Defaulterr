const { test } = require("node:test")
const assert = require("node:assert/strict")
const { evaluateStreams, resolveSelection } = require("../filters")

const audio = [
    { id: 1, streamType: 2, language: "English", codec: "truehd", extendedDisplayTitle: "English (TRUEHD 7.1)" },
    { id: 2, streamType: 2, language: "English", codec: "aac", extendedDisplayTitle: "English Commentary (AAC)" },
    { id: 3, streamType: 2, language: "Español", codec: "aac", extendedDisplayTitle: "Español (AAC)" },
    { id: 4, streamType: 2, codec: "aac", extendedDisplayTitle: "Unknown track (AAC)" },
    { id: 5, streamType: 2, language: "English", codec: "aac", extendedDisplayTitle: "English (AAC)", channels: 2 },
]
const subs = [
    { id: 11, streamType: 3, language: "English", extendedDisplayTitle: "English SDH", hearingImpaired: true },
    { id: 12, streamType: 3, language: "Español", extendedDisplayTitle: "Español" },
]
const pick = (filters, streams = audio) => evaluateStreams(streams, filters)?.id

test("include: multiple values on one field are ANDed", () => {
    assert.equal(pick([{ include: { language: ["English", "Español"] } }]), undefined)
    assert.equal(pick([{ include: { language: "English" } }]), 1)
})

test("include: every listed field must match", () => {
    assert.equal(pick([{ include: { language: "English", codec: "aac" } }]), 2)
})

test("exclude: any listed value rejects the stream", () => {
    assert.equal(pick([{ include: { language: "English" }, exclude: { codec: ["truehd", "dts"] } }]), 2)
    assert.equal(
        pick([{ include: { language: "English" }, exclude: { codec: ["truehd"], extendedDisplayTitle: "commentary" } }]),
        5
    )
})

test("a stream missing the field never satisfies include, and is never rejected by exclude", () => {
    assert.equal(pick([{ include: { language: "zzz" } }]), undefined)
    assert.equal(pick([{ exclude: { language: ["English", "Español"] } }]), 4)
})

test("matching is a case-insensitive substring test and stringifies non-string fields", () => {
    assert.equal(pick([{ include: { language: "engl" } }]), 1)
    assert.equal(pick([{ include: { channels: "2" } }]), 5)
    assert.equal(pick([{ include: { hearingImpaired: "true" } }], subs), 11)
})

test("filters are tried in order and the first that matches anything wins", () => {
    assert.equal(pick([{ include: { language: "Español" } }, { include: { language: "English" } }]), 3)
    assert.equal(pick([{ include: { language: "Klingon" } }, { include: { language: "English" } }]), 1)
})

test("'disabled' as a list element yields id 0", () => {
    assert.equal(pick([{ include: { language: "Klingon" } }, "disabled"], subs), 0)
})

test("no filter matching returns undefined", () => {
    assert.equal(evaluateStreams(audio, [{ include: { language: "Klingon" } }]), undefined)
})

test("resolveSelection: plain audio + subtitle rules", () => {
    const part = { streams: [...audio, ...subs] }
    const { audio: a, subtitles: s } = resolveSelection(part, {
        audio: [{ include: { language: "English" }, exclude: { codec: "truehd", extendedDisplayTitle: "commentary" } }],
        subtitles: [{ include: { language: "English" } }],
    })
    assert.equal(a.id, 5)
    assert.equal(s.id, 11)
})

test("resolveSelection: subtitles: disabled turns subtitles off and leaves audio unset", () => {
    const { audio: a, subtitles: s } = resolveSelection({ streams: [...audio, ...subs] }, { subtitles: "disabled" })
    assert.equal(a.id, undefined)
    assert.equal(s.id, 0)
})

test("resolveSelection: audio on_match drives the subtitle choice", () => {
    const part = { streams: [...audio, ...subs] }
    const filters = {
        audio: [
            { include: { language: "Klingon" }, on_match: { subtitles: "disabled" } },
            { include: { language: "Español" }, on_match: { subtitles: [{ include: { language: "English" } }] } },
        ],
        subtitles: [{ include: { language: "Español" } }],
    }
    const { audio: a, subtitles: s } = resolveSelection(part, filters)
    assert.equal(a.id, 3)
    assert.equal(s.id, 11)
})

test("resolveSelection: an on_match sub-filter that matches nothing does not throw", () => {
    const part = { streams: [...audio, ...subs] }
    const { audio: a, subtitles: s } = resolveSelection(part, {
        audio: [{ include: { language: "English" }, on_match: { subtitles: [{ include: { language: "Klingon" } }] } }],
    })
    assert.equal(a.id, 1)
    assert.equal(s.id, undefined)
})
