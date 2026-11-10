const path = require("path")
const winston = require("winston")
const DailyRotateFile = require("winston-daily-rotate-file")

const logLevel = process.env.LOG_LEVEL || "info"
const filePath = process.argv[2] || "./logs"

const logger = winston.createLogger({
    level: logLevel,
    format: winston.format.combine(
        winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
        winston.format.printf(({ timestamp, level, message }) => {
            // Titles and other values from Plex end up in messages. Collapse control characters
            // so nothing in them can start a new line and pass itself off as a log entry.
            // eslint-disable-next-line no-control-regex
            const safe = String(message).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
            return `${timestamp} [${level.toUpperCase()}]: ${safe}`
        })
    ),
    transports: [
        new winston.transports.Console(),
        new DailyRotateFile({
            filename: path.join(filePath, "defaulterr-%DATE%.log"),
            datePattern: "YYYY-MM-DD",
            maxSize: "500k",
            maxFiles: "7d",
        }),
    ],
})

module.exports = logger
