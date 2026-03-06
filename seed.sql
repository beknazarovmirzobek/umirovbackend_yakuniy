USE myproject_db;
SET FOREIGN_KEY_CHECKS=0;

INSERT INTO users (id, username, password_hash, role, first_name, last_name, must_change_password)
VALUES
  (UUID(), 'teacher', '$2a$10$N0IR2PXzOa2T4Mb8vblGpeIVsjB2hlWHRqfJmEinguktxVGjf8KZm', 'TEACHER', 'Laylo', 'Karimova', 0),
  (UUID(), 'student', '$2a$10$1llT/RJErZtgb6OdvznH6eRdYYV/IqKsp3ObQyD9PEIswY.b91aQ2', 'STUDENT', 'Aziz', 'Saidov', 1),
  (UUID(), 'student2', '$2a$10$1llT/RJErZtgb6OdvznH6eRdYYV/IqKsp3ObQyD9PEIswY.b91aQ2', 'STUDENT', 'Dilnoza', 'Qodirova', 1),
  (UUID(), 'student3', '$2a$10$1llT/RJErZtgb6OdvznH6eRdYYV/IqKsp3ObQyD9PEIswY.b91aQ2', 'STUDENT', 'Javlon', 'Hasanov', 1);

INSERT INTO `groups` (id, name, code, teacher_id)
SELECT UUID(), 'Group A', 'G-A', u.id FROM users u WHERE u.username='teacher';
INSERT INTO `groups` (id, name, code, teacher_id)
SELECT UUID(), 'Group B', 'G-B', u.id FROM users u WHERE u.username='teacher';

INSERT INTO group_members (id, group_id, student_id)
SELECT UUID(), g.id, u.id FROM `groups` g
JOIN users u ON u.username='student'
WHERE g.code='G-A';
INSERT INTO group_members (id, group_id, student_id)
SELECT UUID(), g.id, u.id FROM `groups` g
JOIN users u ON u.username='student2'
WHERE g.code='G-A';
INSERT INTO group_members (id, group_id, student_id)
SELECT UUID(), g.id, u.id FROM `groups` g
JOIN users u ON u.username='student3'
WHERE g.code='G-B';

INSERT INTO subjects (id, name, code, teacher_id)
SELECT UUID(), 'Applied Mathematics', 'MATH-301', u.id FROM users u WHERE u.username='teacher';
INSERT INTO subjects (id, name, code, teacher_id)
SELECT UUID(), 'UX Foundations', 'UX-220', u.id FROM users u WHERE u.username='teacher';
INSERT INTO subjects (id, name, code, teacher_id)
SELECT UUID(), 'Academic English', 'ENG-110', u.id FROM users u WHERE u.username='teacher';

INSERT INTO semesters (id, name, start_date, end_date, is_current)
VALUES
  (UUID(), '2025 Fall', '2025-09-01', '2026-01-15', 0),
  (UUID(), '2026 Spring', '2026-02-01', '2026-06-20', 1),
  (UUID(), '2026 Summer', '2026-07-01', '2026-08-25', 0);

INSERT INTO lessons (id, subject_id, teacher_id, date_time, topic)
SELECT UUID(), s.id, u.id, NOW() - INTERVAL 3 DAY, 'Optimization strategies'
FROM subjects s JOIN users u ON u.username='teacher' LIMIT 1;

INSERT INTO lessons (id, subject_id, teacher_id, date_time, topic)
SELECT UUID(), s.id, u.id, NOW() + INTERVAL 2 DAY, 'User flows & testing'
FROM subjects s JOIN users u ON u.username='teacher' LIMIT 1 OFFSET 1;

INSERT INTO lessons (id, subject_id, teacher_id, date_time, topic)
SELECT UUID(), s.id, u.id, NOW() + INTERVAL 6 DAY, 'Presentation skills'
FROM subjects s JOIN users u ON u.username='teacher' LIMIT 1 OFFSET 2;

INSERT INTO assignments (id, subject_id, teacher_id, title, description, deadline, max_score, attachments, target_type, target_id)
SELECT UUID(), s.id, u.id, 'Linear regression lab', 'Submit analysis with charts and summary.', NOW() + INTERVAL 5 DAY, 100,
  JSON_ARRAY(
  JSON_OBJECT('id', UUID(), 'name','dataset.csv','mimeType','text/csv','sizeKb',420,'kind','document','url','http://localhost:4000/uploads/dataset.csv'),
  JSON_OBJECT('id', UUID(), 'name','lab-instructions.pdf','mimeType','application/pdf','sizeKb',860,'kind','document','url','http://localhost:4000/uploads/lab-instructions.pdf')
),
'GROUP', g.id
FROM subjects s JOIN users u ON u.username='teacher'
JOIN `groups` g ON g.code='G-A' LIMIT 1;

INSERT INTO assignments (id, subject_id, teacher_id, title, description, deadline, max_score, attachments, target_type, target_id)
SELECT UUID(), s.id, u.id, 'Prototype critique', 'Upload critique with insights.', NOW() - INTERVAL 1 DAY, 100,
  JSON_ARRAY(
  JSON_OBJECT('id', UUID(), 'name','ux-critique-guide.docx','mimeType','application/vnd.openxmlformats-officedocument.wordprocessingml.document','sizeKb',320,'kind','document','url','http://localhost:4000/uploads/ux-critique-guide.docx'),
  JSON_OBJECT('id', UUID(), 'name','critique-session.mp4','mimeType','video/mp4','sizeKb',12450,'kind','video','url','http://localhost:4000/uploads/critique-session.mp4')
),
'STUDENT', u2.id
FROM subjects s JOIN users u ON u.username='teacher'
JOIN users u2 ON u2.username='student'
LIMIT 1 OFFSET 1;

INSERT INTO assignments (id, subject_id, teacher_id, title, description, deadline, max_score, attachments, target_type, target_id)
SELECT UUID(), s.id, u.id, 'Essay outline', 'Submit outline and thesis.', NOW() + INTERVAL 10 DAY, 100,
  JSON_ARRAY(
  JSON_OBJECT('id', UUID(), 'name','outline-template.pptx','mimeType','application/vnd.openxmlformats-officedocument.presentationml.presentation','sizeKb',540,'kind','slides','url','http://localhost:4000/uploads/outline-template.pptx')
),
'GROUP', g.id
FROM subjects s JOIN users u ON u.username='teacher'
JOIN `groups` g ON g.code='G-B' LIMIT 1 OFFSET 2;

INSERT INTO attendance (id, lesson_id, student_id, status)
SELECT UUID(), l.id, s.id, 'ONTIME'
FROM lessons l JOIN users s ON s.username='student' LIMIT 1;

INSERT INTO attendance (id, lesson_id, student_id, status)
SELECT UUID(), l.id, s.id, 'LATE'
FROM lessons l JOIN users s ON s.username='student2' LIMIT 1 OFFSET 1;

INSERT INTO attendance (id, lesson_id, student_id, status)
SELECT UUID(), l.id, s.id, 'ABSENT'
FROM lessons l JOIN users s ON s.username='student3' LIMIT 1 OFFSET 2;

INSERT INTO submissions (id, assignment_id, student_id, submitted_at, text, file, is_late)
SELECT UUID(), a.id, s.id, NOW(), 'Draft submission',
JSON_ARRAY(
  JSON_OBJECT('id', UUID(), 'name','submission.pdf','mimeType','application/pdf','sizeKb',780,'kind','document')
),
1
FROM assignments a JOIN users s ON s.username='student' LIMIT 1 OFFSET 1;

INSERT INTO grades (id, assignment_id, student_id, score, grade, graded_at, teacher_id)
SELECT UUID(), a.id, s.id, 86, '4', NOW(), t.id
FROM assignments a
JOIN users s ON s.username='student'
JOIN users t ON t.username='teacher'
LIMIT 1 OFFSET 1;

SET FOREIGN_KEY_CHECKS=1;
