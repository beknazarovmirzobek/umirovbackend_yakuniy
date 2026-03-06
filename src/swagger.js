const spec = {
  openapi: "3.0.0",
  info: {
    title: "umirovatm.uz API",
    version: "1.0.0",
  },
  servers: [{ url: "https://tyutorkpi.sies.uz/umirov/api" }],
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
    },
    schemas: {
      UserPublic: {
        type: "object",
        properties: {
          id: { type: "string" },
          username: { type: "string" },
          role: { type: "string", enum: ["TEACHER", "STUDENT"] },
          firstName: { type: "string" },
          lastName: { type: "string" },
          mustChangePassword: { type: "boolean" },
        },
      },
      UserProfile: {
        allOf: [
          { $ref: "#/components/schemas/UserPublic" },
          {
            type: "object",
            properties: {
              groups: {
                type: "array",
                items: { $ref: "#/components/schemas/Group" },
              },
            },
          },
        ],
      },
      Group: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          code: { type: "string" },
          teacherId: { type: "string" },
          createdAt: { type: "string" },
        },
      },
      FileAttachment: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          mimeType: { type: "string" },
          sizeKb: { type: "number" },
          kind: { type: "string" },
          url: { type: "string" },
        },
      },
      Subject: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          code: { type: "string" },
          teacherId: { type: "string" },
          createdAt: { type: "string" },
        },
      },
      Lesson: {
        type: "object",
        properties: {
          id: { type: "string" },
          subjectId: { type: "string" },
          teacherId: { type: "string" },
          dateTime: { type: "string" },
          topic: { type: "string" },
          createdAt: { type: "string" },
        },
      },
      Assignment: {
        type: "object",
        properties: {
          id: { type: "string" },
          subjectId: { type: "string" },
          teacherId: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          deadline: { type: "string" },
          maxScore: { type: "number" },
          attachments: {
            type: "array",
            items: { $ref: "#/components/schemas/FileAttachment" },
          },
          targetType: { type: "string", enum: ["GROUP", "STUDENT"], nullable: true },
          targetId: { type: "string", nullable: true },
          createdAt: { type: "string" },
        },
      },
      Submission: {
        type: "object",
        properties: {
          id: { type: "string" },
          assignmentId: { type: "string" },
          studentId: { type: "string" },
          submittedAt: { type: "string" },
          text: { type: "string" },
          files: { type: "array", items: { $ref: "#/components/schemas/FileAttachment" } },
          contentHtml: { type: "string", nullable: true },
          sheetJson: { nullable: true },
          isLate: { type: "boolean" },
        },
      },
      Grade: {
        type: "object",
        properties: {
          id: { type: "string" },
          assignmentId: { type: "string" },
          studentId: { type: "string" },
          score: { type: "number" },
          grade: { type: "string", enum: ["FAIL", "3", "4", "5"] },
          gradedAt: { type: "string" },
          teacherId: { type: "string" },
        },
      },
      AttendanceRecord: {
        type: "object",
        properties: {
          id: { type: "string" },
          lessonId: { type: "string" },
          studentId: { type: "string" },
          status: { type: "string", enum: ["ABSENT", "ONTIME", "LATE"] },
          recordedAt: { type: "string" },
        },
      },
      AuthLoginResponse: {
        type: "object",
        properties: {
          accessToken: { type: "string" },
          refreshToken: { type: "string" },
          mustChangePassword: { type: "boolean" },
          user: { $ref: "#/components/schemas/UserPublic" },
        },
      },
    },
  },
  paths: {
    "/auth/login": {
      post: {
        summary: "Login",
        tags: ["Auth"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { username: { type: "string" }, password: { type: "string" } },
              },
            },
          },
        },
        responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/AuthLoginResponse" } } } } },
      },
    },
    "/auth/refresh": {
      post: {
        summary: "Refresh token",
        tags: ["Auth"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", properties: { refreshToken: { type: "string" } } },
            },
          },
        },
        responses: {
          200: {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { accessToken: { type: "string" }, refreshToken: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
    "/auth/logout": {
      post: {
        summary: "Logout",
        tags: ["Auth"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", properties: { refreshToken: { type: "string" } } },
            },
          },
        },
      },
    },
    "/auth/change-password": {
      post: {
        summary: "Change password",
        tags: ["Auth"],
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { oldPassword: { type: "string" }, newPassword: { type: "string" } },
              },
            },
          },
        },
      },
    },
    "/me": {
      get: {
        summary: "Get current user",
        tags: ["Users"],
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/UserProfile" } } } } },
      },
    },
    "/files": {
      post: {
        summary: "Upload file",
        tags: ["Files"],
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                properties: { file: { type: "string", format: "binary" } },
              },
            },
          },
        },
        responses: { 200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/FileAttachment" } } } } },
      },
    },
    "/teacher/students": {
      get: {
        summary: "List students",
        tags: ["Teacher"],
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: "OK", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/UserPublic" } } } } } },
      },
      post: {
        summary: "Create student",
        tags: ["Teacher"],
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  firstName: { type: "string" },
                  lastName: { type: "string" },
                  username: { type: "string" },
                  password: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
    "/teacher/students/{id}": {
      get: { summary: "Student details", tags: ["Teacher"], security: [{ bearerAuth: [] }] },
    },
    "/teacher/students/{id}/reset-password": {
      post: { summary: "Reset student password", tags: ["Teacher"], security: [{ bearerAuth: [] }] },
    },
    "/teacher/students/{id}/attendance": {
      get: { summary: "Student attendance", tags: ["Teacher"], security: [{ bearerAuth: [] }] },
    },
    "/teacher/students/{id}/submissions": {
      get: { summary: "Student submissions", tags: ["Teacher"], security: [{ bearerAuth: [] }] },
    },
    "/teacher/students/{id}/grades": {
      get: { summary: "Student grades", tags: ["Teacher"], security: [{ bearerAuth: [] }] },
    },
    "/teacher/groups": {
      get: { summary: "List groups", tags: ["Teacher"], security: [{ bearerAuth: [] }] },
      post: {
        summary: "Create group",
        tags: ["Teacher"],
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { name: { type: "string" }, code: { type: "string" } },
              },
            },
          },
        },
      },
    },
    "/teacher/groups/{id}": {
      put: { summary: "Update group", tags: ["Teacher"], security: [{ bearerAuth: [] }] },
      delete: { summary: "Delete group", tags: ["Teacher"], security: [{ bearerAuth: [] }] },
    },
    "/teacher/groups/{id}/members": {
      get: { summary: "Group members", tags: ["Teacher"], security: [{ bearerAuth: [] }] },
      post: { summary: "Add member", tags: ["Teacher"], security: [{ bearerAuth: [] }] },
    },
    "/teacher/groups/{id}/members/{studentId}": {
      delete: { summary: "Remove member", tags: ["Teacher"], security: [{ bearerAuth: [] }] },
    },
    "/subjects": {
      get: {
        summary: "List subjects",
        tags: ["Subjects"],
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: "OK", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Subject" } } } } } },
      },
      post: {
        summary: "Create subject",
        tags: ["Subjects"],
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { type: "object", properties: { name: { type: "string" }, code: { type: "string" } } } },
          },
        },
      },
    },
    "/subjects/{id}": {
      put: { summary: "Update subject", tags: ["Subjects"], security: [{ bearerAuth: [] }] },
      delete: { summary: "Delete subject", tags: ["Subjects"], security: [{ bearerAuth: [] }] },
    },
    "/lessons": {
      get: {
        summary: "List lessons",
        tags: ["Lessons"],
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: "OK", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Lesson" } } } } } },
      },
      post: {
        summary: "Create lesson",
        tags: ["Lessons"],
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { subjectId: { type: "string" }, dateTime: { type: "string" }, topic: { type: "string" } },
              },
            },
          },
        },
      },
    },
    "/lessons/{id}/attendance": {
      post: { summary: "Update attendance", tags: ["Lessons"], security: [{ bearerAuth: [] }] },
      get: { summary: "List attendance", tags: ["Lessons"], security: [{ bearerAuth: [] }] },
    },
    "/assignments": {
      get: {
        summary: "List assignments",
        tags: ["Assignments"],
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: "OK", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Assignment" } } } } } },
      },
      post: {
        summary: "Create assignment",
        tags: ["Assignments"],
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  subjectId: { type: "string" },
                  title: { type: "string" },
                  description: { type: "string" },
                  deadline: { type: "string" },
                  maxScore: { type: "number" },
                  attachments: { type: "array", items: { $ref: "#/components/schemas/FileAttachment" } },
                },
              },
            },
          },
        },
      },
    },
    "/assignments/{id}": {
      get: { summary: "Get assignment", tags: ["Assignments"], security: [{ bearerAuth: [] }] },
    },
    "/assignments/{id}/submissions": {
      get: { summary: "List submissions", tags: ["Assignments"], security: [{ bearerAuth: [] }] },
    },
    "/assignments/{id}/grades": {
      get: { summary: "List grades", tags: ["Assignments"], security: [{ bearerAuth: [] }] },
    },
    "/assignments/{id}/grade": {
      post: { summary: "Grade submission", tags: ["Assignments"], security: [{ bearerAuth: [] }] },
    },
    "/student/assignments": {
      get: { summary: "Student assignments", tags: ["Student"], security: [{ bearerAuth: [] }] },
    },
    "/student/submissions": {
      get: { summary: "Student submissions", tags: ["Student"], security: [{ bearerAuth: [] }] },
    },
    "/student/assignments/{id}/submit": {
      post: {
        summary: "Submit assignment",
        tags: ["Student"],
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  text: { type: "string" },
                  files: { type: "array", items: { $ref: "#/components/schemas/FileAttachment" } },
                  contentHtml: { type: "string" },
                  sheetJson: {},
                },
              },
            },
          },
        },
      },
    },
    "/student/grades": {
      get: { summary: "Student grades", tags: ["Student"], security: [{ bearerAuth: [] }] },
    },
    "/student/attendance": {
      get: { summary: "Student attendance", tags: ["Student"], security: [{ bearerAuth: [] }] },
    },
  },
};

module.exports = spec;
