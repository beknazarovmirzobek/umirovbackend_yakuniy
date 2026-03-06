const express = require("express");
const { z } = require("zod");
const { v4: uuid } = require("uuid");

const { query } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

function normalizeSubmissionFiles(raw) {
  if (!raw) return [];
  const parsed = raw && typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!parsed) return [];
  return Array.isArray(parsed) ? parsed : [parsed];
}

const createSchema = z.object({
  subjectId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  deadline: z.string().min(1),
  maxScore: z.number().min(0).max(100).default(100),
  attachments: z.array(z.any()).optional(),
  targetType: z.enum(["GROUP", "STUDENT"]).optional(),
  targetId: z.string().nullable().optional(),
  isLab: z.boolean().optional(),
  labEditor: z.enum(["word", "excel"]).optional(),
});

const gradeSchema = z.object({
  assignmentId: z.string().min(1),
  studentId: z.string().min(1),
  score: z.number().min(0).max(100),
});

function mapGrade(score) {
  if (score < 60) return "FAIL";
  if (score < 70) return "3";
  if (score < 90) return "4";
  return "5";
}

async function getAssignmentById(id) {
  const rows = await query(
    "SELECT a.*, u.first_name AS teacher_first_name, u.last_name AS teacher_last_name FROM assignments a JOIN users u ON u.id = a.teacher_id WHERE a.id = ?",
    [id]
  );
  return rows[0];
}

async function canStudentAccessAssignment(assignment, studentId) {
  if (!assignment) return false;
  if (!assignment.target_type) return true;
  if (assignment.target_type === "STUDENT") return assignment.target_id === studentId;
  if (assignment.target_type === "GROUP") {
    const rows = await query(
      "SELECT id FROM group_members WHERE group_id = ? AND student_id = ?",
      [assignment.target_id, studentId]
    );
    return !!rows[0];
  }
  return false;
}

function mapAssignment(a) {
  return {
    id: a.id,
    subjectId: a.subject_id,
    teacherId: a.teacher_id,
    title: a.title,
    description: a.description,
    deadline: a.deadline,
    maxScore: a.max_score,
    attachments:
      a.attachments && typeof a.attachments === "string"
        ? JSON.parse(a.attachments)
        : a.attachments || [],
    targetType: a.target_type ?? null,
    targetId: a.target_id ?? null,
    isLab: !!a.is_lab,
    labEditor: a.lab_editor,
    teacherName:
      [a.teacher_first_name, a.teacher_last_name].filter(Boolean).join(" ") || null,
    createdAt: a.created_at,
  };
}

router.get("/", requireAuth, requireRole("TEACHER"), async (req, res, next) => {
  try {
    const rows = await query(
      "SELECT a.*, u.first_name AS teacher_first_name, u.last_name AS teacher_last_name FROM assignments a JOIN users u ON u.id = a.teacher_id WHERE a.teacher_id = ? ORDER BY a.created_at DESC",
      [req.user.sub]
    );
    res.json(rows.map(mapAssignment));
  } catch (err) {
    next(err);
  }
});

router.post("/", requireAuth, requireRole("TEACHER"), async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);
    const id = uuid();
    await query(
      "INSERT INTO assignments (id, subject_id, teacher_id, title, description, deadline, max_score, attachments, target_type, target_id, is_lab, lab_editor) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        id,
        body.subjectId,
        req.user.sub,
        body.title,
        body.description,
        new Date(body.deadline),
        body.maxScore ?? 100,
        JSON.stringify(body.attachments ?? []),
        body.targetType ?? null,
        body.targetId ?? null,
        body.isLab ? 1 : 0,
        body.labEditor ?? "word",
      ]
    );
    res.json({
      id,
      subjectId: body.subjectId,
      teacherId: req.user.sub,
      title: body.title,
      description: body.description,
      deadline: body.deadline,
      maxScore: body.maxScore ?? 100,
      attachments: body.attachments ?? [],
      targetType: body.targetType ?? null,
      targetId: body.targetId ?? null,
      isLab: !!body.isLab,
      labEditor: body.labEditor ?? "word",
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", requireAuth, async (req, res, next) => {
  try {
    const a = await getAssignmentById(req.params.id);
    if (!a) return res.status(404).json({ message: "Assignment not found" });
    if (req.user.role === "TEACHER" && a.teacher_id !== req.user.sub) {
      return res.status(403).json({ message: "Forbidden" });
    }
    if (req.user.role === "STUDENT") {
      const allowed = await canStudentAccessAssignment(a, req.user.sub);
      if (!allowed) return res.status(403).json({ message: "Forbidden" });
    }
    res.json(mapAssignment(a));
  } catch (err) {
    next(err);
  }
});

router.get("/:id/submissions", requireAuth, requireRole("TEACHER"), async (req, res, next) => {
  try {
    const assignment = await getAssignmentById(req.params.id);
    if (!assignment) return res.status(404).json({ message: "Assignment not found" });
    if (assignment.teacher_id !== req.user.sub) {
      return res.status(403).json({ message: "Forbidden" });
    }
    const rows = await query("SELECT * FROM submissions WHERE assignment_id = ?", [
      req.params.id,
    ]);
    res.json(
      rows.map((s) => ({
        id: s.id,
        assignmentId: s.assignment_id,
        studentId: s.student_id,
        submittedAt: s.submitted_at,
        text: s.text,
        files: normalizeSubmissionFiles(s.file),
        contentHtml: s.content_html ?? null,
        sheetJson:
          s.sheet_json && typeof s.sheet_json === "string"
            ? JSON.parse(s.sheet_json)
            : s.sheet_json ?? null,
        isLate: !!s.is_late,
      }))
    );
  } catch (err) {
    next(err);
  }
});

router.get("/:id/grades", requireAuth, requireRole("TEACHER"), async (req, res, next) => {
  try {
    const assignment = await getAssignmentById(req.params.id);
    if (!assignment) return res.status(404).json({ message: "Assignment not found" });
    if (assignment.teacher_id !== req.user.sub) {
      return res.status(403).json({ message: "Forbidden" });
    }
    const rows = await query("SELECT * FROM grades WHERE assignment_id = ?", [req.params.id]);
    res.json(
      rows.map((g) => ({
        id: g.id,
        assignmentId: g.assignment_id,
        studentId: g.student_id,
        score: g.score,
        grade: g.grade,
        gradedAt: g.graded_at,
        teacherId: g.teacher_id,
      }))
    );
  } catch (err) {
    next(err);
  }
});

router.post("/:id/grade", requireAuth, requireRole("TEACHER"), async (req, res, next) => {
  try {
    const assignment = await getAssignmentById(req.params.id);
    if (!assignment) return res.status(404).json({ message: "Assignment not found" });
    if (assignment.teacher_id !== req.user.sub) {
      return res.status(403).json({ message: "Forbidden" });
    }
    const body = gradeSchema.parse({ ...req.body, assignmentId: req.params.id });
    const grade = mapGrade(body.score);
    const existing = await query(
      "SELECT id FROM grades WHERE assignment_id = ? AND student_id = ?",
      [body.assignmentId, body.studentId]
    );
    if (existing[0]) {
      await query(
        "UPDATE grades SET score = ?, grade = ?, graded_at = ?, teacher_id = ? WHERE id = ?",
        [body.score, grade, new Date(), req.user.sub, existing[0].id]
      );
      return res.json({
        id: existing[0].id,
        assignmentId: body.assignmentId,
        studentId: body.studentId,
        score: body.score,
        grade,
        gradedAt: new Date().toISOString(),
        teacherId: req.user.sub,
      });
    }
    const id = uuid();
    await query(
      "INSERT INTO grades (id, assignment_id, student_id, score, grade, graded_at, teacher_id) VALUES (?,?,?,?,?,?,?)",
      [id, body.assignmentId, body.studentId, body.score, grade, new Date(), req.user.sub]
    );
    res.json({
      id,
      assignmentId: body.assignmentId,
      studentId: body.studentId,
      score: body.score,
      grade,
      gradedAt: new Date().toISOString(),
      teacherId: req.user.sub,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
