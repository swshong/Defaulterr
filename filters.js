const STREAM_TYPES = { video: 1, audio: 2, subtitles: 3 }

// Returns the first stream matching the first filter that matches anything.
// - include: every listed field must exist on the stream and contain every listed value
// - exclude: the stream is rejected if any listed field contains any listed value
// Matching is a case-insensitive substring test. The string "disabled" short-circuits to id 0.
const evaluateStreams = (streams, filters) => {
    for (const filter of Object.values(filters)) {
        if (filter === "disabled") {
            return { id: 0 }
        }

        const { include, exclude } = filter

        const defaultStream = streams.find((stream) => {
            // Check 'include' first
            if (
                include &&
                Object.entries(include).some(([field, value]) => {
                    const streamValue = stream[field]?.toString().toLowerCase()
                    if (!streamValue) return true
                    const valuesArray = Array.isArray(value) ? value : [value]
                    return valuesArray.some((value) => !streamValue.includes(value.toString().toLowerCase()))
                })
            ) {
                return false
            }

            // Check 'exclude'
            if (
                exclude &&
                Object.entries(exclude).some(([field, value]) => {
                    const streamValue = stream[field]?.toString().toLowerCase()
                    if (!streamValue) return false
                    const valuesArray = Array.isArray(value) ? value : [value]
                    return valuesArray.some((value) => streamValue.includes(value.toString().toLowerCase()))
                })
            ) {
                return false
            }

            return true
        })

        if (defaultStream)
            return {
                id: defaultStream.id,
                extendedDisplayTitle: defaultStream.extendedDisplayTitle,
                onMatch: filter.on_match || {},
            }
    }
}

const findMatchingAudioStream = (part, audioFilters) => {
    if (!audioFilters) return

    const audioStreams = part.streams.filter((stream) => stream.streamType === STREAM_TYPES.audio)
    return evaluateStreams(audioStreams, audioFilters)
}

const findMatchingSubtitleStream = (part, subtitleFilters) => {
    if (!subtitleFilters) return
    if (subtitleFilters === "disabled") return { id: 0 }

    const subtitleStreams = part.streams.filter((stream) => stream.streamType === STREAM_TYPES.subtitles)
    return evaluateStreams(subtitleStreams, subtitleFilters)
}

// Resolves the audio and subtitle selection for one part under one group's filters,
// applying on_match overrides. Either side is {} when nothing matched.
const resolveSelection = (part, filters) => {
    let audio = findMatchingAudioStream(part, filters.audio) || {}
    let subtitles = findMatchingSubtitleStream(part, filters.subtitles) || {}

    if (audio?.onMatch?.subtitles) {
        subtitles = findMatchingSubtitleStream(part, audio.onMatch.subtitles) || {}
    }

    if (subtitles?.onMatch?.audio) {
        audio = findMatchingAudioStream(part, subtitles.onMatch.audio) || {}
    }

    return { audio, subtitles }
}

module.exports = {
    STREAM_TYPES,
    evaluateStreams,
    findMatchingAudioStream,
    findMatchingSubtitleStream,
    resolveSelection,
}
