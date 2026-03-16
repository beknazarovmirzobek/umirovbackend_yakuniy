const config = require("../config");
const { pool } = require("../db");
const {
  ensureStudentCredentialsTable,
  listStudentCredentialsByLookup,
} = require("./studentCredentials");

const TELEGRAM_API_URL = "https://api.telegram.org";
const POLLING_LOCK_NAME = "umirov_telegram_polling";

let started = false;
let starting = false;
let polling = false;
let lastUpdateId = 0;
let pollTimer = null;
let lockConnection = null;
let activePollController = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildStudentMessage(title, student) {
  const fullName =
    [student.firstName, student.lastName].filter(Boolean).join(" ").trim() ||
    student.username;
  const passwordText = student.password
    ? `<code>${escapeHtml(student.password)}</code>`
    : "Topilmadi (reset qilish kerak)";
  const statusText = student.mustChangePassword ? "Parolni almashtirishi kerak" : "Faol";
  return [
    escapeHtml(title),
    `F.I.SH: ${escapeHtml(fullName)}`,
    `Login: <code>${escapeHtml(student.username)}</code>`,
    `Parol: ${passwordText}`,
    `Holat: ${escapeHtml(statusText)}`,
  ].join("\n");
}

function buildCopyKeyboard(student) {
  const inlineKeyboard = [
    [
      {
        text: "Login nusxalash",
        copy_text: { text: student.username },
      },
    ],
  ];
  if (student.password) {
    inlineKeyboard.push([
      {
        text: "Parol nusxalash",
        copy_text: { text: student.password },
      },
    ]);
  }
  return { inline_keyboard: inlineKeyboard };
}

function getAllowedChatIdSet() {
  return new Set((config.telegram.chatIds || []).map((id) => String(id)));
}

function isAllowedChat(chatId) {
  const allowed = getAllowedChatIdSet();
  if (!allowed.size) return false;
  return allowed.has(String(chatId));
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseLookupFromMessage(text) {
  const raw = String(text || "").trim();
  const commandKey = String(config.telegram.commandKey || "@umirov").trim();
  if (!raw || !commandKey) return { isCommand: false, lookupText: "" };

  const escapedKey = escapeRegExp(commandKey);
  const withLookup = raw.match(
    new RegExp(`(?:^|\\s)${escapedKey}(?:\\s+|\\s*[:,-]\\s*)(.+)$`, "i")
  );
  if (withLookup) {
    return {
      isCommand: true,
      lookupText: withLookup[1].trim().replace(/\s+/g, " "),
    };
  }

  const keyOnly = new RegExp(`(?:^|\\s)${escapedKey}(?:\\s*)$`, "i");
  return {
    isCommand: keyOnly.test(raw),
    lookupText: "",
  };
}

function isHelpMessage(text) {
  const raw = String(text || "").trim().toLowerCase();
  return raw === "/start" || raw === "/help" || /^\/(start|help)@/i.test(raw);
}

function buildUsageText() {
  const commandKey = escapeHtml(config.telegram.commandKey || "@umirov");
  return [
    "Talaba login/parolini olish uchun quyidagicha yuboring:",
    `<code>${commandKey} ism familya</code>`,
    `Masalan: <code>${commandKey} mirzobek</code>`,
    `Yoki: <code>${commandKey} Mirzobek Beknazarov</code>`,
  ].join("\n");
}

async function telegramApi(method, payload, options = {}) {
  if (!config.telegram.token) {
    throw new Error("TELEGRAM_BOT_TOKEN topilmadi.");
  }

  const response = await fetch(
    `${TELEGRAM_API_URL}/bot${config.telegram.token}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      ...options,
    }
  );

  const body = await response.json();
  if (!response.ok || !body.ok) {
    const message = body?.description || `Telegram API xatolik: ${method}`;
    const error = new Error(message);
    error.code = body?.error_code || response.status;
    throw error;
  }
  return body.result;
}

async function sendMessage(chatId, text, keyboard) {
  const payload = {
    chat_id: String(chatId),
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (keyboard) payload.reply_markup = keyboard;

  try {
    await telegramApi("sendMessage", payload);
  } catch (err) {
    if (!keyboard) throw err;
    // copy_text ayrim eski Telegram klientlarda ishlamasligi mumkin
    await telegramApi("sendMessage", {
      chat_id: String(chatId),
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  }
}

async function sendStudentCredentials(chatId, title, student) {
  const text = buildStudentMessage(title, student);
  const keyboard = buildCopyKeyboard(student);
  await sendMessage(chatId, text, keyboard?.inline_keyboard?.length ? keyboard : null);
}

function isPollingConflictError(err) {
  return (
    Number(err?.code) === 409 ||
    /terminated by other getUpdates request/i.test(String(err?.message || ""))
  );
}

async function acquirePollingLock() {
  if (lockConnection) return true;

  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.query("SELECT GET_LOCK(?, 0) AS acquired", [
      POLLING_LOCK_NAME,
    ]);
    const acquired = Number(rows?.[0]?.acquired) === 1;
    if (!acquired) {
      connection.release();
      return false;
    }

    lockConnection = connection;
    return true;
  } catch (err) {
    connection.release();
    throw err;
  }
}

async function releasePollingLock() {
  if (!lockConnection) return;

  const connection = lockConnection;
  lockConnection = null;

  try {
    await connection.query("SELECT RELEASE_LOCK(?)", [POLLING_LOCK_NAME]);
  } catch (err) {
    console.error("Telegram polling lockni bo'shatishda xatolik:", err.message);
  } finally {
    connection.release();
  }
}

async function clearWebhook() {
  try {
    await telegramApi("deleteWebhook", {
      drop_pending_updates: false,
    });
  } catch (err) {
    console.warn("Telegram webhookni o'chirib bo'lmadi:", err.message);
  }
}

async function handleIncomingMessage(message) {
  if (!message || !message.text) return;
  const chatId = message?.chat?.id;
  if (!chatId || !isAllowedChat(chatId)) return;

  if (isHelpMessage(message.text)) {
    await sendMessage(chatId, buildUsageText(), null);
    return;
  }

  const command = parseLookupFromMessage(message.text);
  if (!command.isCommand) return;
  if (!command.lookupText) {
    await sendMessage(chatId, buildUsageText(), null);
    return;
  }

  const students = await listStudentCredentialsByLookup(command.lookupText, 20);
  if (!students.length) {
    await sendMessage(
      chatId,
      `${escapeHtml(command.lookupText)} bo'yicha login/parol topilmadi.`,
      null
    );
    return;
  }

  if (students.length > 1) {
    await sendMessage(
      chatId,
      `${students.length} ta talaba topildi: ${escapeHtml(command.lookupText)}`,
      null
    );
  }

  for (let i = 0; i < students.length; i += 1) {
    const student = students[i];
    const title =
      students.length > 1 ? `Talaba ma'lumoti (${i + 1}/${students.length})` : "Talaba ma'lumoti";
    await sendStudentCredentials(chatId, title, student);
  }
}

async function pollUpdates() {
  if (!started || polling) return;
  polling = true;
  try {
    activePollController =
      typeof AbortController === "function" ? new AbortController() : null;
    const updates = await telegramApi("getUpdates", {
      offset: lastUpdateId,
      timeout: 25,
      allowed_updates: ["message"],
    }, activePollController ? { signal: activePollController.signal } : {});

    for (const update of updates) {
      if (typeof update.update_id === "number") {
        lastUpdateId = update.update_id + 1;
      }
      if (update.message) {
        try {
          await handleIncomingMessage(update.message);
        } catch (err) {
          console.error("Telegram xabarini qayta ishlashda xatolik:", err.message);
        }
      }
    }
  } catch (err) {
    if (err?.name === "AbortError") {
      return;
    }
    if (isPollingConflictError(err)) {
      console.error(
        "Telegram polling to'xtatildi: boshqa bot instance getUpdates ishlatyapti."
      );
      await stopTelegramBot();
      return;
    }
    console.error("Telegram polling xatoligi:", err.message);
  } finally {
    activePollController = null;
    polling = false;
  }
}

async function startTelegramBot() {
  if (started || starting) return;
  if (!config.telegram.token) {
    console.warn("TELEGRAM_BOT_TOKEN yo'q. Telegram bot ishga tushmadi.");
    return;
  }
  if (!config.telegram.pollingEnabled) {
    console.log("Telegram polling o'chirilgan. Joriy instance getUpdates ishlatmaydi.");
    return;
  }
  if (typeof fetch !== "function") {
    console.warn("Node fetch qo'llab-quvvatlanmadi. Telegram bot ishga tushmadi.");
    return;
  }

  starting = true;
  try {
    const hasLock = await acquirePollingLock();
    if (!hasLock) {
      console.warn(
        "Telegram polling boshqa backend instance tomonidan band. Joriy instance polling qilmaydi."
      );
      return;
    }

    await ensureStudentCredentialsTable();
    await clearWebhook();

    started = true;
    void pollUpdates();
    const interval = Math.max(1000, Number(config.telegram.pollIntervalMs || 1500));
    pollTimer = setInterval(() => {
      void pollUpdates();
    }, interval);

    console.log("Telegram bot ishga tushdi.");
  } catch (err) {
    console.error("Telegram botni ishga tushirib bo'lmadi:", err.message);
    await releasePollingLock();
  } finally {
    starting = false;
  }
}

async function sendNewStudentNotification(student) {
  if (typeof fetch !== "function") return;
  if (!config.telegram.token) return;
  if (!config.telegram.chatIds?.length) return;

  for (const chatId of config.telegram.chatIds) {
    try {
      await sendStudentCredentials(chatId, "Yangi talaba qo'shildi", student);
    } catch (err) {
      console.error(`Telegramga xabar yuborib bo'lmadi (chat_id: ${chatId}):`, err.message);
    }
  }
}

async function stopTelegramBot() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (activePollController) {
    activePollController.abort();
    activePollController = null;
  }
  started = false;
  starting = false;
  await releasePollingLock();
}

module.exports = {
  startTelegramBot,
  stopTelegramBot,
  sendNewStudentNotification,
};
