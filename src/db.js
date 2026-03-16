const mysql = require("mysql2/promise");
const config = require("./config");

const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  connectionLimit: 10,
});

const DATABASE_CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "PROTOCOL_CONNECTION_LOST",
]);

function isDatabaseConnectionError(err) {
  return DATABASE_CONNECTION_ERROR_CODES.has(err?.code);
}

async function query(sql, params = []) {
  try {
    const [rows] = await pool.execute(sql, params);
    return rows;
  } catch (err) {
    err.isDatabaseConnectionError = isDatabaseConnectionError(err);
    throw err;
  }
}

async function ping() {
  const connection = await pool.getConnection();
  try {
    await connection.ping();
  } finally {
    connection.release();
  }
}

module.exports = { pool, query, ping, isDatabaseConnectionError };
