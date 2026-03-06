const app = require("./app");
const config = require("./config");
const { startTelegramBot } = require("./services/telegramBot");

app.listen(config.port, () => {
  startTelegramBot();
  console.log(`API running on http://localhost:${config.port}`);
});
