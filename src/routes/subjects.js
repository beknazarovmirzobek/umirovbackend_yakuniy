const express = require("express");
const { z } = require("zod");
const { v4: uuid } = require("uuid");

const { query } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

const createSchema = z.object({
  name: z.string().min(1),
  code: z.string().min(1),
});

router.get("/", requireAuth, async (req, res, next) => {
  try {
    let rows = [];
    if (req.user.role === "TEACHER") {
      rows = await query(
        "SELECT * FROM subjects WHERE teacher_id = ? ORDER BY created_at DESC",
        [req.user.sub]
      );
    } else {
      rows = await query(
        "SELECT DISTINCT s.* FROM subjects s JOIN assignments a ON a.subject_id = s.id LEFT JOIN group_members gm ON gm.group_id = a.target_id AND gm.student_id = ? WHERE (a.target_type IS NULL) OR (a.target_type = 'GROUP' AND gm.student_id IS NOT NULL) OR (a.target_type = 'STUDENT' AND a.target_id = ?) ORDER BY s.created_at DESC",
        [req.user.sub, req.user.sub]
      );
    }
    res.json(
      rows.map((s) => ({
        id: s.id,
        name: s.name,
        code: s.code,
        teacherId: s.teacher_id,
        createdAt: s.created_at,
      }))
    );
  } catch (err) {
    next(err);
  }
});

router.post("/", requireAuth, requireRole("TEACHER"), async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);
    const id = uuid();
    await query(
      "INSERT INTO subjects (id, name, code, teacher_id) VALUES (?,?,?,?)",
      [id, body.name, body.code, req.user.sub]
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

router.put("/:id", requireAuth, requireRole("TEACHER"), async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);
    await query("UPDATE subjects SET name = ?, code = ? WHERE id = ? AND teacher_id = ?", [
      body.name,
      body.code,
      req.params.id,
      req.user.sub,
    ]);
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
});

router.delete("/:id", requireAuth, requireRole("TEACHER"), async (req, res, next) => {
  try {
    await query("DELETE FROM subjects WHERE id = ? AND teacher_id = ?", [
      req.params.id,
      req.user.sub,
    ]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
