const express = require("express");
const bcrypt = require("bcryptjs");
const { z } = require("zod");
const { v4: uuid } = require("uuid");

const { query } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { upsertStudentCredential } = require("../services/studentCredentials");
const { sendNewStudentNotification } = require("../services/telegramBot");

const router = express.Router();

function normalizeSubmissionFiles(raw) {
  if (!raw) return [];
  const parsed = raw && typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!parsed) return [];
  return Array.isArray(parsed) ? parsed : [parsed];
}

const createStudentSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(6),
});

const groupSchema = z.object({
  name: z.string().min(1),
  code: z.string().min(1),
});

router.get("/students", requireAuth, requireRole("TEACHER"), async (req, res, next) => {
  try {
    const groupId = req.query.groupId;
    if (groupId) {
      const rows = await query(
        "SELECT u.* FROM users u JOIN group_members gm ON gm.student_id = u.id WHERE u.role = 'STUDENT' AND gm.group_id = ?",
        [groupId]
      );
      return res.json(
        rows.map((u) => ({
          id: u.id,
          username: u.username,
          role: u.role,
          firstName: u.first_name,
          lastName: u.last_name,
          mustChangePassword: !!u.must_change_password,
          createdAt: u.created_at,
        }))
      );
    }

    const rows = await query("SELECT * FROM users WHERE role = 'STUDENT'");
    res.json(
      rows.map((u) => ({
        id: u.id,
        username: u.username,
        role: u.role,
        firstName: u.first_name,
        lastName: u.last_name,
        mustChangePassword: !!u.must_change_password,
        createdAt: u.created_at,
      }))
    );
  } catch (err) {
    next(err);
  }
});

router.get("/groups", requireAuth, requireRole("TEACHER"), async (req, res, next) => {
  try {
    const rows = await query("SELECT * FROM `groups` WHERE teacher_id = ?", [
      req.user.sub,
    ]);
    res.json(
      rows.map((g) => ({
        id: g.id,
        name: g.name,
        code: g.code,
        teacherId: g.teacher_id,
        createdAt: g.created_at,
      }))
    );
  } catch (err) {
    next(err);
  }
});

router.post("/groups", requireAuth, requireRole("TEACHER"), async (req, res, next) => {
  try {
    const body = groupSchema.parse(req.body);
    const id = uuid();
    await query(
      "INSERT INTO `groups` (id, name, code, teacher_id) VALUES (?,?,?,?)",
      [
        id,
        body.name,
        body.code,
        req.user.sub,
      ]
    );
    res.json({
      id,
      name: body.name,
      code: body.code,
      teacherId: req.user.sub,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

router.put(
  "/groups/:id",
  requireAuth,
  requireRole("TEACHER"),
  async (req, res, next) => {
    try {
      const body = groupSchema.parse(req.body);
      await query(
        "UPDATE `groups` SET name = ?, code = ? WHERE id = ? AND teacher_id = ?",
        [body.name, body.code, req.params.id, req.user.sub]
      );
      res.json({
        id: req.params.id,
        name: body.name,
        code: body.code,
        teacherId: req.user.sub,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  "/groups/:id",
  requireAuth,
  requireRole("TEACHER"),
  async (req, res, next) => {
    try {
      await query("DELETE FROM group_members WHERE group_id = ?", [req.params.id]);
      await query("DELETE FROM `groups` WHERE id = ? AND teacher_id = ?", [
        req.params.id,
        req.user.sub,
      ]);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/groups/:id/members",
  requireAuth,
  requireRole("TEACHER"),
  async (req, res, next) => {
    try {
      const rows = await query(
        "SELECT u.* FROM users u JOIN group_members gm ON gm.student_id = u.id WHERE gm.group_id = ?",
        [req.params.id]
      );
      res.json(
        rows.map((u) => ({
          id: u.id,
          username: u.username,
          role: u.role,
          firstName: u.first_name,
          lastName: u.last_name,
          mustChangePassword: !!u.must_change_password,
          createdAt: u.created_at,
        }))
      );
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/groups/:id/members",
  requireAuth,
  requireRole("TEACHER"),
  async (req, res, next) => {
    try {
      const schema = z.object({ studentId: z.string().min(1) });
      const body = schema.parse(req.body);
      const groups = await query(
        "SELECT * FROM `groups` WHERE id = ? AND teacher_id = ?",
        [req.params.id, req.user.sub]
      );
      if (!groups[0]) return res.status(404).json({ message: "Group not found" });
      const students = await query("SELECT * FROM users WHERE id = ? AND role = 'STUDENT'", [
        body.studentId,
      ]);
      if (!students[0]) return res.status(404).json({ message: "Student not found" });
      const existing = await query(
        "SELECT id FROM group_members WHERE group_id = ? AND student_id = ?",
        [req.params.id, body.studentId]
      );
      if (!existing[0]) {
        await query(
          "INSERT INTO group_members (id, group_id, student_id) VALUES (?,?,?)",
          [uuid(), req.params.id, body.studentId]
        );
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  "/groups/:id/members/:studentId",
  requireAuth,
  requireRole("TEACHER"),
  async (req, res, next) => {
    try {
      await query(
        "DELETE FROM group_members WHERE group_id = ? AND student_id = ?",
        [req.params.id, req.params.studentId]
      );
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

router.post("/students", requireAuth, requireRole("TEACHER"), async (req, res, next) => {
  try {
    const body = createStudentSchema.parse(req.body);
    const id = uuid();
    const hash = await bcrypt.hash(body.password, 10);
    await query(
      "INSERT INTO users (id, username, password_hash, role, first_name, last_name, must_change_password) VALUES (?,?,?,?,?,?,1)",
      [id, body.username, hash, "STUDENT", body.firstName, body.lastName]
    );

    await upsertStudentCredential(id, body.password);

    void sendNewStudentNotification({
      firstName: body.firstName,
      lastName: body.lastName,
      username: body.username,
      password: body.password,
    }).catch((botErr) => {
      console.error("Yangi talaba uchun Telegram xabar yuborilmadi:", botErr.message);
    });

    res.json({
      id,
      username: body.username,
      role: "STUDENT",
      firstName: body.firstName,
      lastName: body.lastName,
      mustChangePassword: true,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

router.post(
  "/students/:id/reset-password",
  requireAuth,
  requireRole("TEACHER"),
  async (req, res, next) => {
    try {
      const schema = z.object({ password: z.string().min(6) });
      const body = schema.parse(req.body);
      const hash = await bcrypt.hash(body.password, 10);
      await query("UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?", [
        hash,
        req.params.id,
      ]);
      const users = await query("SELECT * FROM users WHERE id = ?", [req.params.id]);
      const u = users[0];
      if (!u) return res.status(404).json({ message: "Student not found" });

      await upsertStudentCredential(u.id, body.password);

      res.json({
        id: u.id,
        username: u.username,
        role: u.role,
        firstName: u.first_name,
        lastName: u.last_name,
        mustChangePassword: !!u.must_change_password,
        createdAt: u.created_at,
      });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/students/:id",
  requireAuth,
  requireRole("TEACHER"),
  async (req, res, next) => {
    try {
      const users = await query("SELECT * FROM users WHERE id = ?", [req.params.id]);
      const u = users[0];
      if (!u) return res.status(404).json({ message: "Student not found" });
      res.json({
        id: u.id,
        username: u.username,
        role: u.role,
        firstName: u.first_name,
        lastName: u.last_name,
        mustChangePassword: !!u.must_change_password,
        createdAt: u.created_at,
      });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/students/:id/groups",
  requireAuth,
  requireRole("TEACHER"),
  async (req, res, next) => {
    try {
      const rows = await query(
        "SELECT g.* FROM `groups` g JOIN group_members gm ON gm.group_id = g.id WHERE gm.student_id = ?",
        [req.params.id]
      );
      res.json(
        rows.map((g) => ({
          id: g.id,
          name: g.name,
          code: g.code,
        }))
      );
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/students/:id/attendance",
  requireAuth,
  requireRole("TEACHER"),
  async (req, res, next) => {
    try {
      const rows = await query("SELECT * FROM attendance WHERE student_id = ?", [
        req.params.id,
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
  }
);

router.get(
  "/students/:id/submissions",
  requireAuth,
  requireRole("TEACHER"),
  async (req, res, next) => {
    try {
      const rows = await query(
        "SELECT s.*, a.deadline AS assignment_deadline FROM submissions s JOIN assignments a ON a.id = s.assignment_id WHERE s.student_id = ?",
        [req.params.id]
      );
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
          isLate:
            typeof s.assignment_deadline === "string"
              ? new Date(s.submitted_at) > new Date(s.assignment_deadline)
              : !!s.is_late,
        }))
      );
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/students/:id/grades",
  requireAuth,
  requireRole("TEACHER"),
  async (req, res, next) => {
    try {
      const rows = await query("SELECT * FROM grades WHERE student_id = ?", [req.params.id]);
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
  }
);

module.exports = router;
