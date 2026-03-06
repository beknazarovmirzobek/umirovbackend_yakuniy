const express = require("express");
const { z } = require("zod");
const { v4: uuid } = require("uuid");

const { query } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

const createSchema = z.object({
  subjectId: z.string().min(1),
  dateTime: z.string().min(1),
  topic: z.string().min(1),
});

router.get("/", requireAuth, requireRole("TEACHER"), async (req, res, next) => {
  try {
    const rows = await query(
      "SELECT * FROM lessons WHERE teacher_id = ? ORDER BY date_time DESC",
      [req.user.sub]
    );
    res.json(
      rows.map((l) => ({
        id: l.id,
        subjectId: l.subject_id,
        teacherId: l.teacher_id,
        dateTime: l.date_time,
        topic: l.topic,
        createdAt: l.created_at,
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
      "INSERT INTO lessons (id, subject_id, teacher_id, date_time, topic) VALUES (?,?,?,?,?)",
      [id, body.subjectId, req.user.sub, new Date(body.dateTime), body.topic]
    );
    res.json({
      id,
      subjectId: body.subjectId,
      teacherId: req.user.sub,
      dateTime: body.dateTime,
      topic: body.topic,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/attendance", requireAuth, requireRole("TEACHER"), async (req, res, next) => {
  try {
    const lessonRows = await query("SELECT * FROM lessons WHERE id = ?", [req.params.id]);
    const lesson = lessonRows[0];
    if (!lesson) return res.status(404).json({ message: "Lesson not found" });
    if (lesson.teacher_id !== req.user.sub) {
      return res.status(403).json({ message: "Forbidden" });
    }
    const records = z
      .array(
        z.object({
          studentId: z.string().min(1),
          status: z.enum(["ABSENT", "ONTIME", "LATE"]),
        })
      )
      .parse(req.body);

    await query("DELETE FROM attendance WHERE lesson_id = ?", [req.params.id]);
    for (const record of records) {
      await query(
        "INSERT INTO attendance (id, lesson_id, student_id, status) VALUES (?,?,?,?)",
        [uuid(), req.params.id, record.studentId, record.status]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get("/:id/attendance", requireAuth, requireRole("TEACHER"), async (req, res, next) => {
  try {
    const lessonRows = await query("SELECT * FROM lessons WHERE id = ?", [req.params.id]);
    const lesson = lessonRows[0];
    if (!lesson) return res.status(404).json({ message: "Lesson not found" });
    if (lesson.teacher_id !== req.user.sub) {
      return res.status(403).json({ message: "Forbidden" });
    }
    const rows = await query("SELECT * FROM attendance WHERE lesson_id = ?", [
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
});

module.exports = router;
