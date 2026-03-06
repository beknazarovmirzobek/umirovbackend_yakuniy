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

router.get("/assignments", requireAuth, requireRole("STUDENT"), async (req, res, next) => {
  try {
    const rows = await query(
      "SELECT a.* FROM assignments a LEFT JOIN group_members gm ON gm.group_id = a.target_id AND gm.student_id = ? WHERE (a.target_type IS NULL) OR (a.target_type = 'GROUP' AND gm.student_id IS NOT NULL) OR (a.target_type = 'STUDENT' AND a.target_id = ?) ORDER BY a.created_at DESC",
      [req.user.sub, req.user.sub]
    );
    res.json(
      rows.map((a) => ({
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
        createdAt: a.created_at,
        isLab: !!a.is_lab,
        labEditor: a.lab_editor,
      }))
    );
  } catch (err) {
    next(err);
  }
});

router.get("/submissions", requireAuth, requireRole("STUDENT"), async (req, res, next) => {
  try {
    const rows = await query("SELECT * FROM submissions WHERE student_id = ?", [
      req.user.sub,
    ]);
    res.json(
      rows.map((s) => ({
        id: s.id,
        assignmentId: s.assignment_id,
        studentId: s.student_id,
        submittedAt: s.submitted_at,
        text: s.text,
        files: normalizeSubmissionFiles(s.file),
        isLate: !!s.is_late,
        contentHtml: s.content_html,
        sheetJson:
          s.sheet_json && typeof s.sheet_json === "string"
            ? JSON.parse(s.sheet_json)
            : s.sheet_json ?? null,
      }))
    );
  } catch (err) {
    next(err);
  }
});

router.post(
  "/assignments/:id/submit",
  requireAuth,
  requireRole("STUDENT"),
  async (req, res, next) => {
    try {
      const schema = z.object({
        text: z.string().optional().default(""),
        files: z.array(z.any()).optional(),
        file: z.any().optional(),
        contentHtml: z.string().optional(),
        sheetJson: z.any().optional(),
      });
      const body = schema.parse(req.body);
      const files = Array.isArray(body.files)
        ? body.files
        : body.file
          ? [body.file]
          : [];
      const assignmentRows = await query("SELECT * FROM assignments WHERE id = ?", [
        req.params.id,
      ]);
      const assignment = assignmentRows[0];
      if (!assignment) return res.status(404).json({ message: "Assignment not found" });
      const submittedAt = new Date();
      const isLate = submittedAt.getTime() > new Date(assignment.deadline).getTime();

      const existing = await query(
        "SELECT id FROM submissions WHERE assignment_id = ? AND student_id = ?",
        [req.params.id, req.user.sub]
      );
      const contentHtml = body.contentHtml ?? null;
      const sheetJson = body.sheetJson ?? null;
      if (existing[0]) {
        await query(
          "UPDATE submissions SET submitted_at = ?, text = ?, content_html = ?, sheet_json = ?, file = ?, is_late = ? WHERE id = ?",
          [
            submittedAt,
            body.text,
            contentHtml,
            sheetJson ? JSON.stringify(sheetJson) : null,
            files.length ? JSON.stringify(files) : null,
            isLate ? 1 : 0,
            existing[0].id,
          ]
        );
        return res.json({
          id: existing[0].id,
          assignmentId: req.params.id,
          studentId: req.user.sub,
          submittedAt,
          text: body.text,
          contentHtml,
          sheetJson,
          files,
          isLate,
        });
      }

      const id = uuid();
      await query(
        "INSERT INTO submissions (id, assignment_id, student_id, submitted_at, text, content_html, sheet_json, file, is_late) VALUES (?,?,?,?,?,?,?,?,?)",
        [
          id,
          req.params.id,
          req.user.sub,
          submittedAt,
          body.text,
          contentHtml,
          sheetJson ? JSON.stringify(sheetJson) : null,
          files.length ? JSON.stringify(files) : null,
          isLate ? 1 : 0,
        ]
      );
      res.json({
        id,
        assignmentId: req.params.id,
        studentId: req.user.sub,
        submittedAt,
        text: body.text,
        contentHtml,
        sheetJson,
        files,
        isLate,
      });
    } catch (err) {
      next(err);
    }
  }
);

router.get("/grades", requireAuth, requireRole("STUDENT"), async (req, res, next) => {
  try {
    const rows = await query("SELECT * FROM grades WHERE student_id = ?", [req.user.sub]);
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

router.get("/attendance", requireAuth, requireRole("STUDENT"), async (req, res, next) => {
  try {
    const rows = await query("SELECT * FROM attendance WHERE student_id = ?", [
      req.user.sub,
    ]);
    res.json(
      rows.map((r) => ({
        id: r.id,
        lessonId: r.lesson_id,
        studentId: r.student_id,
        status: r.status,
        recordedAt: r.recorded_at,
      }))
    );
  } catch (err) {
    next(err);
  }
});

router.put("/profile", requireAuth, requireRole("STUDENT"), async (req, res, next) => {
  try {
    const schema = z.object({
      firstName: z.string().min(1),
      lastName: z.string().min(1),
      username: z.string().min(1),
    });
    const body = schema.parse(req.body);
    await query(
      "UPDATE users SET first_name = ?, last_name = ?, username = ? WHERE id = ?",
      [body.firstName, body.lastName, body.username, req.user.sub]
    );
    res.json({
      id: req.user.sub,
      username: body.username,
      role: "STUDENT",
      firstName: body.firstName,
      lastName: body.lastName,
      mustChangePassword: false,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
