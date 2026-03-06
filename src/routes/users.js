const express = require("express");
const { query } = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.get("/me", requireAuth, async (req, res, next) => {
  try {
    const users = await query("SELECT * FROM users WHERE id = ?", [req.user.sub]);
    const user = users[0];
    if (!user) return res.status(404).json({ message: "User not found" });
    let groups = [];
    if (user.role === "STUDENT") {
      const rows = await query(
        "SELECT g.* FROM `groups` g JOIN group_members gm ON gm.group_id = g.id WHERE gm.student_id = ?",
        [user.id]
      );
      groups = rows.map((g) => ({
        id: g.id,
        name: g.name,
        code: g.code,
        teacherId: g.teacher_id,
        createdAt: g.created_at,
      }));
    }
    res.json({
      id: user.id,
      username: user.username,
      role: user.role,
      firstName: user.first_name,
      lastName: user.last_name,
      mustChangePassword: !!user.must_change_password,
      groups,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
