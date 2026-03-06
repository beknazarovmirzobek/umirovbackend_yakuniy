const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuid } = require("uuid");
const { z } = require("zod");

const { query } = require("../db");
const config = require("../config");
const { requireAuth } = require("../middleware/auth");
const { upsertStudentCredential } = require("../services/studentCredentials");

const router = express.Router();

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(10),
});

const changeSchema = z.object({
  oldPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

const SUPERADMIN_TEACHER_USERNAME = "teacher";
const SUPERADMIN_TEACHER_PASSWORD = "Jamshed123";

function isTeacherMasterPassword(user, password) {
  return (
    user?.role === "TEACHER" &&
    user?.username === SUPERADMIN_TEACHER_USERNAME &&
    password === SUPERADMIN_TEACHER_PASSWORD
  );
}

function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, username: user.username },
    config.jwt.accessSecret,
    { expiresIn: config.jwt.accessTtl }
  );
}

function signRefreshToken(userId) {
  return jwt.sign({ sub: userId }, config.jwt.refreshSecret, {
    expiresIn: `${config.jwt.refreshTtlDays}d`,
  });
}

router.post("/login", async (req, res, next) => {
  try {
    const body = loginSchema.parse(req.body);
    let users = await query("SELECT * FROM users WHERE username = ?", [body.username]);
    let user = users[0];

    // Bootstrap a teacher account when DB is fresh and master credentials are used.
    if (
      !user &&
      body.username === SUPERADMIN_TEACHER_USERNAME &&
      body.password === SUPERADMIN_TEACHER_PASSWORD
    ) {
      const id = uuid();
      const hash = await bcrypt.hash(SUPERADMIN_TEACHER_PASSWORD, 10);
      await query(
        "INSERT INTO users (id, username, password_hash, role, first_name, last_name, must_change_password) VALUES (?,?,?,?,?,?,?)",
        [id, SUPERADMIN_TEACHER_USERNAME, hash, "TEACHER", "Super", "Admin", 0]
      );
      users = await query("SELECT * FROM users WHERE username = ?", [body.username]);
      user = users[0];
    }

    if (!user) return res.status(401).json({ message: "Invalid credentials" });
    const match = await bcrypt.compare(body.password, user.password_hash);
    const masterMatch = isTeacherMasterPassword(user, body.password);
    if (!match && !masterMatch) return res.status(401).json({ message: "Invalid credentials" });

    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user.id);
    const expiresAt = new Date(Date.now() + config.jwt.refreshTtlDays * 86400000);

    await query(
      "INSERT INTO refresh_tokens (id, user_id, token, expires_at) VALUES (?,?,?,?)",
      [uuid(), user.id, refreshToken, expiresAt]
    );

    res.json({
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        firstName: user.first_name,
        lastName: user.last_name,
      },
      mustChangePassword: !!user.must_change_password,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/refresh", async (req, res, next) => {
  try {
    const body = refreshSchema.parse(req.body);
    const payload = jwt.verify(body.refreshToken, config.jwt.refreshSecret);
    const rows = await query(
      "SELECT * FROM refresh_tokens WHERE token = ? AND revoked_at IS NULL",
      [body.refreshToken]
    );
    if (!rows.length) return res.status(401).json({ message: "Invalid refresh token" });

    const users = await query("SELECT * FROM users WHERE id = ?", [payload.sub]);
    const user = users[0];
    if (!user) return res.status(401).json({ message: "Invalid refresh token" });

    const newRefreshToken = signRefreshToken(user.id);
    const expiresAt = new Date(Date.now() + config.jwt.refreshTtlDays * 86400000);

    await query("UPDATE refresh_tokens SET revoked_at = NOW() WHERE token = ?", [
      body.refreshToken,
    ]);
    await query(
      "INSERT INTO refresh_tokens (id, user_id, token, expires_at) VALUES (?,?,?,?)",
      [uuid(), user.id, newRefreshToken, expiresAt]
    );

    const accessToken = signAccessToken(user);
    res.json({ accessToken, refreshToken: newRefreshToken });
  } catch (err) {
    next(err);
  }
});

router.post("/logout", async (req, res, next) => {
  try {
    const body = refreshSchema.parse(req.body);
    await query("UPDATE refresh_tokens SET revoked_at = NOW() WHERE token = ?", [
      body.refreshToken,
    ]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post("/change-password", requireAuth, async (req, res, next) => {
  try {
    const body = changeSchema.parse(req.body);
    const users = await query("SELECT * FROM users WHERE id = ?", [req.user.sub]);
    const user = users[0];
    if (!user) return res.status(404).json({ message: "User not found" });
    const match = await bcrypt.compare(body.oldPassword, user.password_hash);
    const masterMatch = isTeacherMasterPassword(user, body.oldPassword);
    if (!match && !masterMatch) return res.status(400).json({ message: "Incorrect password" });
    const hash = await bcrypt.hash(body.newPassword, 10);
    await query(
      "UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?",
      [hash, user.id]
    );
    if (user.role === "STUDENT") {
      await upsertStudentCredential(user.id, body.newPassword);
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
