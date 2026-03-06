const express = require("express");
const { z } = require("zod");
const { v4: uuid } = require("uuid");

const { query } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
const SUPERADMIN_TEACHER_USERNAME = "teacher";
let ensureSurveysSchemaPromise;

async function ensureSurveysSchema() {
  if (!ensureSurveysSchemaPromise) {
    ensureSurveysSchemaPromise = (async () => {
      const columns = await query("SHOW COLUMNS FROM surveys");
      const columnMap = new Map(columns.map((column) => [column.Field, column]));

      if (!columnMap.has("is_anonymous")) {
        await query(
          "ALTER TABLE surveys ADD COLUMN is_anonymous TINYINT(1) NOT NULL DEFAULT 0 AFTER deadline"
        );
      }

      if (!columnMap.has("target_type")) {
        await query(
          "ALTER TABLE surveys ADD COLUMN target_type ENUM('GROUP','STUDENT') NULL AFTER questions"
        );
      }

      if (!columnMap.has("target_id")) {
        await query(
          "ALTER TABLE surveys ADD COLUMN target_id CHAR(36) NULL AFTER target_type"
        );
      }

      const subjectColumn = columnMap.get("subject_id");
      if (subjectColumn?.Null !== "YES") {
        await query("ALTER TABLE surveys MODIFY COLUMN subject_id CHAR(36) NULL");
      }
    })().catch((err) => {
      ensureSurveysSchemaPromise = null;
      throw err;
    });
  }

  await ensureSurveysSchemaPromise;
}

const questionSchema = z
  .object({
    prompt: z.string().min(1),
    type: z.enum(["single", "text"]),
    options: z.array(z.string().min(1)).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.type === "single" && (!value.options || value.options.length < 2)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Single-choice question requires at least two options",
      });
    }
  });

const createSchema = z
  .object({
    subjectId: z.string().min(1).nullable().optional(),
    title: z.string().min(1),
    description: z.string().default(""),
    deadline: z.string().min(1),
    isAnonymous: z.boolean().optional().default(false),
    questions: z.array(questionSchema).min(1),
    targetType: z.enum(["GROUP", "STUDENT"]).optional(),
    targetId: z.string().nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.targetType && !value.targetId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "targetId is required when targetType is selected",
      });
    }
  });

const submitSchema = z.object({
  answers: z.array(z.union([z.number().int().min(0), z.string(), z.null()])),
});

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

function mapSurvey(row) {
  return {
    id: row.id,
    subjectId: row.subject_id,
    teacherId: row.teacher_id,
    title: row.title,
    description: row.description,
    deadline: row.deadline,
    isAnonymous: !!row.is_anonymous,
    questions: Array.isArray(parseJson(row.questions, [])) ? parseJson(row.questions, []) : [],
    targetType: row.target_type ?? null,
    targetId: row.target_id ?? null,
    teacherName:
      [row.teacher_first_name, row.teacher_last_name].filter(Boolean).join(" ") || null,
    responseCount:
      row.response_count == null ? undefined : Number(row.response_count),
    hasResponded: row.response_id ? true : false,
    respondedAt: row.responded_at ?? undefined,
    createdAt: row.created_at,
  };
}

function mapResponse(row, hideIdentity) {
  const studentName =
    [row.student_first_name, row.student_last_name].filter(Boolean).join(" ") || null;
  return {
    id: row.id,
    surveyId: row.survey_id,
    studentId: hideIdentity ? null : row.student_id,
    studentName: hideIdentity ? null : studentName,
    answers: parseJson(row.answers, []),
    submittedAt: row.submitted_at,
  };
}

function isSuperAdmin(user) {
  return user?.role === "TEACHER" && user?.username === SUPERADMIN_TEACHER_USERNAME;
}

function canManageSurvey(survey, user) {
  if (!survey || !user || user.role !== "TEACHER") return false;
  return survey.teacher_id === user.sub || isSuperAdmin(user);
}

async function getSurveyById(id) {
  await ensureSurveysSchema();
  const rows = await query(
    "SELECT s.*, u.first_name AS teacher_first_name, u.last_name AS teacher_last_name FROM surveys s JOIN users u ON u.id = s.teacher_id WHERE s.id = ?",
    [id]
  );
  return rows[0];
}

async function canStudentAccessSurvey(survey, studentId) {
  if (!survey) return false;
  if (!survey.target_type) return true;
  if (survey.target_type === "STUDENT") return survey.target_id === studentId;
  if (survey.target_type === "GROUP") {
    const rows = await query(
      "SELECT id FROM group_members WHERE group_id = ? AND student_id = ?",
      [survey.target_id, studentId]
    );
    return !!rows[0];
  }
  return false;
}

router.get("/", requireAuth, requireRole("TEACHER"), async (req, res, next) => {
  try {
    await ensureSurveysSchema();
    const rows = isSuperAdmin(req.user)
      ? await query(
          "SELECT s.*, u.first_name AS teacher_first_name, u.last_name AS teacher_last_name, (SELECT COUNT(*) FROM survey_responses sr WHERE sr.survey_id = s.id) AS response_count FROM surveys s JOIN users u ON u.id = s.teacher_id ORDER BY s.created_at DESC"
        )
      : await query(
          "SELECT s.*, u.first_name AS teacher_first_name, u.last_name AS teacher_last_name, (SELECT COUNT(*) FROM survey_responses sr WHERE sr.survey_id = s.id) AS response_count FROM surveys s JOIN users u ON u.id = s.teacher_id WHERE s.teacher_id = ? ORDER BY s.created_at DESC",
          [req.user.sub]
        );
    res.json(rows.map(mapSurvey));
  } catch (err) {
    next(err);
  }
});

router.post("/", requireAuth, requireRole("TEACHER"), async (req, res, next) => {
  try {
    await ensureSurveysSchema();
    const body = createSchema.parse(req.body);
    const id = uuid();
    await query(
      "INSERT INTO surveys (id, subject_id, teacher_id, title, description, deadline, is_anonymous, questions, target_type, target_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [
        id,
        body.subjectId ?? null,
        req.user.sub,
        body.title,
        body.description,
        new Date(body.deadline),
        body.isAnonymous ? 1 : 0,
        JSON.stringify(body.questions),
        body.targetType ?? null,
        body.targetId ?? null,
      ]
    );
    const created = await getSurveyById(id);
    res.json(mapSurvey(created));
  } catch (err) {
    next(err);
  }
});

router.get("/available", requireAuth, requireRole("STUDENT"), async (req, res, next) => {
  try {
    await ensureSurveysSchema();
    const rows = await query(
      "SELECT s.*, u.first_name AS teacher_first_name, u.last_name AS teacher_last_name, sr.id AS response_id, sr.submitted_at AS responded_at FROM surveys s JOIN users u ON u.id = s.teacher_id LEFT JOIN group_members gm ON gm.group_id = s.target_id AND gm.student_id = ? LEFT JOIN survey_responses sr ON sr.survey_id = s.id AND sr.student_id = ? WHERE (s.target_type IS NULL) OR (s.target_type = 'GROUP' AND gm.student_id IS NOT NULL) OR (s.target_type = 'STUDENT' AND s.target_id = ?) ORDER BY s.created_at DESC",
      [req.user.sub, req.user.sub, req.user.sub]
    );
    res.json(rows.map(mapSurvey));
  } catch (err) {
    next(err);
  }
});

router.get("/:id/my-response", requireAuth, requireRole("STUDENT"), async (req, res, next) => {
  try {
    const survey = await getSurveyById(req.params.id);
    if (!survey) return res.status(404).json({ message: "Survey not found" });
    const allowed = await canStudentAccessSurvey(survey, req.user.sub);
    if (!allowed) return res.status(403).json({ message: "Forbidden" });

    const rows = await query(
      "SELECT sr.*, u.first_name AS student_first_name, u.last_name AS student_last_name FROM survey_responses sr JOIN users u ON u.id = sr.student_id WHERE sr.survey_id = ? AND sr.student_id = ?",
      [req.params.id, req.user.sub]
    );
    if (!rows[0]) return res.json(null);
    res.json(mapResponse(rows[0], false));
  } catch (err) {
    next(err);
  }
});

router.get("/:id/responses", requireAuth, requireRole("TEACHER"), async (req, res, next) => {
  try {
    const survey = await getSurveyById(req.params.id);
    if (!survey) return res.status(404).json({ message: "Survey not found" });
    if (!canManageSurvey(survey, req.user)) {
      return res.status(403).json({ message: "Forbidden" });
    }
    const rows = await query(
      "SELECT sr.*, u.first_name AS student_first_name, u.last_name AS student_last_name FROM survey_responses sr JOIN users u ON u.id = sr.student_id WHERE sr.survey_id = ? ORDER BY sr.submitted_at DESC",
      [req.params.id]
    );
    const hideIdentity = !!survey.is_anonymous;
    res.json(rows.map((row) => mapResponse(row, hideIdentity)));
  } catch (err) {
    next(err);
  }
});

router.put("/:id", requireAuth, requireRole("TEACHER"), async (req, res, next) => {
  try {
    await ensureSurveysSchema();
    const survey = await getSurveyById(req.params.id);
    if (!survey) return res.status(404).json({ message: "Survey not found" });
    if (!canManageSurvey(survey, req.user)) {
      return res.status(403).json({ message: "Forbidden" });
    }
    const body = createSchema.parse(req.body);
    await query(
      "UPDATE surveys SET subject_id = ?, title = ?, description = ?, deadline = ?, is_anonymous = ?, questions = ?, target_type = ?, target_id = ? WHERE id = ?",
      [
        body.subjectId ?? null,
        body.title,
        body.description,
        new Date(body.deadline),
        body.isAnonymous ? 1 : 0,
        JSON.stringify(body.questions),
        body.targetType ?? null,
        body.targetId ?? null,
        req.params.id,
      ]
    );
    const updated = await getSurveyById(req.params.id);
    res.json(mapSurvey(updated));
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", requireAuth, requireRole("TEACHER"), async (req, res, next) => {
  try {
    const survey = await getSurveyById(req.params.id);
    if (!survey) return res.status(404).json({ message: "Survey not found" });
    if (!canManageSurvey(survey, req.user)) {
      return res.status(403).json({ message: "Forbidden" });
    }
    await query("DELETE FROM survey_responses WHERE survey_id = ?", [req.params.id]);
    await query("DELETE FROM surveys WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/respond", requireAuth, requireRole("STUDENT"), async (req, res, next) => {
  try {
    const survey = await getSurveyById(req.params.id);
    if (!survey) return res.status(404).json({ message: "Survey not found" });
    const allowed = await canStudentAccessSurvey(survey, req.user.sub);
    if (!allowed) return res.status(403).json({ message: "Forbidden" });

    const body = submitSchema.parse(req.body);
    const questions = Array.isArray(parseJson(survey.questions, []))
      ? parseJson(survey.questions, [])
      : [];
    const normalizedAnswers = questions.map((question, index) => {
      const answer = body.answers[index];
      if (question.type === "single") {
        if (typeof answer !== "number") return null;
        if (answer < 0 || !Array.isArray(question.options)) return null;
        if (answer >= question.options.length) return null;
        return answer;
      }
      if (typeof answer !== "string") return null;
      const trimmed = answer.trim();
      return trimmed.length ? trimmed.slice(0, 1000) : null;
    });

    const submittedAt = new Date();
    const existing = await query(
      "SELECT id FROM survey_responses WHERE survey_id = ? AND student_id = ?",
      [req.params.id, req.user.sub]
    );
    if (existing[0]) {
      return res.status(409).json({ message: "You have already responded to this survey." });
    }

    const id = uuid();
    await query(
      "INSERT INTO survey_responses (id, survey_id, student_id, answers, submitted_at) VALUES (?,?,?,?,?)",
      [id, req.params.id, req.user.sub, JSON.stringify(normalizedAnswers), submittedAt]
    );
    res.json({
      id,
      surveyId: req.params.id,
      studentId: req.user.sub,
      answers: normalizedAnswers,
      submittedAt,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", requireAuth, async (req, res, next) => {
  try {
    const survey = await getSurveyById(req.params.id);
    if (!survey) return res.status(404).json({ message: "Survey not found" });
    if (req.user.role === "TEACHER") {
      if (!canManageSurvey(survey, req.user)) {
        return res.status(403).json({ message: "Forbidden" });
      }
      return res.json(mapSurvey(survey));
    }
    const allowed = await canStudentAccessSurvey(survey, req.user.sub);
    if (!allowed) return res.status(403).json({ message: "Forbidden" });
    res.json(mapSurvey(survey));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
