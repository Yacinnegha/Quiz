'use strict';
/* =========================================================
   script.js — اختبرني
   المنطق الكامل للتطبيق:
   - محرك الذكاء الاصطناعي (مبني على الملف المرفق ai-api-engine.js)
   - تحليل النص: تقسيم إلى فقرات + 3 كلمات مفتاحية لكل فقرة + سياق عام
   - توليد سؤال اختيار من متعدد لكل فقرة (سياق + فقرة + كلمة مفتاحية)
   - إدارة حالة الاختبار (السؤال الحالي، النقاط، المؤقت)
   - وضع محاكاة محلي يعمل بدون مفتاح API
   ========================================================= */

/* =========================================================
   1) محرك الذكاء الاصطناعي — منقول ومعدّل من ai-api-engine.js
   ========================================================= */

const DEFAULT_AI_MODELS = [
  { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite (الأكثر تقدمًا)" },
  { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite (الأخف)" },
];

let AI_MODELS = [...DEFAULT_AI_MODELS];

/* شبكة أمان: نموذج احتياطي أخير يُجرَّب إذا فشلت النماذج المضبوطة */
const SAFETY_NET_MODEL = { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" };

/* ====== تخزين آمن ====== */
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

/* ====== إدارة مفتاح API ====== */
function loadApiKey() {
  return store.get("ai_api_key") || "";
}
function saveApiKeyToStorage(key) {
  if (key) store.set("ai_api_key", key);
  else store.del("ai_api_key");
}

/* ====== ضبط النماذج المخصصة ====== */
function loadCustomModels() {
  try {
    const raw = store.get("ai_custom_models");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.primary && parsed.fallback) {
        AI_MODELS = [
          { id: parsed.primary, label: parsed.primary.split(":")[0] },
          { id: parsed.fallback, label: parsed.fallback.split(":")[0] },
        ];
        return true;
      }
    }
  } catch {}
  return false;
}

function saveCustomModels(primary, fallback) {
  store.set("ai_custom_models", JSON.stringify({ primary, fallback }));
  AI_MODELS = [
    { id: primary, label: primary.split(":")[0] },
    { id: fallback, label: fallback.split(":")[0] },
  ];
}

function resetCustomModels() {
  store.del("ai_custom_models");
  AI_MODELS = [...DEFAULT_AI_MODELS];
}

function setActiveModel(modelId) {
  const fallbackLadder = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-2.5-flash", "gemini-2.0-flash"];
  const fb = fallbackLadder.find((m) => m !== modelId) || SAFETY_NET_MODEL.id;
  AI_MODELS = [
    { id: modelId, label: modelId },
    { id: fb, label: fb },
  ];
}

/* ====== تحليل JSON متين (من الملف المرفق) ====== */
function robustJSONParse(text) {
  try { return JSON.parse(text); } catch {}

  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch {}
  }

  let repaired = match ? match[0] : text;

  let quoteCount = 0;
  for (let i = 0; i < repaired.length; i++) {
    if (repaired[i] === '"' && (i === 0 || repaired[i - 1] !== "\\")) quoteCount++;
  }
  if (quoteCount % 2 !== 0) repaired += '"';

  let openBraces = 0, openBrackets = 0;
  for (const ch of repaired) {
    if (ch === "{") openBraces++;
    else if (ch === "}") openBraces--;
    else if (ch === "[") openBrackets++;
    else if (ch === "]") openBrackets--;
  }
  while (openBrackets > 0) { repaired += "]"; openBrackets--; }
  while (openBraces > 0) { repaired += "}"; openBraces--; }

  try { return JSON.parse(repaired); } catch {}

  const lastComma = repaired.lastIndexOf('",');
  if (lastComma > 0) {
    let truncated = repaired.substring(0, lastComma + 1);
    let ob = 0, obr = 0;
    for (const ch of truncated) {
      if (ch === "{") ob++;
      else if (ch === "}") ob--;
      else if (ch === "[") obr++;
      else if (ch === "]") obr--;
    }
    while (obr > 0) { truncated += "]"; obr--; }
    while (ob > 0) { truncated += "}"; ob--; }
    try { return JSON.parse(truncated); } catch {}
  }

  return null;
}

/* ====== تحويل الرسائل: OpenAI-style ← Gemini (من الملف المرفق) ====== */
function convertMessagesToGeminiFormat(messages) {
  const result = [];
  let systemInstruction = null;
  for (const msg of messages) {
    if (msg.role === "system") {
      systemInstruction = systemInstruction ? systemInstruction + "\n\n" + msg.content : msg.content;
    } else if (msg.role === "user") {
      result.push({ role: "user", parts: [{ text: msg.content }] });
    } else if (msg.role === "assistant") {
      result.push({ role: "model", parts: [{ text: msg.content }] });
    }
  }
  const body = { contents: result };
  if (systemInstruction) {
    body.systemInstruction = { role: "system", parts: [{ text: systemInstruction }] };
  }
  return body;
}

/* ====== تحويل الاستجابة: Gemini ← OpenAI-like (من الملف المرفق) ====== */
function convertGeminiResponseToOpenAIFormat(geminiData) {
  if (geminiData.error) return { error: geminiData.error };

  if (geminiData.promptFeedback && geminiData.promptFeedback.blockReason) {
    return { error: { message: `تم حجب الطلب: ${geminiData.promptFeedback.blockReason}` } };
  }

  const candidate = geminiData.candidates && geminiData.candidates[0];
  if (!candidate) return { error: { message: "استجابة فارغة من Gemini" } };

  if (candidate.finishReason === "SAFETY") {
    return { error: { message: "تم حجب الاستجابة لسبب أمني" } };
  }

  const parts = (candidate.content && candidate.content.parts) || [];
  const text = parts.map((p) => p.text).filter(Boolean).join("").trim();
  if (!text) return { error: { message: "استجابة فارغة من Gemini" } };

  return {
    choices: [{ message: { content: text }, finishReason: candidate.finishReason }],
  };
}

/* ====== الاستدعاء الرئيسي مع النماذج الاحتياطية (من الملف المرفق + إضافة JSON Schema) ====== */
async function callGoogleAIStudioWithFallback({ body, signal, timeoutMs = 30000 }) {
  const apiKey = loadApiKey();
  if (!apiKey) throw new Error("مفتاح Google AI Studio API غير مُعرَّف");

  let lastError = null;
  const PER_MODEL_TIMEOUT = timeoutMs;

  const geminiBody = convertMessagesToGeminiFormat(body.messages || []);
  geminiBody.generationConfig = geminiBody.generationConfig || {};
  if (body.temperature !== undefined) geminiBody.generationConfig.temperature = body.temperature;
  if (body.max_tokens !== undefined) geminiBody.generationConfig.maxOutputTokens = body.max_tokens;
  if (body.jsonSchema) {
    geminiBody.generationConfig.responseMimeType = "application/json";
    geminiBody.generationConfig.responseSchema = body.jsonSchema;
  }

  const attempts = [...AI_MODELS];
  if (!attempts.some((m) => m.id === SAFETY_NET_MODEL.id)) attempts.push(SAFETY_NET_MODEL);

  for (let i = 0; i < attempts.length; i++) {
    const model = attempts[i];
    const perModelController = new AbortController();
    const perModelTimer = setTimeout(() => perModelController.abort(), PER_MODEL_TIMEOUT);

    let externalAbortHandler = null;
    if (signal) {
      if (signal.aborted) {
        clearTimeout(perModelTimer);
        lastError = new Error("الطلب مُلغى خارجيًا");
        continue;
      }
      externalAbortHandler = () => perModelController.abort();
      signal.addEventListener("abort", externalAbortHandler);
    }

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model.id)}:generateContent?key=${encodeURIComponent(apiKey)}`;

      const res = await fetch(url, {
        method: "POST",
        signal: perModelController.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(geminiBody),
      });

      if (!res.ok) {
        let errDetail = "";
        try { errDetail = await res.text(); } catch {}
        console.warn(`[API] فشل النموذج ${model.label} (HTTP ${res.status}): ${errDetail.slice(0, 200)}`);
        lastError = new Error(`HTTP ${res.status}: ${errDetail.slice(0, 140)}`);
        continue;
      }

      const rawData = await res.json();

      if (rawData.error) {
        const errMsg = rawData.error.message || JSON.stringify(rawData.error);
        console.warn(`[API] المزوّد أرجع خطأ للنموذج ${model.label}: ${errMsg}`);
        lastError = new Error(errMsg);
        continue;
      }

      const data = convertGeminiResponseToOpenAIFormat(rawData);
      if (data.error) {
        console.warn(`[API] خطأ في استجابة النموذج ${model.label}: ${data.error.message}`);
        lastError = new Error(data.error.message);
        continue;
      }

      const content = data.choices && data.choices[0] && data.choices[0].message.content;
      if (!content) {
        console.warn(`[API] استجابة فارغة للنموذج ${model.label}`);
        lastError = new Error("استجابة فارغة");
        continue;
      }

      console.log(`[API] نجح النموذج ${model.label}`);
      return { data, usedModel: model.id };
    } catch (err) {
      if (signal && signal.aborted) throw err;
      console.warn(`[API] فشل النموذج ${model.label}: ${err && err.message}`);
      lastError = err;
      continue;
    } finally {
      clearTimeout(perModelTimer);
      if (signal && externalAbortHandler) signal.removeEventListener("abort", externalAbortHandler);
    }
  }

  throw lastError || new Error("فشل جميع النماذج");
}

/* =========================================================
   2) مهام التطبيق عبر الذكاء الاصطناعي (Gemini)
   ========================================================= */

/* الحد الأقصى لعدد الفقرات التي يُقسَّم إليها النص (حدّه المستخدم: 100) */
const MAX_PARAGRAPHS = 100;

/* برومبت التحليل — limit > 0 يعني أن المستخدم طلب عددًا محددًا من الفقرات فيُدرَج في القواعد نفسها */
function buildSystemAnalyze(limit) {
  const rule1 = limit > 0
    ? `1. قسّم النص إلى ${limit} فقرة بالضبط — هذا العدد طلبه المستخدم صراحةً وهو أولوية قصوى يجب الالتزام به (لا أكثر ولا أقل). إذا كانت فقرات النص الطبيعية أقل من ${limit}، فكّك الفقرات الطويلة إلى فقرات أصغر حسب المواضيع أو مجموعات الجمل المتقاربة حتى تبلغ ${limit} فقرة، وما تعذّر بلوغ العدد كاملًا لتقصّر النص قسّمه إلى أكبر عدد ممكن من الفقرات المفهومة. احرص على أن تكون كل فقرة ناتجة تشتمل على معاني مفهومة ويفضل أن تكون الفقرة الواحدة بين 3 إلى 10 أسطر.`
    : `1. قسّم النص إلى فقرات (من 3 إلى ${MAX_PARAGRAPHS} فقرة قدر الإمكان، وكلما كان النص أطول زاد عدد الفقرات). إذا كان النص كتلة واحدة متصلة، قسّمه حسب المواضيع أو مجموعات الجمل المتقاربة، احرص على أن تكون كل فقرة ناتجة تشتمل على معاني مفهومة ويفضل أن تكون الفقرة الواحدة بين 3 إلى 10 أسطر.`;
  return `أنت خبير تعليمي متخصص في تحليل النصوص العربية وإنشاء اختبارات.
مهمتك: تحليل النص الذي يرسله المستخدم وإرجاع النتيجة بصيغة JSON فقط.
القواعد:
${rule1}
2. انسخ نص كل فقرة كما ورد حرفيًا مع تقليم المسافات الزائدة فقط. لا تهدر أي جزء من النص أثناء التقسيم.
3. لكل فقرة استخرج بالضبط 3 كلمات مفتاحية: كلمات مهمة وردت حرفيًا داخل الفقرة، ذات محتوى دلالي (ليست أدوات نحو أو حروف جر أو كلمات شائعة)، ومختلفة عن بعضها.
4. اكتب سياقًا عامًا موجزًا (من ثلاث إلى خمسة جمل) يلخص موضوع النص كله.
أعد JSON فقط دون أي شرح إضافي.`;
}

const SCHEMA_ANALYZE = {
  type: "OBJECT",
  properties: {
    context: { type: "STRING" },
    paragraphs: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          text: { type: "STRING" },
          keywords: { type: "ARRAY", items: { type: "STRING" } },
        },
        required: ["text", "keywords"],
      },
    },
  },
  required: ["context", "paragraphs"],
};

const SYSTEM_QUIZ = `أنت مختص في تأليف أسئلة اختيار من متعدد باللغة العربية بناءً على فقرات نصية.
ستستقبل: السياق العام للنص، فقرة واحدة، وكلمة مفتاحية من هذه الفقرة.
المطلوب: سؤال واحد اختيار من متعدد حول الكلمة المفتاحية في سياقها داخل الفقرة.
القواعد الصارمة:
1. السؤال يجب أن يكون قابلًا للإجابة من الفقرة نفسها فقط، ولا تفترض معرفة المستخدم للفقرة مسبقًا ولا تشر لوجودها (لا تستخدم عبارات مثل «حسب الفقرة» أو «كما ورد في النص» أو «الفقرة السابقة») — صغ السؤال ليكون مفهومًا بمفرده.
2. أربعة خيارات: خيار واحد صحيح فقط، وثلاثة مشتتات منطقية ومقنعة لكنها خاطئة عند التدقيق.
3. correctIndex هو رقم الخيار الصحيح (0 إلى 3).
4. explanation: تعليل موجز للإجابة الصحيحة مستند إلى ما ورد حرفيًا في الفقرة.
5. اجعل السؤال واضحًا ومباشرًا وباللغة العربية الفصحى.
أعد JSON فقط.`;

const SCHEMA_QUESTION = {
  type: "OBJECT",
  properties: {
    question: { type: "STRING" },
    options: { type: "ARRAY", items: { type: "STRING" } },
    correctIndex: { type: "INTEGER" },
    explanation: { type: "STRING" },
  },
  required: ["question", "options", "correctIndex", "explanation"],
};

/* --- تحليل النص: فقرات + كلمات مفتاحية + سياق عام (limit: عدد الفقرات المطلوب من المستخدم، 0 = تلقائي) --- */
async function aiAnalyzeText(text, signal, limit = 0) {
  const paraLimit = limit > 0 ? Math.min(limit, MAX_PARAGRAPHS) : 0;
  const body = {
    messages: [
      { role: "system", content: buildSystemAnalyze(paraLimit) },
      {
        role: "user",
        content: `حلّل النص التالي:\n\n"""\n${text}\n"""` +
          (paraLimit > 0 ? `\n\nتنبيه مهم: قسّم النص أعلاه إلى ${paraLimit} فقرة بالضبط (لا أكثر ولا أقل) كما هو مطلوب في القواعد.` : ""),
      },
    ],
    temperature: 0.4,
    max_tokens: 8192,
    jsonSchema: SCHEMA_ANALYZE,
  };
  const { data } = await callGoogleAIStudioWithFallback({ body, signal, timeoutMs: 60000 });
  const parsed = robustJSONParse(data.choices[0].message.content);
  if (!parsed || !Array.isArray(parsed.paragraphs) || !parsed.paragraphs.length) {
    throw new Error("تعذر فهم استجابة التحليل من النموذج. أعد المحاولة.");
  }
  let paragraphs = parsed.paragraphs
    .map((p) => ({
      text: String((p && p.text) || "").trim(),
      keywords: normalizeKeywords(p && p.keywords, String((p && p.text) || "")),
    }))
    .filter((p) => p.text.length > 0);
  if (!paragraphs.length) throw new Error("لم يتمكن النموذج من تقسيم النص إلى فقرات.");
  const cap = paraLimit > 0 ? paraLimit : MAX_PARAGRAPHS;
  if (paragraphs.length > cap) {
    /* دمج الفائض عن الحد توزيعًا متوازنًا حتى لا يُهدر أي جزء من النص */
    paragraphs = mergeParagraphObjects(paragraphs, cap);
  }
  const context = String(parsed.context || "").trim() || paragraphs[0].text.slice(0, 160);
  return { context, paragraphs };
}

/* دمج فقرات متجاورة توزيعًا متوازنًا حتى بلوغ target فقرة (كل النص يُحفظ، لا شيء يُهدر) */
function mergeParagraphObjects(paragraphs, target) {
  if (paragraphs.length <= target) return paragraphs;
  const base = Math.floor(paragraphs.length / target);
  const extra = paragraphs.length % target;
  const out = [];
  let idx = 0;
  for (let g = 0; g < target; g++) {
    const size = base + (g < extra ? 1 : 0);
    const chunk = paragraphs.slice(idx, idx + size);
    idx += size;
    const text = chunk.map((p) => p.text).join("\n");
    out.push({ text, keywords: normalizeKeywords(chunk.flatMap((p) => p.keywords || []), text) });
  }
  return out;
}

function normalizeKeywords(raw, paragraphText) {
  let kws = Array.isArray(raw) ? raw.map((k) => String(k).trim()).filter(Boolean) : [];
  kws = [...new Set(kws)].slice(0, 3);
  while (kws.length < 3) {
    const extra = demoExtractKeywords(paragraphText, kws);
    if (!extra.length) break;
    kws.push(extra[0]);
  }
  return kws;
}

/* --- توليد سؤال من (سياق + فقرة + كلمة مفتاحية) --- */
async function aiGenerateQuestion({ context, paragraph, keyword }, signal) {
  const lvl = getDifficulty();
  const diffDirective = lvl === "easy"
    ? "مستوى الصعوبة المطلوب: سهل — اجعل السؤال مباشرًا وواضحًا، واجعل المشتتات مختلفة بوضوح عن الإجابة الصحيحة بحيث يستطيع قارئ متمكن من الفقرة الإجابة بسرعة وثقة."
    : lvl === "hard"
      ? "مستوى الصعوبة المطلوب: صعب — اجعل السؤال تحليليًا يتطلب فهمًا أعمق للفقرة لا مجرد استرجاع حرفي، واجعل المشتتات قريبة لفظيًا ودلاليًا من الإجابة الصحيحة بحيث يتطلب التفريق بينها تدقيقًا في التفاصيل."
      : "";
  const body = {
    messages: [
      { role: "system", content: SYSTEM_QUIZ },
      {
        role: "user",
        content: `السياق العام للنص:\n${context}\n\nالفقرة:\n"""\n${paragraph}\n"""\n\nالكلمة المفتاحية المطلوب السؤال عنها: «${keyword}»${diffDirective ? "\n\n" + diffDirective : ""}\n\nأعد سؤال اختيار من متعدد بصيغة JSON.`,
      },
    ],
    temperature: 0.9,
    max_tokens: 2048,
    jsonSchema: SCHEMA_QUESTION,
  };
  const { data } = await callGoogleAIStudioWithFallback({ body, signal, timeoutMs: 45000 });
  const parsed = robustJSONParse(data.choices[0].message.content);
  if (!parsed || typeof parsed.question !== "string" || !Array.isArray(parsed.options) || parsed.options.length < 2) {
    throw new Error("تعذر فهم استجابة السؤال من النموذج. أعد المحاولة.");
  }
  return normalizeQuestion(parsed);
}

function normalizeQuestion(q) {
  let options = q.options.map((o) => String(o).trim()).filter(Boolean).slice(0, 4);
  while (options.length < 4) options.push("لا شيء مما سبق " + (options.length + 1));
  let correctIndex = Number.isInteger(q.correctIndex) ? q.correctIndex : parseInt(q.correctIndex, 10);
  if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length) correctIndex = 0;
  const correctText = options[correctIndex];
  options = shuffle([...options]);
  return {
    question: String(q.question).trim(),
    options,
    correctIndex: options.indexOf(correctText),
    explanation: String(q.explanation || "").trim(),
  };
}

/* --- استخراج كلمات مفتاحية جديدة (لجولة إعادة بأسئلة مختلفة) --- */
async function aiRefreshKeywords({ paragraph, exclude }, signal) {
  const body = {
    messages: [
      { role: "system", content: "أنت مساعد يستخرج كلمات مفتاحية من نصوص عربية. أعد JSON فقط." },
      {
        role: "user",
        content: `الفقرة:\n"""\n${paragraph}\n"""\n\nكلمات استُخدمت سابقًا (ممنوع تكرارها): ${exclude.join("، ") || "لا شيء"}\n\nاستخرج 3 كلمات مفتاحية جديدة وردت حرفيًا في الفقرة وليست ضمن القائمة الممنوعة.`,
      },
    ],
    temperature: 0.8,
    max_tokens: 512,
    jsonSchema: {
      type: "OBJECT",
      properties: { keywords: { type: "ARRAY", items: { type: "STRING" } } },
      required: ["keywords"],
    },
  };
  try {
    const { data } = await callGoogleAIStudioWithFallback({ body, signal, timeoutMs: 30000 });
    const parsed = robustJSONParse(data.choices[0].message.content);
    const kws = parsed && Array.isArray(parsed.keywords)
      ? parsed.keywords.map((k) => String(k).trim()).filter(Boolean)
      : [];
    return [...new Set(kws)].slice(0, 3);
  } catch {
    return [];
  }
}

/* --- رسائل أخطاء مفهومة بالعربية --- */
function friendlyApiError(err) {
  const msg = String((err && err.message) || err || "");
  if (/API key not valid|API_KEY_INVALID/i.test(msg)) return "مفتاح API غير صالح. تأكد من نسخه كاملًا من Google AI Studio.";
  if (/\b401\b|\b403\b|permission|PERMISSION_DENIED/i.test(msg)) return "تم رفض الوصول (403). تأكد أن المفتاح مفعّل وأن Generative Language API متاحة له.";
  if (/\b429\b|quota|RESOURCE_EXHAUSTED/i.test(msg)) return "تم تجاوز حصة الاستخدام (429). انتظر قليلًا ثم أعد المحاولة.";
  if (/\b404\b|not found|NOT_FOUND/i.test(msg)) return "النموذج المطلوب غير متاح لمفتاحك (404). جرّب نموذجًا آخر من قائمة «النموذج».";
  if (/abort|timeout/i.test(msg)) return "انتهت مهلة الطلب أو أُلغي. تحقق من اتصالك ثم أعد المحاولة.";
  if (/failed to fetch|networkerror|load failed/i.test(msg)) return "تعذر الاتصال بخدمة Google. تحقق من اتصال الإنترنت.";
  if (/مفتاح Google AI Studio API غير مُعرَّف/.test(msg)) return "أدخل مفتاح API أولًا، أو فعّل وضع المحاكاة.";
  return msg || "حدث خطأ غير متوقع.";
}

/* =========================================================
   3) محرك المحاكاة — يعمل محليًا بدون أي مفتاح API
   ========================================================= */

const AR_STOPWORDS = new Set(
  ("في من على إلى عن أن إن أنه إنه التي الذي الذين اللواتي هذا هذه ذلك تلك هو هي هم هن نحن كان كانت يكون تكون " +
    "قد لقد مع كل بعض لا ما لم لن إذا ثم أو أم بل بين عند عندما كما لكن لكنه حيث بعد قبل خلال نحو منذ سوف يا أما " +
    "إما كي لكي لأن حتى غير أي أيضا أيضًا هناك هنا به بها بهم بها له لها لهم منه منها عليه عليها إليه إليها ذات ذو " +
    "عدد عدة شيء أشياء جدا جدًا يمكن يجب أكثر أقل كثير قليل أول آخر بينما رغم مثل نفس عبر دون بدون سواء وذلك وهذه " +
    "التي وهو وهي وكان وقد ولكنه هذا تلك هناك أثناء ضمن سوى عوض بد إذ حين لحظ إلا سوى كأن ليس ليست لست لم يكن").split(/\s+/)
);

function demoExtractKeywords(text, exclude) {
  const ex = exclude || [];
  const words = String(text)
    .replace(/[^\u0600-\u06FF0-9A-Za-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const freq = new Map();
  for (const w of words) {
    if (w.length < 3 || AR_STOPWORDS.has(w) || ex.includes(w)) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  let cands = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map((e) => e[0]);
  if (!cands.length) {
    cands = words.filter((w) => w.length >= 3 && !ex.includes(w)).sort((a, b) => b.length - a.length);
  }
  return [...new Set(cands)].slice(0, 3);
}

/* تفكيك أطول الفقرات بالجمل حتى بلوغ target فقرة (محاكاة ما يفعله النموذج عندما يقل عدد الفقرات عن المطلوب) */
function splitPartsToCount(parts, target) {
  const SENT = /(?<=[.!؟?])\s+/;
  const out = parts.slice();
  while (out.length < target) {
    let bestIdx = -1;
    let bestCount = 1;
    for (let i = 0; i < out.length; i++) {
      const c = out[i].split(SENT).filter(Boolean).length;
      if (c > bestCount) { bestCount = c; bestIdx = i; }
    }
    if (bestIdx < 0) break; /* لا توجد فقرة قابلة للتفكيك أكثر */
    const sents = out[bestIdx].split(SENT).map((s) => s.trim()).filter(Boolean);
    const half = Math.ceil(sents.length / 2);
    const first = sents.slice(0, half).join(" ");
    const second = sents.slice(half).join(" ");
    if (!first || !second) break;
    out.splice(bestIdx, 1, first, second);
  }
  return out;
}

/* دمج فقرات متجاورة توزيعًا متوازنًا حتى بلوغ target فقرة */
function mergePartsToCount(parts, target) {
  if (parts.length <= target) return parts;
  const base = Math.floor(parts.length / target);
  const extra = parts.length % target;
  const out = [];
  let idx = 0;
  for (let g = 0; g < target; g++) {
    const size = base + (g < extra ? 1 : 0);
    out.push(parts.slice(idx, idx + size).join("\n"));
    idx += size;
  }
  return out;
}

function demoAnalyze(text, limit = 0) {
  let parts = text.split(/\n\s*\n+/).map((t) => t.trim()).filter(Boolean);
  if (parts.length < 2) {
    const sentences = text.split(/(?<=[.!؟?])\s+/).map((s) => s.trim()).filter(Boolean);
    parts = [];
    const size = sentences.length >= 9 ? 3 : 2;
    for (let i = 0; i < sentences.length; i += size) {
      parts.push(sentences.slice(i, i + size).join(" "));
    }
    if (!parts.length) parts = [text.trim()];
  }
  const target = limit > 0 ? Math.min(limit, MAX_PARAGRAPHS) : 0;
  if (target > 0 && parts.length < target) parts = splitPartsToCount(parts, target);
  if (target > 0 && parts.length > target) parts = mergePartsToCount(parts, target);
  if (target === 0 && parts.length > MAX_PARAGRAPHS) {
    const head = parts.slice(0, MAX_PARAGRAPHS - 1);
    head.push(parts.slice(MAX_PARAGRAPHS - 1).join(" "));
    parts = head;
  }
  const paragraphs = parts.map((t) => ({ text: t, keywords: demoExtractKeywords(t) }));
  const firstSentences = paragraphs
    .map((p) => (p.text.split(/(?<=[.!؟?])\s+/)[0] || p.text).slice(0, 120))
    .slice(0, 2)
    .join(" ");
  return { context: firstSentences || text.slice(0, 120), paragraphs };
}

function demoGenerateQuestion({ paragraph, keyword, pool, difficulty: lvl }) {
  const sentences = paragraph.split(/(?<=[.!؟?])\s+/).map((s) => s.trim()).filter(Boolean);
  const target = sentences.find((s) => s.includes(keyword)) || paragraph;
  const masked = target.replace(keyword, "______");
  /* المشتتات تختلف حسب مستوى الصعوبة */
  let candidates = pool.filter((k) => k && k !== keyword);
  if (lvl === "easy") {
    /* مشتتات من فقرات أخرى — مختلفة بوضوح عن سياق هذه الفقرة */
    const sameParagraphWords = new Set(demoExtractKeywords(paragraph));
    const fromOthers = candidates.filter((k) => !sameParagraphWords.has(k));
    if (fromOthers.length >= 3) candidates = fromOthers;
  } else if (lvl === "hard") {
    /* كلمات من الفقرة نفسها الأقرب في الطول — أقرب بلطف وأصعب تمييزًا */
    const inPara = demoExtractKeywords(paragraph, [keyword]).filter((k) => k !== keyword);
    inPara.sort((a, b) => Math.abs(a.length - keyword.length) - Math.abs(b.length - keyword.length));
    candidates = [...new Set([...inPara, ...candidates])]; /* إزالة التكرار الناتج عن الدمج */
  }
  const distractors = shuffle(candidates).slice(0, 3);
  let guard = 0;
  while (distractors.length < 3 && guard++ < 10) {
    const w = demoExtractKeywords(paragraph, [keyword, ...distractors])[0];
    if (!w || distractors.includes(w)) break;
    distractors.push(w);
  }
  const generic = ["العملية", "النتيجة", "الهدف", "المعلومة", "الأسلوب", "الظاهرة"];
  for (const g of generic) {
    if (distractors.length >= 3) break;
    if (g !== keyword && !distractors.includes(g)) distractors.push(g);
  }
  const options = shuffle([keyword, ...distractors.slice(0, 3)]);
  const shortTarget = target.length > 140 ? target.slice(0, 140) + "…" : target;
  return {
    question: `أكمل الفراغ بالكلمة الصحيحة المناسبة:
«${masked}»`,
    options,
    correctIndex: options.indexOf(keyword),
    explanation: `الكلمة «${keyword}» وردت في الفقرة ضمن الجملة: «${shortTarget}»`,
  };
}

/* =========================================================
   4) أدوات مساعدة عامة
   ========================================================= */

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isAbort(err) {
  return err && (err.name === "AbortError" || /الطلب مُلغى خارجيًا/.test(String(err.message)));
}

function fmtDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function el(id) {
  return document.getElementById(id);
}

/* صيغة العدد العربية */
function quizCountWord(n) {
  if (n === 1) return "سؤال واحد";
  if (n === 2) return "سؤالان";
  if (n >= 3 && n <= 10) return n + " أسئلة";
  return n + " سؤالًا";
}

/* صيغة عدد مرات اللعب */
function playCountWord(n) {
  if (n === 1) return "لُعب مرة واحدة";
  if (n === 2) return "لُعب مرتين";
  return "لُعب " + n + " مرات";
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ====== المؤثرات الصوتية (WebAudio — بدون ملفات) ====== */
const sound = { enabled: store.get("quiz_sound") !== "off", ctx: null };

function audioCtx() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!sound.ctx) sound.ctx = new AC();
  if (sound.ctx.state === "suspended") sound.ctx.resume().catch(() => {});
  return sound.ctx;
}

function tone(freq, start, dur, type) {
  const ctx = audioCtx();
  if (!ctx) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type || "sine";
  o.frequency.value = freq;
  const t = ctx.currentTime + start;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.06, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g);
  g.connect(ctx.destination);
  o.start(t);
  o.stop(t + dur + 0.05);
}

function playCorrect() {
  if (!sound.enabled) return;
  try { tone(587.33, 0, 0.12); tone(880, 0.1, 0.18); } catch {}
}

function playWrong() {
  if (!sound.enabled) return;
  try { tone(311.13, 0, 0.16, "triangle"); tone(233.08, 0.12, 0.22, "triangle"); } catch {}
}

function playFinish() {
  if (!sound.enabled) return;
  try { [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, i * 0.11, 0.16)); } catch {}
}

function updateSoundIcon() {
  el("icon-vol").classList.toggle("hidden", !sound.enabled);
  el("icon-vol-x").classList.toggle("hidden", sound.enabled);
  el("btn-sound").setAttribute("aria-pressed", String(sound.enabled));
}

function toggleSound() {
  sound.enabled = !sound.enabled;
  store.set("quiz_sound", sound.enabled ? "on" : "off");
  updateSoundIcon();
  if (sound.enabled) playCorrect();
  toast("info", sound.enabled ? "تم تفعيل المؤثرات الصوتية." : "تم كتم المؤثرات الصوتية.");
}

/* ====== إعدادات وضع السرعة (مؤقت لكل سؤال) ====== */
const speedSettings = { on: false, secs: 10 };

/* تقييد زمن السؤال — أي عدد من الثواني بين 1 و600 */
function clampQuestionSecs(n) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v)) return 10;
  return Math.max(1, Math.min(600, v));
}

function loadSpeedSettings() {
  try {
    const raw = JSON.parse(store.get("quiz_speed") || "null");
    if (raw && typeof raw.on === "boolean") {
      speedSettings.on = raw.on;
      speedSettings.secs = clampQuestionSecs(raw.secs);
    }
  } catch {}
}

function saveSpeedSettings() {
  store.set("quiz_speed", JSON.stringify({ on: speedSettings.on, secs: speedSettings.secs }));
}

function syncSpeedInputs() {
  el("speed-mode").checked = speedSettings.on;
  el("speed-seconds").value = String(speedSettings.secs);
}

/* ====== مستوى الصعوبة (segmented control) ====== */
const DIFF_LABELS = { easy: "سهل", medium: "متوسط", hard: "صعب" };
const DIFF_ORDER = ["easy", "medium", "hard"];
let difficulty = "medium";

function loadDifficulty() {
  const v = store.get("quiz_difficulty");
  difficulty = DIFF_LABELS[v] ? v : "medium";
}

function getDifficulty() { return difficulty; }

function syncDifficultyUI() {
  const seg = el("difficulty-seg");
  if (!seg) return;
  const idx = DIFF_ORDER.indexOf(difficulty);
  seg.querySelectorAll(".seg-btn").forEach((b) => {
    const on = b.dataset.level === difficulty;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", on ? "true" : "false");
  });
  seg.dataset.diff = difficulty;
  const thumb = seg.querySelector(".seg-thumb");
  if (thumb) thumb.style.transform = "translateX(" + (-100 * idx) + "%)";
}

function setDifficulty(lvl, silent) {
  if (!DIFF_LABELS[lvl]) return;
  difficulty = lvl;
  store.set("quiz_difficulty", lvl);
  syncDifficultyUI();
  if (!silent) {
    toast("info", "مستوى الصعوبة: " + DIFF_LABELS[lvl] +
      (lvl === "easy" ? " — أسئلة مباشرة ومشتتات واضحة."
      : lvl === "hard" ? " — أسئلة تحليلية ومشتتات قريبة من الإجابة."
      : " (متوازن)."));
  }
}

/* ====== سجل النتائج (localStorage) ====== */
function loadHistory() {
  try { return JSON.parse(store.get("quiz_history") || "[]"); } catch { return []; }
}

function saveHistoryItem(item) {
  const h = loadHistory();
  h.unshift(item);
  store.set("quiz_history", JSON.stringify(h.slice(0, 20)));
}

function clearHistory() {
  if (!loadHistory().length) return;
  if (!confirm("هل تريد مسح سجل النتائج بالكامل؟")) return;
  store.del("quiz_history");
  renderHistory();
  toast("info", "تم مسح سجل النتائج.");
}

/* تصدير السجل بصيغة CSV (BOM للعربية في Excel/Sheets) */
function exportHistoryCSV() {
  const h = loadHistory();
  if (!h.length) {
    toast("error", "لا يوجد سجل للتصدير بعد.");
    return;
  }
  const esc = (v) => {
    const s = String(v == null ? "" : v);
    return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const typeOf = (x) =>
    [x.demo && "محاكاة", x.focus && "تدريب", x.imported && "مستورد"].filter(Boolean).join("+") || "عادي";
  const rows = [
    ["التاريخ", "النتيجة", "الأسئلة", "النسبة %", "المدة (ثانية)", "المستوى", "النوع", "مقتطف"],
  ];
  h.forEach((x) => {
    rows.push([
      new Date(x.date).toLocaleString("ar"),
      x.score,
      x.total,
      x.pct,
      Math.round((x.duration || 0) / 1000),
      DIFF_LABELS[x.lvl] || "متوسط",
      typeOf(x),
      String(x.preview || "").replace(/\s+/g, " ").slice(0, 60),
    ]);
  });
  const csv = "\uFEFF" + rows.map((r) => r.map(esc).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "اختبرني-السجل-" + new Date().toISOString().slice(0, 10) + ".csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast("success", "تم تصدير السجل بصيغة CSV — افتحه في Excel أو Google Sheets.");
}

/* نطاق الإحصاءات الزمني المختار: all أو عدد أيام (7/30) */
let histRange = "all";

function historyInRange(all) {
  if (histRange === "all") return all;
  const days = parseInt(histRange, 10) || 0;
  if (!days) return all;
  const min = Date.now() - days * 86400000;
  return all.filter((x) => {
    const t = new Date(x.date).getTime();
    return !isNaN(t) && t >= min;
  });
}

function setHistoryRange(range) {
  histRange = range;
  document.querySelectorAll(".hist-range").forEach((b) => {
    const on = b.dataset.range === histRange;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
  renderHistory();
}

function testCountWord(n) {
  if (n === 1) return "اختبار واحد";
  if (n === 2) return "اختباران";
  if (n >= 3 && n <= 10) return n + " اختبارات";
  return n + " اختبارًا";
}

/* شريط التقدم الأسبوعي: آخر 7 أيام مقابل الأسبوع السابق — مستقل عن نطاق الإحصاءات */
function renderWeekStrip(all) {
  const strip = el("week-strip");
  if (!strip) return;
  strip.innerHTML = "";
  const day = 86400000;
  const now = Date.now();
  const inWin = (x, from, to) => {
    const t = new Date(x.date).getTime();
    return !isNaN(t) && t >= from && t < to;
  };
  const tw = all.filter((x) => inWin(x, now - 7 * day, now + day));
  const lw = all.filter((x) => inWin(x, now - 14 * day, now - 7 * day));
  if (!tw.length && !lw.length) { strip.classList.add("hidden"); return; }
  strip.classList.remove("hidden");

  const avgOf = (arr) => arr.length ? Math.round(arr.reduce((s, x) => s + (x.pct || 0), 0) / arr.length) : null;
  const twAvg = avgOf(tw);
  const lwAvg = avgOf(lw);

  const seg = (label, count, avg, dim) => {
    const d = document.createElement("div");
    d.className = "week-seg" + (dim ? " dim" : "");
    const l = document.createElement("span");
    l.className = "week-label";
    l.textContent = label;
    const v = document.createElement("strong");
    v.className = "week-value";
    v.textContent = count ? testCountWord(count) + (avg !== null ? " · متوسط " + avg + "%" : "") : "لا اختبارات";
    d.appendChild(l);
    d.appendChild(v);
    return d;
  };

  strip.appendChild(seg("هذا الأسبوع", tw.length, twAvg, false));
  strip.appendChild(seg("الأسبوع الماضي", lw.length, lwAvg, !lw.length));

  const delta = document.createElement("span");
  delta.className = "week-delta";
  if (twAvg !== null && lwAvg !== null) {
    const diff = twAvg - lwAvg;
    if (diff > 0) { delta.classList.add("up"); delta.textContent = "↑ +" + diff + "%"; }
    else if (diff < 0) { delta.classList.add("down"); delta.textContent = "↓ " + diff + "%"; }
    else { delta.classList.add("flat"); delta.textContent = "→ مستقر"; }
  } else {
    delta.classList.add("flat");
    delta.textContent = twAvg !== null ? "بداية" : "—";
  }
  strip.appendChild(delta);
}

function renderHistory() {
  const card = el("history-card");
  const list = el("history-list");
  const spark = el("history-spark");
  const all = loadHistory();
  if (!all.length) {
    card.classList.add("hidden");
    list.innerHTML = "";
    spark.innerHTML = "";
    return;
  }
  card.classList.remove("hidden");

  /* النطاق الزمني يقيّد الإحصاءات والمخطط والقائمة معًا */
  const h = historyInRange(all);
  const best = h.length ? Math.max.apply(null, h.map((x) => x.pct || 0)) : 0;

  /* شريط الأسبوع يبقى من السجل كاملًا لا من النطاق */
  renderWeekStrip(all);

  /* ---- إحصاءات ملخصة (ضمن النطاق) ---- */
  const noData = !h.length;
  const avg = noData ? 0 : Math.round(h.reduce((s, x) => s + (x.pct || 0), 0) / h.length);
  el("hs-count").textContent = String(h.length);
  el("hs-avg").textContent = noData ? "—" : avg + "%";
  el("hs-best").textContent = noData ? "—" : best + "%";
  const trendBox = el("hs-trend-box");
  trendBox.classList.remove("trend-up", "trend-down");
  const trendEl = el("hs-trend");
  const lastPct = h[0] ? (h[0].pct || 0) : 0;
  const prevPct = h[1] ? (h[1].pct || 0) : null;
  if (noData || prevPct === null) trendEl.textContent = "—";
  else if (lastPct > prevPct) { trendEl.textContent = "↑ " + lastPct + "%"; trendBox.classList.add("trend-up"); }
  else if (lastPct < prevPct) { trendEl.textContent = "↓ " + lastPct + "%"; trendBox.classList.add("trend-down"); }
  else trendEl.textContent = "→ " + lastPct + "%";

  /* ---- حالة الفراغ ضمن النطاق ---- */
  spark.innerHTML = "";
  list.innerHTML = "";
  if (noData) {
    const empty = document.createElement("div");
    empty.className = "spark-empty";
    empty.textContent = "لا نتائج ضمن هذا النطاق الزمني — جرّب نطاقًا أوسع.";
    spark.appendChild(empty);
    return;
  }

  /* ---- مخطط التقدم (آخر 12 نتيجة ضمن النطاق، الأقدم يمينًا) ---- */
  h.slice(0, 12).reverse().forEach((item) => {
    const bar = document.createElement("i");
    bar.className = "bar" + (h.length > 1 && (item.pct || 0) === best ? " best" : "");
    bar.style.height = Math.max(8, item.pct || 4) + "%";
    let tip = (item.score || 0) + "/" + (item.total || 0) + " — " + (item.pct || 0) + "%";
    if (item.focus) tip += " (تدريب)";
    if (item.imported) tip += " (مستورد)";
    if (item.demo) tip += " (محاكاة)";
    bar.title = tip;
    spark.appendChild(bar);
  });

  /* ---- قائمة النتائج (ضمن النطاق) ---- */
  h.slice(0, 10).forEach((item) => {
    const li = document.createElement("li");
    li.className = "history-item";

    const score = document.createElement("span");
    score.className = "history-score";
    score.textContent = item.score + "/" + item.total;

    const pct = document.createElement("span");
    pct.className = "history-pct";
    pct.textContent = (item.pct || 0) + "%";

    const preview = document.createElement("span");
    preview.className = "history-preview";
    preview.textContent = item.preview || "";

    const date = document.createElement("span");
    date.className = "history-date";
    try {
      date.textContent = new Date(item.date).toLocaleString("ar", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    } catch { date.textContent = ""; }

    li.appendChild(score);
    li.appendChild(pct);
    if (item.demo) {
      const d = document.createElement("span");
      d.className = "chip accent history-chip-mini";
      d.textContent = "محاكاة";
      li.appendChild(d);
    }
    if (item.focus) {
      const d = document.createElement("span");
      d.className = "chip history-chip-mini focus";
      d.textContent = "تدريب";
      li.appendChild(d);
    }
    if (item.imported) {
      const d = document.createElement("span");
      d.className = "chip history-chip-mini imported";
      d.textContent = "مستورد";
      li.appendChild(d);
    }
    if (item.lvl && item.lvl !== "medium") {
      const lv = document.createElement("span");
      lv.className = "chip history-chip-mini lvl-chip " + (item.lvl === "hard" ? "bad" : "ok");
      lv.textContent = DIFF_LABELS[item.lvl] || "";
      li.appendChild(lv);
    }
    if ((item.pct || 0) === best && h.length > 1) {
      const b = document.createElement("span");
      b.className = "history-best";
      b.textContent = "الأفضل";
      li.appendChild(b);
    }
    li.appendChild(date);
    list.appendChild(li);
  });
}

/* ====== احتفال النتيجة العالية ====== */
function burstConfetti() {
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const wrap = el("confetti");
  wrap.innerHTML = "";
  const colors = ["#14b8a6", "#34d399", "#f59e0b", "#fb7185", "#a3e635"];
  for (let i = 0; i < 42; i++) {
    const p = document.createElement("i");
    p.style.left = Math.random() * 100 + "%";
    p.style.background = colors[i % colors.length];
    p.style.width = 6 + Math.random() * 6 + "px";
    p.style.height = 10 + Math.random() * 8 + "px";
    p.style.setProperty("--d", 2.2 + Math.random() * 1.6 + "s");
    p.style.setProperty("--delay", Math.random() * 0.5 + "s");
    p.style.setProperty("--r", Math.floor(Math.random() * 360) + "deg");
    wrap.appendChild(p);
  }
  setTimeout(() => { wrap.innerHTML = ""; }, 4800);
}

function showScreen(name) {
  ["setup", "preparing", "quiz", "results", "cards"].forEach((s) => {
    const node = el("screen-" + s);
    if (node) node.classList.toggle("active", s === name);
  });
  window.scrollTo(0, 0);
}

/* =========================================================
   5) حالة التطبيق
   ========================================================= */

const state = {
  demo: false,
  analysis: null,          /* { context, paragraphs: [{text, keywords}] } */
  activeParagraphs: [],    /* الفقرات الناتجة عن التحليل (كل فقرة = سؤال) */
  usedKeywords: [],        /* لكل فقرة: الكلمات المستخدمة في الجولات السابقة */
  round: 0,
  roundPcts: [],           /* نسب كل جولة على نفس النص (للمقارنة) */
  quiz: null,              /* { current, score, streak, bestStreak, answers, startedAt, timerId } */
  pending: new Map(),      /* فهرس الفقرة ← وعد بتوليد السؤال */
  questions: new Map(),    /* فهرس الفقرة ← السؤال المولّد نفسه (للحفظ والاستئناف من آخر سؤال) */
  abortCtrl: null,
  rendered: null,          /* السؤال المعروض حاليًا */
  staticQuestions: null,   /* أسئلة ثابتة مستوردة من ملف JSON (بدون توليد) */
  focusRestore: null,      /* لقطة لاستعادة الاختبار الكامل بعد جولة التدريب على الأخطاء */
  importMeta: null,        /* { name } للاختبار المستورد */
};

/* =========================================================
   6) تحضير الاختبار (شاشة التحضير)
   ========================================================= */

let prepTimers = [];

function startPreparingAnimation() {
  stopPreparingAnimation();
  const seq = [
    { at: 0, step: 1, progress: 18 },
    { at: 1100, step: 2, progress: 52 },
    { at: 2400, step: 3, progress: 82 },
  ];
  for (const s of seq) {
    prepTimers.push(setTimeout(() => {
      const li = el("prep-step-" + s.step);
      if (li) { li.classList.add("active"); li.classList.remove("done"); }
      el("prep-progress").style.width = s.progress + "%";
    }, s.at));
  }
}

function finishPreparingAnimation() {
  stopPreparingAnimation();
  [1, 2, 3].forEach((n) => {
    const li = el("prep-step-" + n);
    if (li) { li.classList.add("done"); li.classList.remove("active"); }
  });
  el("prep-progress").style.width = "100%";
}

function stopPreparingAnimation() {
  prepTimers.forEach(clearTimeout);
  prepTimers = [];
}

async function startQuiz() {
  const text = el("input-text").value.trim();
  const demo = el("demo-mode").checked;
  const key = el("api-key").value.trim();

  if (!demo && !key) {
    toast("error", "أدخل مفتاح API أولًا، أو فعّل «وضع المحاكاة» للتجربة بدون مفتاح.");
    el("api-key").focus();
    return;
  }
  if (text.length < 100) {
    toast("error", "النص قصير جدًا — يحتاج التطبيق نصًا من 100 حرف على الأقل ليقسّمه إلى فقرات.");
    el("input-text").focus();
    return;
  }
  if (el("para-limit").value === "custom" && !String(el("para-limit-custom").value).trim()) {
    toast("error", "حدّد عدد الفقرات (بين 1 و100) أو اختر «غير محدد».");
    el("para-limit-custom").focus();
    return;
  }

  state.demo = demo;
  state.staticQuestions = null;
  state.importMeta = null;
  state.round = 0;
  state.abortCtrl = new AbortController();
  showScreen("preparing");
  startPreparingAnimation();

  try {
    const paraLimit = getParagraphLimit();
    let analysis;
    if (demo) {
      await sleep(2600);
      analysis = demoAnalyze(text, paraLimit);
    } else {
      analysis = await aiAnalyzeText(text, state.abortCtrl.signal, paraLimit);
    }
    if (state.abortCtrl.signal.aborted) return;
    applyAnalysis(analysis);
    saveLastSession();
    finishPreparingAnimation();
    await sleep(550);
    if (state.abortCtrl.signal.aborted) return;
    await beginRound();
    const activeCount = state.activeParagraphs.length;
    const suffix = paraLimit > 0
      ? (activeCount === paraLimit ? " كما حددت" : ` (طلبت ${paraLimit} والنص قصير)`)
      : "";
    toast("info", `تم تقسيم النص إلى ${quizCountWord(activeCount)}${suffix} — بالتوفيق!`);
  } catch (err) {
    stopPreparingAnimation();
    if (isAbort(err)) { showScreen("setup"); return; }
    console.error("[Analyzing]", err);
    toast("error", friendlyApiError(err));
    showScreen("setup");
  }
}

/* =========================================================
   7) إدارة جولة الاختبار
   ========================================================= */

/* تجهيز شاشة الاختبار (رقاقات الجولة/المصدر/المستوى/السلسلة) — مشترك بين البداية والاستئناف */
function setupRoundScreen() {
  showScreen("quiz");
  el("round-chip").classList.toggle("hidden", state.round <= 1);
  el("round-chip").textContent = "الجولة " + state.round;
  el("focus-chip").classList.toggle("hidden", !state.focusRestore);
  el("source-chip").classList.toggle("hidden", !state.staticQuestions);
  if (state.staticQuestions) {
    el("source-chip").textContent = state.importMeta && state.importMeta.libId
      ? "اختبار من مكتبتي"
      : state.importMeta && state.importMeta.link ? "اختبار من رابط مشترك" : "اختبار مستورد";
  }
  const lvl = getDifficulty();
  el("level-chip").classList.toggle("hidden", lvl === "medium");
  el("level-chip").textContent = "المستوى: " + DIFF_LABELS[lvl];
  el("quiz-streak").classList.add("hidden"); /* صفّر شارة السلسلة من الجولة السابقة */
  el("speed-chip").classList.add("hidden");
  el("speed-bar").classList.add("hidden");
}

async function beginRound() {
  state.round++;
  state.abortCtrl = new AbortController();
  state.rendered = null;
  closePassageModal();
  state.quiz = { current: 0, score: 0, streak: 0, bestStreak: 0, answers: [], startedAt: Date.now(), timerId: null, speedBonus: 0, qTimerId: null, qDeadline: 0, passagesViewed: 0 };
  state.pending.clear();
  state.questions.clear();
  /* الأسئلة المستوردة كائنات ثابتة تُعاد استخدامها بين الجولات — صفّر إجاباتها */
  if (state.staticQuestions) state.staticQuestions.forEach((q) => { q.userAnswer = null; q.correct = null; q.speedFast = false; q.answerMs = null; });
  setupRoundScreen();
  updateQuizMeta();
  startTimer();
  await showCurrentQuestion();
}

/* اختيار كلمة مفتاحية عشوائية غير مستخدمة سابقًا للفقرة i */
async function pickKeyword(i) {
  const p = state.activeParagraphs[i];
  if (!p.keywords.length) p.keywords = demoExtractKeywords(p.text);
  const used = state.usedKeywords[i];
  let avail = p.keywords.filter((k) => !used.includes(k));

  if (!avail.length) {
    /* كل الكلمات استُخدمت: نطلب كلمات جديدة مختلفة (متصفحًا أو محليًا) */
    let fresh = [];
    if (state.demo) {
      fresh = demoExtractKeywords(p.text, [...used]);
    } else {
      fresh = await aiRefreshKeywords({ paragraph: p.text, exclude: used }, state.abortCtrl && state.abortCtrl.signal);
    }
    fresh = fresh.filter((k) => k && !used.includes(k));
    if (!fresh.length) {
      /* حل أخير: تدوير الكلمات الأصلية */
      const base = p.keywords.length ? p.keywords : demoExtractKeywords(p.text);
      fresh = [base[(state.round - 1) % base.length]];
    }
    for (const k of fresh) {
      if (!p.keywords.includes(k)) p.keywords.push(k);
    }
    avail = fresh;
  }

  const kw = avail[Math.floor(Math.random() * avail.length)];
  used.push(kw);
  return kw;
}

/* توليد سؤال الفقرة i (مع تخزين الوعد لتفادي التوليد المزدوج) */
function ensureQuestion(i) {
  if (state.pending.has(i)) return state.pending.get(i);
  const promise = (async () => {
    const p = state.activeParagraphs[i];
    const keyword = await pickKeyword(i);
    if (state.demo) {
      await sleep(400 + Math.random() * 500);
      const pool = [...new Set(state.analysis.paragraphs.flatMap((pp) => pp.keywords))];
      const q = demoGenerateQuestion({ paragraph: p.text, keyword, pool, difficulty: getDifficulty() });
      const full = { paragraphIndex: i, keyword, ...q, userAnswer: null, correct: null };
      state.questions.set(i, full);
      return full;
    }
    const q = await aiGenerateQuestion(
      { context: state.analysis.context, paragraph: p.text, keyword },
      state.abortCtrl ? state.abortCtrl.signal : undefined
    );
    const full = { paragraphIndex: i, keyword, ...q, userAnswer: null, correct: null };
    state.questions.set(i, full);
    return full;
  })();
  promise.catch(() => {}); /* تفادي رفض غير معالَج عند الجلب المسبق */
  state.pending.set(i, promise);
  return promise;
}

async function showCurrentQuestion() {
  const qz = state.quiz;
  if (!qz) return;
  const i = qz.current;

  /* اختبار مستورد: أسئلة جاهزة بلا أي توليد */
  if (state.staticQuestions) {
    const q = state.staticQuestions[i];
    if (!q) return;
    state.rendered = q;
    renderQuestion(q);
    return;
  }

  renderQuestionLoading();

  /* جلب مسبق للسؤال التالي لتسريع الانتقال */
  if (i + 1 < state.activeParagraphs.length) {
    try { ensureQuestion(i + 1); } catch {}
  }

  try {
    const q = await ensureQuestion(i);
    if (state.quiz !== qz || qz.current !== i) return; /* تغيّرت الجولة أثناء الانتظار */
    state.rendered = q;
    renderQuestion(q);
  } catch (err) {
    if (isAbort(err) || state.quiz !== qz) return;
    console.error("[Question]", err);
    renderQuestionError(err);
  }
}

function renderQuestionLoading() {
  stopQuestionTimer(true);
  el("q-text").innerHTML = "";
  const loader = document.createElement("span");
  loader.className = "loading-inline";
  loader.textContent = "جاري توليد السؤال…";
  el("q-text").appendChild(loader);

  el("options").innerHTML = "";
  for (let k = 0; k < 4; k++) {
    const sk = document.createElement("div");
    sk.className = "skeleton";
    el("options").appendChild(sk);
  }
  el("feedback").classList.add("hidden");
  el("feedback").innerHTML = "";
  el("btn-next").disabled = true;
  el("btn-next").textContent = "التالي";
}

function renderQuestion(q) {
  /* الكلمة المفتاحية لا تُعرض في خانة السؤال (لتجنب الإفصاح) — تبقى في نافذة الفقرة فقط */
  el("q-text").textContent = q.question;

  el("options").innerHTML = "";
  q.options.forEach((opt, idx) => {
    const label = document.createElement("label");
    label.className = "option";

    const input = document.createElement("input");
    input.type = "radio";
    input.name = "option";
    input.value = String(idx);
    input.className = "sr-only";
    input.addEventListener("change", () => selectAnswer(q, idx));

    const letter = document.createElement("span");
    letter.className = "option-letter";
    letter.textContent = String(idx + 1);

    const text = document.createElement("span");
    text.className = "option-text";
    text.textContent = opt;

    label.appendChild(input);
    label.appendChild(letter);
    label.appendChild(text);
    el("options").appendChild(label);
  });

  el("feedback").classList.add("hidden");
  el("feedback").innerHTML = "";
  el("btn-next").disabled = true;
  el("btn-next").textContent = "التالي";
  startQuestionTimer(q);
}

function renderQuestionError(err) {
  el("q-text").textContent = "تعذر توليد السؤال";
  el("options").innerHTML = "";

  const fb = el("feedback");
  fb.className = "feedback error";
  fb.innerHTML = "";

  const icon = document.createElement("div");
  icon.className = "feedback-icon";
  icon.textContent = "!";

  const body = document.createElement("div");
  body.className = "feedback-body";
  const strong = document.createElement("strong");
  strong.textContent = "حدث خطأ أثناء توليد السؤال";
  const p = document.createElement("p");
  p.textContent = friendlyApiError(err);
  body.appendChild(strong);
  body.appendChild(p);

  const retry = document.createElement("button");
  retry.className = "btn ghost sm";
  retry.type = "button";
  retry.textContent = "إعادة المحاولة";
  retry.style.marginTop = "10px";
  retry.addEventListener("click", () => {
    if (!state.quiz) return;
    state.pending.delete(state.quiz.current);
    showCurrentQuestion();
  });
  body.appendChild(retry);

  fb.appendChild(icon);
  fb.appendChild(body);
  fb.classList.remove("hidden");
}

function selectAnswer(q, idx) {
  const qz = state.quiz;
  if (!qz || q.userAnswer !== null) return;

  stopQuestionTimer(true);
  q.userAnswer = idx;
  q.correct = idx === q.correctIndex;
  q.answerMs = speedSettings.on && qz.qDeadline ? Date.now() - (qz.qDeadline - speedSettings.secs * 1000) : null;
  q.speedFast = !!(speedSettings.on && q.correct && qz.qDeadline && Date.now() <= qz.qDeadline - (speedSettings.secs * 1000) / 2);
  if (q.speedFast) qz.speedBonus++;
  if (q.correct) {
    qz.score++;
    qz.streak++;
    qz.bestStreak = Math.max(qz.bestStreak, qz.streak);
    playCorrect();
  } else {
    qz.streak = 0;
    playWrong();
  }
  qz.answers.push(q);
  updateSavedProgress();

  const streakChip = el("quiz-streak");
  if (qz.streak >= 2) {
    streakChip.querySelector("span").textContent = "سلسلة ×" + qz.streak;
    streakChip.classList.remove("hidden");
  } else {
    streakChip.classList.add("hidden");
  }

  const labels = [...el("options").children];
  labels.forEach((label, i) => {
    const input = label.querySelector("input");
    if (input) input.disabled = true;
    label.classList.add("locked");
    if (i === q.correctIndex) label.classList.add("correct");
    else if (i === idx) label.classList.add("wrong");
    else label.classList.add("dim");
  });

  showFeedback(q);
  updateQuizMeta();
  scrollFeedbackIntoView();

  const isLast = qz.current === state.activeParagraphs.length - 1;
  el("btn-next").disabled = false;
  el("btn-next").textContent = isLast ? "عرض النتيجة" : "السؤال التالي";
}

function scrollFeedbackIntoView() {
  const fb = el("feedback");
  if (!fb.classList.contains("hidden") && fb.scrollIntoView) {
    try { fb.scrollIntoView({ behavior: "smooth", block: "nearest" }); } catch {}
  }
}

/* ====== نافذة الفقرة المنبثقة (قراءة الفقرة بعد الإجابة) ====== */
const BOOK_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>';
let passageReturnFocus = null;

/* نص الفقرة المرتبطة بالسؤال — وللاختبارات المستوردة نعرض السياق العام إن وُجد */
function getPassageForQuestion(q) {
  if (!q) return null;
  if (!state.staticQuestions) {
    const p = state.activeParagraphs[q.paragraphIndex];
    if (p && p.text) return { title: "الفقرة المتعلقة بالسؤال", text: p.text };
  }
  const ctx = state.analysis && state.analysis.context ? String(state.analysis.context).trim() : "";
  if (ctx) return { title: "السياق العام للاختبار", text: ctx };
  return null;
}

function isPassageOpen() {
  return !el("passage-overlay").classList.contains("hidden");
}

function openPassageModal(q) {
  const passage = getPassageForQuestion(q);
  if (!passage) {
    toast("info", "لا يتوفر نص مرتبط بهذا السؤال.");
    return;
  }
  /* إحصاء: كم مرة استعان المستخدم بالفقرات في هذه الجولة */
  if (state.quiz) state.quiz.passagesViewed = (state.quiz.passagesViewed || 0) + 1;

  el("passage-title-text").textContent = passage.title;

  const kwWrap = el("passage-kw");
  kwWrap.innerHTML = "";
  if (q.keyword) {
    const chip = document.createElement("span");
    chip.className = "modal-kw-chip";
    chip.appendChild(document.createTextNode("الكلمة المفتاحية: "));
    const strong = document.createElement("strong");
    strong.textContent = q.keyword;
    chip.appendChild(strong);
    kwWrap.appendChild(chip);
    kwWrap.classList.remove("hidden");
  } else {
    kwWrap.classList.add("hidden");
  }

  const body = el("passage-body");
  body.innerHTML = "";
  body.appendChild(highlightKeywordFrag(passage.text, q.keyword));
  body.scrollTop = 0;

  /* زر المتابعة يتبدل حسب السياق: داخل الاختبار أم من شاشة المراجعة */
  el("btn-passage-continue").textContent =
    el("screen-quiz").classList.contains("active") ? "متابعة الاختبار" : "إغلاق";

  passageReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  el("passage-overlay").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  try { el("btn-passage-continue").focus(); } catch {}
}

function closePassageModal() {
  const overlay = el("passage-overlay");
  if (overlay.classList.contains("hidden")) return;
  overlay.classList.add("hidden");
  document.body.style.overflow = "";
  if (passageReturnFocus && document.contains(passageReturnFocus)) {
    try { passageReturnFocus.focus(); } catch {}
  }
  passageReturnFocus = null;
}

/* فخ التركيز: إبقاء Tab داخل النافذة طالما هي مفتوحة */
function trapPassageTab(e) {
  const focusables = [...el("passage-overlay").querySelectorAll("button, [tabindex='0']")]
    .filter((n) => !n.disabled && n.offsetParent !== null);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

/* تلميح أول مرة يشرح زر «قراءة الفقرة» — يُعرض مرة واحدة فقط (onboarding) */
const TIP_PASSAGE_KEY = "quiz_tip_passage_v1";
let passageTipTimer = null;

function maybeShowPassageTip(container) {
  if (!container || store.get(TIP_PASSAGE_KEY)) return;
  /* لا معنى للتلميح إن غاب الزر نفسه */
  if (!container.querySelector(".passage-btn")) return;
  store.set(TIP_PASSAGE_KEY, "1");
  const tip = document.createElement("div");
  tip.className = "passage-tip";
  tip.setAttribute("role", "note");
  const txt = document.createElement("span");
  txt.textContent = "جديد: بعد كل إجابة يمكنك قراءة الفقرة الأصلية المرتبطة بالسؤال قبل المتابعة.";
  const ok = document.createElement("button");
  ok.type = "button";
  ok.className = "btn sm";
  ok.textContent = "فهمت";
  ok.addEventListener("click", dismissPassageTip);
  tip.appendChild(txt);
  tip.appendChild(ok);
  container.appendChild(tip);
  passageTipTimer = setTimeout(dismissPassageTip, 10000);
}

function dismissPassageTip() {
  if (passageTipTimer) { clearTimeout(passageTipTimer); passageTipTimer = null; }
  const tip = document.querySelector(".passage-tip");
  if (!tip) return;
  tip.classList.add("leaving");
  setTimeout(() => tip.remove(), 250);
}

/* أيقونة قلم لإعادة تسمية عناصر المكتبة */
const PENCIL_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>';

/* زر «قراءة الفقرة» يُضاف إلى التغذية الراجعة بعد كل إجابة */
function appendPassageButton(container, q, label) {
  if (!getPassageForQuestion(q) || !container) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn sm passage-btn";
  btn.innerHTML = BOOK_ICON;
  btn.appendChild(document.createTextNode(label || "قراءة الفقرة المتعلقة"));
  btn.addEventListener("click", () => openPassageModal(q));
  container.appendChild(btn);
}

/* ====== مؤقت السؤال (وضع السرعة) ====== */
function startQuestionTimer(q) {
  stopQuestionTimer();
  const qz = state.quiz;
  if (!speedSettings.on || !qz || q.userAnswer !== null) return;
  const totalMs = speedSettings.secs * 1000;
  qz.qDeadline = Date.now() + totalMs;
  const chip = el("speed-chip");
  const fill = el("speed-bar-fill");
  const bar = el("speed-bar");
  chip.classList.remove("hidden", "danger");
  bar.classList.remove("hidden", "danger");
  const update = () => {
    if (!state.quiz || state.quiz !== qz || state.rendered !== q || q.userAnswer !== null) {
      stopQuestionTimer();
      return;
    }
    const remain = qz.qDeadline - Date.now();
    const frac = Math.max(0, remain / totalMs);
    el("speed-value").textContent = String(Math.max(0, Math.ceil(remain / 1000)));
    fill.style.width = (frac * 100) + "%";
    const danger = remain < totalMs * 0.3;
    chip.classList.toggle("danger", danger);
    bar.classList.toggle("danger", danger);
    if (remain <= 0) {
      stopQuestionTimer();
      handleTimeout(q);
    }
  };
  update();
  qz.qTimerId = setInterval(update, 100);
}

function stopQuestionTimer(hide) {
  if (state.quiz && state.quiz.qTimerId) {
    clearInterval(state.quiz.qTimerId);
    state.quiz.qTimerId = null;
  }
  if (hide) {
    el("speed-chip").classList.add("hidden");
    el("speed-bar").classList.add("hidden");
  }
}

function handleTimeout(q) {
  const qz = state.quiz;
  if (!qz || q.userAnswer !== null) return;

  stopQuestionTimer(true);
  q.userAnswer = -1;
  q.correct = false;
  q.speedFast = false;
  q.answerMs = null;
  qz.streak = 0;
  qz.answers.push(q);
  updateSavedProgress();
  playWrong();

  const labels = [...el("options").children];
  labels.forEach((label, i) => {
    const input = label.querySelector("input");
    if (input) input.disabled = true;
    label.classList.add("locked");
    if (i === q.correctIndex) label.classList.add("correct");
    else label.classList.add("dim");
  });

  const fb = el("feedback");
  fb.innerHTML = "";
  fb.className = "feedback wrong timeout";

  const icon = document.createElement("div");
  icon.className = "feedback-icon";
  icon.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="7" x2="12" y2="12"/><line x1="12" y1="12" x2="15.5" y2="14"/></svg>';

  const body = document.createElement("div");
  body.className = "feedback-body";
  const strong = document.createElement("strong");
  strong.textContent = "انتهى الوقت! الصحيحة هي: «" + q.options[q.correctIndex] + "»";
  const p = document.createElement("p");
  p.textContent = q.explanation || "لا يتوفر تعليل لهذا السؤال.";
  body.appendChild(strong);
  body.appendChild(p);
  appendPassageButton(body, q, "قراءة الفقرة المتعلقة");

  fb.appendChild(icon);
  fb.appendChild(body);
  fb.classList.remove("hidden");
  updateQuizMeta();
  scrollFeedbackIntoView();

  const isLast = qz.current === state.activeParagraphs.length - 1;
  el("btn-next").disabled = false;
  el("btn-next").textContent = isLast ? "عرض النتيجة" : "السؤال التالي";
}

function showFeedback(q) {
  const fb = el("feedback");
  fb.innerHTML = "";
  fb.className = "feedback " + (q.correct ? "correct" : "wrong");

  const icon = document.createElement("div");
  icon.className = "feedback-icon";
  icon.textContent = q.correct ? "✓" : "✕";

  const body = document.createElement("div");
  body.className = "feedback-body";

  const strong = document.createElement("strong");
  if (q.correct) {
    strong.textContent = "إجابة صحيحة، أحسنت!";
  } else {
    strong.textContent = "إجابة خاطئة — الصحيحة هي: «" + q.options[q.correctIndex] + "»";
  }

  const p = document.createElement("p");
  p.textContent = q.explanation || "لا يتوفر تعليل لهذا السؤال.";

  body.appendChild(strong);
  body.appendChild(p);
  appendPassageButton(body, q, "قراءة الفقرة المتعلقة");
  maybeShowPassageTip(body);
  fb.appendChild(icon);
  fb.appendChild(body);
  fb.classList.remove("hidden");
}

async function nextQuestion() {
  const qz = state.quiz;
  if (!qz || el("btn-next").disabled) return;

  const last = state.activeParagraphs.length - 1;
  if (qz.current >= last) {
    finishQuiz();
    return;
  }
  qz.current++;
  updateQuizMeta();
  await showCurrentQuestion();
  updateSavedProgress();
}

function updateQuizMeta() {
  const qz = state.quiz;
  if (!qz) return;
  const total = state.activeParagraphs.length;
  el("quiz-progress-text").textContent = `السؤال ${Math.min(qz.current + 1, total)} من ${total}`;
  el("quiz-score").textContent = `النقاط: ${qz.score}`;
  el("quiz-progress-bar").style.width = (qz.answers.length / total) * 100 + "%";
}

/* ====== المؤقت ====== */
function startTimer() {
  stopTimer();
  const qz = state.quiz;
  if (!qz) return;
  el("quiz-timer-value").textContent = "0:00";
  qz.timerId = setInterval(() => {
    if (!state.quiz) return;
    el("quiz-timer-value").textContent = fmtDuration(Date.now() - state.quiz.startedAt);
  }, 1000);
}

function stopTimer() {
  if (state.quiz && state.quiz.timerId) {
    clearInterval(state.quiz.timerId);
    state.quiz.timerId = null;
  }
}

/* =========================================================
   8) النتائج
   ========================================================= */

let lastResults = null;

function finishQuiz() {
  if (!state.quiz || state.quiz.finished) return; /* حماية من الإنهاء المزدوج */
  state.quiz.finished = true;
  updateSavedProgress(); /* الجولة اكتملت — يمحو اللقطة التقدم ليعود الاستئناف إلى «أسئلة جديدة» */
  stopTimer();
  stopQuestionTimer(true);
  const qz = state.quiz;
  const total = state.activeParagraphs.length;
  const score = qz.score;
  const elapsed = Date.now() - qz.startedAt;
  const pct = total ? Math.round((score / total) * 100) : 0;

  playFinish();

  saveHistoryItem({
    date: Date.now(),
    score,
    total,
    pct,
    round: state.round,
    demo: state.demo,
    focus: !!state.focusRestore,
    imported: !!state.staticQuestions,
    lvl: getDifficulty(),
    duration: elapsed,
    preview: state.staticQuestions && state.importMeta
      ? "[مستورد] " + state.importMeta.name
      : el("input-text").value.trim().slice(0, 42),
  });
  /* تحديث إحصاءات الاختبار المحفوظ في المكتبة (جولات التدريب لا تحدّثه) */
  if (state.importMeta && state.importMeta.libId && !state.focusRestore) {
    const lib = loadLibrary();
    const libItem = lib.find((x) => x.id === state.importMeta.libId);
    if (libItem) {
      libItem.plays = (libItem.plays || 0) + 1;
      libItem.bestPct = Math.max(libItem.bestPct || 0, pct);
      saveLibraryItems(lib);
    }
  }
  /* جولة التدريب المركّز لا تُقارن بجولات الاختبار الكامل */
  if (!state.focusRestore) state.roundPcts.push(pct);

  showScreen("results");
  renderResults(score, total, elapsed, state.round, qz.answers, qz.bestStreak || 0, pct);

  const cmp = el("compare-chip");
  if (state.focusRestore) {
    cmp.className = "chip accent";
    cmp.textContent = "جولة تدريب مركّز على الأخطاء";
    cmp.classList.remove("hidden");
  } else {
    const prev = state.roundPcts.length > 1 ? state.roundPcts[state.roundPcts.length - 2] : null;
    if (prev !== null) {
      const d = pct - prev;
      if (d === 0) {
        cmp.className = "chip";
        cmp.textContent = "نفس نتيجة الجولة السابقة";
      } else {
        cmp.className = "chip " + (d > 0 ? "ok" : "bad");
        cmp.textContent = (d > 0 ? "تحسّن +" : "تراجع ") + d + "% عن الجولة السابقة";
      }
      cmp.classList.remove("hidden");
    } else {
      cmp.classList.add("hidden");
    }
  }

  renderHistory();
}

function renderResults(score, total, elapsed, round, answers, bestStreak, pct) {
  lastResults = { score, total, pct, elapsed, round, answers, bestStreak, passagesViewed: state.quiz ? state.quiz.passagesViewed || 0 : 0 };

  const C = 2 * Math.PI * 54;
  const ring = el("ring-fg");
  ring.style.strokeDashoffset = String(C);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      ring.style.strokeDashoffset = String(C * (1 - score / (total || 1)));
    });
  });

  el("score-num").textContent = `${score}/${total}`;
  el("score-pct").textContent = pct + "%";

  let msg;
  if (pct >= 90) msg = "أداء ممتاز! استيعاب رائع للنص.";
  else if (pct >= 70) msg = "جيد جدًا! فهم قوي مع مجال صغير للتحسين.";
  else if (pct >= 50) msg = "جيد! راجع التعليلات أدناه لتثبيت الفهم.";
  else msg = "لا بأس — أعد الاختبار وركّز على تعليل كل إجابة.";
  el("score-message").textContent = msg;

  el("stat-correct").textContent = `صحيحة: ${score}`;
  el("stat-wrong").textContent = `خاطئة: ${total - score}`;
  el("stat-time").textContent = `الوقت: ${fmtDuration(elapsed)}`;
  el("stat-round").textContent = `الجولة: ${round}`;
  el("stat-streak").textContent = `أفضل سلسلة: ${bestStreak || 0}`;
  const passages = state.quiz ? state.quiz.passagesViewed || 0 : 0;
  const passageChip = el("stat-passage");
  if (passages > 0) {
    el("stat-passage-text").textContent = `قراءة الفقرة: ${passages} ${passages === 1 ? "مرة" : passages === 2 ? "مرتين" : "مرات"}`;
    passageChip.classList.remove("hidden");
  } else {
    passageChip.classList.add("hidden");
  }
  const lvlChip = el("stat-level");
  if (getDifficulty() !== "medium") {
    lvlChip.textContent = "المستوى: " + DIFF_LABELS[getDifficulty()];
    lvlChip.classList.remove("hidden");
  } else {
    lvlChip.classList.add("hidden");
  }
  el("btn-retry-wrong").classList.toggle("hidden", total - score === 0);

  /* شارات وضع السرعة */
  const fastCount = answers.filter((a) => a.speedFast).length;
  const speedChip = el("stat-speed");
  if (fastCount > 0) {
    el("stat-speed-text").textContent = `نقاط السرعة: ${fastCount}`;
    speedChip.classList.remove("hidden");
  } else {
    speedChip.classList.add("hidden");
  }
  const times = answers.map((a) => a.answerMs).filter((t) => typeof t === "number" && t >= 0);
  const fastestChip = el("stat-fastest");
  if (times.length) {
    fastestChip.textContent = `أسرع إجابة: ${(Math.min.apply(null, times) / 1000).toFixed(1)} ث`;
    fastestChip.classList.remove("hidden");
  } else {
    fastestChip.classList.add("hidden");
  }

  if (pct >= 80) burstConfetti();

  const list = el("review-list");
  list.innerHTML = "";
  answers.forEach((q, i) => {
    const li = document.createElement("li");
    li.className = "review-item " + (q.correct ? "correct-item" : "wrong-item");

    const head = document.createElement("div");
    head.className = "review-head";
    const num = document.createElement("span");
    num.className = "review-num";
    num.textContent = String(i + 1);
    const qText = document.createElement("span");
    qText.className = "review-q";
    qText.textContent = q.question;
    head.appendChild(num);
    head.appendChild(qText);

    const rows = document.createElement("div");
    rows.className = "review-rows";
    const your = document.createElement("div");
    your.className = q.correct ? "ok" : "no";
    your.textContent = q.userAnswer === -1
      ? "إجابتك: — (انتهى الوقت)"
      : `إجابتك: ${q.options[q.userAnswer]}`;
    rows.appendChild(your);
    if (!q.correct) {
      const right = document.createElement("div");
      right.className = "ok";
      right.textContent = `الإجابة الصحيحة: ${q.options[q.correctIndex]}`;
      rows.appendChild(right);
    }

    const explain = document.createElement("div");
    explain.className = "review-explain";
    explain.textContent = "التعليل: " + (q.explanation || "—");

    li.appendChild(head);
    li.appendChild(rows);
    li.appendChild(explain);
    appendPassageButton(li, q, "عرض الفقرة");
    list.appendChild(li);
  });
}

async function retakeQuiz() {
  /* إعادة بنفس النص مع كلمات مفتاحية مختلفة → أسئلة جديدة (خارج وضع التدريب) */
  restoreFullParagraphs();
  state.abortCtrl = new AbortController();
  await beginRound();
  toast("info", "جولة جديدة — كلمات مفتاحية مختلفة وأسئلة جديدة.");
}

/* ====== وضع التدريب على الأخطاء فقط ====== */
function restoreFullParagraphs() {
  if (!state.focusRestore) return;
  state.activeParagraphs = state.focusRestore.active;
  state.usedKeywords = state.focusRestore.used;
  state.staticQuestions = state.focusRestore.static || null;
  state.focusRestore = null;
}

async function retryWrongOnly() {
  if (!lastResults) return;
  const wrongIdx = [...new Set(lastResults.answers.filter((q) => !q.correct).map((q) => q.paragraphIndex))]
    .filter((i) => state.activeParagraphs[i]);
  if (!wrongIdx.length) {
    toast("success", "لا توجد أخطاء في هذه الجولة — أداء كامل!");
    return;
  }
  state.focusRestore = {
    active: state.activeParagraphs,
    used: state.usedKeywords,
    static: state.staticQuestions,
  };
  state.activeParagraphs = wrongIdx.map((i) => state.focusRestore.active[i]);
  state.usedKeywords = wrongIdx.map((i) => state.focusRestore.used[i] || []);
  if (state.focusRestore.static) {
    state.staticQuestions = wrongIdx.map((i) => state.focusRestore.static[i]).filter(Boolean);
  }
  state.abortCtrl = new AbortController();
  await beginRound();
  toast("info", `وضع التدريب: ${quizCountWord(state.activeParagraphs.length)} أخطأت فيها سابقًا — ركّز على التعليل.`);
}

function backToSetup() {
  stopTimer();
  stopQuestionTimer(true);
  if (state.abortCtrl) { try { state.abortCtrl.abort(); } catch {} }
  updateSavedProgress(); /* احفظ نقطة الاستئناف قبل تفكيك الجولة */
  restoreFullParagraphs();
  state.quiz = null;
  state.rendered = null;
  state.staticQuestions = null;
  state.importMeta = null;
  clearSharedHash();
  renderResume();
  renderHistory();
  renderLibrary();
  showScreen("setup");
}

function quitQuiz() {
  if (!confirm("هل تريد إنهاء الاختبار الحالي؟ سيتم تجاهل الأسئلة المتبقية.")) return;
  stopTimer();
  stopQuestionTimer(true);
  if (state.abortCtrl) { try { state.abortCtrl.abort(); } catch {} }
  updateSavedProgress(); /* احفظ نقطة الاستئناف قبل تفكيك الجولة */
  restoreFullParagraphs();
  state.quiz = null;
  state.rendered = null;
  state.staticQuestions = null;
  state.importMeta = null;
  clearSharedHash();
  renderLibrary();
  renderResume(); /* حدّث بطاقة الاستئناف لتعكس التقدم المحفوظ */
  showScreen("setup");
  toast("info", "تم إنهاء الاختبار — يمكنك استئنافه من حيث توقفت لاحقًا.");
}

async function copyResults() {
  if (!lastResults) return;
  const { score, total, pct, elapsed, round, answers, bestStreak } = lastResults;
  const lines = [];
  const fastCount = answers.filter((a) => a.speedFast).length;
  const lvl = getDifficulty();
  lines.push(`نتيجتي في «اختبرني»: ${score}/${total} (${pct}%) — الوقت ${fmtDuration(elapsed)} — الجولة ${round}${bestStreak ? ` — أفضل سلسلة ×${bestStreak}` : ""}${lvl !== "medium" ? ` — المستوى ${DIFF_LABELS[lvl]}` : ""}${fastCount ? ` — نقاط السرعة ${fastCount}` : ""}${lastResults.passagesViewed ? ` — قراءة الفقرة ${lastResults.passagesViewed} مرة` : ""}`);
  lines.push("");
  answers.forEach((q, i) => {
    lines.push(`${i + 1}. ${q.correct ? "(صحيحة)" : "(خاطئة)"} ${q.question}`);
    lines.push(`   الإجابة الصحيحة: ${q.options[q.correctIndex]}`);
  });
  const text = lines.join("\n");
  try {
    await navigator.clipboard.writeText(text);
    toast("success", "تم نسخ النتيجة إلى الحافظة.");
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      toast("success", "تم نسخ النتيجة إلى الحافظة.");
    } catch {
      toast("error", "تعذر النسخ — انسخ النص يدويًا.");
    }
    document.body.removeChild(ta);
  }
}

/* ====== تطبيق نتيجة التحليل على الحالة (بداية جديدة أو استئناف) ====== */
/* ====== حد عدد الفقرات من خانة النص — 0 = غير محدد (كل الفقرات) ====== */
function clampParagraphLimit(n) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v)) return 0;
  return Math.max(1, Math.min(100, v));
}

function getParagraphLimit() {
  if (el("para-limit").value !== "custom") return 0;
  return clampParagraphLimit(el("para-limit-custom").value);
}

function syncParaLimitUI() {
  const custom = el("para-limit").value === "custom";
  el("para-limit-custom-field").classList.toggle("hidden", !custom);
}

function loadParaLimit() {
  try {
    const raw = JSON.parse(store.get("quiz_para_limit") || "null");
    if (raw && raw.mode === "custom") {
      el("para-limit").value = "custom";
      const c = clampParagraphLimit(raw.custom);
      el("para-limit-custom").value = String(c || 10);
    }
  } catch {}
}

function saveParaLimit() {
  const c = clampParagraphLimit(el("para-limit-custom").value) || 10;
  store.set("quiz_para_limit", JSON.stringify({
    mode: el("para-limit").value === "custom" ? "custom" : "all",
    custom: c,
  }));
}

/* الحد المطلوب من الفقرات يُطبَّق وقت التحليل نفسه (يُدرج في البرومبت) — التحليل الوارد جاهز كما هو */
function applyAnalysis(analysis) {
  state.analysis = analysis;
  state.activeParagraphs = analysis.paragraphs;
  state.usedKeywords = analysis.paragraphs.map(() => []);
  state.roundPcts = [];
  state.round = 0;
}

/* ====== استئناف آخر نص محفوظ (مع استئناف التقدم من آخر سؤال) ====== */
const RESUME_KEY = "quiz_last_session";

function saveLastSession() {
  if (!state.analysis) return;
  store.set(RESUME_KEY, JSON.stringify({
    text: el("input-text").value.trim(),
    analysis: state.analysis,
    savedAt: Date.now(),
    progress: null, /* جلسة جديدة بلا تقدم — يُملأ لاحقًا بعد كل إجابة */
  }));
}

function loadLastSession() {
  try {
    const s = JSON.parse(store.get(RESUME_KEY) || "null");
    if (s && s.analysis && Array.isArray(s.analysis.paragraphs) && s.analysis.paragraphs.length) return s;
  } catch {}
  return null;
}

function clearLastSession() {
  store.del(RESUME_KEY);
  renderResume();
}

/* لقطة تقدم الجولة الحالية للاستئناف من آخر سؤال — null إن لم توجد جولة صالحة */
function snapshotProgress() {
  const qz = state.quiz;
  if (!qz || qz.finished || state.focusRestore || state.staticQuestions || !state.analysis) return null;
  const total = state.activeParagraphs.length;
  if (!total) return null;
  /* الاختبار تسلسلي: عدد الإجابات = فهرس أول سؤال غير مُجاب (نقطة الاستئناف) */
  const resumeAt = qz.answers.length;
  if (resumeAt < 0 || resumeAt >= total) return null; /* الجولة اكتملت — لا معنى للاستئناف */
  if (!state.questions.has(resumeAt)) return null; /* سؤال الاستئناف لم يُولّد بعد */
  const questions = [];
  state.questions.forEach((q, i) => questions.push({ i, q }));
  if (!questions.length) return null;
  return {
    demo: state.demo,
    round: state.round,
    roundPcts: state.roundPcts.slice(),
    usedKeywords: state.usedKeywords.map((a) => a.slice()),
    activeCount: total,
    resumeAt,
    score: qz.score,
    streak: qz.streak,
    bestStreak: qz.bestStreak || 0,
    speedBonus: qz.speedBonus || 0,
    passagesViewed: qz.passagesViewed || 0,
    elapsedMs: Math.max(0, Date.now() - qz.startedAt),
    questions,
    savedProgressAt: Date.now(),
  };
}

/* تحديث نقطة الاستئناف في الجلسة المحفوظة — يُستدعى بعد كل إجابة/انتقال وعند مغادرة الصفحة */
function updateSavedProgress() {
  const s = loadLastSession();
  if (!s) return;
  const snap = snapshotProgress();
  s.progress = snap;
  if (snap) s.savedAt = snap.savedProgressAt;
  try { store.set(RESUME_KEY, JSON.stringify(s)); } catch {}
}

/* التحقق من صلاحية التقدم المحفوظ — العدد المتوقع = فقرات التحليل المحفوظ كاملة
   (حد عدد الفقرات يُطبَّق وقت التحليل فقط ولا يبطل تقدم الاستئناف لاحقًا) */
function validateProgress(s) {
  const p = s && s.progress;
  if (!p || typeof p !== "object") return null;
  const full = Array.isArray(s.analysis && s.analysis.paragraphs) ? s.analysis.paragraphs.length : 0;
  if (!full) return null;
  const expected = full;
  if (p.activeCount !== expected) return null; /* تغيّر التحليل المحفوظ منذ الحفظ */
  if (!Number.isInteger(p.resumeAt) || p.resumeAt < 0 || p.resumeAt >= expected) return null;
  if (!Array.isArray(p.questions) || !p.questions.length) return null;
  const seen = new Set();
  for (const it of p.questions) {
    const q = it && it.q;
    if (!q || !Number.isInteger(it.i) || it.i < 0 || it.i >= expected || seen.has(it.i)) return null;
    seen.add(it.i);
    if (typeof q.question !== "string" || !Array.isArray(q.options) || q.options.length < 2) return null;
    if (!Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex >= q.options.length) return null;
    if (!Number.isInteger(q.paragraphIndex) || q.paragraphIndex !== it.i) return null;
  }
  if (!seen.has(p.resumeAt)) return null; /* سؤال الاستئناف نفسه غير محفوظ */
  if (!Array.isArray(p.usedKeywords) || p.usedKeywords.length !== full) return null;
  return p;
}

function renderResume() {
  const s = loadLastSession();
  const card = el("resume-card");
  if (!s) { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");
  el("resume-preview").textContent = (s.text || "").slice(0, 160) || "—";
  el("resume-count").textContent = s.analysis.paragraphs.length + " فقرة";
  try {
    el("resume-date").textContent = new Date(s.savedAt).toLocaleString("ar", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch { el("resume-date").textContent = ""; }
  const prog = validateProgress(s);
  const chip = el("resume-progress");
  if (prog) {
    chip.textContent = "استئناف من السؤال " + (prog.resumeAt + 1) + " من " + prog.activeCount + (prog.score ? " · نقاط " + prog.score : "");
    chip.classList.remove("hidden");
  } else {
    chip.classList.add("hidden");
  }
}

/* استعادة جولة سابقة من التقدم المحفوظ — تكمل من أول سؤال غير مُجاب */
async function resumeQuizRound(prog) {
  state.abortCtrl = new AbortController();
  state.rendered = null;
  closePassageModal();
  state.quiz = {
    current: prog.resumeAt,
    score: prog.score || 0,
    streak: prog.streak || 0,
    bestStreak: prog.bestStreak || 0,
    answers: [],
    startedAt: Date.now() - (prog.elapsedMs || 0), /* استكمال مؤقت الجولة من حيث توقف */
    timerId: null,
    speedBonus: prog.speedBonus || 0,
    qTimerId: null,
    qDeadline: 0,
    passagesViewed: prog.passagesViewed || 0,
  };
  state.pending.clear();
  state.questions.clear();
  (prog.questions || []).forEach(({ i, q }) => {
    state.questions.set(i, q);
    state.pending.set(i, Promise.resolve(q));
    if (q.userAnswer !== null) state.quiz.answers.push(q);
  });
  setupRoundScreen();
  if (state.quiz.streak >= 2) {
    const chip = el("quiz-streak");
    chip.querySelector("span").textContent = "سلسلة ×" + state.quiz.streak;
    chip.classList.remove("hidden");
  }
  updateQuizMeta();
  startTimer();
  await showCurrentQuestion();
}

async function resumeSession() {
  const s = loadLastSession();
  if (!s) return;
  const prog = validateProgress(s);
  if (prog) {
    /* استئناف حقيقي: نفس الأسئلة المحفوظة من أول سؤال غير مُجاب — بلا مفتاح أو توليد */
    state.demo = !!prog.demo;
    state.staticQuestions = null;
    state.importMeta = null;
    applyAnalysis(s.analysis);
    state.usedKeywords = prog.usedKeywords.map((a) => (Array.isArray(a) ? a.slice() : []));
    state.round = prog.round || 1;
    state.roundPcts = Array.isArray(prog.roundPcts) ? prog.roundPcts.slice() : [];
    el("input-text").value = s.text || "";
    updateCharCount();
    await resumeQuizRound(prog);
    toast("success", "تم الاستئناف من السؤال " + (prog.resumeAt + 1) + " من " + state.activeParagraphs.length + " — نقاطك " + state.quiz.score + ".");
    return;
  }
  const demo = el("demo-mode").checked;
  if (!demo && !el("api-key").value.trim()) {
    toast("error", "لتوليد أسئلة جديدة تحتاج مفتاح API، أو فعّل وضع المحاكاة.");
    return;
  }
  state.demo = demo;
  state.staticQuestions = null;
  state.importMeta = null;
  applyAnalysis(s.analysis);
  el("input-text").value = s.text || "";
  updateCharCount();
  await beginRound();
  toast("info", "تم الاستئناف — التحليل محفوظ وسيولّد أسئلة جديدة مباشرة.");
}

/* ====== تصدير الاختبار ====== */
function downloadFile(name, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function exportJson() {
  if (!lastResults) return;
  const data = {
    app: "اختبرني",
    exportedAt: new Date().toISOString(),
    context: state.analysis ? state.analysis.context : "",
    score: lastResults.score,
    total: lastResults.total,
    questions: lastResults.answers.map((q, i) => ({
      n: i + 1,
      keyword: q.keyword,
      question: q.question,
      options: q.options,
      correctAnswer: q.options[q.correctIndex],
      explanation: q.explanation,
      yourAnswer: q.userAnswer !== null && q.userAnswer >= 0 ? q.options[q.userAnswer] : null,
      wasCorrect: !!q.correct,
    })),
  };
  downloadFile("ihtibarani-quiz-" + Date.now() + ".json", JSON.stringify(data, null, 2), "application/json;charset=utf-8");
  toast("success", "تم تصدير الاختبار بصيغة JSON.");
}

function exportText() {
  if (!lastResults) return;
  const letters = ["أ", "ب", "ج", "د"];
  const { score, total, pct, round, answers } = lastResults;
  const lines = [];
  lines.push("اختبرني — اختبار مولّد بالذكاء الاصطناعي من نص");
  lines.push("التاريخ: " + new Date().toLocaleString("ar"));
  if (state.analysis) lines.push("السياق العام: " + state.analysis.context);
  lines.push(`النتيجة: ${score}/${total} (${pct}%) — الجولة ${round}`);
  lines.push("");
  lines.push("=== الأسئلة ===");
  answers.forEach((q, i) => {
    lines.push("");
    lines.push(`${i + 1}) ${q.question}`);
    q.options.forEach((o, oi) => lines.push(`   ${letters[oi]}) ${o}`));
  });
  lines.push("");
  lines.push("=== الإجابات الصحيحة والتعليل ===");
  answers.forEach((q, i) => {
    lines.push(`${i + 1}) ${q.options[q.correctIndex]}`);
    if (q.explanation) lines.push(`   التعليل: ${q.explanation}`);
  });
  downloadFile("ihtibarani-quiz-" + Date.now() + ".txt", lines.join("\n"), "text/plain;charset=utf-8");
  toast("success", "تم تصدير الاختبار كملف نصي.");
}

/* ====== مكتبة اختباراتي (localStorage) ====== */
const LIB_KEY = "quiz_library";
const LIB_MAX = 12;

function loadLibrary() {
  try { return JSON.parse(store.get(LIB_KEY) || "[]"); } catch { return []; }
}

function saveLibraryItems(lib) {
  store.set(LIB_KEY, JSON.stringify(lib.slice(0, LIB_MAX)));
}

function saveCurrentToLibrary() {
  if (!lastResults || !lastResults.answers.length) {
    toast("error", "لا يوجد اختبار لحفظه بعد.");
    return;
  }
  const qs = lastResults.answers.map((q) => ({
    keyword: q.keyword || "",
    question: q.question,
    options: [...q.options],
    correctIndex: q.correctIndex,
    explanation: q.explanation || "",
  }));
  const baseName = state.importMeta && state.importMeta.name
    ? state.importMeta.name
    : (el("input-text").value.trim().slice(0, 42) || "اختبار محفوظ");
  const name = state.focusRestore ? "تدريب: " + baseName : baseName;
  const ctx = state.analysis ? state.analysis.context : "";
  const lib = loadLibrary();
  const sig = name + "||" + qs[0].question;
  const existingIdx = lib.findIndex((it) => (it.name + "||" + (it.questions[0] ? it.questions[0].question : "")) === sig);
  if (existingIdx >= 0) {
    lib[existingIdx].questions = qs;
    lib[existingIdx].ctx = ctx;
    lib[existingIdx].savedAt = Date.now();
    saveLibraryItems(lib);
    renderLibrary();
    flashSaveButton();
    toast("success", `تم تحديث «${name}» في مكتبتك.`);
    return;
  }
  if (lib.length >= LIB_MAX) {
    if (!confirm(`مكتبتك ممتلئة (${LIB_MAX} اختبارات). سيُحذف الاختبار الأقدم لحفظ الجديد. هل تريد المتابعة؟`)) return;
    lib.pop();
  }
  lib.unshift({
    id: "l" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name,
    ctx,
    questions: qs,
    savedAt: Date.now(),
    plays: 0,
    bestPct: 0,
  });
  saveLibraryItems(lib);
  renderLibrary();
  flashSaveButton();
  toast("success", `تم حفظ «${name}» في مكتبتك — ${quizCountWord(qs.length)}.`);
}

function flashSaveButton() {
  const btn = el("btn-save-library");
  if (!btn) return;
  btn.classList.add("saved-flash");
  const label = btn.querySelector(".save-label");
  if (label) {
    const old = label.textContent;
    label.textContent = "محفوظ في مكتبتك";
    setTimeout(() => { label.textContent = old; btn.classList.remove("saved-flash"); }, 2200);
  } else {
    setTimeout(() => btn.classList.remove("saved-flash"), 2200);
  }
}

function renderLibrary() {
  const card = el("library-card");
  const list = el("library-list");
  if (!card || !list) return;
  const lib = loadLibrary();
  el("library-count").textContent = String(lib.length);
  el("btn-clear-library").classList.toggle("hidden", lib.length === 0);
  if (!lib.length) { card.classList.add("hidden"); list.innerHTML = ""; return; }
  card.classList.remove("hidden");
  list.innerHTML = "";
  lib.forEach((it, idx) => {
    const li = document.createElement("li");
    li.className = "lib-item";
    li.style.animationDelay = Math.min(idx * 45, 400) + "ms";

    const info = document.createElement("div");
    info.className = "lib-info";

    const name = document.createElement("span");
    name.className = "lib-name";
    name.textContent = it.name || "اختبار محفوظ";

    const meta = document.createElement("div");
    meta.className = "lib-meta";
    const c1 = document.createElement("span");
    c1.className = "chip";
    c1.textContent = quizCountWord((it.questions || []).length);
    meta.appendChild(c1);
    if (it.bestPct) {
      const c2 = document.createElement("span");
      c2.className = "chip ok";
      c2.textContent = "الأفضل: " + it.bestPct + "%";
      meta.appendChild(c2);
    }
    const c3 = document.createElement("span");
    c3.className = "chip";
    c3.textContent = it.plays ? playCountWord(it.plays) : "لم يُلعب بعد";
    meta.appendChild(c3);
    const c4 = document.createElement("span");
    c4.className = "chip lib-date";
    try { c4.textContent = new Date(it.savedAt).toLocaleDateString("ar", { day: "numeric", month: "short", year: "numeric" }); } catch {}
    meta.appendChild(c4);

    info.appendChild(name);
    info.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "lib-actions";
    const play = document.createElement("button");
    play.className = "btn primary sm";
    play.type = "button";
    play.textContent = "ابدأ";
    play.setAttribute("aria-label", "بدء اختبار " + (it.name || "محفوظ"));
    play.addEventListener("click", () => playLibraryItem(it.id));
    const exp = document.createElement("button");
    exp.className = "btn ghost sm";
    exp.type = "button";
    exp.textContent = "تصدير";
    exp.setAttribute("aria-label", "تصدير اختبار " + (it.name || "محفوظ") + " بصيغة JSON");
    exp.addEventListener("click", () => exportLibraryItem(it.id));
    const ren = document.createElement("button");
    ren.className = "icon-btn lib-ren";
    ren.type = "button";
    ren.title = "إعادة تسمية";
    ren.setAttribute("aria-label", "إعادة تسمية " + (it.name || "الاختبار"));
    ren.innerHTML = PENCIL_ICON;
    ren.addEventListener("click", () => startInlineRename(li, it));
    const del = document.createElement("button");
    del.className = "icon-btn lib-del";
    del.type = "button";
    del.setAttribute("aria-label", "حذف " + (it.name || "الاختبار") + " من المكتبة");
    del.title = "حذف";
    del.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
    del.addEventListener("click", () => deleteLibraryItem(it.id));
    actions.appendChild(play);
    actions.appendChild(exp);
    actions.appendChild(ren);
    actions.appendChild(del);

    li.appendChild(info);
    li.appendChild(actions);
    list.appendChild(li);
  });
}

/* إعادة تسمية عنصر المكتبة في مكانه: حقل إدخال يحل محل الاسم مع حفظ (Enter) وإلغاء (Esc) */
function startInlineRename(li, it) {
  const nameSpan = li.querySelector(".lib-name");
  if (!nameSpan || li.querySelector(".lib-rename-input")) return;
  const oldName = it.name || "";
  let done = false;

  const finish = (saveChanges) => {
    if (done) return;
    done = true;
    if (saveChanges) {
      const next = (input.value || "").trim().slice(0, 80) || oldName;
      if (next !== oldName) {
        const lib = loadLibrary();
        const target = lib.find((x) => x.id === it.id);
        if (target) {
          target.name = next;
          saveLibraryItems(lib);
          toast("success", `تم تحديث الاسم إلى «${next}».`);
        }
      }
    }
    renderLibrary();
  };

  nameSpan.innerHTML = "";
  const input = document.createElement("input");
  input.className = "lib-rename-input";
  input.type = "text";
  input.value = oldName;
  input.maxLength = 80;
  input.setAttribute("aria-label", "الاسم الجديد للاختبار المحفوظ");
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
  nameSpan.appendChild(input);
  input.focus();
  input.select();
}

function playLibraryItem(id) {
  const it = loadLibrary().find((x) => x.id === id);
  if (!it) return;
  const qs = normalizeImportedQuestions({
    questions: (it.questions || []).map((q) => ({
      keyword: q.keyword,
      question: q.question,
      options: q.options,
      correctIndex: q.correctIndex,
      explanation: q.explanation,
    })),
  });
  if (!qs) {
    toast("error", "بيانات هذا الاختبار المحفوظ غير سليمة — حُذف من المكتبة.");
    deleteLibraryItem(id, true);
    return;
  }
  startImported(qs, it.name || "اختبار من المكتبة", it.ctx, false, it.id);
  toast("info", `بدأ اختبار «${it.name || "محفوظ"}» من مكتبتك — بالتوفيق!`);
}

function exportLibraryItem(id) {
  const it = loadLibrary().find((x) => x.id === id);
  if (!it) return;
  const data = {
    app: "اختبرني",
    exportedAt: new Date().toISOString(),
    context: it.ctx || "",
    questions: (it.questions || []).map((q, i) => ({
      n: i + 1,
      keyword: q.keyword || "",
      question: q.question,
      options: q.options,
      correctAnswer: q.options[q.correctIndex],
      explanation: q.explanation || "",
    })),
  };
  const safeName = String(it.name || "quiz").replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 30) || "quiz";
  downloadFile("ihtibarani-" + safeName + ".json", JSON.stringify(data, null, 2), "application/json;charset=utf-8");
  toast("success", "تم تصدير الاختبار من المكتبة.");
}

function deleteLibraryItem(id, silent) {
  const lib = loadLibrary();
  const it = lib.find((x) => x.id === id);
  if (!it) return;
  if (!silent && !confirm(`هل تريد حذف «${it.name || "الاختبار"}» من المكتبة؟`)) return;
  saveLibraryItems(lib.filter((x) => x.id !== id));
  renderLibrary();
  if (!silent) toast("info", "تم حذف الاختبار من المكتبة.");
}

function clearLibrary() {
  if (!loadLibrary().length) return;
  if (!confirm("هل تريد مسح مكتبة الاختبارات بالكامل؟")) return;
  store.del(LIB_KEY);
  renderLibrary();
  toast("info", "تم مسح مكتبة الاختبارات.");
}

/* ====== طباعة الاختبار (PDF عبر نافذة الطباعة) ====== */
function buildPrintSheet() {
  if (!lastResults) return;
  const letters = ["أ", "ب", "ج", "د"];
  let dateStr = "";
  try { dateStr = new Date().toLocaleString("ar", { day: "numeric", month: "long", year: "numeric" }); } catch {}
  const ctx = state.analysis && state.analysis.context ? state.analysis.context : "";
  let html = `<header class="ps-head"><h1>ورقة اختبار — اختبرني</h1><p class="ps-meta">التاريخ: ${escHtml(dateStr)}${ctx ? ` — السياق العام: ${escHtml(ctx)}` : ""}</p></header>`;
  html += '<ol class="ps-questions">';
  lastResults.answers.forEach((q, i) => {
    html += `<li><p class="ps-q"><span class="ps-num">${i + 1}</span> ${escHtml(q.question)}</p><ul class="ps-opts">`;
    q.options.forEach((o, oi) => {
      html += `<li><span class="ps-letter">${letters[oi]}</span> ${escHtml(o)}</li>`;
    });
    html += "</ul></li>";
  });
  html += "</ol>";
  html += '<section class="ps-key"><h2>مفتاح الإجابات والتعليل</h2><ol>';
  lastResults.answers.forEach((q, i) => {
    html += `<li><strong>${i + 1}) ${escHtml(q.options[q.correctIndex])}</strong>${q.explanation ? `<p class="ps-explain">${escHtml(q.explanation)}</p>` : ""}</li>`;
  });
  html += "</ol></section>";
  html += '<footer class="ps-foot">أُنشئ بواسطة «اختبرني» — الإصدار 1.10</footer>';
  el("print-sheet").innerHTML = html;
}

function printQuiz() {
  if (!lastResults) return;
  buildPrintSheet();
  toast("info", "افتحت نافذة الطباعة — اختر «حفظ كملف PDF» من خيارات الطابعة.");
  window.print();
}

/* ====== استيراد اختبار من ملف JSON (مخرجات «تصدير JSON») ====== */
function normalizeImportedQuestions(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.questions) || !data.questions.length) return null;
  const out = [];
  for (const raw of data.questions) {
    const options = Array.isArray(raw.options) ? raw.options.map((o) => String(o).trim()).filter(Boolean) : [];
    const question = String(raw.question || "").trim();
    if (!question || options.length < 2) return null;
    let ci = -1;
    if (typeof raw.correctIndex === "number" && Number.isInteger(raw.correctIndex)) ci = raw.correctIndex;
    else if (raw.correctAnswer != null) ci = options.indexOf(String(raw.correctAnswer).trim());
    if (ci < 0 || ci >= options.length) return null;
    out.push({
      paragraphIndex: out.length,
      keyword: String(raw.keyword || "").trim(),
      question,
      options,
      correctIndex: ci,
      explanation: String(raw.explanation || "").trim(),
      userAnswer: null,
      correct: null,
    });
  }
  return out.length ? out : null;
}

async function handleImportFile(file) {
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    toast("error", "الملف ليس JSON صالحًا — تأكد أنك اخترت ملفًا صدّرته من التطبيق.");
    return;
  }
  const questions = normalizeImportedQuestions(data);
  if (!questions) {
    toast("error", "بنية الملف غير مفهومة — يجب أن يحتوي questions[] بأسئلة وخيارات وإجابة صحيحة لكل سؤال.");
    return;
  }
  startImported(questions, String(file.name || "").replace(/\.json$/i, "") || "اختبار مستورد", data.context, false);
  toast("success", `تم استيراد ${quizCountWord(questions.length)} — بالتوفيق!`);
}

/* ====== بدء اختبار مستورد (ملف أو رابط مشترك) ====== */
function startImported(questions, metaName, context, isLink, libId) {
  stopTimer();
  stopQuestionTimer(true);
  if (state.abortCtrl) { try { state.abortCtrl.abort(); } catch {} }
  state.demo = false;
  state.staticQuestions = questions;
  state.importMeta = { name: metaName, link: !!isLink, libId: libId || null };
  state.analysis = { context: String(context || ""), paragraphs: [] };
  state.activeParagraphs = questions;
  state.usedKeywords = questions.map(() => []);
  state.roundPcts = [];
  state.round = 0;
  state.focusRestore = null;
  beginRound();
}

/* ====== مشاركة الاختبار عبر رابط (Base64 في الهاش) ====== */
function encodeQuizPayload(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function decodeQuizPayload(s) {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes));
}

function buildShareUrl() {
  if (!lastResults || !lastResults.answers.length) return null;
  const payload = {
    v: 1,
    ctx: state.analysis ? state.analysis.context : "",
    qs: lastResults.answers.map((q) => ({
      k: q.keyword || "",
      q: q.question,
      o: q.options,
      ci: q.correctIndex,
      e: q.explanation || "",
    })),
  };
  const url = location.origin + location.pathname + "#q=" + encodeURIComponent(encodeQuizPayload(payload));
  return { url, size: url.length };
}

async function copyTextToClipboard(text, successMsg) {
  try {
    await navigator.clipboard.writeText(text);
    toast("success", successMsg);
    return true;
  } catch {}
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {}
  document.body.removeChild(ta);
  toast(ok ? "success" : "error", ok ? successMsg : "تعذر النسخ — انسخ الرابط يدويًا من شريط العنوان.");
  return ok;
}

async function shareQuizLink() {
  const built = buildShareUrl();
  if (!built) {
    toast("error", "لا يوجد اختبار لمشاركته بعد.");
    return;
  }
  if (built.size > 14000) {
    toast("error", "الاختبار طويل جدًا لمشاركته برابط — استخدم «تصدير JSON» بدلًا من ذلك.");
    return;
  }
  await copyTextToClipboard(built.url, "تم نسخ رابط الاختبار — شاركه مع أي شخص ليخوضه فورًا.");
}

function clearSharedHash() {
  if (location.hash.indexOf("#q=") === 0) {
    try { history.replaceState(null, "", location.pathname + location.search); } catch {}
  }
}

function normalizeSharedQuestions(payload) {
  if (!payload || typeof payload !== "object") return null;
  /* صيغة الرابط المختصرة {qs:[{k,q,o,ci,e}]} */
  if (Array.isArray(payload.qs)) {
    const out = [];
    for (const raw of payload.qs) {
      const options = Array.isArray(raw.o) ? raw.o.map((x) => String(x).trim()).filter(Boolean) : [];
      const question = String(raw.q || "").trim();
      if (!question || options.length < 2) return null;
      const ci = Number.isInteger(raw.ci) ? raw.ci : -1;
      if (ci < 0 || ci >= options.length) return null;
      out.push({
        paragraphIndex: out.length,
        keyword: String(raw.k || "").trim(),
        question,
        options,
        correctIndex: ci,
        explanation: String(raw.e || "").trim(),
        userAnswer: null,
        correct: null,
      });
    }
    return out.length ? out : null;
  }
  /* تقبل أيضًا صيغة «تصدير JSON» الكاملة */
  if (Array.isArray(payload.questions)) return normalizeImportedQuestions(payload);
  return null;
}

function checkHashQuiz() {
  const m = location.hash.match(/[#&]q=([^&]+)/);
  if (!m) return false;
  let payload = null;
  try {
    payload = decodeQuizPayload(decodeURIComponent(m[1]));
  } catch {}
  const questions = normalizeSharedQuestions(payload);
  if (!questions) {
    toast("error", "الرابط لا يحتوي اختبارًا صالحًا — تأكد من نسخه كاملًا.");
    clearSharedHash();
    return false;
  }
  startImported(questions, "اختبار مشترك عبر رابط", payload && payload.ctx, true);
  toast("success", `وصل اختبارًا مشتركًا من رابط — ${quizCountWord(questions.length)}. بالتوفيق!`);
  return true;
}

/* ====== بطاقات المراجعة (Flashcards) ====== */
const cardsState = { cards: [], order: [], pos: 0, recallOn: false, known: [], review: [] };

function buildFlashcards() {
  const cards = [];
  if (state.staticQuestions) {
    state.staticQuestions.forEach((q) => {
      /* qref: مرجع خفيف يكفي لفتح نافذة الفقرة (للمستورد تُعرض «السياق العام» إن وُجد) */
      cards.push({
        keyword: q.keyword || "سؤال",
        sentence: q.explanation || q.question,
        qref: { paragraphIndex: q.paragraphIndex, keyword: q.keyword || "" },
      });
    });
    return cards;
  }
  (state.analysis ? state.analysis.paragraphs : []).forEach((p, pIdx) => {
    const sentences = String(p.text).split(/(?<=[.!؟?])\s+/).map((s) => s.trim()).filter(Boolean);
    (p.keywords || []).forEach((kw) => {
      const target = sentences.find((s) => s.includes(kw)) || p.text;
      cards.push({ keyword: kw, sentence: target, qref: { paragraphIndex: pIdx, keyword: kw } });
    });
  });
  return cards;
}

function openCards() {
  const cards = buildFlashcards();
  if (!cards.length) {
    toast("error", "لا توجد بطاقات بعد — ابدأ اختبارًا أولًا لبناء التحليل.");
    return;
  }
  cardsState.cards = cards;
  cardsState.order = shuffle(cards.map((_, i) => i));
  cardsState.pos = 0;
  /* دخول نظيف: وضع الاسترجاع يبدأ متوقفًا مع تصفير التقييمات */
  cardsState.recallOn = false;
  cardsState.known = [];
  cardsState.review = [];
  const rbtn = el("btn-recall-mode");
  if (rbtn) { rbtn.classList.remove("active"); rbtn.setAttribute("aria-pressed", "false"); }
  const rchip = el("recall-progress");
  if (rchip) rchip.classList.add("hidden");
  el("flashcard").classList.remove("recall");
  showScreen("cards");
  renderCard();
}

/* إبراز الكلمة المفتاحية داخل جملة البطاقة (بأمان تام — نص فقط) */
function highlightKeywordFrag(sentence, keyword) {
  const frag = document.createDocumentFragment();
  const text = String(sentence || "");
  const kw = String(keyword || "").trim();
  if (!kw) { frag.appendChild(document.createTextNode(text)); return frag; }
  let re;
  try {
    re = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
  } catch {
    frag.appendChild(document.createTextNode(text));
    return frag;
  }
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    const mark = document.createElement("mark");
    mark.className = "kw-hl";
    mark.textContent = m[0];
    frag.appendChild(mark);
    last = m.index + m[0].length;
  }
  frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

/* الجملة بفراغ مكان الكلمة — لوضع الاسترجاع (نص فقط بأمان تام) */
function blankKeywordFrag(sentence, keyword) {
  const frag = document.createDocumentFragment();
  const text = String(sentence || "");
  const kw = String(keyword || "").trim();
  if (!kw) { frag.appendChild(document.createTextNode(text)); return frag; }
  let re;
  try {
    re = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
  } catch {
    frag.appendChild(document.createTextNode(text));
    return frag;
  }
  let last = 0, m, count = 0;
  while ((m = re.exec(text)) && count < 3) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    const b = document.createElement("span");
    b.className = "kw-blank";
    b.textContent = "______";
    frag.appendChild(b);
    last = m.index + m[0].length;
    count++;
  }
  frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

function renderCard() {
  const { cards, order, pos, recallOn } = cardsState;
  const card = cards[order[pos]];
  const fc = el("flashcard");
  fc.classList.remove("flipped");
  const front = fc.querySelector(".fc-front");
  const back = fc.querySelector(".fc-back");
  const labelF = front.querySelector(".fc-label");
  const hintF = front.querySelector(".fc-hint");
  const labelB = back.querySelector(".fc-label");
  const hintB = back.querySelector(".fc-hint");
  const kwEl = el("fc-keyword");
  const sentEl = el("fc-sentence");

  /* تنظيف عناصر وضع الاسترجاع من الجولتين قبل إعادة البناء */
  ["fc-blank", "fc-answer", "fc-assess"].forEach((id) => {
    const old = document.getElementById(id);
    if (old) old.remove();
  });

  el("cards-progress").textContent = `بطاقة ${pos + 1} من ${order.length}`;
  const fill = el("cards-progress-fill");
  if (fill) fill.style.width = order.length ? ((pos + 1) / order.length) * 100 + "%" : "0";
  el("btn-cards-prev").disabled = pos === 0;
  el("btn-cards-next").disabled = pos === order.length - 1;

  if (recallOn) {
    /* الوجه الأمامي: الجملة بفراغ مكان الكلمة — استرجِع ثم اقلب */
    labelF.textContent = "وضع الاسترجاع";
    hintF.textContent = "تذكّر الكلمة ثم اقلب البطاقة";
    kwEl.style.display = "none";
    const blank = document.createElement("p");
    blank.className = "fc-blank";
    blank.id = "fc-blank";
    blank.appendChild(blankKeywordFrag(card.sentence, card.keyword));
    front.insertBefore(blank, hintF);
    /* الوجه الخلفي: الإجابة بارزة والجملة مبرزة */
    labelB.textContent = "الكلمة الصحيحة";
    hintB.textContent = "قيّم نفسك ثم تابع";
    const ans = document.createElement("strong");
    ans.className = "fc-answer";
    ans.id = "fc-answer";
    ans.textContent = card.keyword;
    back.insertBefore(ans, sentEl);
    sentEl.innerHTML = "";
    sentEl.appendChild(highlightKeywordFrag(card.sentence, card.keyword));
    /* صف التقييم الذاتي */
    const row = document.createElement("div");
    row.className = "fc-assess";
    row.id = "fc-assess";
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "btn sm assess-ok";
    ok.textContent = "✓ أعرفها";
    ok.setAttribute("aria-label", "أعرف هذه الكلمة — الانتقال للتالية");
    ok.addEventListener("click", (e) => { e.stopPropagation(); assessCard(true); });
    const again = document.createElement("button");
    again.type = "button";
    again.className = "btn sm assess-again";
    again.textContent = "↺ تحتاج مراجعة";
    again.setAttribute("aria-label", "تحتاج هذه الكلمة إلى مراجعة أخرى");
    again.addEventListener("click", (e) => { e.stopPropagation(); assessCard(false); });
    row.appendChild(ok);
    row.appendChild(again);
    back.insertBefore(row, hintB);
  } else {
    labelF.textContent = "الكلمة المفتاحية";
    hintF.textContent = "انقر لعرض سياقها في النص";
    labelB.textContent = "سياق الكلمة في النص";
    hintB.textContent = "انقر للعودة إلى الكلمة";
    kwEl.style.display = "";
    kwEl.textContent = card.keyword;
    sentEl.innerHTML = "";
    sentEl.appendChild(highlightKeywordFrag(card.sentence, card.keyword));
  }
  refreshCardPassageButton(card);
  updateRecallChip();
}

/* زر «قراءة الفقرة» على ظهر البطاقة — يُبنى لكل بطاقة حسب توفر نص مرتبط */
function refreshCardPassageButton(card) {
  const back = el("flashcard").querySelector(".fc-back");
  if (!back) return;
  const stale = document.getElementById("fc-passage-btn");
  if (stale) stale.remove();
  if (!card || !getPassageForQuestion(card.qref)) return;
  const hint = back.querySelector(".fc-hint");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "fc-passage-btn";
  btn.className = "btn sm passage-btn fc-passage-btn";
  btn.innerHTML = BOOK_ICON;
  btn.appendChild(document.createTextNode("قراءة الفقرة"));
  btn.setAttribute("aria-label", "قراءة الفقرة المتعلقة بكلمة " + (card.keyword || ""));
  /* منع انقلاب البطاقة عند نقر الزر */
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    openPassageModal(card.qref);
  });
  if (hint) back.insertBefore(btn, hint);
  else back.appendChild(btn);
}

function flipCard() {
  el("flashcard").classList.toggle("flipped");
}

/* ====== وضع الاسترجاع (تحدي مراجعة سريع) ====== */
function setRecallMode(on) {
  cardsState.recallOn = !!on;
  cardsState.known = [];
  cardsState.review = [];
  const btn = el("btn-recall-mode");
  btn.classList.toggle("active", cardsState.recallOn);
  btn.setAttribute("aria-pressed", cardsState.recallOn ? "true" : "false");
  el("recall-progress").classList.toggle("hidden", !cardsState.recallOn);
  el("flashcard").classList.toggle("recall", cardsState.recallOn);
  renderCard();
  toast("info", cardsState.recallOn
    ? "وضع الاسترجاع: تظهر الجملة والكلمة مخفية — اقلب البطاقة ثم قيّم نفسك."
    : "عادت البطاقات إلى الوضع الاعتيادي.");
}

function updateRecallChip() {
  const chip = el("recall-progress");
  if (!chip || !cardsState.recallOn) return;
  chip.textContent = `أعرفها: ${cardsState.known.length} من ${cardsState.cards.length} · مراجعة: ${cardsState.review.length}`;
}

function assessCard(good) {
  if (!cardsState.recallOn) return;
  const idx = cardsState.order[cardsState.pos];
  if (good) {
    if (!cardsState.known.includes(idx)) cardsState.known.push(idx);
    cardsState.review = cardsState.review.filter((i) => i !== idx);
  } else {
    if (!cardsState.review.includes(idx)) cardsState.review.push(idx);
    cardsState.known = cardsState.known.filter((i) => i !== idx);
  }
  updateRecallChip();
  const done = cardsState.known.length + cardsState.review.length;
  if (done >= cardsState.cards.length) {
    toast("success", `أنهيت جولة الاسترجاع — أعرفها: ${cardsState.known.length} · تحتاج مراجعة: ${cardsState.review.length}.`);
  }
  /* انتقال تلقائي مع الالتفاف إلى أول بطاقة بعد الأخيرة */
  cardsState.pos = (cardsState.pos + 1) % cardsState.order.length;
  renderCard();
}

function nextCard() {
  if (cardsState.pos < cardsState.order.length - 1) { cardsState.pos++; renderCard(); }
}

function prevCard() {
  if (cardsState.pos > 0) { cardsState.pos--; renderCard(); }
}

function shuffleCards() {
  cardsState.order = shuffle([...cardsState.order]);
  cardsState.pos = 0;
  renderCard();
  toast("info", "تم خلط البطاقات.");
}

function exitCards() {
  showScreen(lastResults ? "results" : "setup");
}

/* مشاركة النتيجة (Web Share API مع بديل النسخ) */
async function shareResults() {
  if (!lastResults) return;
  const { score, total, pct } = lastResults;
  const text = state.staticQuestions
    ? `خضيت اختبارًا مستوردًا في تطبيق «اختبرني»: ${score}/${total} (${pct}%).`
    : `حصلت على ${score}/${total} (${pct}%) في اختبار ولّدته من نصي عبر تطبيق «اختبرني».`;
  if (navigator.share) {
    try {
      await navigator.share({ title: "اختبرني", text });
      toast("success", "تمت المشاركة.");
    } catch {}
  } else {
    await copyResults();
  }
}

/* =========================================================
   9) التنبيهات (Toasts)
   ========================================================= */

function toast(type, message) {
  const box = el("toasts");
  const t = document.createElement("div");
  t.className = "toast " + (type || "info");
  t.textContent = message;
  box.appendChild(t);
  setTimeout(() => {
    t.classList.add("leaving");
    setTimeout(() => t.remove(), 320);
  }, 4200);
}

/* =========================================================
   10) المظهر (فاتح/داكن)
   ========================================================= */

function initTheme() {
  const saved = store.get("quiz_theme");
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  setTheme(saved || (prefersDark ? "dark" : "light"));
}

function setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  el("icon-moon").classList.toggle("hidden", theme === "dark");
  el("icon-sun").classList.toggle("hidden", theme !== "dark");
  store.set("quiz_theme", theme);
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  setTheme(cur);
}

/* =========================================================
   11) أحداث الواجهة والتهيئة
   ========================================================= */

const SAMPLE_TEXT = `شهد العقد الأخير تحولًا جوهريًا في مشهد التعليم، حيث باتت منصات التعلم الإلكتروني تتنافس مع الفصول التقليدية على وقتهم واهتمام المتعلمين. لم يعد التعليم حكرًا على القاعات المدرسية، بل أصبح متاحًا بضغطة زر لأي شخص يمتلك اتصالًا بالإنترنت ورغبة في التعلم.

وتقف الذكاء الاصطناعي في قلب هذا التحول، إذ باتت الأنظمة الذكية قادرة على تخصيص المسار التعليمي لكل طالب على حدة، فتحلل نقاط قوته وضعفه، ثم تقترح له المحتوى الأناسب لمستواه. هذا التخصيص الفرد كان حلمًا بعيد المنال في زمن التعليم الموحد للجميع.

غير أن هذا التطور السريع أثار أسئلة جدية حول دور المعلم. فبعض المتفائلين يرون أن التقنية ستحرر المعلم من الأعمال الروتينية كالتصحيح وإعداد التقارير، ليتفرغ لما يتفرد به الإنسان: إلهام الطلاب، وبناء شخصياتهم، وتنمية مهاراتهم الاجتماعية والنفسية.

في المقابل، يحذر الباحثون من مخاطر الإفراط في الاعتماد على الشاشات، ومن تراجع قدرة الطلاب على التركيز العميق والصبر على التعلم الشاق. تشير دراسات حديثة إلى أن القراءة السريعة والمتنقلة تنتج فهمًا سطحيًا، بينما يبقى الفهم العميق مرتبطًا بالقراءة المتأنية والمناقشة الحوارية.

ويبدو أن مستقبل التعليم سيكون هجينًا يمزج بين مرونة التقنية ودفء العلاقة الإنسانية، فالمدرسة التي تتبنى الأدوات الذكية دون أن تفقد روحها الإنسانية هي الأقدر على إعداد جيل يواجه عالمًا يتغير بوتيرة متسارعة.`;

function updateCharCount() {
  const n = el("input-text").value.length;
  el("char-count").textContent = n + " حرف";
}

function fillSample() {
  el("input-text").value = SAMPLE_TEXT;
  updateCharCount();
  toast("info", "تم تعبئة نص تجريبي من 5 فقرات — اضغط «ابدأ الاختبار».");
}

function clearText() {
  el("input-text").value = "";
  updateCharCount();
  el("input-text").focus();
}

function toggleKeyVisibility() {
  const input = el("api-key");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  el("icon-eye").classList.toggle("hidden", show);
  el("icon-eye-off").classList.toggle("hidden", !show);
}

function onDemoToggle() {
  const demo = el("demo-mode").checked;
  el("api-key").disabled = demo;
  el("toggle-key").disabled = demo;
  el("demo-badge").classList.toggle("hidden", !demo);
}

/* ====== قائمة النماذج ====== */
function buildModelSelect() {
  const sel = el("model-select");
  sel.innerHTML = "";
  const hasCustom = loadCustomModels();
  const options = hasCustom
    ? [...AI_MODELS]
    : [...DEFAULT_AI_MODELS, { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" }, { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" }, { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" }];

  options.forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label;
    sel.appendChild(opt);
  });
  const customOpt = document.createElement("option");
  customOpt.value = "__custom__";
  customOpt.textContent = "نماذج مخصصة…";
  sel.appendChild(customOpt);

  if (hasCustom) {
    sel.value = AI_MODELS[0].id;
    el("custom-primary").value = AI_MODELS[0].id;
    el("custom-fallback").value = AI_MODELS[1].id;
    el("custom-models-box").classList.remove("hidden");
    el("custom-status").textContent = "النماذج المخصصة مطبقة.";
  } else {
    sel.value = DEFAULT_AI_MODELS[0].id;
    setActiveModel(DEFAULT_AI_MODELS[0].id);
  }

  sel.addEventListener("change", () => {
    if (sel.value === "__custom__") {
      el("custom-models-box").classList.remove("hidden");
      el("custom-primary").focus();
    } else {
      el("custom-models-box").classList.add("hidden");
      setActiveModel(sel.value);
    }
  });
}

function applyCustomModels() {
  const primary = el("custom-primary").value.trim();
  const fallback = el("custom-fallback").value.trim();
  if (!primary || !fallback) {
    toast("error", "أدخل معرّف النموذج الأساسي والاحتياطي معًا.");
    return;
  }
  saveCustomModels(primary, fallback);
  el("custom-status").textContent = `مطبق: ${primary} ثم ${fallback} عند الفشل.`;
  toast("success", "تم تطبيق النماذج المخصصة.");
}

function resetModels() {
  resetCustomModels();
  el("custom-status").textContent = "استُعيدت النماذج الافتراضية.";
  buildModelSelect();
  toast("info", "استُعيدت النماذج الافتراضية.");
}

/* ====== لوحة المفاتيح في شاشة الاختبار ====== */
function onKeydown(e) {
  /* النافذة المنبثقة تسبق كل شيء: Esc يغلق، Tab محبوس داخلها، والاختبار متوقف عن الاستجابة */
  if (isPassageOpen()) {
    if (e.key === "Escape") {
      e.preventDefault();
      closePassageModal();
    } else if (e.key === "Tab") {
      trapPassageTab(e);
    }
    return;
  }
  if (el("screen-cards").classList.contains("active")) {
    if (e.key === "ArrowLeft") { e.preventDefault(); nextCard(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); prevCard(); }
    else if ((e.key === " " || e.key === "Enter") && document.activeElement === el("flashcard")) { e.preventDefault(); flipCard(); }
    return;
  }
  if (!el("screen-quiz").classList.contains("active") || !state.quiz) return;
  if (e.target && /^(input|textarea|select)$/i.test(e.target.tagName) && e.target.type !== "radio") return;

  if (e.key >= "1" && e.key <= "4") {
    const idx = parseInt(e.key, 10) - 1;
    const label = el("options").children[idx];
    if (!label) return;
    const input = label.querySelector("input");
    if (input && !input.disabled) {
      input.checked = true;
      input.dispatchEvent(new Event("change"));
    }
  } else if (e.key === "Enter") {
    const q = state.rendered;
    if (!q || q.userAnswer === null) return;
    e.preventDefault();
    nextQuestion();
  }
}

/* ====== التهيئة ====== */
function init() {
  initTheme();

  el("theme-toggle").addEventListener("click", toggleTheme);

  /* المفتاح */
  el("api-key").value = loadApiKey();
  el("api-key").addEventListener("input", () => saveApiKeyToStorage(el("api-key").value.trim()));
  el("toggle-key").addEventListener("click", toggleKeyVisibility);

  /* النماذج */
  buildModelSelect();
  el("btn-save-models").addEventListener("click", applyCustomModels);
  el("btn-reset-models").addEventListener("click", resetModels);

  /* وضع المحاكاة */
  el("demo-mode").addEventListener("change", onDemoToggle);

  /* وضع السرعة */
  loadSpeedSettings();
  syncSpeedInputs();
  el("speed-mode").addEventListener("change", () => {
    speedSettings.on = el("speed-mode").checked;
    saveSpeedSettings();
    toast("info", speedSettings.on ? "وضع السرعة مفعّل — ستحصل على مؤقت لكل سؤال." : "تم إيقاف وضع السرعة.");
  });
  el("speed-seconds").addEventListener("change", () => {
    speedSettings.secs = clampQuestionSecs(el("speed-seconds").value);
    el("speed-seconds").value = String(speedSettings.secs); /* اكتب القيمة المُقنّنة */
    saveSpeedSettings();
    toast("info", "زمن السؤال: " + speedSettings.secs + " ثانية" + (speedSettings.on ? "." : " — فعّل وضع السرعة ليُطبّق."));
  });

  /* النص */
  el("input-text").addEventListener("input", updateCharCount);
  el("btn-sample").addEventListener("click", fillSample);
  el("btn-clear").addEventListener("click", clearText);
  updateCharCount();

  /* عدد الفقرات (خانة النص) — يُدرج في برومبت التحليل وقت التحليل فقط، ولا يؤثر على الجلسة المحفوظة */
  loadParaLimit();
  syncParaLimitUI();
  el("para-limit").addEventListener("change", () => {
    syncParaLimitUI();
    saveParaLimit();
  });
  el("para-limit-custom").addEventListener("change", () => {
    if (String(el("para-limit-custom").value).trim()) {
      el("para-limit-custom").value = String(clampParagraphLimit(el("para-limit-custom").value));
    }
    saveParaLimit();
  });

  /* مستوى الصعوبة */
  loadDifficulty();
  syncDifficultyUI();
  el("difficulty-seg").querySelectorAll(".seg-btn").forEach((b) => {
    b.addEventListener("click", () => setDifficulty(b.dataset.level));
  });

  /* الرحلة */
  el("btn-start").addEventListener("click", startQuiz);
  el("btn-cancel").addEventListener("click", () => {
    if (state.abortCtrl) { try { state.abortCtrl.abort(); } catch {} }
    stopPreparingAnimation();
    showScreen("setup");
  });
  el("btn-next").addEventListener("click", nextQuestion);
  el("btn-quit").addEventListener("click", quitQuiz);
  el("btn-retake").addEventListener("click", retakeQuiz);
  el("btn-new-text").addEventListener("click", backToSetup);
  el("btn-copy").addEventListener("click", copyResults);
  el("btn-share").addEventListener("click", shareResults);
  el("btn-sound").addEventListener("click", toggleSound);
  el("btn-clear-history").addEventListener("click", clearHistory);
  el("btn-export-history").addEventListener("click", exportHistoryCSV);
  document.querySelectorAll(".hist-range").forEach((btn) => {
    btn.addEventListener("click", () => setHistoryRange(btn.dataset.range));
  });
  el("btn-cards").addEventListener("click", openCards);
  el("btn-cards-exit").addEventListener("click", exitCards);
  el("flashcard").addEventListener("click", flipCard);
  el("btn-cards-next").addEventListener("click", nextCard);
  el("btn-cards-prev").addEventListener("click", prevCard);
  el("btn-cards-shuffle").addEventListener("click", shuffleCards);
  el("btn-recall-mode").addEventListener("click", () => setRecallMode(!cardsState.recallOn));
  el("btn-export-json").addEventListener("click", exportJson);
  el("btn-export-text").addEventListener("click", exportText);
  el("btn-share-link").addEventListener("click", shareQuizLink);
  el("btn-retry-wrong").addEventListener("click", retryWrongOnly);
  el("btn-save-library").addEventListener("click", saveCurrentToLibrary);
  el("btn-print").addEventListener("click", printQuiz);
  el("btn-clear-library").addEventListener("click", clearLibrary);
  el("btn-import").addEventListener("click", () => el("import-file").click());
  el("import-file").addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = ""; /* للسماح باختيار نفس الملف مجددًا لاحقًا */
    handleImportFile(f);
  });
  el("btn-resume").addEventListener("click", resumeSession);
  el("btn-resume-dismiss").addEventListener("click", () => {
    clearLastSession();
    toast("info", "تم إزالة النص المحفوظ.");
  });
  updateSoundIcon();
  renderHistory();
  renderResume();
  renderLibrary();

  document.addEventListener("keydown", onKeydown);

  /* حفظ نقطة الاستئناف عند مغادرة الصفحة (إغلاق تبويب/تحديث/تبديل تطبيق) */
  window.addEventListener("pagehide", () => updateSavedProgress());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") updateSavedProgress();
  });

  /* نافذة الفقرة المنبثقة: أزرار الإغلاق والخلفية */
  el("btn-passage-close").addEventListener("click", closePassageModal);
  el("btn-passage-continue").addEventListener("click", closePassageModal);
  el("passage-overlay").addEventListener("click", (e) => {
    if (e.target === el("passage-overlay")) closePassageModal();
  });

  /* اختبار قادم عبر رابط مشترك (#q=...) يتجاوز شاشة الإعداد */
  checkHashQuiz();

  console.log("[اختبرني] جاهز — وضع المحاكاة متاح للتجربة بدون مفتاح API.");
}

document.addEventListener("DOMContentLoaded", init);
