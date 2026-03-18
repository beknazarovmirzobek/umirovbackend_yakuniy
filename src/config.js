const dotenv = require("dotenv");

dotenv.config();

function parseCsv(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBoolean(value, defaultValue = false) {
  if (value == null || value === "") return defaultValue;

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

const LOCKED_ADAPTIVE_QUIZ_TOPIC =
  "AXBOROTLI TA'LIM MUHITIDA AMALIY MASHG'ULOTLARNI O'TISH METODIKASI";

const config = {
  port: process.env.PORT || 4000,
  db: {
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "myproject_db",
  },
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || "dev_access_secret",
    refreshSecret: process.env.JWT_REFRESH_SECRET || "dev_refresh_secret",
    accessTtl: process.env.ACCESS_TOKEN_TTL || "15m",
    refreshTtlDays: Number(process.env.REFRESH_TOKEN_TTL_DAYS || 7),
  },
  clientOrigin: process.env.CLIENT_ORIGIN || "https://tyutorkpi.sies.uz",
  serverUrl: process.env.SERVER_URL || "https://tyutorkpi.sies.uz/umirov",
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || "",
    chatIds: parseCsv(process.env.TELEGRAM_CHAT_IDS),
    pollingEnabled: parseBoolean(process.env.TELEGRAM_BOT_POLLING_ENABLED, true),
    pollIntervalMs: Number(process.env.TELEGRAM_BOT_POLL_INTERVAL_MS || 1500),
    commandKey: process.env.TELEGRAM_BOT_COMMAND_KEY || "@umirov",
  },
  adaptiveQuiz: {
    provider: "gemini",
    courseTitle: LOCKED_ADAPTIVE_QUIZ_TOPIC,
    lockedTopic: LOCKED_ADAPTIVE_QUIZ_TOPIC,
    geminiApiKey: process.env.GEMINI_API_KEY || "",
    geminiModel: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    requestTimeoutMs: Number(process.env.GEMINI_TIMEOUT_MS || 25000),
    minDifficulty: 1,
    maxDifficulty: 5,
    startDifficulty: 2,
  },
};

module.exports = config;
