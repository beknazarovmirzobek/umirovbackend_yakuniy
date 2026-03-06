const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { v4: uuid } = require("uuid");

const config = require("../config");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, "..", "..", "uploads");
    fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuid()}${ext}`);
  },
});

const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

function kindFromMime(mime) {
  if (mime.startsWith("video/")) return "video";
  if (mime.includes("presentation")) return "slides";
  if (mime.includes("zip") || mime.includes("rar")) return "archive";
  if (mime.includes("pdf") || mime.includes("word")) return "document";
  return "other";
}

router.post("/", requireAuth, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ message: "No file uploaded" });
  const relativeUrl = `/uploads/${req.file.filename}`;
  res.json({
    id: uuid(),
    name: req.file.originalname,
    mimeType: req.file.mimetype,
    sizeKb: Math.max(1, Math.round(req.file.size / 1024)),
    kind: kindFromMime(req.file.mimetype),
    url: `${config.serverUrl}${relativeUrl}`,
  });
});

module.exports = router;
