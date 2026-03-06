const { query } = require("../db");

let ensureTablePromise;

function normalizeLookup(lookupText) {
  return String(lookupText || "")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeLimit(limit, fallback = 20) {
  const parsed = Number.parseInt(limit, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), 100);
}

async function ensureStudentCredentialsTable() {
  if (!ensureTablePromise) {
    ensureTablePromise = query(
      "CREATE TABLE IF NOT EXISTS student_credentials (user_id CHAR(36) PRIMARY KEY, password_plain VARCHAR(255) NOT NULL, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)"
    );
  }
  await ensureTablePromise;
}

async function upsertStudentCredential(userId, password) {
  await ensureStudentCredentialsTable();
  await query(
    "INSERT INTO student_credentials (user_id, password_plain) VALUES (?,?) ON DUPLICATE KEY UPDATE password_plain = VALUES(password_plain), updated_at = CURRENT_TIMESTAMP",
    [userId, password]
  );
}

function mapCredentialRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    firstName: row.first_name,
    lastName: row.last_name,
    role: row.role,
    mustChangePassword: !!row.must_change_password,
    password: row.password_plain || null,
  };
}

async function getStudentCredentialByUsername(username) {
  await ensureStudentCredentialsTable();
  const rows = await query(
    "SELECT u.id, u.username, u.first_name, u.last_name, u.role, u.must_change_password, sc.password_plain FROM users u LEFT JOIN student_credentials sc ON sc.user_id = u.id WHERE u.role = 'STUDENT' AND u.username = ? LIMIT 1",
    [username]
  );
  return mapCredentialRow(rows[0]);
}

async function getStudentCredentialByLookup(lookupText) {
  const normalized = normalizeLookup(lookupText);
  if (!normalized) return null;

  const like = `%${normalized}%`;
  await ensureStudentCredentialsTable();
  const rows = await query(
    "SELECT u.id, u.username, u.first_name, u.last_name, u.role, u.must_change_password, sc.password_plain FROM users u LEFT JOIN student_credentials sc ON sc.user_id = u.id WHERE u.role = 'STUDENT' AND (LOWER(u.username) = LOWER(?) OR LOWER(CONCAT(TRIM(u.first_name), ' ', TRIM(u.last_name))) = LOWER(?) OR LOWER(CONCAT(TRIM(u.last_name), ' ', TRIM(u.first_name))) = LOWER(?) OR LOWER(u.username) LIKE LOWER(?) OR LOWER(u.first_name) LIKE LOWER(?) OR LOWER(u.last_name) LIKE LOWER(?) OR LOWER(CONCAT(TRIM(u.first_name), ' ', TRIM(u.last_name))) LIKE LOWER(?) OR LOWER(CONCAT(TRIM(u.last_name), ' ', TRIM(u.first_name))) LIKE LOWER(?)) ORDER BY CASE WHEN LOWER(u.username) = LOWER(?) THEN 0 WHEN LOWER(CONCAT(TRIM(u.first_name), ' ', TRIM(u.last_name))) = LOWER(?) THEN 1 WHEN LOWER(CONCAT(TRIM(u.last_name), ' ', TRIM(u.first_name))) = LOWER(?) THEN 2 ELSE 3 END, u.created_at DESC LIMIT 1",
    [
      normalized,
      normalized,
      normalized,
      like,
      like,
      like,
      like,
      like,
      normalized,
      normalized,
      normalized,
    ]
  );
  return mapCredentialRow(rows[0]);
}

async function listStudentCredentialsByLookup(lookupText, limit = 20) {
  const normalized = normalizeLookup(lookupText);
  if (!normalized) return [];

  const like = `%${normalized}%`;
  const safeLimit = normalizeLimit(limit);
  await ensureStudentCredentialsTable();
  const rows = await query(
    `SELECT u.id, u.username, u.first_name, u.last_name, u.role, u.must_change_password, sc.password_plain FROM users u LEFT JOIN student_credentials sc ON sc.user_id = u.id WHERE u.role = 'STUDENT' AND (LOWER(u.username) = LOWER(?) OR LOWER(CONCAT(TRIM(u.first_name), ' ', TRIM(u.last_name))) = LOWER(?) OR LOWER(CONCAT(TRIM(u.last_name), ' ', TRIM(u.first_name))) = LOWER(?) OR LOWER(u.username) LIKE LOWER(?) OR LOWER(u.first_name) LIKE LOWER(?) OR LOWER(u.last_name) LIKE LOWER(?) OR LOWER(CONCAT(TRIM(u.first_name), ' ', TRIM(u.last_name))) LIKE LOWER(?) OR LOWER(CONCAT(TRIM(u.last_name), ' ', TRIM(u.first_name))) LIKE LOWER(?)) ORDER BY CASE WHEN LOWER(u.username) = LOWER(?) THEN 0 WHEN LOWER(CONCAT(TRIM(u.first_name), ' ', TRIM(u.last_name))) = LOWER(?) THEN 1 WHEN LOWER(CONCAT(TRIM(u.last_name), ' ', TRIM(u.first_name))) = LOWER(?) THEN 2 ELSE 3 END, u.created_at DESC LIMIT ${safeLimit}`,
    [
      normalized,
      normalized,
      normalized,
      like,
      like,
      like,
      like,
      like,
      normalized,
      normalized,
      normalized,
    ]
  );
  return rows.map(mapCredentialRow).filter(Boolean);
}

module.exports = {
  ensureStudentCredentialsTable,
  getStudentCredentialByLookup,
  getStudentCredentialByUsername,
  listStudentCredentialsByLookup,
  upsertStudentCredential,
};
