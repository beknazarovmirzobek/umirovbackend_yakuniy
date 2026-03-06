DROP DATABASE IF EXISTS myproject_db;
CREATE DATABASE myproject_db;
USE myproject_db;

CREATE TABLE users (
  id CHAR(36) PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('TEACHER','STUDENT') NOT NULL,
  first_name VARCHAR(80) NOT NULL,
  last_name VARCHAR(80) NOT NULL,
  must_change_password TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE student_credentials (
  user_id CHAR(36) PRIMARY KEY,
  password_plain VARCHAR(255) NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE `groups` (
  id CHAR(36) PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  code VARCHAR(32) NOT NULL,
  teacher_id CHAR(36) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (teacher_id) REFERENCES users(id)
);

CREATE TABLE group_members (
  id CHAR(36) PRIMARY KEY,
  group_id CHAR(36) NOT NULL,
  student_id CHAR(36) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (group_id) REFERENCES `groups`(id),
  FOREIGN KEY (student_id) REFERENCES users(id)
);

CREATE TABLE subjects (
  id CHAR(36) PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  code VARCHAR(32) NOT NULL,
  teacher_id CHAR(36) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (teacher_id) REFERENCES users(id)
);

CREATE TABLE semesters (
  id CHAR(36) PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  start_date DATETIME NOT NULL,
  end_date DATETIME NOT NULL,
  is_current TINYINT(1) NOT NULL DEFAULT 0
);

CREATE TABLE lessons (
  id CHAR(36) PRIMARY KEY,
  subject_id CHAR(36) NOT NULL,
  teacher_id CHAR(36) NOT NULL,
  date_time DATETIME NOT NULL,
  topic VARCHAR(160) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (subject_id) REFERENCES subjects(id),
  FOREIGN KEY (teacher_id) REFERENCES users(id)
);

CREATE TABLE assignments (
  id CHAR(36) PRIMARY KEY,
  subject_id CHAR(36) NOT NULL,
  teacher_id CHAR(36) NOT NULL,
  title VARCHAR(160) NOT NULL,
  description TEXT NOT NULL,
  deadline DATETIME NOT NULL,
  max_score INT NOT NULL DEFAULT 100,
  attachments JSON NULL,
  target_type ENUM('GROUP','STUDENT') NULL,
  target_id CHAR(36) NULL,
  is_lab TINYINT(1) NOT NULL DEFAULT 0,
  lab_editor ENUM('word','excel') NOT NULL DEFAULT 'word',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (subject_id) REFERENCES subjects(id),
  FOREIGN KEY (teacher_id) REFERENCES users(id)
);

CREATE TABLE attendance (
  id CHAR(36) PRIMARY KEY,
  lesson_id CHAR(36) NOT NULL,
  student_id CHAR(36) NOT NULL,
  status ENUM('ABSENT','ONTIME','LATE') NOT NULL,
  recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (lesson_id) REFERENCES lessons(id),
  FOREIGN KEY (student_id) REFERENCES users(id)
);

CREATE TABLE submissions (
  id CHAR(36) PRIMARY KEY,
  assignment_id CHAR(36) NOT NULL,
  student_id CHAR(36) NOT NULL,
  submitted_at DATETIME NOT NULL,
  text TEXT NOT NULL,
  content_html TEXT NULL,
  sheet_json JSON NULL,
  file JSON NULL,
  is_late TINYINT(1) NOT NULL DEFAULT 0,
  FOREIGN KEY (assignment_id) REFERENCES assignments(id),
  FOREIGN KEY (student_id) REFERENCES users(id)
);

CREATE TABLE grades (
  id CHAR(36) PRIMARY KEY,
  assignment_id CHAR(36) NOT NULL,
  student_id CHAR(36) NOT NULL,
  score INT NOT NULL,
  grade ENUM('FAIL','3','4','5') NOT NULL,
  graded_at DATETIME NOT NULL,
  teacher_id CHAR(36) NOT NULL,
  FOREIGN KEY (assignment_id) REFERENCES assignments(id),
  FOREIGN KEY (student_id) REFERENCES users(id),
  FOREIGN KEY (teacher_id) REFERENCES users(id)
);

CREATE TABLE tests (
  id CHAR(36) PRIMARY KEY,
  subject_id CHAR(36) NULL,
  teacher_id CHAR(36) NOT NULL,
  title VARCHAR(180) NOT NULL,
  description TEXT NOT NULL,
  deadline DATETIME NOT NULL,
  max_score INT NOT NULL DEFAULT 100,
  questions JSON NOT NULL,
  target_type ENUM('GROUP','STUDENT') NULL,
  target_id CHAR(36) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (subject_id) REFERENCES subjects(id),
  FOREIGN KEY (teacher_id) REFERENCES users(id)
);

CREATE TABLE test_attempts (
  id CHAR(36) PRIMARY KEY,
  test_id CHAR(36) NOT NULL,
  student_id CHAR(36) NOT NULL,
  answers JSON NOT NULL,
  score INT NOT NULL,
  submitted_at DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_test_attempt (test_id, student_id),
  FOREIGN KEY (test_id) REFERENCES tests(id),
  FOREIGN KEY (student_id) REFERENCES users(id)
);

CREATE TABLE test_sessions (
  id CHAR(36) PRIMARY KEY,
  test_id CHAR(36) NOT NULL,
  student_id CHAR(36) NOT NULL,
  device_id VARCHAR(128) NOT NULL,
  question_order JSON NOT NULL,
  started_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  UNIQUE KEY uq_test_session (test_id, student_id),
  FOREIGN KEY (test_id) REFERENCES tests(id),
  FOREIGN KEY (student_id) REFERENCES users(id)
);

CREATE TABLE test_permissions (
  id CHAR(36) PRIMARY KEY,
  test_id CHAR(36) NOT NULL,
  student_id CHAR(36) NOT NULL,
  granted_by CHAR(36) NOT NULL,
  remaining_attempts INT NOT NULL DEFAULT 0,
  granted_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  UNIQUE KEY uq_test_permission (test_id, student_id),
  FOREIGN KEY (test_id) REFERENCES tests(id),
  FOREIGN KEY (student_id) REFERENCES users(id),
  FOREIGN KEY (granted_by) REFERENCES users(id)
);

CREATE TABLE surveys (
  id CHAR(36) PRIMARY KEY,
  subject_id CHAR(36) NULL,
  teacher_id CHAR(36) NOT NULL,
  title VARCHAR(180) NOT NULL,
  description TEXT NOT NULL,
  deadline DATETIME NOT NULL,
  is_anonymous TINYINT(1) NOT NULL DEFAULT 0,
  questions JSON NOT NULL,
  target_type ENUM('GROUP','STUDENT') NULL,
  target_id CHAR(36) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (subject_id) REFERENCES subjects(id),
  FOREIGN KEY (teacher_id) REFERENCES users(id)
);

CREATE TABLE survey_responses (
  id CHAR(36) PRIMARY KEY,
  survey_id CHAR(36) NOT NULL,
  student_id CHAR(36) NOT NULL,
  answers JSON NOT NULL,
  submitted_at DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_survey_response (survey_id, student_id),
  FOREIGN KEY (survey_id) REFERENCES surveys(id),
  FOREIGN KEY (student_id) REFERENCES users(id)
);

CREATE TABLE refresh_tokens (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  token VARCHAR(255) NOT NULL,
  expires_at DATETIME NOT NULL,
  revoked_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
