const app = require("./app");
const config = require("./config");
const { ping, isDatabaseConnectionError } = require("./db");
const { startTelegramBot, stopTelegramBot } = require("./services/telegramBot");

const server = app.listen(config.port, () => {
  void ping()
    .then(() => {
      console.log(
        `Database connected to ${config.db.host}:${config.db.port}/${config.db.database}`
      );
    })
    .catch((err) => {
      if (isDatabaseConnectionError(err)) {
        console.error(
          `Database unavailable at ${config.db.host}:${config.db.port}/${config.db.database}. Start MySQL and import backend/schema.sql.`
        );
        return;
      }
      console.error("Database check failed:", err);
    });
  void startTelegramBot();
  console.log(`API running on http://localhost:${config.port}`);
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`${signal} qabul qilindi. Server to'xtatilmoqda...`);

  try {
    await stopTelegramBot();
  } catch (err) {
    console.error("Telegram botni to'xtatishda xatolik:", err.message);
  }

  server.close((err) => {
    if (err) {
      console.error("HTTP serverni to'xtatishda xatolik:", err.message);
      process.exit(1);
      return;
    }
    process.exit(0);
  });
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
