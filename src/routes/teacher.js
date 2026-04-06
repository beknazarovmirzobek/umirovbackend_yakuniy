const express = require("express");
const bcrypt = require("bcryptjs");
const { z } = require("zod");
const { v4: uuid } = require("uuid");

const { pool, query } = require("../db");
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
const updateStudentSchema = createStudentSchema.omit({ password: true });

const groupSchema = z.object({
  name: z.string().min(1),
  code: z.string().min(1),
});

function mapPublicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    firstName: user.first_name,
    lastName: user.last_name,
    mustChangePassword: !!user.must_change_password,
    createdAt: user.created_at,
  };
}

async function getStudentRow(studentId) {
  const users = await query("SELECT * FROM users WHERE id = ? AND role = 'STUDENT'", [studentId]);
  return users[0] || null;
}

async function deleteAdaptiveQuizRows(execute, studentId) {
  for (const statement of [
    "DELETE FROM adaptive_quiz_sessions WHERE user_id = ?",
    "DELETE FROM adaptive_quiz_answer_logs WHERE user_id = ?",
  ]) {
    try {
      await execute(statement, [studentId]);
    } catch (err) {
      if (err?.code !== "ER_NO_SUCH_TABLE") {
        throw err;
      }
    }
  }
}

router.get("/students", requireAuth, requireRole("TEACHER"), async (req, res, next) => {
  try {
    const groupId = req.query.groupId;
    if (groupId) {
      const rows = await query(
        "SELECT u.* FROM users u JOIN group_members gm ON gm.student_id = u.id WHERE u.role = 'STUDENT' AND gm.group_id = ?",
        [groupId]
      );
      return res.json(
        rows.map(mapPublicUser)
      );
    }

    const rows = await query("SELECT * FROM users WHERE role = 'STUDENT'");
    res.json(rows.map(mapPublicUser));
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
        rows.map(mapPublicUser)
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

    res.json(
      mapPublicUser({
        id,
        username: body.username,
        role: "STUDENT",
        first_name: body.firstName,
        last_name: body.lastName,
        must_change_password: 1,
        created_at: new Date().toISOString(),
      })
    );
  } catch (err) {
    next(err);
  }
});

router.put(
  "/students/:id",
  requireAuth,
  requireRole("TEACHER"),
  async (req, res, next) => {
    try {
      const body = updateStudentSchema.parse(req.body);
      const student = await getStudentRow(req.params.id);
      if (!student) return res.status(404).json({ message: "Student not found" });

      const nextUsername = body.username.trim();
      const duplicate = await query("SELECT id FROM users WHERE username = ? AND id <> ? LIMIT 1", [
        nextUsername,
        student.id,
      ]);
      if (duplicate[0]) {
        return res.status(400).json({ message: "Username already exists" });
      }

      await query("UPDATE users SET first_name = ?, last_name = ?, username = ? WHERE id = ?", [
        body.firstName.trim(),
        body.lastName.trim(),
        nextUsername,
        student.id,
      ]);

      const updated = await getStudentRow(student.id);
      if (!updated) return res.status(404).json({ message: "Student not found" });
      res.json(mapPublicUser(updated));
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  "/students/:id",
  requireAuth,
  requireRole("TEACHER"),
  async (req, res, next) => {
    const connection = await pool.getConnection();
    let transactionStarted = false;
    try {
      const student = await getStudentRow(req.params.id);
      if (!student) return res.status(404).json({ message: "Student not found" });

      const execute = async (sql, params = []) => {
        await connection.execute(sql, params);
      };

      await connection.beginTransaction();
      transactionStarted = true;
      await execute("DELETE FROM group_members WHERE student_id = ?", [student.id]);
      await execute("DELETE FROM attendance WHERE student_id = ?", [student.id]);
      await execute("DELETE FROM submissions WHERE student_id = ?", [student.id]);
      await execute("DELETE FROM grades WHERE student_id = ?", [student.id]);
      await execute("DELETE FROM test_attempts WHERE student_id = ?", [student.id]);
      await execute("DELETE FROM test_sessions WHERE student_id = ?", [student.id]);
      await execute("DELETE FROM test_permissions WHERE student_id = ?", [student.id]);
      await execute("DELETE FROM survey_responses WHERE student_id = ?", [student.id]);
      await execute("DELETE FROM refresh_tokens WHERE user_id = ?", [student.id]);
      await deleteAdaptiveQuizRows(execute, student.id);
      await execute("DELETE FROM users WHERE id = ? AND role = 'STUDENT'", [student.id]);
      await connection.commit();

      res.json({ ok: true });
    } catch (err) {
      if (transactionStarted) {
        await connection.rollback();
      }
      next(err);
    } finally {
      connection.release();
    }
  }
);

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

      res.json(mapPublicUser(u));
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
      const u = await getStudentRow(req.params.id);
      if (!u) return res.status(404).json({ message: "Student not found" });
      res.json(mapPublicUser(u));
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
