const express = require("express");
const { z } = require("zod");
const { v4: uuid } = require("uuid");

const { query } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

const DEFAULT_RANDOM_QUESTION_COUNT = 30;
const MAX_TEXT_ANSWER_LENGTH = 1000;
const MAX_TIME_LIMIT_MINUTES = 720;
const PASSING_PERCENTAGE = 60;
const DEVICE_HEADER = "x-test-device-id";

const questionContentSchema = z.union([
  z.string().min(1),
  z.object({
    type: z.enum(["TEXT", "IMAGE"]),
    value: z.string().min(1),
  }),
]);

const questionSchema = z
  .object({
    type: z.enum(["single", "multi", "text"]).optional(),
    prompt: questionContentSchema,
    options: z.array(questionContentSchema).optional(),
    correctOption: z.number().int().min(0).optional(),
    correctOptions: z.array(z.number().int().min(0)).optional(),
    correctText: z.string().optional(),
    points: z.number().int().min(1).default(1),
  })
  .superRefine((value, ctx) => {
    const hasCorrectText =
      typeof value.correctText === "string" && value.correctText.trim().length > 0;
    const hasCorrectOptions =
      Array.isArray(value.correctOptions) && value.correctOptions.length > 0;
    const type =
      value.type === "text"
        ? "text"
        : value.type === "multi"
        ? "multi"
        : value.type === "single"
        ? "single"
        : hasCorrectText
        ? "text"
        : hasCorrectOptions && value.correctOptions.length > 1
        ? "multi"
        : "single";
    if (type === "text") {
      if (typeof value.correctText !== "string" || !value.correctText.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Yozma savol uchun correctText majburiy",
        });
      }
      return;
    }

    if (!Array.isArray(value.options) || value.options.length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Variantli savolda kamida 2 ta variant bo'lishi kerak",
      });
      return;
    }

    if (type === "multi") {
      if (!Array.isArray(value.correctOptions) || !value.correctOptions.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Ko'p javobli savolda correctOptions majburiy",
        });
        return;
      }

      const seen = new Set();
      for (const correctIndex of value.correctOptions) {
        if (!Number.isInteger(correctIndex)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "correctOptions faqat butun indekslardan iborat bo'lishi kerak",
          });
          return;
        }
        if (correctIndex < 0 || correctIndex >= value.options.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "correctOptions ichida diapazondan tashqari indeks bor",
          });
          return;
        }
        if (seen.has(correctIndex)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "correctOptions ichida takrorlangan indeks bo'lmasligi kerak",
          });
          return;
        }
        seen.add(correctIndex);
      }
      return;
    }

    const fallbackCorrectOption =
      Array.isArray(value.correctOptions) && value.correctOptions.length === 1
        ? value.correctOptions[0]
        : null;
    const correctOption =
      typeof value.correctOption === "number" ? value.correctOption : fallbackCorrectOption;
    if (typeof correctOption !== "number") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Bitta javobli savolda correctOption majburiy",
      });
      return;
    }
    if (correctOption < 0 || correctOption >= value.options.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "correctOption diapazondan tashqarida",
      });
    }
  });

const createSchema = z
  .object({
    subjectId: z.string().min(1).nullable().optional(),
    title: z.string().min(1),
    description: z.string().default(""),
    deadline: z.string().min(1),
    maxScore: z.number().int().min(1).max(100).default(100),
    questions: z.array(questionSchema).min(1),
    questionSampleSize: z.number().int().min(1).optional(),
    timeLimitMinutes: z.number().int().min(1).max(MAX_TIME_LIMIT_MINUTES).optional(),
    targetType: z.enum(["GROUP", "STUDENT"]).optional(),
    targetId: z.string().nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.targetType && !value.targetId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "targetType tanlansa targetId ham majburiy",
      });
    }
  });

const submitSchema = z.object({
  answers: z.array(
    z.union([z.number().int().min(0), z.array(z.number().int().min(0)), z.string(), z.null()])
  ),
});

const grantPermissionSchema = z.object({
  studentId: z.string().min(1),
  attempts: z.number().int().min(1).max(20).optional().default(1),
});

let ensureSessionTablePromise = null;
let ensurePermissionTablePromise = null;
let ensureAttemptTablePromise = null;

function parseJson(raw, fallback) {
  if (raw == null) return fallback;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }
  return raw;
}

function normalizeQuestionContent(rawContent) {
  if (typeof rawContent === "string") {
    const value = rawContent.trim();
    if (!value) return null;
    return { type: "TEXT", value };
  }

  if (!rawContent || typeof rawContent !== "object" || Array.isArray(rawContent)) {
    return null;
  }

  const type = rawContent.type === "IMAGE" ? "IMAGE" : "TEXT";
  const value = typeof rawContent.value === "string" ? rawContent.value.trim() : "";
  if (!value) return null;
  return { type, value };
}

function normalizeStoredTestSettings(rawSettings) {
  if (!rawSettings || typeof rawSettings !== "object" || Array.isArray(rawSettings)) {
    return { questionSampleSize: null, timeLimitMinutes: null };
  }

  const questionSampleSize =
    Number.isInteger(rawSettings.questionSampleSize) && rawSettings.questionSampleSize > 0
      ? Number(rawSettings.questionSampleSize)
      : null;
  const timeLimitMinutes =
    Number.isInteger(rawSettings.timeLimitMinutes) &&
    rawSettings.timeLimitMinutes > 0 &&
    rawSettings.timeLimitMinutes <= MAX_TIME_LIMIT_MINUTES
      ? Number(rawSettings.timeLimitMinutes)
      : null;

  return { questionSampleSize, timeLimitMinutes };
}

function parseTestPayload(rawQuestions) {
  const parsed = parseJson(rawQuestions, []);
  if (Array.isArray(parsed)) {
    return { rawQuestionList: parsed, rawSettings: null };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { rawQuestionList: [], rawSettings: null };
  }

  const rawQuestionList = Array.isArray(parsed.items)
    ? parsed.items
    : Array.isArray(parsed.questions)
    ? parsed.questions
    : [];
  const rawSettings =
    parsed.settings && typeof parsed.settings === "object" && !Array.isArray(parsed.settings)
      ? parsed.settings
      : null;

  return { rawQuestionList, rawSettings };
}

function normalizeRuntimeTestSettings(rawSettings, questionCount) {
  const normalized = normalizeStoredTestSettings(rawSettings);
  return {
    questionSampleSize:
      normalized.questionSampleSize == null
        ? null
        : Math.max(1, Math.min(normalized.questionSampleSize, questionCount)),
    timeLimitMinutes: normalized.timeLimitMinutes,
  };
}

function parseTestSettings(rawQuestions, questionCount) {
  const payload = parseTestPayload(rawQuestions);
  return normalizeRuntimeTestSettings(payload.rawSettings, questionCount);
}

function normalizeCorrectOptions(rawCorrectOptions, optionsLength) {
  if (!Array.isArray(rawCorrectOptions)) return [];

  const normalized = [];
  const seen = new Set();
  for (const rawIndex of rawCorrectOptions) {
    const index = Number(rawIndex);
    if (!Number.isInteger(index)) continue;
    if (index < 0 || index >= optionsLength) continue;
    if (seen.has(index)) continue;
    seen.add(index);
    normalized.push(index);
  }
  return normalized;
}

function normalizeQuestion(rawQuestion) {
  if (!rawQuestion || typeof rawQuestion !== "object" || Array.isArray(rawQuestion)) {
    return null;
  }

  const prompt = normalizeQuestionContent(rawQuestion.prompt);
  const points = Number.isInteger(rawQuestion.points) ? Number(rawQuestion.points) : 1;
  const hasCorrectText =
    typeof rawQuestion.correctText === "string" && rawQuestion.correctText.trim().length > 0;
  const rawType =
    rawQuestion.type === "text" || rawQuestion.type === "single" || rawQuestion.type === "multi"
      ? rawQuestion.type
      : null;

  if (!prompt) return null;

  if (rawType === "text" || (!rawType && hasCorrectText)) {
    const correctText =
      typeof rawQuestion.correctText === "string"
        ? rawQuestion.correctText.trim().slice(0, MAX_TEXT_ANSWER_LENGTH)
        : "";
    if (!correctText) return null;
    return {
      type: "text",
      prompt,
      options: [],
      correctText,
      points: points > 0 ? points : 1,
    };
  }

  const rawOptions = Array.isArray(rawQuestion.options) ? rawQuestion.options : [];
  const options = rawOptions.map(normalizeQuestionContent).filter(Boolean);
  const fallbackCorrectOption = Number.isInteger(rawQuestion.correctOption)
    ? Number(rawQuestion.correctOption)
    : null;

  if (options.length < 2) return null;
  const normalizedCorrectOptions = normalizeCorrectOptions(rawQuestion.correctOptions, options.length);
  const isFallbackValid =
    typeof fallbackCorrectOption === "number" &&
    fallbackCorrectOption >= 0 &&
    fallbackCorrectOption < options.length;
  const shouldBeMulti = rawType === "multi" || normalizedCorrectOptions.length > 1;

  if (shouldBeMulti) {
    if (normalizedCorrectOptions.length > 1) {
      return {
        type: "multi",
        prompt,
        options,
        correctOptions: normalizedCorrectOptions,
        points: points > 0 ? points : 1,
      };
    }

    if (normalizedCorrectOptions.length === 1) {
      return {
        type: "single",
        prompt,
        options,
        correctOption: normalizedCorrectOptions[0],
        points: points > 0 ? points : 1,
      };
    }

    if (isFallbackValid) {
      return {
        type: "single",
        prompt,
        options,
        correctOption: fallbackCorrectOption,
        points: points > 0 ? points : 1,
      };
    }

    return null;
  }

  const correctOption =
    isFallbackValid
      ? fallbackCorrectOption
      : normalizedCorrectOptions.length === 1
      ? normalizedCorrectOptions[0]
      : null;
  if (correctOption == null) return null;

  return {
    type: "single",
    prompt,
    options,
    correctOption,
    points: points > 0 ? points : 1,
  };
}

function parseQuestions(rawQuestions) {
  const payload = parseTestPayload(rawQuestions);
  if (!Array.isArray(payload.rawQuestionList)) return [];
  const normalized = [];
  for (const rawQuestion of payload.rawQuestionList) {
    const question = normalizeQuestion(rawQuestion);
    if (question) normalized.push(question);
  }
  return normalized;
}

function createQuestionsPayload(questions, settings) {
  const normalizedSettings = normalizeStoredTestSettings(settings);
  if (
    normalizedSettings.questionSampleSize == null &&
    normalizedSettings.timeLimitMinutes == null
  ) {
    return questions;
  }

  return {
    version: 2,
    items: questions,
    settings: normalizedSettings,
  };
}

function sanitizeQuestionsForStudent(rawQuestions) {
  return rawQuestions.map((question) => {
    if (question.type === "text") {
      return {
        type: "text",
        prompt: question.prompt,
        options: [],
        points: question.points,
      };
    }
    if (question.type === "multi") {
      return {
        type: "multi",
        prompt: question.prompt,
        options: question.options,
        points: question.points,
      };
    }
    return {
      type: "single",
      prompt: question.prompt,
      options: question.options,
      points: question.points,
    };
  });
}

function getQuestionSampleSize(questionCount, preferredSampleSize = null) {
  if (!Number.isInteger(questionCount) || questionCount <= 0) return 0;
  if (Number.isInteger(preferredSampleSize) && preferredSampleSize > 0) {
    return Math.min(preferredSampleSize, questionCount);
  }
  return Math.min(DEFAULT_RANDOM_QUESTION_COUNT, questionCount);
}

function normalizeAnswerTextForCompare(value) {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function calculateTimeRemainingSeconds(startedAt, timeLimitMinutes) {
  if (!Number.isInteger(timeLimitMinutes) || timeLimitMinutes <= 0) return null;
  if (!(startedAt instanceof Date) || Number.isNaN(startedAt.getTime())) return null;
  const limitMs = timeLimitMinutes * 60 * 1000;
  const elapsedMs = Date.now() - startedAt.getTime();
  return Math.max(0, Math.ceil((limitMs - elapsedMs) / 1000));
}

function getExpiredTimeLimitMessage() {
  return "Bu test uchun vaqt tugagan. Testga kirib bo'lmaydi.";
}

function mapTest(row, includeCorrectOptions, options = {}) {
  const allQuestions = Array.isArray(options.allQuestions)
    ? options.allQuestions
    : parseQuestions(row.questions);
  const settings =
    options.settings && typeof options.settings === "object"
      ? options.settings
      : parseTestSettings(row.questions, allQuestions.length);
  const selectedQuestions = Array.isArray(options.selectedQuestions)
    ? options.selectedQuestions
    : allQuestions;
  const questions = includeCorrectOptions
    ? selectedQuestions
    : sanitizeQuestionsForStudent(selectedQuestions);

  return {
    id: row.id,
    subjectId: row.subject_id,
    teacherId: row.teacher_id,
    title: row.title,
    description: row.description,
    deadline: row.deadline,
    maxScore: Number(row.max_score),
    questions,
    questionPoolSize: allQuestions.length,
    questionSampleSize:
      typeof options.questionSampleSize === "number"
        ? options.questionSampleSize
        : getQuestionSampleSize(allQuestions.length, settings.questionSampleSize),
    timeLimitMinutes:
      typeof options.timeLimitMinutes === "number"
        ? options.timeLimitMinutes
        : settings.timeLimitMinutes,
    timeRemainingSeconds:
      typeof options.timeRemainingSeconds === "number" ? options.timeRemainingSeconds : undefined,
    targetType: row.target_type ?? null,
    targetId: row.target_id ?? null,
    teacherName:
      [row.teacher_first_name, row.teacher_last_name].filter(Boolean).join(" ") || null,
    attemptCount:
      row.attempt_count == null ? undefined : Number(row.attempt_count),
    attemptNumber:
      row.attempt_number == null ? undefined : Math.max(1, Number(row.attempt_number) || 1),
    attemptScore:
      row.attempt_score == null ? undefined : Number(row.attempt_score),
    correctCount:
      row.correct_count == null ? undefined : Math.max(0, Number(row.correct_count) || 0),
    questionCount:
      row.question_count == null ? undefined : Math.max(0, Number(row.question_count) || 0),
    percentage:
      row.percentage == null ? undefined : Math.max(0, Math.min(100, Number(row.percentage) || 0)),
    passed:
      row.passed == null ? undefined : Boolean(Number(row.passed)),
    attemptSubmittedAt: row.attempt_submitted_at ?? undefined,
    permissionRemainingAttempts:
      typeof options.permissionRemainingAttempts === "number"
        ? options.permissionRemainingAttempts
        : row.permission_remaining_attempts == null
        ? undefined
        : Number(row.permission_remaining_attempts),
    entryBlockedReason:
      typeof options.entryBlockedReason === "string" ? options.entryBlockedReason : undefined,
    createdAt: row.created_at,
  };
}

function mapAttempt(row) {
  return {
    id: row.id,
    testId: row.test_id,
    studentId: row.student_id,
    studentName:
      [row.student_first_name, row.student_last_name].filter(Boolean).join(" ") || null,
    answers: parseJson(row.answers, []),
    score: Number(row.score),
    questionOrder: parseJson(row.question_order, []),
    optionOrders: parseJson(row.option_orders, []),
    attemptNumber:
      row.attempt_number == null ? undefined : Math.max(1, Number(row.attempt_number) || 1),
    correctCount:
      row.correct_count == null ? undefined : Math.max(0, Number(row.correct_count) || 0),
    questionCount:
      row.question_count == null ? undefined : Math.max(0, Number(row.question_count) || 0),
    percentage:
      row.percentage == null ? undefined : Math.max(0, Math.min(100, Number(row.percentage) || 0)),
    passed:
      row.passed == null ? undefined : Boolean(Number(row.passed)),
    submittedAt: row.submitted_at,
  };
}

function mapPermission(row) {
  return {
    studentId: row.student_id,
    studentName:
      [row.student_first_name, row.student_last_name].filter(Boolean).join(" ") || null,
    remainingAttempts: Number(row.remaining_attempts || 0),
    attemptScore: row.attempt_score == null ? null : Number(row.attempt_score),
    attemptNumber:
      row.attempt_number == null ? null : Math.max(1, Number(row.attempt_number) || 1),
    correctCount:
      row.correct_count == null ? null : Math.max(0, Number(row.correct_count) || 0),
    questionCount:
      row.question_count == null ? null : Math.max(0, Number(row.question_count) || 0),
    percentage:
      row.percentage == null ? null : Math.max(0, Math.min(100, Number(row.percentage) || 0)),
    passed: row.passed == null ? null : Boolean(Number(row.passed)),
    attemptSubmittedAt: row.attempt_submitted_at ?? null,
    grantedAt: row.granted_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

async function ensureTestSessionTable() {
  if (!ensureSessionTablePromise) {
    ensureSessionTablePromise = query(
      "CREATE TABLE IF NOT EXISTS test_sessions (id CHAR(36) PRIMARY KEY, test_id CHAR(36) NOT NULL, student_id CHAR(36) NOT NULL, device_id VARCHAR(128) NOT NULL, question_order JSON NOT NULL, started_at DATETIME NOT NULL, updated_at DATETIME NOT NULL, UNIQUE KEY uq_test_session (test_id, student_id), FOREIGN KEY (test_id) REFERENCES tests(id), FOREIGN KEY (student_id) REFERENCES users(id))"
    );
  }
  await ensureSessionTablePromise;
}

async function ensureTestAttemptTable() {
  if (!ensureAttemptTablePromise) {
    ensureAttemptTablePromise = (async () => {
      await query(
        "CREATE TABLE IF NOT EXISTS test_attempts (id CHAR(36) PRIMARY KEY, test_id CHAR(36) NOT NULL, student_id CHAR(36) NOT NULL, attempt_number INT NOT NULL DEFAULT 1, answers JSON NOT NULL, question_order JSON NULL, option_orders JSON NULL, score INT NOT NULL, correct_count INT NOT NULL DEFAULT 0, question_count INT NOT NULL DEFAULT 0, percentage INT NOT NULL DEFAULT 0, passed TINYINT(1) NOT NULL DEFAULT 0, submitted_at DATETIME NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (test_id) REFERENCES tests(id), FOREIGN KEY (student_id) REFERENCES users(id))"
      );

      const columns = await query("SHOW COLUMNS FROM test_attempts");
      const columnNames = new Set(columns.map((column) => column.Field));
      const alterStatements = [];

      if (!columnNames.has("attempt_number")) {
        alterStatements.push(
          "ADD COLUMN attempt_number INT NOT NULL DEFAULT 1 AFTER student_id"
        );
      }
      if (!columnNames.has("question_order")) {
        alterStatements.push("ADD COLUMN question_order JSON NULL AFTER answers");
      }
      if (!columnNames.has("option_orders")) {
        alterStatements.push("ADD COLUMN option_orders JSON NULL AFTER question_order");
      }
      if (!columnNames.has("correct_count")) {
        alterStatements.push(
          "ADD COLUMN correct_count INT NOT NULL DEFAULT 0 AFTER score"
        );
      }
      if (!columnNames.has("question_count")) {
        alterStatements.push(
          "ADD COLUMN question_count INT NOT NULL DEFAULT 0 AFTER correct_count"
        );
      }
      if (!columnNames.has("percentage")) {
        alterStatements.push("ADD COLUMN percentage INT NOT NULL DEFAULT 0 AFTER question_count");
      }
      if (!columnNames.has("passed")) {
        alterStatements.push("ADD COLUMN passed TINYINT(1) NOT NULL DEFAULT 0 AFTER percentage");
      }

      if (alterStatements.length) {
        await query(`ALTER TABLE test_attempts ${alterStatements.join(", ")}`);
      }

      const indexes = await query("SHOW INDEX FROM test_attempts");
      const indexNames = new Set(indexes.map((index) => index.Key_name));
      const followUpStatements = [];

      if (indexNames.has("uq_test_attempt")) {
        followUpStatements.push("DROP INDEX uq_test_attempt");
      }
      if (!indexNames.has("uq_test_attempt_number")) {
        followUpStatements.push(
          "ADD UNIQUE INDEX uq_test_attempt_number (test_id, student_id, attempt_number)"
        );
      }
      if (!indexNames.has("idx_test_attempts_lookup")) {
        followUpStatements.push(
          "ADD INDEX idx_test_attempts_lookup (test_id, student_id, submitted_at)"
        );
      }

      if (followUpStatements.length) {
        await query(`ALTER TABLE test_attempts ${followUpStatements.join(", ")}`);
      }
    })().catch((error) => {
      ensureAttemptTablePromise = null;
      throw error;
    });
  }
  await ensureAttemptTablePromise;
}

async function ensureTestPermissionTable() {
  if (!ensurePermissionTablePromise) {
    ensurePermissionTablePromise = query(
      "CREATE TABLE IF NOT EXISTS test_permissions (id CHAR(36) PRIMARY KEY, test_id CHAR(36) NOT NULL, student_id CHAR(36) NOT NULL, granted_by CHAR(36) NOT NULL, remaining_attempts INT NOT NULL DEFAULT 0, granted_at DATETIME NOT NULL, updated_at DATETIME NOT NULL, UNIQUE KEY uq_test_permission (test_id, student_id), FOREIGN KEY (test_id) REFERENCES tests(id), FOREIGN KEY (student_id) REFERENCES users(id), FOREIGN KEY (granted_by) REFERENCES users(id))"
    );
  }
  await ensurePermissionTablePromise;
}

async function getRemainingAttempts(testId, studentId) {
  await ensureTestPermissionTable();
  const rows = await query(
    "SELECT remaining_attempts FROM test_permissions WHERE test_id = ? AND student_id = ?",
    [testId, studentId]
  );
  if (!rows[0]) return 0;
  const remainingAttempts = Number(rows[0].remaining_attempts);
  return Number.isFinite(remainingAttempts) && remainingAttempts > 0 ? remainingAttempts : 0;
}

function getLatestAttemptJoinSql(alias = "ta") {
  return `LEFT JOIN (
    SELECT attempt_rows.*
    FROM test_attempts attempt_rows
    INNER JOIN (
      SELECT test_id, student_id, MAX(attempt_number) AS max_attempt_number
      FROM test_attempts
      GROUP BY test_id, student_id
    ) latest_attempts
      ON latest_attempts.test_id = attempt_rows.test_id
     AND latest_attempts.student_id = attempt_rows.student_id
     AND latest_attempts.max_attempt_number = attempt_rows.attempt_number
  ) ${alias}`;
}

async function hasAttempt(testId, studentId) {
  await ensureTestAttemptTable();
  const rows = await query(
    "SELECT id FROM test_attempts WHERE test_id = ? AND student_id = ? LIMIT 1",
    [testId, studentId]
  );
  return !!rows[0];
}

async function getLatestAttemptByStudent(testId, studentId) {
  await ensureTestAttemptTable();
  const rows = await query(
    "SELECT ta.*, u.first_name AS student_first_name, u.last_name AS student_last_name FROM test_attempts ta JOIN users u ON u.id = ta.student_id WHERE ta.test_id = ? AND ta.student_id = ? ORDER BY ta.attempt_number DESC, ta.submitted_at DESC LIMIT 1",
    [testId, studentId]
  );
  return rows[0] ? mapAttempt(rows[0]) : null;
}

async function listAttemptsByStudent(testId, studentId) {
  await ensureTestAttemptTable();
  const rows = await query(
    "SELECT ta.*, u.first_name AS student_first_name, u.last_name AS student_last_name FROM test_attempts ta JOIN users u ON u.id = ta.student_id WHERE ta.test_id = ? AND ta.student_id = ? ORDER BY ta.attempt_number DESC, ta.submitted_at DESC",
    [testId, studentId]
  );
  return rows.map(mapAttempt);
}

async function listPermissionsByTest(testId) {
  await ensureTestAttemptTable();
  await ensureTestPermissionTable();
  const rows = await query(
    `SELECT u.id AS student_id, u.first_name AS student_first_name, u.last_name AS student_last_name, COALESCE(tp.remaining_attempts, 0) AS remaining_attempts, tp.granted_at, tp.updated_at, ta.attempt_number, ta.score AS attempt_score, ta.correct_count, ta.question_count, ta.percentage, ta.passed, ta.submitted_at AS attempt_submitted_at FROM users u LEFT JOIN test_permissions tp ON tp.student_id = u.id AND tp.test_id = ? ${getLatestAttemptJoinSql(
      "ta"
    )} ON ta.student_id = u.id AND ta.test_id = ? WHERE u.role = 'STUDENT' AND (tp.student_id IS NOT NULL OR ta.id IS NOT NULL) ORDER BY u.first_name ASC, u.last_name ASC`,
    [testId, testId]
  );
  return rows.map(mapPermission);
}

function shuffleInPlace(values) {
  for (let i = values.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = values[i];
    values[i] = values[j];
    values[j] = tmp;
  }
  return values;
}

function normalizeAttemptQuestionOrder(rawOrder, questionCount) {
  return normalizeQuestionOrder(rawOrder, questionCount, questionCount);
}

function hasSameQuestionSet(firstOrder, secondOrder) {
  if (!Array.isArray(firstOrder) || !Array.isArray(secondOrder)) return false;
  if (firstOrder.length !== secondOrder.length) return false;
  const firstSet = new Set(firstOrder);
  if (firstSet.size !== secondOrder.length) return false;
  return secondOrder.every((index) => firstSet.has(index));
}

function createRandomQuestionOrder(questionCount, sampleSize, previousQuestionOrders = []) {
  const safeSampleSize = Math.min(Math.max(0, sampleSize), questionCount);
  if (safeSampleSize <= 0) return [];

  const normalizedPreviousOrders = Array.isArray(previousQuestionOrders)
    ? previousQuestionOrders
        .map((rawOrder) => normalizeAttemptQuestionOrder(rawOrder, questionCount))
        .filter((order) => order.length > 0)
    : [];
  const latestOrder = normalizedPreviousOrders[0] ?? [];

  const frequencies = Array.from({ length: questionCount }, () => 0);
  normalizedPreviousOrders.forEach((order) => {
    order.forEach((index) => {
      if (Number.isInteger(index) && index >= 0 && index < questionCount) {
        frequencies[index] += 1;
      }
    });
  });

  const buckets = new Map();
  for (let index = 0; index < questionCount; index += 1) {
    const frequency = frequencies[index];
    if (!buckets.has(frequency)) {
      buckets.set(frequency, []);
    }
    buckets.get(frequency).push(index);
  }

  const rankedIndices = Array.from(buckets.keys())
    .sort((a, b) => a - b)
    .flatMap((frequency) => shuffleInPlace([...buckets.get(frequency)]));

  let selected = rankedIndices.slice(0, safeSampleSize);

  if (
    questionCount > safeSampleSize &&
    latestOrder.length === safeSampleSize &&
    hasSameQuestionSet(selected, latestOrder)
  ) {
    const selectedSet = new Set(selected);
    const replacement = rankedIndices.find((index) => !selectedSet.has(index));
    if (Number.isInteger(replacement)) {
      const replaceAt = Math.max(0, selected.findIndex((index) => latestOrder.includes(index)));
      selected = [...selected];
      selected[replaceAt] = replacement;
    }
  }

  return shuffleInPlace([...selected]);
}

function hashStringSeed(value) {
  const text = typeof value === "string" ? value : String(value ?? "");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createSeededOptionOrder(optionCount, seedValue) {
  if (!Number.isInteger(optionCount) || optionCount <= 0) return [];
  const indices = Array.from({ length: optionCount }, (_, index) => index);
  let seed = hashStringSeed(seedValue);
  for (let index = indices.length - 1; index > 0; index -= 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const swapIndex = seed % (index + 1);
    const tmp = indices[index];
    indices[index] = indices[swapIndex];
    indices[swapIndex] = tmp;
  }
  return indices;
}

function parseSessionQuestionState(rawState) {
  const parsed = parseJson(rawState, []);
  if (Array.isArray(parsed)) {
    return {
      questionOrder: parsed,
      optionOrders: [],
    };
  }
  if (!parsed || typeof parsed !== "object") {
    return {
      questionOrder: [],
      optionOrders: [],
    };
  }
  return {
    questionOrder: Array.isArray(parsed.questionOrder) ? parsed.questionOrder : [],
    optionOrders: Array.isArray(parsed.optionOrders) ? parsed.optionOrders : [],
  };
}

function createSessionQuestionState(questionOrder, optionOrders) {
  return {
    version: 2,
    questionOrder,
    optionOrders,
  };
}

function normalizeQuestionOrder(rawOrder, questionCount, sampleSize) {
  const parsedOrder = Array.isArray(rawOrder) ? rawOrder : [];
  const unique = [];
  const seen = new Set();

  if (Array.isArray(parsedOrder)) {
    for (const rawIndex of parsedOrder) {
      const index = Number(rawIndex);
      if (!Number.isInteger(index)) continue;
      if (index < 0 || index >= questionCount) continue;
      if (seen.has(index)) continue;
      seen.add(index);
      unique.push(index);
      if (unique.length >= sampleSize) break;
    }
  }

  if (unique.length < sampleSize) {
    const remaining = [];
    for (let index = 0; index < questionCount; index += 1) {
      if (!seen.has(index)) remaining.push(index);
    }
    shuffleInPlace(remaining);
    unique.push(...remaining.slice(0, sampleSize - unique.length));
  }

  return unique;
}

function normalizeOptionOrder(rawOrder, optionCount) {
  if (!Number.isInteger(optionCount) || optionCount <= 0) return [];
  const parsedOrder = Array.isArray(rawOrder) ? rawOrder : [];
  const unique = [];
  const seen = new Set();

  for (const rawIndex of parsedOrder) {
    const index = Number(rawIndex);
    if (!Number.isInteger(index)) continue;
    if (index < 0 || index >= optionCount) continue;
    if (seen.has(index)) continue;
    seen.add(index);
    unique.push(index);
  }

  if (unique.length < optionCount) {
    const remaining = [];
    for (let index = 0; index < optionCount; index += 1) {
      if (!seen.has(index)) remaining.push(index);
    }
    shuffleInPlace(remaining);
    unique.push(...remaining);
  }

  return unique;
}

function resolveOptionOrdersForQuestions(rawOptionOrders, selectedQuestions, seedBase = "") {
  const source = Array.isArray(rawOptionOrders) ? rawOptionOrders : [];
  return selectedQuestions.map((question, questionIndex) => {
    if (!question || question.type === "text") return [];
    const optionCount = Array.isArray(question.options) ? question.options.length : 0;
    if (optionCount <= 0) return [];
    const normalized = normalizeOptionOrder(source[questionIndex], optionCount);
    return normalized.length
      ? normalized
      : createSeededOptionOrder(optionCount, `${seedBase}:${questionIndex}:${optionCount}`);
  });
}

function applyOptionOrderToQuestion(question, optionOrder) {
  if (!question || question.type === "text") return question;
  const optionCount = Array.isArray(question.options) ? question.options.length : 0;
  if (optionCount <= 0) return question;
  const normalizedOptionOrder = normalizeOptionOrder(optionOrder, optionCount);
  if (normalizedOptionOrder.length !== optionCount) return question;

  const reorderedOptions = normalizedOptionOrder
    .map((sourceIndex) => question.options[sourceIndex])
    .filter(Boolean);
  if (reorderedOptions.length !== optionCount) return question;

  if (question.type === "multi") {
    const correctSet = new Set(
      Array.isArray(question.correctOptions) ? question.correctOptions : []
    );
    const mappedCorrectOptions = normalizedOptionOrder.reduce((acc, sourceIndex, targetIndex) => {
      if (correctSet.has(sourceIndex)) acc.push(targetIndex);
      return acc;
    }, []);
    return {
      ...question,
      options: reorderedOptions,
      correctOptions: mappedCorrectOptions,
    };
  }

  const mappedCorrectOption = normalizedOptionOrder.indexOf(question.correctOption);
  return {
    ...question,
    options: reorderedOptions,
    correctOption: mappedCorrectOption >= 0 ? mappedCorrectOption : question.correctOption,
  };
}

function convertPresentedAnswerToStored(question, answer, optionOrder) {
  if (!question || question.type === "text") return answer;

  const optionCount = Array.isArray(question.options) ? question.options.length : 0;
  const normalizedOptionOrder = normalizeOptionOrder(optionOrder, optionCount);
  if (normalizedOptionOrder.length !== optionCount) {
    return question.type === "multi" ? [] : null;
  }

  if (question.type === "multi") {
    if (!Array.isArray(answer)) return [];
    const mapped = [];
    const seen = new Set();
    for (const displayIndex of answer) {
      if (!Number.isInteger(displayIndex)) continue;
      if (displayIndex < 0 || displayIndex >= normalizedOptionOrder.length) continue;
      const sourceIndex = normalizedOptionOrder[displayIndex];
      if (!Number.isInteger(sourceIndex)) continue;
      if (seen.has(sourceIndex)) continue;
      seen.add(sourceIndex);
      mapped.push(sourceIndex);
    }
    mapped.sort((a, b) => a - b);
    return mapped;
  }

  if (!Number.isInteger(answer)) return null;
  if (answer < 0 || answer >= normalizedOptionOrder.length) return null;
  const sourceIndex = normalizedOptionOrder[answer];
  return Number.isInteger(sourceIndex) ? sourceIndex : null;
}

function convertStoredAnswerToPresented(question, answer, optionOrder) {
  if (!question || question.type === "text") return answer;

  const optionCount = Array.isArray(question.options) ? question.options.length : 0;
  const normalizedOptionOrder = normalizeOptionOrder(optionOrder, optionCount);
  if (normalizedOptionOrder.length !== optionCount) {
    return question.type === "multi" ? [] : null;
  }

  const displayBySource = new Map();
  normalizedOptionOrder.forEach((sourceIndex, displayIndex) => {
    displayBySource.set(sourceIndex, displayIndex);
  });

  if (question.type === "multi") {
    if (!Array.isArray(answer)) return [];
    const mapped = [];
    const seen = new Set();
    for (const sourceIndex of answer) {
      if (!Number.isInteger(sourceIndex)) continue;
      const displayIndex = displayBySource.get(sourceIndex);
      if (!Number.isInteger(displayIndex)) continue;
      if (seen.has(displayIndex)) continue;
      seen.add(displayIndex);
      mapped.push(displayIndex);
    }
    mapped.sort((a, b) => a - b);
    return mapped;
  }

  if (!Number.isInteger(answer)) return null;
  const displayIndex = displayBySource.get(answer);
  return Number.isInteger(displayIndex) ? displayIndex : null;
}

function mapStoredAnswersToPresented(storedAnswers, questions, optionOrders) {
  const answers = Array.isArray(storedAnswers) ? storedAnswers : [];
  return questions.map((question, index) =>
    convertStoredAnswerToPresented(question, answers[index], optionOrders[index])
  );
}

function parseDeviceId(req) {
  const raw = req.headers[DEVICE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > 128) return null;
  return normalized;
}

async function listAttemptQuestionOrders(testId, studentId) {
  await ensureTestAttemptTable();
  const rows = await query(
    "SELECT question_order FROM test_attempts WHERE test_id = ? AND student_id = ? ORDER BY attempt_number DESC, submitted_at DESC",
    [testId, studentId]
  );
  return rows.map((row) => parseJson(row.question_order, []));
}

function resolveAttemptSnapshot(attempt, allQuestions) {
  if (!attempt || !Array.isArray(allQuestions) || allQuestions.length === 0) {
    return null;
  }

  const rawQuestionOrder = parseJson(attempt.questionOrder, []);
  if (!Array.isArray(rawQuestionOrder) || rawQuestionOrder.length === 0) {
    return null;
  }

  const sampleSize =
    Number.isInteger(attempt.questionCount) && attempt.questionCount > 0
      ? attempt.questionCount
      : getQuestionSampleSize(allQuestions.length);
  const questionOrder = normalizeQuestionOrder(
    rawQuestionOrder,
    allQuestions.length,
    Math.min(sampleSize, allQuestions.length)
  );
  const selectedQuestions = questionOrder.map((index) => allQuestions[index]).filter(Boolean);
  if (!selectedQuestions.length) {
    return null;
  }
  const optionOrders = resolveOptionOrdersForQuestions(
    parseJson(attempt.optionOrders, []),
    selectedQuestions,
    attempt.id
  );
  const presentedQuestions = selectedQuestions.map((question, index) =>
    applyOptionOrderToQuestion(question, optionOrders[index])
  );

  return {
    selectedQuestions,
    presentedQuestions,
    optionOrders,
  };
}

async function getOrCreateTestSession({
  testId,
  studentId,
  deviceId,
  questionCount,
  preferredSampleSize,
}) {
  await ensureTestSessionTable();
  const sampleSize = Math.min(preferredSampleSize, questionCount);
  const now = new Date();

  const rows = await query(
    "SELECT * FROM test_sessions WHERE test_id = ? AND student_id = ?",
    [testId, studentId]
  );
  const existing = rows[0];

  if (!existing) {
    const previousQuestionOrders = await listAttemptQuestionOrders(testId, studentId);
    const questionOrder = createRandomQuestionOrder(
      questionCount,
      sampleSize,
      previousQuestionOrders
    );
    const optionOrders = [];
    const sessionState = createSessionQuestionState(questionOrder, optionOrders);
    const id = uuid();
    try {
      await query(
        "INSERT INTO test_sessions (id, test_id, student_id, device_id, question_order, started_at, updated_at) VALUES (?,?,?,?,?,?,?)",
        [id, testId, studentId, deviceId, JSON.stringify(sessionState), now, now]
      );
      return { blocked: false, id, questionOrder, optionOrders, sampleSize, startedAt: now };
    } catch (err) {
      if (err && err.code === "ER_DUP_ENTRY") {
        return getOrCreateTestSession({
          testId,
          studentId,
          deviceId,
          questionCount,
          preferredSampleSize,
        });
      }
      throw err;
    }
  }

  if (existing.device_id && existing.device_id !== deviceId) {
    return { blocked: true };
  }

  const sessionState = parseSessionQuestionState(existing.question_order);
  const questionOrder = normalizeQuestionOrder(sessionState.questionOrder, questionCount, sampleSize);
  const optionOrders = Array.isArray(sessionState.optionOrders) ? sessionState.optionOrders : [];
  const nextSessionState = createSessionQuestionState(questionOrder, optionOrders);
  await query(
    "UPDATE test_sessions SET device_id = ?, question_order = ?, updated_at = ? WHERE id = ?",
    [deviceId, JSON.stringify(nextSessionState), now, existing.id]
  );
  const startedAt = existing.started_at ? new Date(existing.started_at) : now;
  return { blocked: false, id: existing.id, questionOrder, optionOrders, sampleSize, startedAt };
}

async function resolveStudentQuestionSet(req, res, test, allQuestions, settings) {
  const deviceId = parseDeviceId(req);
  if (!deviceId) {
    res.status(400).json({ message: "Test qurilma identifikatori yo'q yoki noto'g'ri." });
    return null;
  }

  const preferredSampleSize = getQuestionSampleSize(
    allQuestions.length,
    settings.questionSampleSize
  );
  const session = await getOrCreateTestSession({
    testId: test.id,
    studentId: req.user.sub,
    deviceId,
    questionCount: allQuestions.length,
    preferredSampleSize,
  });

  if (session.blocked) {
    res.status(403).json({
      message: "Bu test boshqa qurilmada boshlangan. Faqat o'sha qurilmadan davom eting.",
    });
    return null;
  }

  const selectedQuestions = session.questionOrder
    .map((index) => allQuestions[index])
    .filter(Boolean);
  const optionOrders = resolveOptionOrdersForQuestions(
    session.optionOrders,
    selectedQuestions,
    session.id
  );
  const presentedQuestions = selectedQuestions.map((question, index) =>
    applyOptionOrderToQuestion(question, optionOrders[index])
  );
  const now = new Date();
  await query("UPDATE test_sessions SET question_order = ?, updated_at = ? WHERE id = ?", [
    JSON.stringify(createSessionQuestionState(session.questionOrder, optionOrders)),
    now,
    session.id,
  ]);
  const timeRemainingSeconds = calculateTimeRemainingSeconds(
    session.startedAt,
    settings.timeLimitMinutes
  );

  return {
    questionOrder: session.questionOrder,
    selectedQuestions,
    presentedQuestions,
    optionOrders,
    questionSampleSize: presentedQuestions.length,
    timeRemainingSeconds,
    startedAt: session.startedAt,
  };
}

async function getTestById(id) {
  const rows = await query(
    "SELECT t.*, u.first_name AS teacher_first_name, u.last_name AS teacher_last_name, (SELECT COUNT(*) FROM test_attempts ta WHERE ta.test_id = t.id) AS attempt_count FROM tests t JOIN users u ON u.id = t.teacher_id WHERE t.id = ?",
    [id]
  );
  return rows[0];
}

function canManageTest(test, user) {
  if (!test || !user || user.role !== "TEACHER") return false;
  return test.teacher_id === user.sub;
}

async function clearTestTransientState(testId) {
  await ensureTestSessionTable();
  await ensureTestPermissionTable();
  await query("DELETE FROM test_sessions WHERE test_id = ?", [testId]);
  await query("DELETE FROM test_permissions WHERE test_id = ?", [testId]);
}

async function canStudentAccessTest(test, studentId) {
  if (!test) return false;
  if (!test.target_type) return true;
  if (test.target_type === "STUDENT") return test.target_id === studentId;
  if (test.target_type === "GROUP") {
    const rows = await query(
      "SELECT id FROM group_members WHERE group_id = ? AND student_id = ?",
      [test.target_id, studentId]
    );
    return !!rows[0];
  }
  return false;
}

router.get("/", requireAuth, requireRole("TEACHER"), async (req, res, next) => {
  try {
    const rows = await query(
      "SELECT t.*, u.first_name AS teacher_first_name, u.last_name AS teacher_last_name, (SELECT COUNT(*) FROM test_attempts ta WHERE ta.test_id = t.id) AS attempt_count FROM tests t JOIN users u ON u.id = t.teacher_id WHERE t.teacher_id = ? ORDER BY t.created_at DESC",
      [req.user.sub]
    );
    res.json(rows.map((row) => mapTest(row, true)));
  } catch (err) {
    next(err);
  }
});

router.post("/", requireAuth, requireRole("TEACHER"), async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);
    const normalizedQuestions = parseQuestions(body.questions);
    if (!normalizedQuestions.length) {
      return res.status(400).json({ message: "Kamida bitta yaroqli savol bo'lishi kerak." });
    }
    const settings = normalizeRuntimeTestSettings(
      {
        questionSampleSize: body.questionSampleSize,
        timeLimitMinutes: body.timeLimitMinutes,
      },
      normalizedQuestions.length
    );

    const id = uuid();
    await query(
      "INSERT INTO tests (id, subject_id, teacher_id, title, description, deadline, max_score, questions, target_type, target_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [
        id,
        body.subjectId ?? null,
        req.user.sub,
        body.title,
        body.description,
        new Date(body.deadline),
        body.maxScore,
        JSON.stringify(createQuestionsPayload(normalizedQuestions, settings)),
        body.targetType ?? null,
        body.targetId ?? null,
      ]
    );
    const created = await getTestById(id);
    res.json(mapTest(created, true));
  } catch (err) {
    next(err);
  }
});

router.put("/:id", requireAuth, requireRole("TEACHER"), async (req, res, next) => {
  try {
    const test = await getTestById(req.params.id);
    if (!test) return res.status(404).json({ message: "Test topilmadi" });
    if (!canManageTest(test, req.user)) {
      return res.status(403).json({ message: "Ruxsat yo'q" });
    }

    const body = createSchema.parse(req.body);
    const normalizedQuestions = parseQuestions(body.questions);
    if (!normalizedQuestions.length) {
      return res.status(400).json({ message: "Kamida bitta yaroqli savol bo'lishi kerak." });
    }

    const settings = normalizeRuntimeTestSettings(
      {
        questionSampleSize: body.questionSampleSize,
        timeLimitMinutes: body.timeLimitMinutes,
      },
      normalizedQuestions.length
    );

    const nextQuestionsPayload = createQuestionsPayload(normalizedQuestions, settings);
    const currentQuestionsPayload = parseJson(test.questions, []);
    const progressAffectingChange =
      JSON.stringify(currentQuestionsPayload) !== JSON.stringify(nextQuestionsPayload) ||
      Number(test.max_score) !== Number(body.maxScore) ||
      (test.target_type ?? null) !== (body.targetType ?? null) ||
      (test.target_id ?? null) !== (body.targetId ?? null);

    if (Number(test.attempt_count || 0) > 0 && progressAffectingChange) {
      return res.status(409).json({
        message:
          "Bu testda talabalar urinishlari mavjud. Savollar, ball yoki qamrovni o'zgartirish uchun yangi test yarating.",
      });
    }

    await query(
      "UPDATE tests SET subject_id = ?, title = ?, description = ?, deadline = ?, max_score = ?, questions = ?, target_type = ?, target_id = ? WHERE id = ?",
      [
        body.subjectId ?? null,
        body.title,
        body.description,
        new Date(body.deadline),
        body.maxScore,
        JSON.stringify(nextQuestionsPayload),
        body.targetType ?? null,
        body.targetId ?? null,
        req.params.id,
      ]
    );

    if (progressAffectingChange) {
      await clearTestTransientState(req.params.id);
    }

    const updated = await getTestById(req.params.id);
    res.json(mapTest(updated, true));
  } catch (err) {
    next(err);
  }
});

router.get("/available", requireAuth, requireRole("STUDENT"), async (req, res, next) => {
  try {
    await ensureTestAttemptTable();
    await ensureTestPermissionTable();
    await ensureTestSessionTable();
    const deviceId = parseDeviceId(req);
    const rows = await query(
      `SELECT t.*, u.first_name AS teacher_first_name, u.last_name AS teacher_last_name, ta.id AS attempt_id, ta.attempt_number, ta.score AS attempt_score, ta.correct_count, ta.question_count, ta.percentage, ta.passed, ta.submitted_at AS attempt_submitted_at, COALESCE(tp.remaining_attempts, 0) AS permission_remaining_attempts, ts.started_at AS session_started_at, ts.device_id AS session_device_id FROM tests t JOIN users u ON u.id = t.teacher_id LEFT JOIN test_permissions tp ON tp.test_id = t.id AND tp.student_id = ? LEFT JOIN group_members gm ON gm.group_id = t.target_id AND gm.student_id = ? LEFT JOIN test_sessions ts ON ts.test_id = t.id AND ts.student_id = ? ${getLatestAttemptJoinSql(
        "ta"
      )} ON ta.test_id = t.id AND ta.student_id = ? WHERE ((t.target_type IS NULL) OR (t.target_type = 'GROUP' AND gm.student_id IS NOT NULL) OR (t.target_type = 'STUDENT' AND t.target_id = ?)) AND (COALESCE(tp.remaining_attempts, 0) > 0 OR ta.id IS NOT NULL) ORDER BY t.created_at DESC`,
      [req.user.sub, req.user.sub, req.user.sub, req.user.sub, req.user.sub]
    );
    res.json(
      rows.map((row) => {
        const allQuestions = parseQuestions(row.questions);
        const settings = parseTestSettings(row.questions, allQuestions.length);
        const sessionStartedAt = row.session_started_at ? new Date(row.session_started_at) : null;
        const timeRemainingSeconds = calculateTimeRemainingSeconds(
          sessionStartedAt,
          settings.timeLimitMinutes
        );
        const entryBlockedReason =
          row.session_device_id && deviceId && row.session_device_id !== deviceId
            ? "Bu test boshqa qurilmada boshlangan. Faqat o'sha qurilmadan davom eting."
            : typeof timeRemainingSeconds === "number" && timeRemainingSeconds <= 0
            ? getExpiredTimeLimitMessage()
            : undefined;

        return mapTest(row, false, {
          allQuestions,
          settings,
          timeRemainingSeconds: timeRemainingSeconds ?? undefined,
          entryBlockedReason,
        });
      })
    );
  } catch (err) {
    next(err);
  }
});

router.get("/:id/my-attempt", requireAuth, requireRole("STUDENT"), async (req, res, next) => {
  try {
    const test = await getTestById(req.params.id);
    if (!test) return res.status(404).json({ message: "Test topilmadi" });

    const allowed = await canStudentAccessTest(test, req.user.sub);
    if (!allowed) return res.status(403).json({ message: "Ruxsat yo'q" });

    const mappedAttempt = await getLatestAttemptByStudent(req.params.id, req.user.sub);
    if (!mappedAttempt) return res.json(null);

    const allQuestions = parseQuestions(test.questions);
    const snapshot = resolveAttemptSnapshot(mappedAttempt, allQuestions);
    if (snapshot) {
      mappedAttempt.answers = mapStoredAnswersToPresented(
        mappedAttempt.answers,
        snapshot.selectedQuestions,
        snapshot.optionOrders
      );
    }

    res.json(mappedAttempt);
  } catch (err) {
    next(err);
  }
});

router.get("/:id/my-attempts", requireAuth, requireRole("STUDENT"), async (req, res, next) => {
  try {
    const test = await getTestById(req.params.id);
    if (!test) return res.status(404).json({ message: "Test topilmadi" });

    const allowed = await canStudentAccessTest(test, req.user.sub);
    if (!allowed) return res.status(403).json({ message: "Ruxsat yo'q" });

    const attempts = await listAttemptsByStudent(req.params.id, req.user.sub);
    res.json(attempts);
  } catch (err) {
    next(err);
  }
});

router.get("/:id/attempts", requireAuth, requireRole("TEACHER"), async (req, res, next) => {
  try {
    const test = await getTestById(req.params.id);
    if (!test) return res.status(404).json({ message: "Test topilmadi" });
    if (!canManageTest(test, req.user)) return res.status(403).json({ message: "Ruxsat yo'q" });
    await ensureTestAttemptTable();
    const rows = await query(
      "SELECT ta.*, u.first_name AS student_first_name, u.last_name AS student_last_name FROM test_attempts ta JOIN users u ON u.id = ta.student_id WHERE ta.test_id = ? ORDER BY ta.submitted_at DESC, ta.attempt_number DESC",
      [req.params.id]
    );
    res.json(rows.map(mapAttempt));
  } catch (err) {
    next(err);
  }
});

router.get("/:id/permissions", requireAuth, requireRole("TEACHER"), async (req, res, next) => {
  try {
    const test = await getTestById(req.params.id);
    if (!test) return res.status(404).json({ message: "Test topilmadi" });
    if (!canManageTest(test, req.user)) return res.status(403).json({ message: "Ruxsat yo'q" });
    const permissions = await listPermissionsByTest(req.params.id);
    res.json(permissions);
  } catch (err) {
    next(err);
  }
});

router.post(
  "/:id/permissions/grant",
  requireAuth,
  requireRole("TEACHER"),
  async (req, res, next) => {
    try {
      const test = await getTestById(req.params.id);
      if (!test) return res.status(404).json({ message: "Test topilmadi" });
      if (!canManageTest(test, req.user)) return res.status(403).json({ message: "Ruxsat yo'q" });

      const body = grantPermissionSchema.parse(req.body);
      const studentRows = await query("SELECT id FROM users WHERE id = ? AND role = 'STUDENT'", [
        body.studentId,
      ]);
      if (!studentRows[0]) return res.status(404).json({ message: "Talaba topilmadi" });

      await ensureTestPermissionTable();
      await ensureTestAttemptTable();
      await ensureTestSessionTable();
      const now = new Date();
      const id = uuid();
      await query(
        "INSERT INTO test_permissions (id, test_id, student_id, granted_by, remaining_attempts, granted_at, updated_at) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE remaining_attempts = remaining_attempts + VALUES(remaining_attempts), granted_by = VALUES(granted_by), updated_at = VALUES(updated_at)",
        [id, req.params.id, body.studentId, req.user.sub, body.attempts, now, now]
      );
      await query("DELETE FROM test_sessions WHERE test_id = ? AND student_id = ?", [
        req.params.id,
        body.studentId,
      ]);

      const rows = await query(
        `SELECT u.id AS student_id, u.first_name AS student_first_name, u.last_name AS student_last_name, COALESCE(tp.remaining_attempts, 0) AS remaining_attempts, tp.granted_at, tp.updated_at, ta.attempt_number, ta.score AS attempt_score, ta.correct_count, ta.question_count, ta.percentage, ta.passed, ta.submitted_at AS attempt_submitted_at FROM users u LEFT JOIN test_permissions tp ON tp.student_id = u.id AND tp.test_id = ? ${getLatestAttemptJoinSql(
          "ta"
        )} ON ta.student_id = u.id AND ta.test_id = ? WHERE u.id = ? LIMIT 1`,
        [req.params.id, req.params.id, body.studentId]
      );
      if (!rows[0]) return res.status(404).json({ message: "Talaba topilmadi" });
      res.json(mapPermission(rows[0]));
    } catch (err) {
      next(err);
    }
  }
);

router.post("/:id/submit", requireAuth, requireRole("STUDENT"), async (req, res, next) => {
  try {
    const test = await getTestById(req.params.id);
    if (!test) return res.status(404).json({ message: "Test topilmadi" });

    const allowed = await canStudentAccessTest(test, req.user.sub);
    if (!allowed) return res.status(403).json({ message: "Ruxsat yo'q" });
    const remainingAttempts = await getRemainingAttempts(req.params.id, req.user.sub);
    if (remainingAttempts <= 0) {
      return res.status(403).json({
        message: "Bu testni topshirish uchun ruxsatingiz yo'q. O'qituvchidan ruxsat so'rang.",
      });
    }

    const allQuestions = parseQuestions(test.questions);
    const settings = parseTestSettings(test.questions, allQuestions.length);
    const resolved = await resolveStudentQuestionSet(req, res, test, allQuestions, settings);
    if (!resolved) return;
    if (typeof resolved.timeRemainingSeconds === "number" && resolved.timeRemainingSeconds <= 0) {
      return res.status(400).json({ message: "Bu test uchun ajratilgan vaqt tugagan." });
    }

    const body = submitSchema.parse(req.body);
    const originalQuestions = resolved.selectedQuestions;
    const presentedQuestions = resolved.presentedQuestions;

    const normalizedPresentedAnswers = presentedQuestions.map((question, index) => {
      const answer = body.answers[index];
      if (question.type === "text") {
        if (typeof answer !== "string") return null;
        const trimmed = answer.trim().slice(0, MAX_TEXT_ANSWER_LENGTH);
        return trimmed.length ? trimmed : null;
      }

      if (question.type === "multi") {
        if (!Array.isArray(answer)) return [];
        const normalized = [];
        const seen = new Set();
        for (const rawIndex of answer) {
          if (!Number.isInteger(rawIndex)) continue;
          if (rawIndex < 0 || rawIndex >= question.options.length) continue;
          if (seen.has(rawIndex)) continue;
          seen.add(rawIndex);
          normalized.push(rawIndex);
        }
        normalized.sort((a, b) => a - b);
        return normalized;
      }

      if (typeof answer !== "number") return null;
      if (answer < 0 || answer >= question.options.length) return null;
      return answer;
    });

    const storedAnswers = originalQuestions.map((question, index) => {
      const answer = normalizedPresentedAnswers[index];
      if (question.type === "text") return answer;
      return convertPresentedAnswerToStored(question, answer, resolved.optionOrders[index]);
    });

    await ensureTestAttemptTable();
    const totalPoints =
      originalQuestions.reduce((sum, question) => sum + Number(question.points || 0), 0) || 1;
    const scoring = originalQuestions.reduce(
      (summary, question, index) => {
      const answer = storedAnswers[index];
      if (question.type === "text") {
        if (typeof answer === "string" && typeof question.correctText === "string") {
          const normalizedAnswer = normalizeAnswerTextForCompare(answer);
          const normalizedCorrect = normalizeAnswerTextForCompare(question.correctText);
          if (normalizedAnswer && normalizedAnswer === normalizedCorrect) {
              return {
                earnedPoints: summary.earnedPoints + Number(question.points || 0),
                correctCount: summary.correctCount + 1,
              };
          }
        }
          return summary;
      }

      if (question.type === "multi") {
        if (!Array.isArray(answer) || !answer.length || !Array.isArray(question.correctOptions)) {
            return summary;
        }
        const normalizedCorrectOptions = Array.from(
          new Set(
            question.correctOptions.filter(
              (index) => Number.isInteger(index) && index >= 0 && index < question.options.length
            )
          )
        ).sort((a, b) => a - b);
        if (
          normalizedCorrectOptions.length === answer.length &&
          normalizedCorrectOptions.every((value, valueIndex) => value === answer[valueIndex])
        ) {
            return {
              earnedPoints: summary.earnedPoints + Number(question.points || 0),
              correctCount: summary.correctCount + 1,
            };
        }
          return summary;
      }

      if (answer === question.correctOption) {
          return {
            earnedPoints: summary.earnedPoints + Number(question.points || 0),
            correctCount: summary.correctCount + 1,
          };
      }
        return summary;
      },
      { earnedPoints: 0, correctCount: 0 }
    );
    const questionCount = originalQuestions.length;
    const percentage = Math.max(
      0,
      Math.min(100, Math.round((scoring.earnedPoints / totalPoints) * 100))
    );
    const passed = percentage >= PASSING_PERCENTAGE;
    const score = Math.round((scoring.earnedPoints / totalPoints) * Number(test.max_score || 100));
    const submittedAt = new Date();
    const latestAttempt = await getLatestAttemptByStudent(req.params.id, req.user.sub);
    const nextAttemptNumber = (latestAttempt?.attemptNumber ?? 0) + 1;

    const id = uuid();
    await query(
      "INSERT INTO test_attempts (id, test_id, student_id, attempt_number, answers, question_order, option_orders, score, correct_count, question_count, percentage, passed, submitted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        id,
        req.params.id,
        req.user.sub,
        nextAttemptNumber,
        JSON.stringify(storedAnswers),
        JSON.stringify(resolved.questionOrder ?? resolved.selectedQuestions.map((_, index) => index)),
        JSON.stringify(resolved.optionOrders),
        score,
        scoring.correctCount,
        questionCount,
        percentage,
        passed ? 1 : 0,
        submittedAt,
      ]
    );
    await query(
      "UPDATE test_permissions SET remaining_attempts = GREATEST(remaining_attempts - 1, 0), updated_at = ? WHERE test_id = ? AND student_id = ?",
      [submittedAt, req.params.id, req.user.sub]
    );
    await query("DELETE FROM test_sessions WHERE test_id = ? AND student_id = ?", [
      req.params.id,
      req.user.sub,
    ]);
    res.json({
      id,
      testId: req.params.id,
      studentId: req.user.sub,
      answers: normalizedPresentedAnswers,
      score,
      attemptNumber: nextAttemptNumber,
      correctCount: scoring.correctCount,
      questionCount,
      percentage,
      passed,
      submittedAt,
    });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", requireAuth, requireRole("TEACHER"), async (req, res, next) => {
  try {
    const test = await getTestById(req.params.id);
    if (!test) return res.status(404).json({ message: "Test topilmadi" });
    if (!canManageTest(test, req.user)) {
      return res.status(403).json({ message: "Ruxsat yo'q" });
    }

    await clearTestTransientState(req.params.id);
    await query("DELETE FROM test_attempts WHERE test_id = ?", [req.params.id]);
    await query("DELETE FROM tests WHERE id = ?", [req.params.id]);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", requireAuth, async (req, res, next) => {
  try {
    const test = await getTestById(req.params.id);
    if (!test) return res.status(404).json({ message: "Test topilmadi" });

    const allQuestions = parseQuestions(test.questions);
    const settings = parseTestSettings(test.questions, allQuestions.length);

    if (req.user.role === "TEACHER") {
      if (!canManageTest(test, req.user)) return res.status(403).json({ message: "Ruxsat yo'q" });
      return res.json(mapTest(test, true, { allQuestions, settings }));
    }

    const allowed = await canStudentAccessTest(test, req.user.sub);
    if (!allowed) return res.status(403).json({ message: "Ruxsat yo'q" });
    const remainingAttempts = await getRemainingAttempts(req.params.id, req.user.sub);
    const attemptExists = await hasAttempt(req.params.id, req.user.sub);
    if (!attemptExists && remainingAttempts <= 0) {
      return res.status(403).json({
        message: "Hozircha bu test uchun o'qituvchi ruxsat bermagan. O'qituvchingizga murojaat qiling.",
      });
    }

    if (remainingAttempts <= 0) {
      return res.json(
        mapTest(test, false, {
          allQuestions,
          settings,
          selectedQuestions: [],
          questionSampleSize: 0,
          permissionRemainingAttempts: remainingAttempts,
        })
      );
    }

    const resolved = await resolveStudentQuestionSet(req, res, test, allQuestions, settings);
    if (!resolved) return;
    if (typeof resolved.timeRemainingSeconds === "number" && resolved.timeRemainingSeconds <= 0) {
      return res.status(403).json({ message: getExpiredTimeLimitMessage() });
    }

    res.json(
      mapTest(test, false, {
        allQuestions,
        settings,
        selectedQuestions: resolved.presentedQuestions,
        questionSampleSize: resolved.questionSampleSize,
        timeRemainingSeconds: resolved.timeRemainingSeconds ?? undefined,
        permissionRemainingAttempts: remainingAttempts,
      })
    );
  } catch (err) {
    next(err);
  }
});

module.exports = router;
