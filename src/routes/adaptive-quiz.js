const express = require("express");
const { z } = require("zod");
const { v4: uuid } = require("uuid");

const config = require("../config");
const { query } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const {
  AdaptiveQuizAiError,
  getProviderMeta,
  evaluateAnswer,
  generateNextQuestion,
} = require("../services/adaptiveQuizAi");

const router = express.Router();

const startSchema = z.object({
  topic: z.string().trim().min(1).max(200).optional(),
});

const answerSchema = z.object({
  answer: z.string().trim().min(1).max(2000),
});

let ensureAdaptiveQuizSessionTablePromise = null;
let ensureAdaptiveQuizAnswerLogTablePromise = null;

function parseJson(rawValue, fallback) {
  if (rawValue == null) return fallback;
  if (typeof rawValue === "string") {
    try {
      return JSON.parse(rawValue);
    } catch {
      return fallback;
    }
  }
  return rawValue;
}

function clampDifficulty(value) {
  const min = config.adaptiveQuiz.minDifficulty;
  const max = config.adaptiveQuiz.maxDifficulty;
  if (!Number.isFinite(value)) return config.adaptiveQuiz.startDifficulty;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function getDifficultyShift(score) {
  if (!Number.isFinite(score)) return 0;
  if (score >= 85) return 1;
  if (score >= 55) return 0;
  return -1;
}

function normalizeTopic(value) {
  return String(value || "")
    .trim()
    .toLocaleLowerCase("uz-UZ");
}

function getLockedTopic() {
  return config.adaptiveQuiz.lockedTopic || config.adaptiveQuiz.courseTitle;
}

function buildLockedTopicRejection() {
  const lockedTopic = getLockedTopic();
  return {
    ...buildEnvelope(null),
    allowed: false,
    message: `Faqat "${lockedTopic}" mavzusi bo'yicha savol-javob ruxsat etilgan.`,
    suggestedTopics: [lockedTopic],
  };
}

async function ensureAdaptiveQuizSessionTable() {
  if (!ensureAdaptiveQuizSessionTablePromise) {
    ensureAdaptiveQuizSessionTablePromise = query(
      "CREATE TABLE IF NOT EXISTS adaptive_quiz_sessions (id CHAR(36) PRIMARY KEY, user_id CHAR(36) NOT NULL UNIQUE, topic VARCHAR(255) NOT NULL, current_difficulty TINYINT NOT NULL DEFAULT 2, current_question JSON NOT NULL, history JSON NOT NULL, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id))"
    );
  }
  await ensureAdaptiveQuizSessionTablePromise;
}

async function ensureAdaptiveQuizAnswerLogTable() {
  if (!ensureAdaptiveQuizAnswerLogTablePromise) {
    ensureAdaptiveQuizAnswerLogTablePromise = query(
      "CREATE TABLE IF NOT EXISTS adaptive_quiz_answer_logs (id CHAR(36) PRIMARY KEY, user_id CHAR(36) NOT NULL, topic VARCHAR(255) NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL, score INT NOT NULL DEFAULT 0, is_correct TINYINT(1) NOT NULL DEFAULT 0, difficulty TINYINT NOT NULL DEFAULT 2, created_at DATETIME NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id), KEY idx_adaptive_quiz_answer_logs_user (user_id, created_at))"
    );
  }
  await ensureAdaptiveQuizAnswerLogTablePromise;
}

function mapSession(row) {
  if (!row) return null;

  const currentQuestion = parseJson(row.current_question, {});
  const history = parseJson(row.history, []);

  return {
    id: row.id,
    userId: row.user_id,
    topic: row.topic,
    currentDifficulty: clampDifficulty(row.current_difficulty),
    currentQuestion: {
      question:
        currentQuestion && typeof currentQuestion.question === "string"
          ? currentQuestion.question
          : "",
    },
    history: Array.isArray(history)
      ? history.map((item) => ({
          question: typeof item?.question === "string" ? item.question : "",
          answer: typeof item?.answer === "string" ? item.answer : "",
          isCorrect: Boolean(item?.isCorrect),
          difficulty: clampDifficulty(item?.difficulty),
          feedback: typeof item?.feedback === "string" ? item.feedback : "",
          idealAnswer: typeof item?.idealAnswer === "string" ? item.idealAnswer : "",
          score:
            typeof item?.score === "number" && Number.isFinite(item.score)
              ? Math.max(0, Math.min(100, Math.round(item.score)))
              : undefined,
          createdAt:
            typeof item?.createdAt === "string" ? item.createdAt : new Date().toISOString(),
        }))
      : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getSessionByUser(userId) {
  await ensureAdaptiveQuizSessionTable();
  const rows = await query("SELECT * FROM adaptive_quiz_sessions WHERE user_id = ? LIMIT 1", [userId]);
  return rows[0] || null;
}

async function deleteSessionByUser(userId) {
  await ensureAdaptiveQuizSessionTable();
  await query("DELETE FROM adaptive_quiz_sessions WHERE user_id = ?", [userId]);
}

async function insertAnswerLog({
  userId,
  topic,
  question,
  answer,
  score,
  isCorrect,
  difficulty,
}) {
  await ensureAdaptiveQuizAnswerLogTable();
  await query(
    "INSERT INTO adaptive_quiz_answer_logs (id, user_id, topic, question, answer, score, is_correct, difficulty, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [
      uuid(),
      userId,
      topic,
      question,
      answer,
      Math.max(0, Math.min(100, Math.round(score))),
      isCorrect ? 1 : 0,
      clampDifficulty(difficulty),
      new Date(),
    ]
  );
}

function buildEnvelope(session) {
  return {
    session,
    ...getProviderMeta(),
  };
}

function formatStudentName(row) {
  return [row.first_name, row.last_name].filter(Boolean).join(" ").trim() || row.username || "Talaba";
}

function parseGroupNames(value) {
  if (typeof value !== "string" || !value.trim()) return [];
  return value
    .split("||")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getPersistedState(row) {
  if (!row) return null;
  return {
    currentQuestion: parseJson(row.current_question, {}),
    history: parseJson(row.history, []),
  };
}

async function upsertSession(userId, nextState) {
  await ensureAdaptiveQuizSessionTable();
  const now = new Date();
  const currentQuestion = JSON.stringify(nextState.currentQuestion ?? {});
  const history = JSON.stringify(Array.isArray(nextState.history) ? nextState.history : []);

  await query(
    "INSERT INTO adaptive_quiz_sessions (id, user_id, topic, current_difficulty, current_question, history, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE topic = VALUES(topic), current_difficulty = VALUES(current_difficulty), current_question = VALUES(current_question), history = VALUES(history), updated_at = VALUES(updated_at)",
    [
      nextState.id || uuid(),
      userId,
      nextState.topic,
      clampDifficulty(nextState.currentDifficulty),
      currentQuestion,
      history,
      now,
      now,
    ]
  );

  return getSessionByUser(userId);
}

function handleAiError(res, next, error) {
  if (error instanceof AdaptiveQuizAiError) {
    return res.status(error.statusCode || 500).json({ message: error.message });
  }
  return next(error);
}

router.get("/teacher/stats", requireAuth, requireRole("TEACHER"), async (req, res, next) => {
  try {
    await ensureAdaptiveQuizAnswerLogTable();
    const lockedTopic = getLockedTopic();
    const rows = await query(
      "SELECT u.id AS student_id, u.username, u.first_name, u.last_name, GROUP_CONCAT(DISTINCT g.name ORDER BY g.name SEPARATOR '||') AS group_names, stats.answer_count, stats.average_score, stats.last_activity_at FROM users u LEFT JOIN group_members gm ON gm.student_id = u.id LEFT JOIN `groups` g ON g.id = gm.group_id AND g.teacher_id = ? LEFT JOIN (SELECT user_id, COUNT(*) AS answer_count, AVG(score) AS average_score, MAX(created_at) AS last_activity_at FROM adaptive_quiz_answer_logs WHERE topic = ? GROUP BY user_id) stats ON stats.user_id = u.id WHERE u.role = 'STUDENT' GROUP BY u.id, u.username, u.first_name, u.last_name, stats.answer_count, stats.average_score, stats.last_activity_at",
      [req.user.sub, lockedTopic]
    );

    const students = rows
      .map((row) => ({
        studentId: row.student_id,
        studentName: formatStudentName(row),
        username: row.username,
        groupNames: parseGroupNames(row.group_names),
        answerCount: Number(row.answer_count || 0),
        averageScore:
          row.average_score == null || !Number.isFinite(Number(row.average_score))
            ? null
            : Math.max(0, Math.min(100, Math.round(Number(row.average_score)))),
        lastActivityAt:
          typeof row.last_activity_at === "string" || row.last_activity_at instanceof Date
            ? new Date(row.last_activity_at).toISOString()
            : null,
      }))
      .filter((item) => item.answerCount > 0)
      .sort((left, right) => {
        if (right.answerCount !== left.answerCount) {
          return right.answerCount - left.answerCount;
        }
        const leftAverage = left.averageScore ?? -1;
        const rightAverage = right.averageScore ?? -1;
        if (rightAverage !== leftAverage) {
          return rightAverage - leftAverage;
        }
        return left.studentName.localeCompare(right.studentName, "uz");
      });

    const totalAnswers = students.reduce((sum, item) => sum + item.answerCount, 0);
    const weightedScoreSum = students.reduce(
      (sum, item) => sum + (item.averageScore ?? 0) * item.answerCount,
      0
    );

    return res.json({
      courseTitle: lockedTopic,
      summary: {
        studentCount: students.length,
        activeStudentCount: students.length,
        totalAnswers,
        averageScore: totalAnswers ? Math.round(weightedScoreSum / totalAnswers) : null,
      },
      students,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/session", requireAuth, async (req, res, next) => {
  try {
    const session = await getSessionByUser(req.user.sub);
    res.json(buildEnvelope(mapSession(session)));
  } catch (error) {
    next(error);
  }
});

router.post("/session", requireAuth, async (req, res, next) => {
  try {
    const body = startSchema.parse(req.body ?? {});
    const lockedTopic = getLockedTopic();

    if (body.topic && normalizeTopic(body.topic) !== normalizeTopic(lockedTopic)) {
      await deleteSessionByUser(req.user.sub);
      return res.status(403).json(buildLockedTopicRejection());
    }

    const firstQuestion = await generateNextQuestion({
      role: req.user.role,
      topic: lockedTopic,
      difficulty: config.adaptiveQuiz.startDifficulty,
      history: [],
    });

    if (!firstQuestion.question || !firstQuestion.expectedAnswer) {
      return res.status(502).json({ message: "AI birinchi savolni yaratib bera olmadi." });
    }

    const persisted = await upsertSession(req.user.sub, {
      topic: lockedTopic,
      currentDifficulty: config.adaptiveQuiz.startDifficulty,
      currentQuestion: {
        question: firstQuestion.question,
        expectedAnswer: firstQuestion.expectedAnswer,
      },
      history: [],
    });

    return res.json({
      ...buildEnvelope(mapSession(persisted)),
      allowed: true,
    });
  } catch (error) {
    return handleAiError(res, next, error);
  }
});

router.post("/session/answer", requireAuth, async (req, res, next) => {
  try {
    const body = answerSchema.parse(req.body);
    const sessionRow = await getSessionByUser(req.user.sub);
    if (!sessionRow) {
      return res.status(404).json({ message: "Faol adaptive quiz sessiyasi topilmadi." });
    }

    const state = getPersistedState(sessionRow);
    const question = typeof state?.currentQuestion?.question === "string" ? state.currentQuestion.question : "";
    const expectedAnswer =
      typeof state?.currentQuestion?.expectedAnswer === "string"
        ? state.currentQuestion.expectedAnswer
        : "";

    if (!question || !expectedAnswer) {
      return res.status(409).json({ message: "Sessiya savoli buzilgan. Yangi chat boshlang." });
    }

    const evaluation = await evaluateAnswer({
      role: req.user.role,
      topic: sessionRow.topic,
      difficulty: clampDifficulty(sessionRow.current_difficulty),
      question,
      expectedAnswer,
      answer: body.answer,
    });

    const previousDifficulty = clampDifficulty(sessionRow.current_difficulty);
    const nextDifficulty = clampDifficulty(previousDifficulty + getDifficultyShift(evaluation.score));

    const nextHistory = [
      ...(Array.isArray(state?.history) ? state.history : []),
      {
        question,
        answer: body.answer,
        isCorrect: evaluation.isCorrect,
        difficulty: previousDifficulty,
        feedback: evaluation.feedback,
        idealAnswer: evaluation.idealAnswer,
        score: evaluation.score,
        createdAt: new Date().toISOString(),
      },
    ];

    await insertAnswerLog({
      userId: req.user.sub,
      topic: sessionRow.topic,
      question,
      answer: body.answer,
      score: evaluation.score,
      isCorrect: evaluation.isCorrect,
      difficulty: previousDifficulty,
    });

    const nextQuestion = await generateNextQuestion({
      role: req.user.role,
      topic: sessionRow.topic,
      difficulty: nextDifficulty,
      history: nextHistory,
    });

    if (!nextQuestion.question || !nextQuestion.expectedAnswer) {
      return res.status(502).json({ message: "AI keyingi savolni yaratib bera olmadi." });
    }

    const persisted = await upsertSession(req.user.sub, {
      id: sessionRow.id,
      topic: sessionRow.topic,
      currentDifficulty: nextDifficulty,
      currentQuestion: nextQuestion,
      history: nextHistory,
    });

    return res.json({
      ...buildEnvelope(mapSession(persisted)),
      evaluation: {
        isCorrect: evaluation.isCorrect,
        score: evaluation.score,
        feedback: evaluation.feedback,
        idealAnswer: evaluation.idealAnswer,
        previousDifficulty,
        nextDifficulty,
      },
    });
  } catch (error) {
    return handleAiError(res, next, error);
  }
});

router.delete("/session", requireAuth, async (req, res, next) => {
  try {
    await deleteSessionByUser(req.user.sub);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
