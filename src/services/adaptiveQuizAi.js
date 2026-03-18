const config = require("../config");

const COURSE_SCOPE_HINTS = [
  "axborotli ta'lim muhiti tushunchasi va tarkibi",
  "amaliy mashg'ulotlarni rejalashtirish metodikasi",
  "raqamli ta'lim resurslari va platformalari",
  "LMS, Moodle, Google Classroom kabi vositalardan foydalanish",
  "interaktiv metodlar va blended learning",
  "virtual laboratoriyalar va masofaviy amaliyot",
  "baholash, monitoring va feedback",
  "kompetensiyaga yo'naltirilgan amaliy topshiriqlar",
];

class AdaptiveQuizAiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "AdaptiveQuizAiError";
    this.statusCode = statusCode;
  }
}

function getProviderMeta() {
  return {
    provider: "Google Gemini",
    model: config.adaptiveQuiz.geminiModel,
    courseTitle: config.adaptiveQuiz.courseTitle,
  };
}

function getCourseScopePrompt() {
  return [
    `Siz faqat "${config.adaptiveQuiz.courseTitle}" faniga tegishli AI-assistentsiz.`,
    "Faqat shu fan yoki uning bevosita kichik mavzulari bo'yicha ishlang.",
    "Mavzudan tashqari so'rovlarni rad eting va fan doirasidagi mavzu ekanini tushuntiring.",
    `Ruxsat etilgan yo'nalishlar namunalari: ${COURSE_SCOPE_HINTS.join(", ")}.`,
    "Har doim o'zbek tilida javob bering.",
  ].join(" ");
}

function extractJsonObject(rawText) {
  const text = String(rawText || "").trim();
  if (!text) {
    throw new AdaptiveQuizAiError(502, "AI bo'sh javob qaytardi.");
  }

  const fencedMatch = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/i);
  const candidate = fencedMatch?.[1] || text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new AdaptiveQuizAiError(502, "AI javobini JSON sifatida o'qib bo'lmadi.");
  }

  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    throw new AdaptiveQuizAiError(502, "AI JSON javobi noto'g'ri formatda keldi.");
  }
}

function normalizeText(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function normalizeSuggestions(value) {
  if (!Array.isArray(value)) return COURSE_SCOPE_HINTS.slice(0, 3);
  const items = value
    .map((item) => normalizeText(item))
    .filter(Boolean)
    .slice(0, 5);
  return items.length ? items : COURSE_SCOPE_HINTS.slice(0, 3);
}

async function callGeminiJson(userPrompt) {
  const apiKey = config.adaptiveQuiz.geminiApiKey;
  if (!apiKey) {
    throw new AdaptiveQuizAiError(
      503,
      "GEMINI_API_KEY topilmadi. Adaptive quiz ishlashi uchun backend muhitiga Gemini API kalitini qo'shing."
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.adaptiveQuiz.requestTimeoutMs);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${config.adaptiveQuiz.geminiModel}:generateContent?key=${encodeURIComponent(
        apiKey
      )}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: getCourseScopePrompt() }],
          },
          contents: [
            {
              role: "user",
              parts: [{ text: userPrompt }],
            },
          ],
          generationConfig: {
            temperature: 0.2,
            topP: 0.9,
            responseMimeType: "application/json",
          },
        }),
        signal: controller.signal,
      }
    );

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        payload?.error?.message ||
        payload?.message ||
        "Gemini API bilan bog'lanishda xatolik yuz berdi.";
      throw new AdaptiveQuizAiError(response.status, message);
    }

    const text = payload?.candidates?.[0]?.content?.parts
      ?.map((part) => part?.text)
      .filter(Boolean)
      .join("\n");

    return extractJsonObject(text);
  } catch (error) {
    if (error instanceof AdaptiveQuizAiError) throw error;
    if (error?.name === "AbortError") {
      throw new AdaptiveQuizAiError(504, "Gemini javobi vaqtida kelmadi.");
    }
    throw new AdaptiveQuizAiError(
      502,
      error instanceof Error ? error.message : "Gemini so'rovi bajarilmadi."
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function validateTopicAndGenerateFirstQuestion({ topic, role }) {
  const prompt = [
    "Quyidagi topicni tekshiring va faqat JSON qaytaring.",
    `Foydalanuvchi roli: ${role}.`,
    `Topic: "${topic}".`,
    "Agar topic ushbu fan doirasiga to'g'ridan-to'g'ri tegishli bo'lsa, allowed=true qiling va birinchi savolni yarating.",
    "Agar topic mavzudan tashqari bo'lsa, allowed=false qiling.",
    'JSON schema: {"allowed":boolean,"reason":string,"normalizedTopic":string,"suggestedTopics":string[],"firstQuestion":string,"expectedAnswer":string}.',
    "Savol o'zbek tilida, ochiq savol bo'lsin, 1-2 gapdan oshmasin.",
    "expectedAnswer qisqa, asosiy mazmunni beradigan namunaviy javob bo'lsin.",
  ].join("\n");

  const result = await callGeminiJson(prompt);
  const allowed = Boolean(result?.allowed);

  return {
    allowed,
    reason: normalizeText(
      result?.reason,
      allowed
        ? "Mavzu fan doirasiga mos."
        : "Bu mavzu tanlangan fan doirasiga kirmaydi."
    ),
    normalizedTopic: normalizeText(result?.normalizedTopic, normalizeText(topic)),
    suggestedTopics: normalizeSuggestions(result?.suggestedTopics),
    firstQuestion: allowed ? normalizeText(result?.firstQuestion) : "",
    expectedAnswer: allowed ? normalizeText(result?.expectedAnswer) : "",
  };
}

async function evaluateAnswer({ role, topic, difficulty, question, expectedAnswer, answer }) {
  const prompt = [
    "Quyidagi javobni baholang va faqat JSON qaytaring.",
    `Foydalanuvchi roli: ${role}.`,
    `Topic: "${topic}".`,
    `Difficulty: ${difficulty}.`,
    `Savol: "${question}".`,
    `Namunaviy javob: "${expectedAnswer}".`,
    `Foydalanuvchi javobi: "${answer}".`,
    'JSON schema: {"isCorrect":boolean,"score":number,"feedback":string,"idealAnswer":string}.',
    "Javobni faqat so'zma-so'z moslik bilan emas, ma'no jihatdan baholang.",
    "Agar foydalanuvchi sinonim, qisqaroq yoki boshqacha jumla bilan lekin to'g'ri ma'noni bersa, yuqori score bering.",
    "score 0 dan 100 gacha bo'lsin va javobning mazmuniy moslik foizini bildirsin.",
    "isCorrect=true faqat javob mazmunan yetarli darajada to'g'ri bo'lsa qo'ying.",
    "feedback juda qisqa bo'lsin va mazmuniy moslikni 1 jumlada tushuntirsin.",
    "idealAnswer 1-3 gapli namunaviy javob bo'lsin.",
  ].join("\n");

  const result = await callGeminiJson(prompt);

  const score =
    typeof result?.score === "number" && Number.isFinite(result.score)
      ? Math.max(0, Math.min(100, Math.round(result.score)))
      : 0;

  return {
    isCorrect: typeof result?.isCorrect === "boolean" ? result.isCorrect : score >= 70,
    score,
    feedback: normalizeText(
      result?.feedback,
      `Mazmuniy moslik ${score}%.`
    ),
    idealAnswer: normalizeText(
      result?.idealAnswer,
      normalizeText(expectedAnswer, "Namunaviy javob topilmadi.")
    ),
  };
}

function stringifyHistory(history) {
  if (!Array.isArray(history) || !history.length) {
    return "Oldingi savollar yo'q.";
  }

  return history
    .slice(-6)
    .map(
      (item, index) =>
        `${index + 1}. qiyinlik=${item.difficulty}; to'g'rilik=${
          item.isCorrect ? "to'g'ri" : "noto'g'ri"
        }; savol="${item.question}"`
    )
    .join("\n");
}

async function generateNextQuestion({ role, topic, difficulty, history }) {
  const prompt = [
    "Yangi savol yarating va faqat JSON qaytaring.",
    `Foydalanuvchi roli: ${role}.`,
    `Topic: "${topic}".`,
    `Target difficulty: ${difficulty} (1 juda oson, 5 murakkab).`,
    "Savol oldingilarni takrorlamasin.",
    `Oldingi savollar:\n${stringifyHistory(history)}`,
    'JSON schema: {"question":string,"expectedAnswer":string}.',
    "Savol o'zbek tilida, ochiq formatda bo'lsin, test variantlari bermang.",
    "expectedAnswer qisqa namunaviy javob bo'lsin.",
  ].join("\n");

  const result = await callGeminiJson(prompt);

  return {
    question: normalizeText(result?.question),
    expectedAnswer: normalizeText(result?.expectedAnswer),
  };
}

module.exports = {
  AdaptiveQuizAiError,
  getProviderMeta,
  validateTopicAndGenerateFirstQuestion,
  evaluateAnswer,
  generateNextQuestion,
};
