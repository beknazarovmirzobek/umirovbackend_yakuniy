const express = require("express");
const path = require("path");
const cors = require("cors");
const morgan = require("morgan");
const swaggerUi = require("swagger-ui-express");
const { ZodError } = require("zod");

const swaggerSpec = require("./swagger");

const authRoutes = require("./routes/auth");
const fileRoutes = require("./routes/files");
const subjectRoutes = require("./routes/subjects");
const lessonRoutes = require("./routes/lessons");
const assignmentRoutes = require("./routes/assignments");
const testRoutes = require("./routes/tests");
const surveyRoutes = require("./routes/surveys");
const teacherRoutes = require("./routes/teacher");
const studentRoutes = require("./routes/student");
const userRoutes = require("./routes/users");

const app = express();

app.use(
  cors({
    origin: true,
    credentials: false,
  })
);
app.use(express.json({ limit: "2mb" }));
app.use(morgan("dev"));

app.get("/health", (req, res) => res.json({ status: "ok" }));
app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.use("/uploads", express.static(path.join(__dirname, "..", "uploads")));

app.use("/api/auth", authRoutes);
app.use("/api/files", fileRoutes);
app.use("/api", userRoutes);
app.use("/api/subjects", subjectRoutes);
app.use("/api/lessons", lessonRoutes);
app.use("/api/assignments", assignmentRoutes);
app.use("/api/tests", testRoutes);
app.use("/api/surveys", surveyRoutes);
app.use("/api/teacher", teacherRoutes);
app.use("/api/student", studentRoutes);

app.use((err, req, res, next) => {
  if (err instanceof ZodError) {
    return res.status(400).json({
      message: err.issues[0]?.message || "Validation error",
      issues: err.issues.map((issue) => ({
        path: issue.path,
        message: issue.message,
      })),
    });
  }

  if (err?.code === "ER_BAD_FIELD_ERROR" || err?.code === "ER_NO_SUCH_TABLE") {
    console.error("Database schema mismatch:", err);
    return res.status(500).json({
      message: "Database schema is outdated. Run the latest schema updates.",
    });
  }

  console.error(err);
  res.status(500).json({ message: "Server error" });
});

module.exports = app;
