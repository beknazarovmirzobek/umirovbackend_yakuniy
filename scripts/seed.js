const bcrypt = require("bcryptjs");
const { v4: uuid } = require("uuid");
const { query } = require("../src/db");

async function seed() {
  const teacherId = uuid();
  const studentId = uuid();

  const teacherHash = await bcrypt.hash("Teacher123!", 10);
  const studentHash = await bcrypt.hash("Student123!", 10);

  await query(
    "CREATE TABLE IF NOT EXISTS student_credentials (user_id CHAR(36) PRIMARY KEY, password_plain VARCHAR(255) NOT NULL, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)"
  );

  await query("DELETE FROM refresh_tokens");
  await query("DELETE FROM survey_responses");
  await query("DELETE FROM surveys");
  await query("DELETE FROM test_permissions").catch(() => {});
  await query("DELETE FROM test_sessions").catch(() => {});
  await query("DELETE FROM test_attempts");
  await query("DELETE FROM tests");
  await query("DELETE FROM grades");
  await query("DELETE FROM submissions");
  await query("DELETE FROM attendance");
  await query("DELETE FROM lessons");
  await query("DELETE FROM assignments");
  await query("DELETE FROM subjects");
  await query("DELETE FROM student_credentials");
  await query("DELETE FROM users");

  await query(
    "INSERT INTO users (id, username, password_hash, role, first_name, last_name, must_change_password) VALUES (?,?,?,?,?,?,?)",
    [teacherId, "teacher", teacherHash, "TEACHER", "Laylo", "Karimova", 0]
  );
  await query(
    "INSERT INTO users (id, username, password_hash, role, first_name, last_name, must_change_password) VALUES (?,?,?,?,?,?,?)",
    [studentId, "student", studentHash, "STUDENT", "Aziz", "Saidov", 1]
  );
  await query(
    "INSERT INTO student_credentials (user_id, password_plain) VALUES (?,?)",
    [studentId, "Student123!"]
  );

  const sub1 = uuid();
  const sub2 = uuid();
  const sub3 = uuid();
  await query(
    "INSERT INTO subjects (id, name, code, teacher_id) VALUES (?,?,?,?)",
    [sub1, "Applied Mathematics", "MATH-301", teacherId]
  );
  await query(
    "INSERT INTO subjects (id, name, code, teacher_id) VALUES (?,?,?,?)",
    [sub2, "UX Foundations", "UX-220", teacherId]
  );
  await query(
    "INSERT INTO subjects (id, name, code, teacher_id) VALUES (?,?,?,?)",
    [sub3, "Academic English", "ENG-110", teacherId]
  );

  const assign1 = uuid();
  const assign2 = uuid();
  const assign3 = uuid();
  await query(
    "INSERT INTO assignments (id, subject_id, teacher_id, title, description, deadline, max_score, attachments, is_lab, lab_editor) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [
      assign1,
      sub1,
      teacherId,
      "Linear regression lab",
      "Submit analysis with charts and summary.",
      new Date(Date.now() + 5 * 86400000),
      100,
      JSON.stringify([
        {
          id: uuid(),
          name: "dataset.csv",
          mimeType: "text/csv",
          sizeKb: 420,
          kind: "document",
        },
        {
          id: uuid(),
          name: "lab-instructions.pdf",
          mimeType: "application/pdf",
          sizeKb: 860,
          kind: "document",
        },
      ]),
      0,
      "word",
    ]
  );
  await query(
    "INSERT INTO assignments (id, subject_id, teacher_id, title, description, deadline, max_score, attachments, is_lab, lab_editor) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [
      assign2,
      sub2,
      teacherId,
      "Prototype critique",
      "Upload critique with insights.",
      new Date(Date.now() - 1 * 86400000),
      100,
      JSON.stringify([
        {
          id: uuid(),
          name: "ux-critique-guide.docx",
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          sizeKb: 320,
          kind: "document",
        },
        {
          id: uuid(),
          name: "critique-session.mp4",
          mimeType: "video/mp4",
          sizeKb: 12450,
          kind: "video",
        },
      ]),
      0,
      "word",
    ]
  );
  await query(
    "INSERT INTO assignments (id, subject_id, teacher_id, title, description, deadline, max_score, attachments, is_lab, lab_editor) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [
      assign3,
      sub3,
      teacherId,
      "Essay outline",
      "Submit outline and thesis.",
      new Date(Date.now() + 10 * 86400000),
      100,
      JSON.stringify([
        {
          id: uuid(),
          name: "outline-template.pptx",
          mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          sizeKb: 540,
          kind: "slides",
        },
      ]),
      0,
      "word",
    ]
  );

  const test1 = uuid();
  const test2 = uuid();
  const testQuestions = [
    {
      prompt: "What is the derivative of x^2?",
      options: ["2x", "x", "x^3", "2"],
      correctOption: 0,
      points: 2,
    },
    {
      prompt: "Which chart is best to compare categories?",
      options: ["Bar chart", "Scatter plot", "Histogram", "Area chart"],
      correctOption: 0,
      points: 1,
    },
  ];
  const uxTestQuestions = [
    {
      prompt: "What is the primary goal of UX research?",
      options: [
        "Understand user needs and behavior",
        "Pick a color palette",
        "Increase file size",
        "Skip usability testing",
      ],
      correctOption: 0,
      points: 2,
    },
    {
      prompt: "Which method gives direct user feedback?",
      options: ["Usability interview", "Minification", "Tree shaking", "Code splitting"],
      correctOption: 0,
      points: 2,
    },
  ];

  await query(
    "INSERT INTO tests (id, subject_id, teacher_id, title, description, deadline, max_score, questions) VALUES (?,?,?,?,?,?,?,?)",
    [
      test1,
      sub1,
      teacherId,
      "Weekly Math Quiz",
      "Complete the short multiple-choice quiz.",
      new Date(Date.now() + 3 * 86400000),
      100,
      JSON.stringify(testQuestions),
    ]
  );
  await query(
    "INSERT INTO tests (id, subject_id, teacher_id, title, description, deadline, max_score, questions) VALUES (?,?,?,?,?,?,?,?)",
    [
      test2,
      sub2,
      teacherId,
      "UX Fundamentals Test",
      "Check understanding of UX basics.",
      new Date(Date.now() + 6 * 86400000),
      100,
      JSON.stringify(uxTestQuestions),
    ]
  );

  const survey1 = uuid();
  const survey2 = uuid();
  const surveyQuestions = [
    {
      prompt: "How clear were this week's lessons?",
      type: "single",
      options: ["Very clear", "Mostly clear", "Somewhat clear", "Not clear"],
    },
    {
      prompt: "What should be improved in next lesson?",
      type: "text",
    },
  ];
  const surveyQuestions2 = [
    {
      prompt: "How confident do you feel about assignments?",
      type: "single",
      options: ["High", "Medium", "Low"],
    },
    {
      prompt: "Share one suggestion for the teacher.",
      type: "text",
    },
  ];

  await query(
    "INSERT INTO surveys (id, subject_id, teacher_id, title, description, deadline, is_anonymous, questions) VALUES (?,?,?,?,?,?,?,?)",
    [
      survey1,
      sub2,
      teacherId,
      "Week 1 Feedback",
      "Anonymous feedback survey about this week.",
      new Date(Date.now() + 7 * 86400000),
      1,
      JSON.stringify(surveyQuestions),
    ]
  );
  await query(
    "INSERT INTO surveys (id, subject_id, teacher_id, title, description, deadline, is_anonymous, questions) VALUES (?,?,?,?,?,?,?,?)",
    [
      survey2,
      sub3,
      teacherId,
      "English Class Pulse",
      "Quick pulse survey for the English class.",
      new Date(Date.now() + 9 * 86400000),
      0,
      JSON.stringify(surveyQuestions2),
    ]
  );

  await query(
    "INSERT INTO test_attempts (id, test_id, student_id, answers, score, submitted_at) VALUES (?,?,?,?,?,?)",
    [
      uuid(),
      test1,
      studentId,
      JSON.stringify([0, 0]),
      100,
      new Date(),
    ]
  );

  await query(
    "INSERT INTO survey_responses (id, survey_id, student_id, answers, submitted_at) VALUES (?,?,?,?,?)",
    [
      uuid(),
      survey2,
      studentId,
      JSON.stringify([1, "More speaking practice would help."]),
      new Date(),
    ]
  );

  console.log("Seed complete.");
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
