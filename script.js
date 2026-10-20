'use strict';
/* =========================================================
   script.js — اختبرني (الإصدار 2.6)
   المنطق الكامل للتطبيق:
   - محرك الذكاء الاصطناعي (Google Gemini مع النماذج الاحتياطية وإصلاح JSON)
   - تحليل النص: تقسيم إلى فقرات + 3 كلمات مفتاحية لكل فقرة + سياق عام
   - أنماط أسئلة متعددة (اختيار من متعدد، صح/خطأ، أكمل الفراغ، تحليلي، متنوع ذكي)
   - وسائل مساعدة ذكية (حذف خيارين 50:50، تلميح ذكي، قراءة صوتية TTS، تمييز بنجمة، ملاحظات المتعلم)
   - دليل الدراسة الشامل + نظام الأوسمة والإنجازات + قوائم الحفظ والنسخ الاحتياطي
   ========================================================= */

/* =========================================================
   1) محرك الذكاء الاصطناعي
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

/* ====== تحليل JSON متين ====== */
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

/* ====== تحويل الرسائل: OpenAI-style ← Gemini ====== */
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

/* ====== تحويل الاستجابة: Gemini ← OpenAI-like ====== */
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

/* ====== الاستدعاء الرئيسي مع النماذج الاحتياطية ====== */
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

const MAX_PARAGRAPHS = 100;

function buildSystemAnalyze(limit) {
  const rule1 = limit > 0
    ? `1. قسّم النص إلى ${limit} فقرة بالضبط — هذا العدد طلبه المستخدم صراحةً وهو أولوية قصوى يجب الالتزام به (لا أكثر ولا أقل). إذا كانت فقرات النص الطبيعية أقل من ${limit}، فكّك الفقرات الطويلة إلى فقرات أصغر حسب المواضيع أو مجموعات الجمل المتقاربة حتى تبلغ ${limit} فقرة، وما تعذّر بلوغ العدد كاملًا لتقصّر النص قسّمه إلى أكبر عدد ممكن من الفقرات المفهومة. احرص على أن تكون كل فقرة ناتجة تشتمل على معاني مفهومة ويفضل أن تكون الفقرة الواحدة بين 3 إلى 10 أسطر.`
    : `1. قسّم النص إلى فقرات (من 3 إلى ${MAX_PARAGRAPHS} فقرة قدر الإمكان، وكلما كان النص أطول زاد عدد الفقرات). إذا كان النص كتلة واحدة متصلة، قسّمه حسب المواضيع أو مجموعات الجمل المتقاربة، احرص على أن تكون كل فقرة ناتجة تشتمل على معاني مفهومة ويفضل أن تكون الفقرة الواحدة بين 3 إلى 10 أسطر.`;
  return `أنت خبير تعليمي متخصص في تحليل النصوص العربية وإنشاء اختبارات.
مهمتك: تحليل النص الذي يرسله المستخدم وإرجاع النتيجة بصيغة JSON فقط.
القواعد:
${rule1}
2. انسخ نص كل فقرة كما ورد حرفيًا مع تقليم المسافات الزائدة فقط، واحرص على الحفاظ الكامل على بنية الأسطر الأصلية: كل سطر يبقى في سطر مستقل بفواصل الأسطر نفسها، والعناوين والعبارات المستقلة تبقى في أسطر مستقلة مميزة ولا تُدمج أبدًا مع الجمل التي تليها في سطر واحد، ولا تحوّل الفقرة إلى كتلة نص واحدة مسطّحة. لا تهدر أي جزء من النص أثناء التقسيم.
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

const SYSTEM_QUIZ = `أنت مختص في تأليف أسئلة تعليمية باللغة العربية بناءً على فقرات نصية.
ستستقبل: السياق العام للنص، فقرة واحدة، وكلمة مفتاحية من هذه الفقرة.
المطلوب: سؤال واحد حول الكلمة المفتاحية في سياقها داخل الفقرة وفق النمط المحدد.
القواعد الصارمة:
1. السؤال يجب أن يكون قابلًا للإجابة من الفقرة نفسها فقط، ولا تفترض معرفة المستخدم للفقرة مسبقًا ولا تشر لوجودها (لا تستخدم عبارات مثل «حسب الفقرة» أو «كما ورد في النص» أو «الفقرة السابقة») — صغ السؤال ليكون مفهومًا بمفرده.
2. التزم بعدد الخيارات المحدد في النمط (4 خيارات للاختيار من متعدد وأكمل الفراغ والتحليلي، أو خياران فقط لسؤال صح أم خطأ).
3. correctIndex هو رقم الخيار الصحيح (يبدأ من 0).
4. explanation: تعليل موجز للإجابة الصحيحة مستند إلى ما ورد حرفيًا في الفقرة.
5. اجعل السؤال واضحًا ومباشرًا وباللغة العربية الفصحى.
أعد JSON فقط.`;

const SYSTEM_QUIZ_FOCUSED = `أنت مختص في تأليف أسئلة تعليمية باللغة العربية بناءً على فقرات نصية.
ستستقبل: السياق العام للنص وفقرة واحدة، دون كلمة مفتاحية محددة.
المطلوب: سؤال واحد يختبر الفكرة المحورية أو المعلومة الجوهرية في الفقرة (المفهوم الأساس، العلاقة بين الأفكار، السبب والنتيجة، التعريف أو الاستنتاج المباشر) وفق النمط المحدد.
القواعد الصارمة:
1. السؤال يجب أن يكون قابلًا للإجابة من الفقرة نفسها فقط، ولا تفترض معرفة المستخدم للفقرة مسبقًا ولا تشر لوجودها (لا تستخدم عبارات مثل «حسب الفقرة» أو «كما ورد في النص» أو «الفقرة السابقة») — صغ السؤال ليكون مفهومًا بمفرده، ولا تربطه بكلمة واحدة بعينها بل بالمعنى الكلي للفقرة.
2. التزم بعدد الخيارات المحدد في النمط (4 خيارات للاختيار من متعدد وأكمل الفراغ والتحليلي، أو خياران فقط لسؤال صح أم خطأ).
3. correctIndex هو رقم الخيار الصحيح (يبدأ من 0).
4. explanation: تعليل موجز للإجابة الصحيحة مستند إلى ما ورد حرفيًا في الفقرة.
5. اجعل السؤال واضحًا ومباشرًا وباللغة العربية الفصحى.
أعد JSON فقط.`;

function buildSystemQuiz(useKeywords) {
  return useKeywords ? SYSTEM_QUIZ : SYSTEM_QUIZ_FOCUSED;
}

const SCHEMA_QUESTION = {
  type: "OBJECT",
  properties: {
    /* «متنوع ذكي»: qType أول حقل — Gemini يولّد الحقول تسلسليًا وفق propertyOrdering،
       فبتحديد النمط أولًا يُلزَم باختياره قبل صياغة السؤال، بدل أن يكتب سؤالًا قياسيًا
       بـ 4 خيارات ثم يوسمه "mcq" بعد أن يكون قد التزم به فعليًا. */
    qType: {
      type: "STRING",
      enum: ["mcq", "tf", "fill", "why"],
      description: "رمز نمط السؤال المختار بعد تحليل طبيعة الفقرة — حدّده أولًا قبل كتابة نص السؤال",
    },
    question: { type: "STRING" },
    options: { type: "ARRAY", items: { type: "STRING" } },
    correctIndex: { type: "INTEGER" },
    explanation: { type: "STRING" },
  },
  required: ["qType", "question", "options", "correctIndex", "explanation"],
  /* ترتيب التوليد الفعلي: النمط أولًا ثم السؤال والخيارات الموافقة له */
  propertyOrdering: ["qType", "question", "options", "correctIndex", "explanation"],
};

/* --- تحليل النص --- */
async function aiAnalyzeText(text, signal, limit = 0) {
  const paraLimit = limit > 0 ? Math.min(limit, MAX_PARAGRAPHS) : 0;
  const body = {
    messages: [
      { role: "system", content: buildSystemAnalyze(paraLimit) },
      {
        role: "user",
        content: `حلّل النص التالي:\n\n"""\n${text}\n"""\n\nتنبيه: عند نسخ نص كل فقرة حافظ على فواصل الأسطر والعناوين كما وردت في النص الأصلي تمامًا — لا تدمج الأسطر المتجاورة في سطر واحد.` +
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
    paragraphs = mergeParagraphObjects(paragraphs, cap);
  }
  const context = String(parsed.context || "").trim() || paragraphs[0].text.slice(0, 160);
  return { context, paragraphs };
}

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
    const extra = localExtractKeywords(paragraphText, kws);
    if (!extra.length) break;
    kws.push(extra[0]);
  }
  return kws;
}

/* ====== أنماط الأسئلة (Question Types) ====== */
const Q_TYPE_LABELS = {
  mcq: "اختيار من متعدد",
  tf: "صح أم خطأ",
  fill: "أكمل الفراغ",
  why: "تحليلي — لماذا وكيف",
  mix: "متنوع ذكي",
};
/* «متنوع ذكي»: آخر نمط ولّده النموذج لكل فقرة — لمنع تكرار النمط في الجولات الجديدة وعند إعادة التوليد */
const mixTypeHistory = new Map();
/* «متنوع ذكي»: أنماط الأسئلة المولَّدة في الجولة الحالية بالترتيب — لتنويع الأنماط داخل الجولة الواحدة */
const mixRoundTypes = [];
let qType = "mix"; /* الافتراضي: «متنوع ذكي» بطلب المستخدم */

function loadQType() {
  const v = store.get("quiz_q_type");
  qType = Q_TYPE_LABELS[v] ? v : "mix";
}
function getQType() { return qType; }
function syncQTypeUI() {
  const sel = el("q-type");
  if (sel) sel.value = qType;
}
function setQType(v, silent) {
  if (!Q_TYPE_LABELS[v]) return;
  qType = v;
  store.set("quiz_q_type", v);
  syncQTypeUI();
  if (!silent) {
    toast("info", "نمط الأسئلة: " + Q_TYPE_LABELS[v] + " — يُطبّق على الأسئلة التي ستُولَّد.");
  }
}

function resolveEffectiveQType() {
  /* «متنوع ذكي» يُمرَّر كما هو: النموذج يحلّل الفقرة ويختار النمط الأنسب بنفسه (بدل التناوب الحسابي الثابت) */
  return qType;
}

function buildQuestionTypeDirective(effectiveType, avoidType, recentTypes) {
  if (effectiveType === "mix") {
    const avoidNote = (avoidType && ["mcq", "tf", "fill", "why"].includes(avoidType))
      ? `\n\nتنبيه تنويع: كان السؤال السابق لهذه الفقرة من نمط «${avoidType}» — اختر هذه المرة نمطًا آخر غيره لتنويع التدريب، إلا إذا كانت طبيعة الفقرة لا تصلح إلا به.`
      : "";
    const rt = Array.isArray(recentTypes) ? recentTypes.filter((t) => ["mcq", "tf", "fill", "why"].includes(t)) : [];
    const roundNote = (rt.length >= 2 && rt.every((t) => t === rt[0]))
      ? `\n\nتنبيه تنويع الجولة: كانت الأسئلة الأخيرة في هذه الجولة كلها من نمط «${rt[0]}» — إن سمحت طبيعة هذه الفقرة فاختر نمطًا مختلفًا عنه هذه المرة.`
      : "";
    return `نمط السؤال: «متنوع ذكي» — على خطوتين:\nالخطوة 1: حلّل طبيعة الفقرة المعطاة أولًا وحدّد أبرز سمتها: هل هي غنية بالمعلومات المتفرعة أو المقارنات؟ هل تُقرر حقائق محددة أو أحكامًا دقيقة تحتمل الصدق أو الكذب؟ هل تتمحور حول مصطلح أو مفهوم أو اسم أو تعريف واضح؟ هل تشرح علاقات سبب ونتيجة أو تعليلًا منطقيًا؟\nالخطوة 2: اختر النمط الأنسب لطبيعتها من بين الأنماط الأربعة وسجّل رمزه في حقل qType (أول حقل في JSON):\n- "mcq" (اختيار من متعدد بـ 4 خيارات): فقط إذا كانت الفقرة فعلًا غنية بالمعلومات المتفرعة أو المقارنات.\n- "tf" (صح أم خطأ بخيارين فقط ["صحيح", "خطأ"] مع correctIndex = 0 للصحيح و1 للخطأ): إذا تُقرر في الفقرة حقيقة أو حكم دقيق تحتمل التصويب أو التخطئة الذكية.\n- "fill" (أكمل الفراغ «______» بـ 4 خيارات): إذا كانت الفقرة تتمحور حول مصطلح علمي أو مفهوم محوري أو اسم أو تعريف واضح.\n- "why" (تحليلي استنتاجي «لماذا / كيف / ما العلاقة» بـ 4 خيارات): إذا كانت الفقرة تشرح علاقات سبب ونتيجة أو تعليلًا منطقيًا.\nتحذير مهم: لا تختر "mcq" تلقائيًا كخيار افتراضي؛ إن لم تكن الفقرة غنية بالمقارنات والمعلومات المتفرعة فاختر النمط الأنسب من غيره.\nحدّد qType أولًا قبل كتابة نص السؤال، ثم صُغ السؤال وفق النمط المختار والتزم الصارم بعدد خياراته: خياران فقط إذا اخترت "tf"، و4 خيارات لأي نمط آخر.` + avoidNote + roundNote;
  }
  if (effectiveType === "tf") {
    return `نمط السؤال المطلوب: صح أم خطأ — صغ عبارة خبرية واضحة ودقيقة تحتمل الصدق أو الكذب بناءً على الفقرة (نوّع بين العبارات الصحيحة والعبارات الخاطئة التي تتضمن تحريفًا ذكيًا لمعلومة في الفقرة). اجعل مصفوفة options تحتوي خيارين فقط بالضبط هما: ["صحيح", "خطأ"] (أو ما يقابلهما بلغة السؤال المختارة)، واجعل correctIndex يساوي 0 إذا كانت العبارة صحيحة أو 1 إذا كانت خاطئة.`;
  }
  if (effectiveType === "fill") {
    return `نمط السؤال المطلوب: أكمل الفراغ — صغ جملة محورية مستخلصة من معنى الفقرة مع استبدال المصطلح أو المفهوم الجوهري برمز الفراغ «______»، واجعل الخيارات الأربعة (options) كلمات أو عبارات قصيرة تملأ هذا الفراغ (واحدة صحيحة وثلاثة مشتتات مقنعة).`;
  }
  if (effectiveType === "why") {
    return `نمط السؤال المطلوب: سؤال تحليلي واستنتاجي (لماذا / كيف / ما العلاقة / ما النتيجة المترتبة) — صغ سؤالًا يختبر فهم العلاقات السببية أو الدلالية العميقة في الفقرة مع 4 خيارات تحليلية (خيار واحد صحيح وثلاثة مشتتات).`;
  }
  return `نمط السؤال المطلوب: اختيار من متعدد قياسي — صغ سؤالًا واضحًا مع 4 خيارات (خيار واحد صحيح وثلاثة مشتتات منطقية).`;
}

/* --- توليد سؤال من (سياق + فقرة [+ كلمة مفتاحية]) --- */
async function aiGenerateQuestion({ context, paragraph, keyword, paragraphIndex = 0, avoidType = "" }, signal) {
  const lvl = getDifficulty();
  const effectiveType = resolveEffectiveQType();
  const diffDirective = lvl === "easy"
    ? "مستوى الصعوبة المطلوب: سهل — اجعل السؤال مباشرًا وواضحًا، واجعل المشتتات مختلفة بوضوح عن الإجابة الصحيحة بحيث يستطيع قارئ متمكن من الفقرة الإجابة بسرعة وثقة."
    : lvl === "hard"
      ? "مستوى الصعوبة المطلوب: صعب — اجعل السؤال تحليليًا يتطلب فهمًا أعمق للفقرة لا مجرد استرجاع حرفي، واجعل المشتتات قريبة لفظيًا ودلاليًا من الإجابة الصحيحة بحيث يتطلب التفريق بينها تدقيقًا في التفاصيل."
      : "";
  const typeDirective = buildQuestionTypeDirective(effectiveType, avoidType, effectiveType === "mix" ? mixRoundTypes.slice(-2) : []);
  const langDirective = buildLangDirective();
  const extraDirective = buildExtraDirective();
  const useKw = kwMode === "kw" && !!keyword;
  const body = {
    messages: [
      { role: "system", content: buildSystemQuiz(useKw) },
      {
        role: "user",
        content: `السياق العام للنص:\n${context}\n\nالفقرة:\n"""\n${paragraph}\n"""` +
          (useKw
            ? `\n\nالكلمة المفتاحية المطلوب السؤال عنها: «${keyword}»`
            : `\n\nمطلوب سؤال يركز على الفكرة المحورية للفقرة دون الارتباط بكلمة محددة.`) +
          "\n\n" + typeDirective +
          (diffDirective ? "\n\n" + diffDirective : "") +
          (langDirective ? "\n\n" + langDirective : "") +
          (extraDirective ? "\n\n" + extraDirective : "") +
          `\n\nأعد السؤال بصيغة JSON.`,
      },
    ],
    temperature: 0.85,
    max_tokens: 2048,
    jsonSchema: SCHEMA_QUESTION,
  };
  const { data } = await callGoogleAIStudioWithFallback({ body, signal, timeoutMs: 45000 });
  const parsed = robustJSONParse(data.choices[0].message.content);
  if (!parsed || typeof parsed.question !== "string" || !Array.isArray(parsed.options) || parsed.options.length < 2) {
    throw new Error("تعذر فهم استجابة السؤال من النموذج. أعد المحاولة.");
  }
  const nq = normalizeQuestion(parsed, effectiveType);
  /* «متنوع ذكي»: احفظ النمط الذي اختاره النموذج لهذه الفقرة، وتابع أنماط الجولة الحالية لتنويعها */
  if (effectiveType === "mix") {
    if (Number.isInteger(paragraphIndex)) mixTypeHistory.set(paragraphIndex, nq.qType);
    mixRoundTypes.push(nq.qType);
  }
  return nq;
}

function normalizeQuestion(q, effectiveType = "mcq") {
  let rawOpts = q.options.map((o) => String(o).trim()).filter(Boolean);
  /* «متنوع ذكي»: النمط الفعلي هو ما اختاره النموذج في qType، ويُستدل من عدد الخيارات إن غاب */
  const resolvedType = (effectiveType === "mix" && ["mcq", "tf", "fill", "why"].includes(q.qType))
    ? q.qType
    : (effectiveType === "mix" ? (rawOpts.length === 2 ? "tf" : "mcq") : effectiveType);
  const isTF = resolvedType === "tf" || rawOpts.length === 2;
  let options = isTF ? rawOpts.slice(0, 2) : rawOpts.slice(0, 4);
  if (!isTF) {
    while (options.length < 4) options.push("لا شيء مما سبق " + (options.length + 1));
  }
  let correctIndex = Number.isInteger(q.correctIndex) ? q.correctIndex : parseInt(q.correctIndex, 10);
  if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length) correctIndex = 0;
  const correctText = options[correctIndex];
  if (!isTF) {
    options = shuffle([...options]);
  }
  return {
    qType: isTF ? "tf" : resolvedType,
    question: String(q.question).trim(),
    options,
    correctIndex: options.indexOf(correctText),
    explanation: String(q.explanation || "").trim(),
  };
}

/* --- استخراج كلمات مفتاحية جديدة --- */
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
  if (/مفتاح Google AI Studio API غير مُعرَّف/.test(msg)) return "أدخل مفتاح API أولًا.";
  return msg || "حدث خطأ غير متوقع.";
}

/* =========================================================
   3) أدوات الكلمات المفتاحية المحلية
   ========================================================= */

const AR_STOPWORDS = new Set(
  ("في من على إلى عن أن إن أنه إنه التي الذي الذين اللواتي هذا هذه ذلك تلك هو هي هم هن نحن كان كانت يكون تكون " +
    "قد لقد مع كل بعض لا ما لم لن إذا ثم أو أم بل بين عند عندما كما لكن لكنه حيث بعد قبل خلال نحو منذ سوف يا أما " +
    "إما كي لكي لأن حتى غير أي أيضا أيضًا هناك هنا به بها بهم بها له لها لهم منه منها عليه عليها إليه إليها ذات ذو " +
    "عدد عدة شيء أشياء جدا جدًا يمكن يجب أكثر أقل كثير قليل أول آخر بينما رغم مثل نفس عبر دون بدون سواء وذلك وهذه " +
    "التي وهو وهي وكان وقد ولكنه هذا تلك هناك أثناء ضمن سوى عوض بد إذ حين لحظ إلا سوى كأن ليس ليست لست لم يكن").split(/\s+/)
);

function localExtractKeywords(text, exclude) {
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

/* =========================================================
   4) أدوات مساعدة عامة + المؤثرات الصوتية + القراءة الصوتية (TTS)
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

function quizCountWord(n) {
  if (n === 1) return "سؤال واحد";
  if (n === 2) return "سؤالان";
  if (n >= 3 && n <= 10) return n + " أسئلة";
  return n + " سؤالًا";
}

function playCountWord(n) {
  if (n === 1) return "لُعب مرة واحدة";
  if (n === 2) return "لُعب مرتين";
  return "لُعب " + n + " مرات";
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ====== النطق الصوتي (Text-to-Speech) ====== */
const LANG_BCP47 = {
  auto: "ar-SA",
  ar: "ar-SA",
  en: "en-US",
  fr: "fr-FR",
  es: "es-ES",
  de: "de-DE",
  tr: "tr-TR",
  ur: "ur-PK",
  id: "id-ID",
  ru: "ru-RU",
  zh: "zh-CN",
};

function stopSpeech() {
  try {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  } catch {}
  const btn = el("btn-tts-q");
  if (btn) btn.classList.remove("speaking");
}

function speakText(text, triggerBtn) {
  if (!("speechSynthesis" in window)) {
    toast("error", "المتصفح الحالي لا يدعم ميزة القراءة الصوتية.");
    return;
  }
  if (window.speechSynthesis.speaking) {
    stopSpeech();
    return;
  }
  const clean = String(text || "").trim();
  if (!clean) return;
  const utter = new SpeechSynthesisUtterance(clean);
  const isLatin = /[A-Za-z]{4,}/.test(clean) && !/[\u0600-\u06FF]{3,}/.test(clean);
  utter.lang = isLatin && quizLang === "auto" ? "en-US" : (LANG_BCP47[quizLang] || "ar-SA");
  utter.rate = 0.96;
  if (triggerBtn) triggerBtn.classList.add("speaking");
  utter.onend = () => { if (triggerBtn) triggerBtn.classList.remove("speaking"); };
  utter.onerror = () => { if (triggerBtn) triggerBtn.classList.remove("speaking"); };
  window.speechSynthesis.speak(utter);
}

function speakCurrentQuestion() {
  const q = state.rendered;
  if (!q) return;
  /* نقرأ الصيغة نفسها دون محددات $ و\( \) حتى لا تُقرأ العلامات بصوت عالٍ */
  const text = stripMathDelimiters(q.question) + " ... الخيارات: " + q.options.map((o, i) => `الخيار ${i + 1}: ${stripMathDelimiters(o)}`).join(" . ");
  speakText(text, el("btn-tts-q"));
}

/* ====== المؤثرات الصوتية (WebAudio) ====== */
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

/* ====== إعدادات وضع السرعة ====== */
const speedSettings = { on: false, secs: 60 }; /* الزمن الافتراضي 60 ثانية بطلب المستخدم */

function clampQuestionSecs(n) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v)) return 60;
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

/* ====== مستوى الصعوبة ====== */
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

/* ====== لغة السؤال ====== */
const LANG_NAMES = {
  auto: "لغة النص تلقائيًا",
  ar: "العربية",
  en: "الإنجليزية",
  fr: "الفرنسية",
  es: "الإسبانية",
  de: "الألمانية",
  tr: "التركية",
  ur: "الأردية",
  id: "الإندونيسية",
  ru: "الروسية",
  zh: "الصينية",
};
let quizLang = "auto";

function loadQuizLang() {
  const v = store.get("quiz_lang");
  quizLang = LANG_NAMES[v] ? v : "auto";
}

function getQuizLang() { return quizLang; }

function syncQuizLangUI() {
  el("quiz-lang").value = quizLang;
}

function setQuizLang(v, silent) {
  if (!LANG_NAMES[v]) return;
  quizLang = v;
  store.set("quiz_lang", v);
  syncQuizLangUI();
  if (!silent) {
    toast("info", "لغة السؤال: " + (v === "auto" ? "تلقائي — بلغة النص." : LANG_NAMES[v] + " — سيولّد السؤال والخيارات والتعليل بها."));
  }
}

function buildLangDirective() {
  if (quizLang === "auto") return "";
  return "مهم — لغة السؤال: اكتب السؤال والخيارات والتعليل كلها باللغة " + LANG_NAMES[quizLang] +
    ". وإذا كانت الفقرة أو الكلمة المفتاحية بلغة أخرى فترجم المعنى بدقة دون تغيير المضمون، ويُستحسن إثبات الكلمة المفتاحية الأصلية بين قوسين عند أول ذكر لها.";
}

/* ====== أسلوب توليد الأسئلة + خلط ترتيب الفقرات ====== */
const KW_MODE_LABELS = {
  kw: "بكلمات مفتاحية — أسئلة أكثر تنوعًا",
  none: "بدون كلمات مفتاحية — أسئلة أكثر تركيزًا",
};
let kwMode = "none";
let shuffleParagraphsOn = false;

function loadKwMode() {
  kwMode = store.get("quiz_kw_mode") === "kw" ? "kw" : "none";
  shuffleParagraphsOn = store.get("quiz_shuffle_paras") === "1";
}

function getKwMode() { return kwMode; }

function syncKwModeUI() {
  el("kw-mode").value = kwMode;
  const sp = el("shuffle-paragraphs");
  if (sp) sp.checked = shuffleParagraphsOn;
}

function setKwMode(v, silent) {
  if (v !== "kw" && v !== "none") return;
  kwMode = v;
  store.set("quiz_kw_mode", v);
  syncKwModeUI();
  if (!silent) {
    toast("info", "أسلوب الأسئلة: " + KW_MODE_LABELS[v] + " — يُطبّق على الأسئلة التي ستُولَّد.");
  }
}

/* ====== تعليمات إضافية من المستخدم ====== */
const MAX_EXTRA_INSTRUCTIONS = 500;
let extraInstructions = "";

function loadExtraInstructions() {
  extraInstructions = String(store.get("quiz_extra_instructions") || "").slice(0, MAX_EXTRA_INSTRUCTIONS);
}

function getExtraInstructions() { return extraInstructions; }

function updateExtraCount(live) {
  const n = typeof live === "string" ? live.length : extraInstructions.length;
  el("extra-count").textContent = n + "/" + MAX_EXTRA_INSTRUCTIONS;
  el("btn-extra-clear").disabled = n === 0;
  el("extra-instructions-box").classList.toggle("has-content", n > 0);
}

function syncExtraInstructionsUI() {
  el("extra-instructions").value = extraInstructions;
  updateExtraCount();
}

function setExtraInstructions(v, silent) {
  const clean = String(v || "").replace(/\r/g, "").slice(0, MAX_EXTRA_INSTRUCTIONS);
  extraInstructions = clean;
  store.set("quiz_extra_instructions", clean);
  updateExtraCount();
  if (!silent) {
    toast("info", clean ? "حُفظت التعليمات الإضافية — ستُطبَّق على الأسئلة القادمة." : "مُحيت التعليمات الإضافية.");
  }
}

let extraSavedTimer = null;
function flashExtraSaved() {
  const badge = el("extra-saved");
  badge.classList.add("show");
  clearTimeout(extraSavedTimer);
  extraSavedTimer = setTimeout(() => badge.classList.remove("show"), 1600);
}

function buildExtraDirective() {
  const t = extraInstructions.trim();
  if (!t) return "";
  return "تعليمات إضافية من المستخدم — التزم بها في صياغة السؤال وخياراته وتعليله ما أمكن، ما لم تتعارض مع القواعد أعلاه:\n" + t;
}

/* ====== نظام الأوسمة والإنجازات (Achievements) ====== */
const ACHIEVEMENTS_KEY = "quiz_achievements_v1";
const ACHIEVEMENTS_DEF = [
  { id: "first_quiz", icon: "🚀", title: "البداية الذكية", desc: "أنهيت أول اختبار لك في التطبيق" },
  { id: "perfect_score", icon: "🏆", title: "العلامة الكاملة", desc: "حققت 100% في اختبار من 3 أسئلة فأكثر" },
  { id: "streak_5", icon: "🔥", title: "سلسلة نارية", desc: "حققت 5 إجابات صحيحة متتالية" },
  { id: "speed_master", icon: "⚡", title: "سيد السرعة", desc: "كسبت 3 نقاط سرعة أو أكثر في جولة واحدة" },
  { id: "deep_reader", icon: "📖", title: "قارئ متعمق", desc: "راجعت الفقرات الأصلية 3 مرات أو أكثر في جولة" },
  { id: "hard_winner", icon: "🛡️", title: "قاهر الصعاب", desc: "حققت 80% أو أعلى في المستوى الصعب" },
  { id: "mistake_crusher", icon: "🎯", title: "قناص الأخطاء", desc: "أنهيت جولة تدريب على الأخطاء بنجاح 100%" },
  { id: "veteran_10", icon: "👑", title: "المثابر", desc: "أتممت 10 اختبارات في سجلك" },
];

function loadAchievements() {
  try { return JSON.parse(store.get(ACHIEVEMENTS_KEY) || "{}"); } catch { return {}; }
}

function saveAchievements(map) {
  store.set(ACHIEVEMENTS_KEY, JSON.stringify(map || {}));
}

function evaluateAchievements({ pct, total, bestStreak, speedBonus, passagesViewed, isFocus, lvl, historyCount }) {
  const unlocked = loadAchievements();
  const newlyUnlocked = [];
  const unlock = (id) => {
    if (!unlocked[id]) {
      unlocked[id] = Date.now();
      const def = ACHIEVEMENTS_DEF.find((a) => a.id === id);
      if (def) newlyUnlocked.push(def);
    }
  };
  unlock("first_quiz");
  if (pct === 100 && total >= 3) unlock("perfect_score");
  if (bestStreak >= 5) unlock("streak_5");
  if (speedBonus >= 3) unlock("speed_master");
  if (passagesViewed >= 3) unlock("deep_reader");
  if (lvl === "hard" && pct >= 80 && total >= 2) unlock("hard_winner");
  if (isFocus && pct === 100) unlock("mistake_crusher");
  if (historyCount >= 10) unlock("veteran_10");

  if (newlyUnlocked.length) {
    saveAchievements(unlocked);
    newlyUnlocked.forEach((b, idx) => {
      setTimeout(() => {
        toast("success", `${b.icon} وسام جديد: «${b.title}» — ${b.desc}!`);
      }, idx * 700);
    });
  }
}

function renderAchievementsStrip() {
  const wrap = el("achievements-strip");
  if (!wrap) return;
  const unlocked = loadAchievements();
  wrap.innerHTML = "";
  ACHIEVEMENTS_DEF.forEach((a) => {
    const isOn = !!unlocked[a.id];
    const span = document.createElement("span");
    span.className = "ach-badge" + (isOn ? " unlocked" : "");
    span.title = a.title + " — " + a.desc + (isOn ? " (مفتوح ✓)" : " (مقفل)");
    span.textContent = `${a.icon} ${a.title}`;
    wrap.appendChild(span);
  });
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
    [x.focus && "تدريب", x.imported && "مستورد"].filter(Boolean).join("+") || "عادي";
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

  renderAchievementsStrip();

  const h = historyInRange(all);
  const best = h.length ? Math.max.apply(null, h.map((x) => x.pct || 0)) : 0;

  renderWeekStrip(all);

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

  spark.innerHTML = "";
  list.innerHTML = "";
  if (noData) {
    const empty = document.createElement("div");
    empty.className = "spark-empty";
    empty.textContent = "لا نتائج ضمن هذا النطاق الزمني — جرّب نطاقًا أوسع.";
    spark.appendChild(empty);
    return;
  }

  h.slice(0, 12).reverse().forEach((item) => {
    const bar = document.createElement("i");
    bar.className = "bar" + (h.length > 1 && (item.pct || 0) === best ? " best" : "");
    bar.style.height = Math.max(8, item.pct || 4) + "%";
    let tip = (item.score || 0) + "/" + (item.total || 0) + " — " + (item.pct || 0) + "%";
    if (item.focus) tip += " (تدريب)";
    if (item.imported) tip += " (مستورد)";
    bar.title = tip;
    spark.appendChild(bar);
  });

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
  stopSpeech();
  ["setup", "preparing", "quiz", "results", "cards", "lists"].forEach((s) => {
    const node = el("screen-" + s);
    if (node) node.classList.toggle("active", s === name);
  });
  updateHeaderStudyBtn();
  window.scrollTo(0, 0);
}

function updateHeaderStudyBtn() {
  const btn = el("btn-header-study");
  if (!btn) return;
  const hasAnalysis = !!(state.analysis && Array.isArray(state.analysis.paragraphs) && state.analysis.paragraphs.length);
  const lastSess = loadLastSession();
  btn.classList.toggle("hidden", !hasAnalysis && !lastSess);
}

/* =========================================================
   5) حالة التطبيق
   ========================================================= */

const state = {
  analysis: null,          /* { context, paragraphs: [{text, keywords}] } */
  activeParagraphs: [],    /* الفقرات الناتجة عن التحليل (كل فقرة = سؤال) */
  usedKeywords: [],        /* لكل فقرة: الكلمات المستخدمة في الجولات السابقة */
  round: 0,
  roundPcts: [],           /* نسب كل جولة على نفس النص (للمقارنة) */
  quiz: null,              /* { current, score, streak, bestStreak, answers, startedAt, timerId, ... } */
  pending: new Map(),      /* فهرس الفقرة ← وعد بتوليد السؤال */
  questions: new Map(),    /* فهرس الفقرة ← السؤال المولّد نفسه */
  abortCtrl: null,
  rendered: null,          /* السؤال المعروض حاليًا */
  regen: null,             /* { i, q } سؤال معاد توليده للفقرة i */
  staticQuestions: null,   /* أسئلة ثابتة مستوردة من ملف JSON */
  focusRestore: null,      /* لقطة لاستعادة الاختبار الكامل بعد جولة التدريب على الأخطاء */
  importMeta: null,        /* { name } للاختبار المستورد */
  savedRef: null,          /* { listId, itemId } */
};

/* =========================================================
   6) تحضير الاختبار (شاشة التحضير)
   ========================================================= */

let prepTimers = [];

function startPreparingAnimation() {
  stopPreparingAnimation();
  const step2Label = el("prep-step-2").querySelector(".step-label");
  if (step2Label) {
    step2Label.textContent = kwMode === "none" ? "تحديد الفكرة المحورية لكل فقرة" : "استخراج الكلمات المفتاحية";
  }
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
  const key = el("api-key").value.trim();

  if (!key) {
    toast("error", "أدخل مفتاح API أولًا لبدء توليد الأسئلة.");
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

  state.staticQuestions = null;
  state.importMeta = null;
  state.savedRef = null;
  state.round = 0;
  mixTypeHistory.clear(); /* نص جديد = تحليل جديد، فتبدأ دورة تنويع الأنماط من صفر */
  state.abortCtrl = new AbortController();
  showScreen("preparing");
  startPreparingAnimation();

  try {
    const paraLimit = getParagraphLimit();
    const analysis = await aiAnalyzeText(text, state.abortCtrl.signal, paraLimit);
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
   7) إدارة جولة الاختبار + وسائل المساعدة الذكية
   ========================================================= */

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
  el("quiz-streak").classList.add("hidden");
  el("speed-chip").classList.add("hidden");
  el("speed-bar").classList.add("hidden");
}

async function beginRound() {
  state.round++;
  state.abortCtrl = new AbortController();
  state.rendered = null;
  state.regen = null;
  closePassageModal();
  if (shuffleParagraphsOn && !state.staticQuestions && !state.focusRestore && state.analysis && state.analysis.paragraphs.length > 1) {
    const idxs = shuffle(state.analysis.paragraphs.map((_, idx) => idx));
    state.activeParagraphs = idxs.map((i) => state.analysis.paragraphs[i]);
    state.usedKeywords = state.activeParagraphs.map(() => []);
  }
  state.quiz = {
    current: 0,
    score: 0,
    streak: 0,
    bestStreak: 0,
    answers: [],
    startedAt: Date.now(),
    timerId: null,
    speedBonus: 0,
    qTimerId: null,
    qDeadline: 0,
    passagesViewed: 0,
  };
  state.pending.clear();
  state.questions.clear();
  mixRoundTypes.length = 0; /* جولة جديدة = يبدأ تنويع أنماط «متنوع ذكي» داخل الجولة من صفر */
  if (state.staticQuestions) {
    state.staticQuestions.forEach((q) => {
      q.userAnswer = null;
      q.correct = null;
      q.speedFast = false;
      q.answerMs = null;
      q.fiftyUsed = false;
      q.hintUsed = false;
    });
  }
  setupRoundScreen();
  updateQuizMeta();
  startTimer();
  await showCurrentQuestion();
}

/* اختيار كلمة مفتاحية عشوائية غير مستخدمة سابقًا للفقرة i */
async function pickKeyword(i) {
  const p = state.activeParagraphs[i];
  if (!p.keywords.length) p.keywords = localExtractKeywords(p.text);
  const used = state.usedKeywords[i];
  let avail = p.keywords.filter((k) => !used.includes(k));

  if (!avail.length) {
    let fresh = await aiRefreshKeywords({ paragraph: p.text, exclude: used }, state.abortCtrl && state.abortCtrl.signal);
    fresh = fresh.filter((k) => k && !used.includes(k));
    if (!fresh.length) {
      const base = p.keywords.length ? p.keywords : localExtractKeywords(p.text);
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

function ensureQuestion(i) {
  if (state.pending.has(i)) return state.pending.get(i);
  const promise = (async () => {
    const p = state.activeParagraphs[i];
    const useKw = getKwMode() === "kw";
    const keyword = useKw ? await pickKeyword(i) : "";
    const q = await aiGenerateQuestion(
      { context: state.analysis.context, paragraph: p.text, keyword, paragraphIndex: i, avoidType: getQType() === "mix" ? (mixTypeHistory.get(i) || "") : "" },
      state.abortCtrl ? state.abortCtrl.signal : undefined
    );
    const full = {
      paragraphIndex: i,
      keyword,
      ...q,
      userAnswer: null,
      correct: null,
      starred: false,
      userNote: "",
      fiftyUsed: false,
      hintUsed: false,
    };
    state.questions.set(i, full);
    return full;
  })();
  promise.catch(() => {});
  state.pending.set(i, promise);
  return promise;
}

async function showCurrentQuestion() {
  const qz = state.quiz;
  if (!qz) return;
  const i = qz.current;
  stopSpeech();

  if (state.staticQuestions) {
    const q = state.staticQuestions[i];
    if (!q) return;
    state.rendered = q;
    renderQuestion(q);
    return;
  }

  renderQuestionLoading();

  if (i + 1 < state.activeParagraphs.length) {
    try { ensureQuestion(i + 1); } catch {}
  }

  try {
    const q = await ensureQuestion(i);
    if (state.quiz !== qz || qz.current !== i) return;
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

  el("q-hint-box").classList.add("hidden");
  el("q-hint-box").innerHTML = "";
  el("btn-fifty").disabled = true;
  el("btn-hint").disabled = true;
  el("btn-tts-q").disabled = true;
  el("btn-star-q").disabled = true;

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
  renderQuizDots();
}

function renderQuestion(q) {
  const qTextEl = el("q-text");
  qTextEl.innerHTML = "";
  qTextEl.appendChild(mathRichFrag(q.question));

  const badge = el("q-type-badge");
  if (badge) {
    const t = q.qType || (q.options && q.options.length === 2 ? "tf" : "mcq");
    badge.textContent = Q_TYPE_LABELS[t] || "اختيار من متعدد";
  }

  el("q-hint-box").classList.add("hidden");
  el("q-hint-box").innerHTML = "";

  const isAnswered = q.userAnswer !== null;
  el("btn-fifty").disabled = isAnswered || q.fiftyUsed || (q.options && q.options.length <= 2);
  el("btn-hint").disabled = isAnswered || q.hintUsed || !getPassageForQuestion(q);
  el("btn-tts-q").disabled = false;
  el("btn-star-q").disabled = false;
  syncStarButton(q);

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
    text.dir = "auto";
    text.appendChild(mathRichFrag(opt));

    label.appendChild(input);
    label.appendChild(letter);
    label.appendChild(text);
    el("options").appendChild(label);
  });

  el("feedback").classList.add("hidden");
  el("feedback").innerHTML = "";
  el("btn-next").disabled = true;
  el("btn-next").textContent = "التالي";
  renderQuizDots();
  startQuestionTimer(q);
}

/* ====== وسائل المساعدة الذكية (50:50 + تلميح + نجمة + خريطة الأسئلة) ====== */
function activateFiftyLifeline() {
  const q = state.rendered;
  if (!q || q.userAnswer !== null || q.fiftyUsed || !q.options || q.options.length <= 2) return;
  const wrongIndices = q.options.map((_, idx) => idx).filter((idx) => idx !== q.correctIndex);
  shuffle(wrongIndices);
  const toEliminate = wrongIndices.slice(0, 2);
  const labels = [...el("options").children];
  toEliminate.forEach((idx) => {
    const lbl = labels[idx];
    if (!lbl) return;
    lbl.classList.add("eliminated");
    const inp = lbl.querySelector("input");
    if (inp) inp.disabled = true;
  });
  q.fiftyUsed = true;
  el("btn-fifty").disabled = true;
  toast("info", "تم استبعاد خيارين خاطئين — اختر من الخيارين المتبقيين.");
}

function activateHintLifeline() {
  const q = state.rendered;
  if (!q || q.userAnswer !== null || q.hintUsed) return;
  const passage = getPassageForQuestion(q);
  if (!passage || !passage.text) {
    toast("info", "لا يتوفر تلميح نصي لهذا السؤال.");
    return;
  }
  const sentences = String(passage.text)
    .split(/(?<=[.!؟?\n])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 15);
  let target = "";
  if (q.keyword) {
    target = sentences.find((s) => s.includes(q.keyword)) || "";
  }
  if (!target) {
    target = sentences[0] || passage.text.slice(0, 160);
  }
  const correctOpt = String(q.options[q.correctIndex] || "").trim();
  if (correctOpt.length >= 4 && target.includes(correctOpt)) {
    target = target.replace(correctOpt, "«...»");
  }
  const box = el("q-hint-box");
  box.innerHTML = "";
  const strong = document.createElement("strong");
  strong.textContent = "💡 تلميح من الفقرة:";
  box.appendChild(strong);
  box.appendChild(mathRichFrag(" " + target));
  box.classList.remove("hidden");
  q.hintUsed = true;
  el("btn-hint").disabled = true;
}

function syncStarButton(q) {
  const btn = el("btn-star-q");
  if (!btn || !q) return;
  const on = !!q.starred;
  btn.classList.toggle("starred", on);
  btn.setAttribute("aria-pressed", on ? "true" : "false");
}

function toggleStarCurrentQuestion() {
  const q = state.rendered;
  if (!q) return;
  q.starred = !q.starred;
  syncStarButton(q);
  renderQuizDots();
  updateSavedProgress();
  toast("info", q.starred ? "★ تم تمييز السؤال للمراجعة." : "أُزيلت النجمة عن السؤال.");
}

function renderQuizDots() {
  const wrap = el("quiz-dots");
  if (!wrap || !state.quiz) return;
  const total = state.activeParagraphs.length;
  wrap.innerHTML = "";
  if (total <= 1) {
    wrap.classList.add("hidden");
    return;
  }
  wrap.classList.remove("hidden");
  for (let i = 0; i < total; i++) {
    const q = state.staticQuestions ? state.staticQuestions[i] : state.questions.get(i);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "quiz-dot";
    btn.textContent = String(i + 1);
    const isAnswered = q && q.userAnswer !== null;
    if (i === state.quiz.current) btn.classList.add("current");
    if (isAnswered) {
      btn.classList.add("answered", q.correct ? "ok" : "bad");
      btn.title = `السؤال ${i + 1}: ${q.correct ? "إجابة صحيحة" : "إجابة خاطئة"} — انقر لقراءة الفقرة`;
      btn.addEventListener("click", () => openPassageModal(q));
    } else {
      btn.title = i === state.quiz.current ? `السؤال الحالي (${i + 1})` : `السؤال ${i + 1}`;
    }
    if (q && q.starred) btn.classList.add("starred");
    wrap.appendChild(btn);
  }
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
  stopSpeech();
  q.userAnswer = idx;
  q.correct = idx === q.correctIndex;
  q.answerMs = speedSettings.on && qz.qDeadline ? Date.now() - (qz.qDeadline - speedSettings.secs * 1000) : null;
  q.speedFast = !!(speedSettings.on && q.correct && qz.qDeadline && Date.now() <= qz.qDeadline - (speedSettings.secs * 1000) / 2);
  if (q.regen) {
    q.answerMs = null;
    q.speedFast = false;
  } else {
    if (q.speedFast) qz.speedBonus++;
    if (q.correct) {
      qz.score++;
      qz.streak++;
      qz.bestStreak = Math.max(qz.bestStreak, qz.streak);
    } else {
      qz.streak = 0;
    }
    qz.answers.push(q);
    updateSavedProgress();
  }
  if (q.correct) playCorrect();
  else playWrong();

  el("btn-fifty").disabled = true;
  el("btn-hint").disabled = true;

  if (!q.regen) {
    const streakChip = el("quiz-streak");
    if (qz.streak >= 2) {
      streakChip.querySelector("span").textContent = "سلسلة ×" + qz.streak;
      streakChip.classList.remove("hidden");
    } else {
      streakChip.classList.add("hidden");
    }
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
  renderQuizDots();
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

/* ====== نافذة الفقرة المنبثقة ====== */
const BOOK_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>';
let passageReturnFocus = null;

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

let passageNavIdx = -1;
let passageNavMax = -1;

function openPassageModal(q) {
  const passage = getPassageForQuestion(q);
  if (!passage) {
    toast("info", "لا يتوفر نص مرتبط بهذا السؤال.");
    return;
  }
  if (state.quiz) state.quiz.passagesViewed = (state.quiz.passagesViewed || 0) + 1;

  const navBase = (!state.staticQuestions && q && Number.isInteger(q.paragraphIndex) &&
    state.activeParagraphs[q.paragraphIndex] && state.activeParagraphs.length > 1) ? q.paragraphIndex : -1;
  passageNavIdx = navBase;
  passageNavMax = state.quiz && el("screen-quiz").classList.contains("active")
    ? Math.max(navBase, state.quiz.current)
    : (state.activeParagraphs.length - 1);
  el("passage-nav").classList.toggle("hidden", navBase < 0);
  el("passage-hint").innerHTML = navBase >= 0
    ? "تنقّل بين فقرات الأسئلة السابقة والحالية فقط — <kbd>Esc</kbd> للإغلاق"
    : "اقرأ الفقرة بتمعّن ثم أكمل — <kbd>Esc</kbd> للإغلاق";

  if (navBase >= 0) {
    renderPassageAt(navBase, false, q);
  } else {
    renderPassageStatic(passage, q);
  }

  el("btn-passage-continue").textContent =
    el("screen-quiz").classList.contains("active") ? "متابعة الاختبار" : "إغلاق";

  passageReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  el("passage-overlay").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  try { el("btn-passage-continue").focus(); } catch {}
}

function renderPassageStatic(passage, q) {
  el("passage-title-text").textContent = passage.title;
  const kwWrap = el("passage-kw");
  kwWrap.innerHTML = "";
  if (q && q.keyword) {
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
  body.appendChild(passageRichFrag(passage.text, q && q.keyword));
  body.scrollTop = 0;
}

function renderPassageAt(idx, animate, baseQ) {
  const p = state.activeParagraphs[idx];
  if (!p || !p.text) return false;
  const navQ = (baseQ && baseQ.paragraphIndex === idx && baseQ.keyword)
    ? baseQ
    : ((state.questions && state.questions.get(idx)) || null);
  const kw = (navQ && navQ.keyword) || "";
  el("passage-title-text").textContent = "الفقرة المتعلقة بالسؤال " + (idx + 1);
  const kwWrap = el("passage-kw");
  kwWrap.innerHTML = "";
  if (kw) {
    const chip = document.createElement("span");
    chip.className = "modal-kw-chip";
    chip.appendChild(document.createTextNode("الكلمة المفتاحية: "));
    const strong = document.createElement("strong");
    strong.textContent = kw;
    chip.appendChild(strong);
    kwWrap.appendChild(chip);
    kwWrap.classList.remove("hidden");
  } else {
    kwWrap.classList.add("hidden");
  }
  const body = el("passage-body");
  body.innerHTML = "";
  body.appendChild(passageRichFrag(p.text, kw));
  body.scrollTop = 0;
  if (animate) {
    body.classList.remove("nav-anim");
    void body.offsetWidth;
    body.classList.add("nav-anim");
  }
  el("passage-nav-pos").textContent = "السؤال " + (idx + 1) + " من " + (passageNavMax + 1);
  el("btn-passage-prev").disabled = idx <= 0;
  el("btn-passage-next").disabled = idx >= passageNavMax;
  return true;
}

function passageGo(dir) {
  if (passageNavIdx < 0) return;
  const target = passageNavIdx + dir;
  if (target < 0 || target > passageNavMax) return;
  passageNavIdx = target;
  renderPassageAt(passageNavIdx, true);
}

function closePassageModal() {
  const overlay = el("passage-overlay");
  if (overlay.classList.contains("hidden")) return;
  stopSpeech();
  overlay.classList.add("hidden");
  document.body.style.overflow = "";
  if (passageReturnFocus && document.contains(passageReturnFocus)) {
    try { passageReturnFocus.focus(); } catch {}
  }
  passageReturnFocus = null;
}

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

const TIP_PASSAGE_KEY = "quiz_tip_passage_v1";
let passageTipTimer = null;

function maybeShowPassageTip(container) {
  if (!container || store.get(TIP_PASSAGE_KEY)) return;
  if (!container.querySelector(".passage-btn")) return;
  store.set(TIP_PASSAGE_KEY, "1");
  const tip = document.createElement("div");
  tip.className = "passage-tip";
  tip.setAttribute("role", "note");
  const txt = document.createElement("span");
  txt.textContent = "جديد: بعد كل إجابة يمكنك قراءة الفقرة الأصلية المرتبطة بالسؤال أو تدوين ملاحظتك الشخصية قبل المتابعة.";
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

const PENCIL_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>';

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

/* حقل ملاحظة المتعلم الشخصية داخل التغذية الراجعة */
function appendNoteEditor(container, q) {
  if (!container || !q) return;
  const wrap = document.createElement("div");
  wrap.className = "q-note-wrap";
  const ta = document.createElement("textarea");
  ta.className = "q-note-input";
  ta.rows = 1;
  ta.maxLength = 300;
  ta.dir = "auto";
  ta.placeholder = "📝 أضف ملاحظة شخصية على هذا السؤال أو الفقرة (تُحفظ تلقائيًا وتظهر في دليل الدراسة)...";
  ta.value = q.userNote || "";
  ta.addEventListener("input", () => {
    q.userNote = ta.value;
    updateSavedProgress();
  });
  wrap.appendChild(ta);
  container.appendChild(wrap);
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
  stopSpeech();
  q.userAnswer = -1;
  q.correct = false;
  q.speedFast = false;
  q.answerMs = null;
  if (!q.regen) {
    qz.streak = 0;
    qz.answers.push(q);
    updateSavedProgress();
  }
  playWrong();

  el("btn-fifty").disabled = true;
  el("btn-hint").disabled = true;

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
  strong.textContent = "انتهى الوقت! الصحيحة هي: ";
  strong.appendChild(document.createTextNode("«"));
  strong.appendChild(mathRichFrag(q.options[q.correctIndex]));
  strong.appendChild(document.createTextNode("»"));
  const p = document.createElement("p");
  p.dir = "auto";
  p.appendChild(mathRichFrag(q.explanation || "لا يتوفر تعليل لهذا السؤال."));
  body.appendChild(strong);
  body.appendChild(p);
  const actRow = document.createElement("div");
  actRow.className = "fb-actions-row";
  appendPassageButton(actRow, q, "قراءة الفقرة المتعلقة");
  appendRegenButton(actRow, q);
  body.appendChild(actRow);
  appendNoteEditor(body, q);

  fb.appendChild(icon);
  fb.appendChild(body);
  fb.classList.remove("hidden");
  updateQuizMeta();
  renderQuizDots();
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
    strong.textContent = "إجابة خاطئة — الصحيحة هي: ";
    strong.appendChild(document.createTextNode("«"));
    strong.appendChild(mathRichFrag(q.options[q.correctIndex]));
    strong.appendChild(document.createTextNode("»"));
  }

  const p = document.createElement("p");
  p.dir = "auto";
  p.appendChild(mathRichFrag(q.explanation || "لا يتوفر تعليل لهذا السؤال."));

  body.appendChild(strong);
  body.appendChild(p);
  const actRow = document.createElement("div");
  actRow.className = "fb-actions-row";
  appendPassageButton(actRow, q, "قراءة الفقرة المتعلقة");
  appendRegenButton(actRow, q);
  body.appendChild(actRow);
  if (q.regen) {
    const note = document.createElement("span");
    note.className = "regen-note";
    note.textContent = "سؤال معاد توليده — إجابته لا تُحتسب في التنقيط";
    body.appendChild(note);
  }
  appendNoteEditor(body, q);
  maybeShowPassageTip(body);
  fb.appendChild(icon);
  fb.appendChild(body);
  fb.classList.remove("hidden");
}

/* ====== إعادة توليد السؤال بعد الإجابة ====== */
let regenBusy = false;
const REGEN_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';

function appendRegenButton(container, q) {
  if (!container || !q || state.staticQuestions) return;
  if (!Number.isInteger(q.paragraphIndex) || !state.activeParagraphs[q.paragraphIndex]) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn ghost sm regen-btn";
  btn.innerHTML = REGEN_ICON;
  btn.appendChild(document.createTextNode("إعادة توليد السؤال"));
  btn.addEventListener("click", () => regenerateQuestion(q.paragraphIndex, btn));
  container.appendChild(btn);
}

function renderAnsweredQuestion(q) {
  renderQuestion(q);
  stopQuestionTimer(true);
  const labels = [...el("options").children];
  labels.forEach((label, i) => {
    const input = label.querySelector("input");
    if (input) input.disabled = true;
    label.classList.add("locked");
    if (i === q.correctIndex) label.classList.add("correct");
    else if (i === q.userAnswer) label.classList.add("wrong");
    else label.classList.add("dim");
  });
  showFeedback(q);
  if (state.quiz) {
    const isLast = state.quiz.current === state.activeParagraphs.length - 1;
    el("btn-next").disabled = false;
    el("btn-next").textContent = isLast ? "عرض النتيجة" : "السؤال التالي";
  }
}

async function regenerateQuestion(i, btn) {
  const qz = state.quiz;
  if (!qz || regenBusy || state.staticQuestions) return;
  const p = state.activeParagraphs[i];
  if (!p) return;
  regenBusy = true;
  if (btn) { btn.disabled = true; btn.classList.add("busy"); }
  renderQuestionLoading();
  try {
    const useKw = getKwMode() === "kw";
    const keyword = useKw ? await pickKeyword(i) : "";
    const orig = state.questions.get(i);
    /* «متنوع ذكي»: مرّر نمط السؤال السابق ليطلب النموذج نمطًا آخر هذه المرة (تنويع التدريب) */
    const prevType = getQType() === "mix" && orig && orig.qType && orig.qType !== "mix" ? orig.qType : "";
    const nq = await aiGenerateQuestion(
      { context: state.analysis.context, paragraph: p.text, keyword, paragraphIndex: i, avoidType: prevType },
      state.abortCtrl ? state.abortCtrl.signal : undefined
    );
    if (state.quiz !== qz || qz.current !== i) return;
    const full = {
      paragraphIndex: i,
      keyword,
      ...nq,
      userAnswer: null,
      correct: null,
      regen: true,
      starred: orig ? !!orig.starred : false,
      userNote: orig ? (orig.userNote || "") : "",
    };
    state.regen = { i, q: full };
    state.rendered = full;
    renderQuestion(full);
  } catch (err) {
    if (isAbort(err)) return;
    console.error("[Regen]", err);
    toast("error", friendlyApiError(err));
    const orig = state.questions.get(i);
    if (orig && state.quiz === qz && qz.current === i) {
      state.rendered = orig;
      renderAnsweredQuestion(orig);
    }
  } finally {
    regenBusy = false;
    if (btn) { btn.disabled = false; btn.classList.remove("busy"); }
  }
}

async function nextQuestion() {
  const qz = state.quiz;
  if (!qz || el("btn-next").disabled) return;

  state.regen = null;
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
   8) النتائج + تصفية المراجعة والبحث
   ========================================================= */

let lastResults = null;
let reviewFilter = "all";

function finishQuiz() {
  if (!state.quiz || state.quiz.finished) return;
  state.quiz.finished = true;
  updateSavedProgress();
  stopTimer();
  stopQuestionTimer(true);
  stopSpeech();
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
    focus: !!state.focusRestore,
    imported: !!state.staticQuestions,
    lvl: getDifficulty(),
    duration: elapsed,
    preview: state.staticQuestions && state.importMeta
      ? "[مستورد] " + state.importMeta.name
      : el("input-text").value.trim().slice(0, 42),
  });

  const allHistory = loadHistory();
  evaluateAchievements({
    pct,
    total,
    bestStreak: qz.bestStreak || 0,
    speedBonus: qz.answers.filter((a) => a.speedFast).length,
    passagesViewed: qz.passagesViewed || 0,
    isFocus: !!state.focusRestore,
    lvl: getDifficulty(),
    historyCount: allHistory.length,
  });

  if (state.savedRef && !state.focusRestore) {
    withItem(state.savedRef.listId, state.savedRef.itemId, (it) => {
      it.plays = (it.plays || 0) + 1;
      it.bestPct = Math.max(it.bestPct || 0, pct);
      it.lastPct = pct;
      it.updatedAt = Date.now();
      if (it.source === "session") it.progress = null;
    });
  }
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

  reviewFilter = "all";
  document.querySelectorAll(".rev-filter").forEach((b) => b.classList.toggle("active", b.dataset.filter === "all"));
  const rs = el("review-search");
  if (rs) rs.value = "";
  renderReviewList();
}

function renderReviewList() {
  const list = el("review-list");
  if (!list || !lastResults) return;
  list.innerHTML = "";
  const query = String((el("review-search") && el("review-search").value) || "").trim().toLowerCase();

  const items = lastResults.answers
    .map((q, i) => ({ q, i }))
    .filter(({ q }) => {
      if (reviewFilter === "wrong" && q.correct) return false;
      if (reviewFilter === "correct" && !q.correct) return false;
      if (reviewFilter === "starred" && !q.starred) return false;
      if (reviewFilter === "noted" && !(q.userNote && q.userNote.trim())) return false;
      if (query) {
        const hay = [q.question, ...(q.options || []), q.explanation || "", q.userNote || "", q.keyword || ""].join(" ").toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });

  if (!items.length) {
    const empty = document.createElement("li");
    empty.className = "review-item";
    empty.style.textAlign = "center";
    empty.style.color = "var(--muted)";
    empty.textContent = "لا توجد أسئلة تطابق معيار التصفية أو البحث الحالي.";
    list.appendChild(empty);
    return;
  }

  items.forEach(({ q, i }) => {
    const li = document.createElement("li");
    li.className = "review-item " + (q.correct ? "correct-item" : "wrong-item");

    const head = document.createElement("div");
    head.className = "review-head";
    const num = document.createElement("span");
    num.className = "review-num";
    num.textContent = String(i + 1);
    const qText = document.createElement("span");
    qText.className = "review-q";
    qText.appendChild(mathRichFrag(q.question));

    const starBtn = document.createElement("button");
    starBtn.type = "button";
    starBtn.className = "review-star-btn" + (q.starred ? " on" : "");
    starBtn.textContent = q.starred ? "★" : "☆";
    starBtn.title = "تمييز السؤال بنجمة";
    starBtn.addEventListener("click", () => {
      q.starred = !q.starred;
      renderReviewList();
    });

    head.appendChild(num);
    head.appendChild(qText);
    head.appendChild(starBtn);

    const rows = document.createElement("div");
    rows.className = "review-rows";
    const your = document.createElement("div");
    your.className = q.correct ? "ok" : "no";
    if (q.userAnswer === -1) {
      your.textContent = "إجابتك: — (انتهى الوقت)";
    } else {
      your.textContent = "إجابتك: ";
      your.appendChild(mathRichFrag(q.options[q.userAnswer]));
    }
    rows.appendChild(your);
    if (!q.correct) {
      const right = document.createElement("div");
      right.className = "ok";
      right.textContent = "الإجابة الصحيحة: ";
      right.appendChild(mathRichFrag(q.options[q.correctIndex]));
      rows.appendChild(right);
    }

    const explain = document.createElement("div");
    explain.className = "review-explain";
    explain.dir = "auto";
    explain.textContent = "التعليل: ";
    explain.appendChild(mathRichFrag(q.explanation || "—"));

    li.appendChild(head);
    li.appendChild(rows);
    li.appendChild(explain);
    if (q.userNote && q.userNote.trim()) {
      const un = document.createElement("div");
      un.className = "review-user-note";
      un.dir = "auto";
      un.textContent = "📝 ملاحظتك: " + q.userNote.trim();
      li.appendChild(un);
    }
    appendPassageButton(li, q, "عرض الفقرة");
    list.appendChild(li);
  });
}

async function retakeQuiz() {
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
  updateSavedProgress();
  restoreFullParagraphs();
  state.quiz = null;
  state.rendered = null;
  state.regen = null;
  state.staticQuestions = null;
  state.importMeta = null;
  clearSharedHash();
  renderListsOverview();
  renderResume();
  renderHistory();
  showScreen("setup");
}

function quitQuiz() {
  if (!confirm("هل تريد إنهاء الاختبار الحالي؟ سيتم حفظ تقدمك الحالي للاستئناف لاحقًا.")) return;
  stopTimer();
  stopQuestionTimer(true);
  if (state.abortCtrl) { try { state.abortCtrl.abort(); } catch {} }
  updateSavedProgress();
  restoreFullParagraphs();
  state.quiz = null;
  state.rendered = null;
  state.regen = null;
  state.staticQuestions = null;
  state.importMeta = null;
  clearSharedHash();
  renderListsOverview();
  renderResume();
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
    if (q.userNote && q.userNote.trim()) lines.push(`   ملاحظتي: ${q.userNote.trim()}`);
  });
  const text = lines.join("\n");
  await copyTextToClipboard(text, "تم نسخ النتيجة إلى الحافظة.");
}

/* ====== حد عدد الفقرات ====== */
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

function applyAnalysis(analysis) {
  state.analysis = analysis;
  state.activeParagraphs = analysis.paragraphs;
  state.usedKeywords = analysis.paragraphs.map(() => []);
  state.roundPcts = [];
  state.round = 0;
  updateHeaderStudyBtn();
}

/* ====== استئناف آخر نص محفوظ ====== */
const RESUME_KEY = "quiz_last_session";

function saveLastSession() {
  if (!state.analysis) return;
  store.set(RESUME_KEY, JSON.stringify({
    text: el("input-text").value.trim(),
    analysis: state.analysis,
    savedAt: Date.now(),
    progress: null,
    savedRef: null,
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
  updateHeaderStudyBtn();
}

function snapshotProgress() {
  const qz = state.quiz;
  if (!qz || qz.finished || state.focusRestore || state.staticQuestions || !state.analysis) return null;
  const total = state.activeParagraphs.length;
  if (!total) return null;
  const resumeAt = qz.answers.length;
  if (resumeAt < 0 || resumeAt >= total) return null;
  if (!state.questions.has(resumeAt)) return null;
  const questions = [];
  state.questions.forEach((q, i) => questions.push({ i, q }));
  if (!questions.length) return null;
  return {
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

function updateSavedProgress() {
  if (!state.quiz) return;
  const s = loadLastSession();
  if (!s) return;
  const snap = snapshotProgress();
  if (snap) {
    s.progress = snap;
    s.savedAt = snap.savedProgressAt;
  } else if (state.quiz.finished) {
    s.progress = null;
  } else {
    return;
  }
  try { store.set(RESUME_KEY, JSON.stringify(s)); } catch {}
  syncSavedItemProgress();
}

function validateProgress(s) {
  const p = s && s.progress;
  if (!p || typeof p !== "object") return null;
  const full = Array.isArray(s.analysis && s.analysis.paragraphs) ? s.analysis.paragraphs.length : 0;
  if (!full) return null;
  const expected = full;
  if (p.activeCount !== expected) return null;
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
  if (!seen.has(p.resumeAt)) return null;
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

async function resumeQuizRound(prog) {
  state.abortCtrl = new AbortController();
  state.rendered = null;
  state.regen = null;
  closePassageModal();
  state.quiz = {
    current: prog.resumeAt,
    score: prog.score || 0,
    streak: prog.streak || 0,
    bestStreak: prog.bestStreak || 0,
    answers: [],
    startedAt: Date.now() - (prog.elapsedMs || 0),
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
  state.savedRef = s.savedRef && findSavedItem(s.savedRef) ? { listId: s.savedRef.listId, itemId: s.savedRef.itemId } : null;
  const prog = validateProgress(s);
  if (prog) {
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
  if (!el("api-key").value.trim()) {
    toast("error", "لتوليد أسئلة جديدة تحتاج مفتاح API.");
    return;
  }
  state.staticQuestions = null;
  state.importMeta = null;
  applyAnalysis(s.analysis);
  el("input-text").value = s.text || "";
  updateCharCount();
  await beginRound();
  toast("info", "تم الاستئناف — التحليل محفوظ وسيولّد أسئلة جديدة مباشرة.");
}

/* ====== نافذة دليل الدراسة الشامل (Study Guide Modal) ====== */
let studyGuideReturnFocus = null;

function isStudyGuideOpen() {
  return !el("study-guide-overlay").classList.contains("hidden");
}

function getActiveAnalysisForStudy() {
  if (state.analysis && Array.isArray(state.analysis.paragraphs) && state.analysis.paragraphs.length) {
    return state.analysis;
  }
  const last = loadLastSession();
  if (last && last.analysis && Array.isArray(last.analysis.paragraphs) && last.analysis.paragraphs.length) {
    return last.analysis;
  }
  return null;
}

function openStudyGuideModal() {
  const analysis = getActiveAnalysisForStudy();
  if (!analysis) {
    toast("info", "حلّل نصًا أولًا لعرض دليل الدراسة والملخص الذكي.");
    return;
  }
  const sgCtx = el("sg-context");
  sgCtx.innerHTML = "";
  sgCtx.appendChild(mathRichFrag(analysis.context || "—"));

  const kwBox = el("sg-keywords");
  kwBox.innerHTML = "";
  const allKws = [...new Set(analysis.paragraphs.flatMap((p) => p.keywords || []).filter(Boolean))];
  el("sg-keywords-section").classList.toggle("hidden", !allKws.length);
  allKws.forEach((kw) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "sg-kw-chip";
    chip.textContent = kw;
    chip.title = "انقر لتصفية الفقرات التي تحتوي هذه الكلمة";
    chip.addEventListener("click", () => {
      el("sg-search").value = kw;
      renderStudyGuideParagraphs(analysis);
    });
    kwBox.appendChild(chip);
  });

  el("sg-search").value = "";
  renderStudyGuideParagraphs(analysis);

  studyGuideReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  el("study-guide-overlay").classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function renderStudyGuideParagraphs(analysis) {
  const a = analysis || getActiveAnalysisForStudy();
  const wrap = el("sg-paragraphs");
  if (!wrap || !a) return;
  wrap.innerHTML = "";
  const q = String(el("sg-search").value || "").trim().toLowerCase();

  a.paragraphs.forEach((p, idx) => {
    const qObj = state.questions && state.questions.get(idx);
    const note = qObj && qObj.userNote ? qObj.userNote.trim() : "";
    const hay = [p.text, ...(p.keywords || []), note].join(" ").toLowerCase();
    if (q && !hay.includes(q)) return;

    const card = document.createElement("div");
    card.className = "sg-para-card";

    const head = document.createElement("div");
    head.className = "sg-para-head";
    const num = document.createElement("span");
    num.className = "sg-para-num";
    num.textContent = `الفقرة ${idx + 1}`;
    head.appendChild(num);

    const kws = document.createElement("div");
    kws.style.display = "flex";
    kws.style.gap = "5px";
    kws.style.flexWrap = "wrap";
    (p.keywords || []).forEach((k) => {
      const sp = document.createElement("span");
      sp.className = "chip";
      sp.style.fontSize = "0.7rem";
      sp.style.padding = "2px 9px";
      sp.textContent = k;
      kws.appendChild(sp);
    });
    head.appendChild(kws);

    const ttsBtn = document.createElement("button");
    ttsBtn.type = "button";
    ttsBtn.className = "btn ghost sm";
    ttsBtn.style.padding = "4px 10px";
    ttsBtn.style.minHeight = "30px";
    ttsBtn.textContent = "🔊 استماع";
    ttsBtn.addEventListener("click", () => speakText(p.text, ttsBtn));
    head.appendChild(ttsBtn);

    const body = document.createElement("div");
    body.className = "sg-para-text";
    body.dir = "auto";
    body.appendChild(passageRichFrag(p.text, ""));

    card.appendChild(head);
    card.appendChild(body);
    if (note) {
      const nEl = document.createElement("div");
      nEl.className = "review-user-note";
      nEl.dir = "auto";
      nEl.textContent = "📝 ملاحظتك: " + note;
      card.appendChild(nEl);
    }
    wrap.appendChild(card);
  });
}

function closeStudyGuideModal() {
  const ov = el("study-guide-overlay");
  if (ov.classList.contains("hidden")) return;
  stopSpeech();
  ov.classList.add("hidden");
  document.body.style.overflow = "";
  if (studyGuideReturnFocus && document.contains(studyGuideReturnFocus)) {
    try { studyGuideReturnFocus.focus(); } catch {}
  }
  studyGuideReturnFocus = null;
}

async function copyStudyGuide() {
  const a = getActiveAnalysisForStudy();
  if (!a) return;
  const lines = [];
  lines.push("دليل الدراسة والملخص — اختبرني");
  lines.push("================================");
  lines.push("السياق العام: " + (a.context || "—"));
  lines.push("");
  a.paragraphs.forEach((p, idx) => {
    lines.push(`--- الفقرة ${idx + 1} ---`);
    if (p.keywords && p.keywords.length) lines.push(`الكلمات المفتاحية: ${p.keywords.join(" · ")}`);
    lines.push(p.text);
    const qObj = state.questions && state.questions.get(idx);
    if (qObj && qObj.userNote && qObj.userNote.trim()) {
      lines.push(`ملاحظتي: ${qObj.userNote.trim()}`);
    }
    lines.push("");
  });
  await copyTextToClipboard(lines.join("\n"), "تم نسخ دليل الدراسة الكامل إلى الحافظة.");
}

/* ====== نافذة اختصارات لوحة المفاتيح ====== */
let shortcutsReturnFocus = null;
function openShortcutsModal() {
  if (isOverlayVisibleById("shortcuts-overlay")) return;
  shortcutsReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  el("shortcuts-overlay").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  try { el("btn-shortcuts-ok").focus(); } catch {}
}
function closeShortcutsModal() {
  const ov = el("shortcuts-overlay");
  if (ov.classList.contains("hidden")) return;
  ov.classList.add("hidden");
  document.body.style.overflow = "";
  if (shortcutsReturnFocus && document.contains(shortcutsReturnFocus)) {
    try { shortcutsReturnFocus.focus(); } catch {}
  }
  shortcutsReturnFocus = null;
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
    version: "2.0",
    exportedAt: new Date().toISOString(),
    context: state.analysis ? state.analysis.context : "",
    score: lastResults.score,
    total: lastResults.total,
    questions: lastResults.answers.map((q, i) => ({
      n: i + 1,
      qType: q.qType || "mcq",
      keyword: q.keyword,
      question: q.question,
      options: q.options,
      correctAnswer: q.options[q.correctIndex],
      explanation: q.explanation,
      yourAnswer: q.userAnswer !== null && q.userAnswer >= 0 ? q.options[q.userAnswer] : null,
      wasCorrect: !!q.correct,
      starred: !!q.starred,
      userNote: q.userNote || "",
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
    q.options.forEach((o, oi) => lines.push(`   ${letters[oi] || (oi + 1)}) ${o}`));
  });
  lines.push("");
  lines.push("=== الإجابات الصحيحة والتعليل ===");
  answers.forEach((q, i) => {
    lines.push(`${i + 1}) ${q.options[q.correctIndex]}`);
    if (q.explanation) lines.push(`   التعليل: ${q.explanation}`);
    if (q.userNote && q.userNote.trim()) lines.push(`   ملاحظتي: ${q.userNote.trim()}`);
  });
  downloadFile("ihtibarani-quiz-" + Date.now() + ".txt", lines.join("\n"), "text/plain;charset=utf-8");
  toast("success", "تم تصدير الاختبار كملف نصي.");
}

/* ====== قوائم حفظ الاختبارات (localStorage) ====== */
const LISTS_KEY = "quiz_lists_v1";
const LAST_LIST_KEY = "quiz_save_list";
const MAX_LISTS = 10;
const MAX_ITEMS = 15;
const DEFAULT_LIST_NAME = "قائمة الحفظ";

function uid(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function loadLists() {
  let ls = null;
  try { ls = JSON.parse(store.get(LISTS_KEY) || "null"); } catch {}
  if (ls && Array.isArray(ls.lists) && ls.lists.length) {
    ls.lists.forEach((l) => { if (!Array.isArray(l.items)) l.items = []; });
    if (!ls.lists.some((l) => l.id === "default")) {
      ls.lists.unshift({ id: "default", name: DEFAULT_LIST_NAME, builtin: true, createdAt: Date.now(), items: [] });
    }
    if (!findList(ls, ls.activeListId)) ls.activeListId = "default";
    return ls;
  }
  ls = { v: 1, activeListId: "default", lists: [{ id: "default", name: DEFAULT_LIST_NAME, builtin: true, createdAt: Date.now(), items: [] }] };
  try {
    const old = JSON.parse(store.get("quiz_library") || "[]");
    (Array.isArray(old) ? old : []).forEach((it) => {
      if (!it || !Array.isArray(it.questions) || !it.questions.length) return;
      ls.lists[0].items.push({
        id: String(it.id || uid("i")),
        name: String(it.name || "اختبار محفوظ"),
        createdAt: it.savedAt || Date.now(),
        updatedAt: it.savedAt || Date.now(),
        source: "legacy",
        text: "", analysis: null, progress: null,
        questions: it.questions,
        ctx: String(it.ctx || ""),
        plays: it.plays || 0,
        bestPct: it.bestPct || 0,
        lastPct: null,
      });
    });
  } catch {}
  saveLists(ls);
  return ls;
}

function saveLists(ls) {
  store.set(LISTS_KEY, JSON.stringify(ls));
}

function findList(ls, id) {
  return ls && Array.isArray(ls.lists) ? ls.lists.find((l) => l.id === id) || null : null;
}

function findSavedItem(ref) {
  if (!ref || !ref.listId || !ref.itemId) return null;
  const list = findList(loadLists(), ref.listId);
  return list ? list.items.find((x) => x.id === itemIdFromRef(ref)) || null : null;
}

function itemIdFromRef(ref) {
  return ref ? ref.itemId : null;
}

function withItem(listId, itemId, fn) {
  const ls = loadLists();
  const list = findList(ls, listId);
  if (!list) return false;
  const idx = list.items.findIndex((x) => x.id === itemId);
  if (idx < 0) return false;
  fn(list.items[idx], list, idx);
  saveLists(ls);
  return true;
}

function firstParaSig(analysis) {
  const p = analysis && Array.isArray(analysis.paragraphs) ? analysis.paragraphs[0] : null;
  return p && p.text ? String(p.text).slice(0, 80) : "";
}

function deriveSessionName() {
  if (state.importMeta && state.importMeta.name) return state.importMeta.name;
  return el("input-text").value.trim().slice(0, 42) || "اختبار محفوظ";
}

function fmtShortDate(ts) {
  try { return new Date(ts).toLocaleDateString("ar", { day: "numeric", month: "short", year: "numeric" }); } catch { return ""; }
}

function buildItemFromCurrent(name) {
  const now = Date.now();
  if (state.staticQuestions) {
    return {
      id: uid("i"), name, createdAt: now, updatedAt: now, source: "legacy",
      text: "", analysis: null, progress: null,
      questions: state.staticQuestions.map((q) => ({
        keyword: q.keyword || "", question: q.question, options: [...q.options],
        correctIndex: q.correctIndex, explanation: q.explanation || "",
      })),
      ctx: state.analysis ? state.analysis.context : "",
      plays: 0, bestPct: 0, lastPct: null,
    };
  }
  return {
    id: uid("i"), name, createdAt: now, updatedAt: now, source: "session",
    text: el("input-text").value.trim(),
    analysis: state.analysis,
    progress: snapshotProgress(),
    questions: null, ctx: "",
    plays: 0, bestPct: 0, lastPct: null,
  };
}

function syncSavedItemProgress() {
  if (!state.savedRef || !state.quiz) return;
  const snap = snapshotProgress();
  withItem(state.savedRef.listId, state.savedRef.itemId, (it) => {
    if (snap) {
      it.progress = snap;
      it.updatedAt = snap.savedProgressAt;
    } else if (state.quiz.finished && !state.focusRestore) {
      it.progress = null;
    }
  });
}

function patchResumeSavedRef(ref) {
  const s = loadLastSession();
  if (!s) return;
  s.savedRef = ref || null;
  try { store.set(RESUME_KEY, JSON.stringify(s)); } catch {}
}

function flashSaveButton() {
  const btn = el("btn-save-library");
  if (!btn) return;
  btn.classList.add("saved-flash");
  const label = btn.querySelector(".save-label");
  if (label) {
    const old = label.textContent;
    label.textContent = "محفوظ في القائمة ✓";
    setTimeout(() => { label.textContent = old; btn.classList.remove("saved-flash"); }, 2200);
  } else {
    setTimeout(() => btn.classList.remove("saved-flash"), 2200);
  }
}

/* ====== نافذة الحفظ في قائمة ====== */
let saveModalCtx = { mode: "results" };
let saveModalReturnFocus = null;

function isSaveListOpen() {
  return !el("save-list-overlay").classList.contains("hidden");
}

function openSaveToListModal(mode) {
  if (isSaveListOpen()) return;
  if (mode === "last-session") {
    if (!loadLastSession()) { toast("error", "لا يوجد نص محفوظ لنقله."); return; }
  } else if (!state.analysis && !state.staticQuestions) {
    toast("error", "لا يوجد اختبار لحفظه بعد.");
    return;
  }
  saveModalCtx = { mode };
  el("save-list-title-text").textContent = mode === "last-session" ? "نقل النص المحفوظ إلى قائمة" : "حفظ الاختبار في قائمة";
  el("btn-save-list-confirm").textContent = mode === "last-session" ? "نقل إلى القائمة" : "حفظ في القائمة";
  let prefill = "";
  if (state.savedRef) {
    const cur = findSavedItem(state.savedRef);
    if (cur) prefill = cur.name || "";
  }
  if (!prefill) {
    prefill = mode === "last-session"
      ? ((loadLastSession().text || "").trim().slice(0, 42) || "اختبار محفوظ")
      : deriveSessionName();
  }
  el("save-list-name").value = prefill;
  el("save-list-new-name").value = "";
  el("save-list-new-field").classList.add("hidden");
  renderSaveListOptions();
  saveModalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  el("save-list-overlay").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  try { el("save-list-name").focus(); el("save-list-name").select(); } catch {}
}

function closeSaveToListModal() {
  const ov = el("save-list-overlay");
  if (ov.classList.contains("hidden")) return;
  ov.classList.add("hidden");
  document.body.style.overflow = "";
  if (saveModalReturnFocus && document.contains(saveModalReturnFocus)) {
    try { saveModalReturnFocus.focus(); } catch {}
  }
  saveModalReturnFocus = null;
}

function renderSaveListOptions() {
  const ls = loadLists();
  const wrap = el("save-list-options");
  wrap.innerHTML = "";
  const lastUsed = store.get(LAST_LIST_KEY);
  const prechecked = state.savedRef && findSavedItem(state.savedRef)
    ? state.savedRef.listId
    : (findList(ls, lastUsed) ? lastUsed : "default");
  ls.lists.forEach((l) => {
    const row = document.createElement("label");
    row.className = "list-pick-row";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "save-list-choice";
    input.value = l.id;
    input.checked = l.id === prechecked;
    input.addEventListener("change", () => el("save-list-new-field").classList.add("hidden"));
    const nm = document.createElement("span");
    nm.className = "lpr-name";
    nm.textContent = l.name;
    const ct = document.createElement("span");
    ct.className = "lpr-count";
    ct.textContent = String(l.items.length);
    row.appendChild(input);
    row.appendChild(nm);
    row.appendChild(ct);
    if (l.builtin) {
      const badge = document.createElement("span");
      badge.className = "lpr-badge";
      badge.textContent = "افتراضية";
      row.appendChild(badge);
    }
    wrap.appendChild(row);
  });
  const newRow = document.createElement("label");
  newRow.className = "list-pick-row new";
  const ninput = document.createElement("input");
  ninput.type = "radio";
  ninput.name = "save-list-choice";
  ninput.value = "__new__";
  const nnm = document.createElement("span");
  nnm.className = "lpr-name";
  nnm.textContent = "قائمة جديدة…";
  newRow.appendChild(ninput);
  newRow.appendChild(nnm);
  ninput.addEventListener("change", () => {
    el("save-list-new-field").classList.remove("hidden");
    try { el("save-list-new-name").focus(); } catch {}
  });
  wrap.appendChild(newRow);
}

function confirmSaveToList() {
  const choiceEl = document.querySelector('input[name="save-list-choice"]:checked');
  if (!choiceEl) { toast("error", "اختر قائمة أولًا."); return; }
  const choice = choiceEl.value;
  let targetId;
  if (choice === "__new__") {
    const nm = el("save-list-new-name").value.trim().slice(0, 40);
    if (!nm) { toast("error", "أدخل اسم القائمة الجديدة."); try { el("save-list-new-name").focus(); } catch {} return; }
    const ls0 = loadLists();
    if (ls0.lists.length >= MAX_LISTS) { toast("error", `وصلت إلى الحد الأقصى (${MAX_LISTS} قوائم) — احذف قائمة أولًا.`); return; }
    if (ls0.lists.some((l) => l.name === nm)) { toast("error", "توجد قائمة بهذا الاسم بالفعل."); return; }
    targetId = uid("l");
    ls0.lists.push({ id: targetId, name: nm, createdAt: Date.now(), items: [] });
    saveLists(ls0);
  } else {
    targetId = choice;
  }

  const ls = loadLists();
  const targetList = findList(ls, targetId);
  if (!targetList) { toast("error", "القائمة غير موجودة."); return; }
  const name = el("save-list-name").value.trim().slice(0, 80) || deriveSessionName();

  let item = null;
  if (state.savedRef) {
    for (const l of ls.lists) {
      const idx = l.items.findIndex((x) => x.id === state.savedRef.itemId);
      if (idx >= 0) {
        item = l.items[idx];
        if (l.id !== targetList.id) {
          l.items.splice(idx, 1);
          targetList.items.unshift(item);
        }
        break;
      }
    }
  }

  if (saveModalCtx.mode === "last-session") {
    const s = loadLastSession();
    if (!s) { toast("error", "لا يوجد نص محفوظ لنقله."); return; }
    if (!item) {
      const sig = firstParaSig(s.analysis);
      item = targetList.items.find((x) => x.source === "session" && x.name === name && firstParaSig(x.analysis) === sig) || null;
      if (!item) {
        if (targetList.items.length >= MAX_ITEMS) {
          toast("error", `القائمة «${targetList.name}» ممتلئة (${MAX_ITEMS} اختبار) — احذف عنصرًا أولًا.`);
          return;
        }
        item = { id: uid("i"), createdAt: Date.now(), plays: 0, bestPct: 0, lastPct: null, source: "session", questions: null, ctx: "" };
        targetList.items.unshift(item);
      }
    }
    item.text = s.text || "";
    item.analysis = s.analysis;
    item.progress = s.progress || null;
  } else {
    const built = buildItemFromCurrent(name);
    if (!item) {
      const sig = built.source === "session"
        ? firstParaSig(built.analysis)
        : (built.questions && built.questions[0] ? built.questions[0].question : "");
      item = targetList.items.find((x) => x.name === name && x.source === built.source
        && ((x.source === "session" ? firstParaSig(x.analysis) : (x.questions && x.questions[0] ? x.questions[0].question : "")) === sig)) || null;
      if (!item) {
        if (targetList.items.length >= MAX_ITEMS) {
          toast("error", `القائمة «${targetList.name}» ممتلئة (${MAX_ITEMS} اختبار) — احذف عنصرًا أولًا.`);
          return;
        }
        targetList.items.unshift(built);
        item = built;
      }
    }
    item.text = built.text;
    item.analysis = built.analysis;
    item.progress = built.progress;
    item.questions = built.questions;
    item.ctx = built.ctx;
    item.source = built.source;
  }
  item.name = name;
  item.updatedAt = Date.now();
  state.savedRef = { listId: targetList.id, itemId: item.id };
  store.set(LAST_LIST_KEY, targetList.id);
  saveLists(ls);

  if (saveModalCtx.mode === "last-session") {
    state.savedRef = null;
    clearLastSession();
    closeSaveToListModal();
    renderListsOverview();
    toast("success", `نُقل النص المحفوظ إلى «${targetList.name}» — لن يمحيه إنشاء اختبارات جديدة.`);
    return;
  }
  patchResumeSavedRef(state.savedRef);
  closeSaveToListModal();
  renderListsOverview();
  if (el("screen-lists").classList.contains("active")) renderListsScreen();
  flashSaveButton();
  toast("success", `تم حفظ «${name}» في قائمة «${targetList.name}»${item.progress ? " مع تقدمك الحالي" : ""}.`);
}

/* ====== فتح/استئناف اختبار من القوائم ====== */
async function openLibraryItem(listId, itemId) {
  const list = findList(loadLists(), listId);
  const it = list ? list.items.find((x) => x.id === itemId) : null;
  if (!it) return;
  if (it.source === "legacy") {
    playLegacyItem(listId, it);
    return;
  }
  if (!it.analysis || !Array.isArray(it.analysis.paragraphs) || !it.analysis.paragraphs.length) {
    toast("error", "بيانات هذا الاختبار غير مكتملة — لا يمكن فتحه.");
    return;
  }
  stopTimer();
  stopQuestionTimer(true);
  if (state.quiz && !state.quiz.finished) updateSavedProgress();
  if (state.abortCtrl) { try { state.abortCtrl.abort(); } catch {} }
  state.staticQuestions = null;
  state.importMeta = null;
  state.focusRestore = null;
  state.rendered = null;
  state.regen = null;
  applyAnalysis(it.analysis);
  el("input-text").value = it.text || "";
  updateCharCount();
  const prog = validateProgress(it);
  state.savedRef = { listId, itemId };
  store.set(RESUME_KEY, JSON.stringify({
    text: it.text || "",
    analysis: it.analysis,
    savedAt: it.updatedAt || Date.now(),
    progress: prog ? it.progress : null,
    savedRef: { listId, itemId },
  }));
  if (prog) {
    state.usedKeywords = prog.usedKeywords.map((a) => (Array.isArray(a) ? a.slice() : []));
    state.round = prog.round || 1;
    state.roundPcts = Array.isArray(prog.roundPcts) ? prog.roundPcts.slice() : [];
    await resumeQuizRound(prog);
    toast("success", `استؤنف «${it.name}» من السؤال ${prog.resumeAt + 1} من ${state.activeParagraphs.length} — نقاطك ${state.quiz.score}.`);
  } else {
    if (!el("api-key").value.trim()) {
      showScreen("setup");
      toast("error", "هذا الاختبار بلا تقدم محفوظ — أدخل مفتاح API لتوليد أسئلة جديدة له.");
      el("api-key").focus();
      return;
    }
    state.usedKeywords = it.analysis.paragraphs.map(() => []);
    state.round = 0;
    state.roundPcts = [];
    state.abortCtrl = new AbortController();
    await beginRound();
    toast("info", `بدأ «${it.name}» — جولة جديدة بأسئلة جديدة.`);
  }
}

function playLegacyItem(listId, it) {
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
    toast("error", "بيانات هذا الاختبار غير سليمة — حُذف من القائمة.");
    deleteListItem(listId, it.id, true);
    return;
  }
  startImported(qs, it.name || "اختبار محفوظ", it.ctx, false, it.id);
  state.savedRef = { listId, itemId: it.id };
  toast("info", `بدأ اختبار «${it.name || "محفوظ"}» من قوائمك — بالتوفيق!`);
}

function exportListItem(listId, itemId) {
  const list = findList(loadLists(), listId);
  const it = list ? list.items.find((x) => x.id === itemId) : null;
  if (!it) return;
  let questions = null;
  if (it.source === "legacy" && Array.isArray(it.questions)) questions = it.questions;
  else if (it.progress && Array.isArray(it.progress.questions)) questions = it.progress.questions.map((x) => x.q);
  if (!questions || !questions.length) {
    toast("error", "لا توجد أسئلة مولّدة لتصديرها بعد — ابدأ الاختبار أولًا ثم صدّر.");
    return;
  }
  const data = {
    app: "اختبرني",
    exportedAt: new Date().toISOString(),
    context: it.ctx || (it.analysis ? it.analysis.context : ""),
    questions: questions.map((q, i) => ({
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
  toast("success", "تم تصدير الاختبار من القائمة.");
}

function deleteListItem(listId, itemId, silent) {
  const ls = loadLists();
  const list = findList(ls, listId);
  const it = list ? list.items.find((x) => x.id === itemId) : null;
  if (!it) return;
  if (!silent && !confirm(`هل تريد حذف «${it.name}» من القائمة؟ سيُمحى تقدمه المحفوظ أيضًا.`)) return;
  list.items = list.items.filter((x) => x.id !== itemId);
  if (state.savedRef && state.savedRef.itemId === itemId) {
    state.savedRef = null;
    patchResumeSavedRef(null);
  }
  saveLists(ls);
  renderListsScreen();
  renderListsOverview();
  if (!silent) toast("info", "تم حذف الاختبار من القائمة.");
}

function moveItemTo(fromListId, itemId, toListId) {
  if (fromListId === toListId) return;
  const ls = loadLists();
  const from = findList(ls, fromListId);
  const to = findList(ls, toListId);
  if (!from || !to) return;
  const idx = from.items.findIndex((x) => x.id === itemId);
  if (idx < 0) return;
  if (to.items.length >= MAX_ITEMS) {
    toast("error", `القائمة «${to.name}» ممتلئة (${MAX_ITEMS} اختبار) — احذف عنصرًا أولًا.`);
    return;
  }
  const [it] = from.items.splice(idx, 1);
  to.items.unshift(it);
  if (state.savedRef && state.savedRef.itemId === itemId) {
    state.savedRef.listId = toListId;
    patchResumeSavedRef(state.savedRef);
  }
  saveLists(ls);
  renderListsScreen();
  renderListsOverview();
  toast("success", `نُقل «${it.name}» إلى «${to.name}».`);
}

function reorderListItem(listId, itemId, dir) {
  const ls = loadLists();
  const list = findList(ls, listId);
  if (!list) return;
  const i = list.items.findIndex((x) => x.id === itemId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.items.length) return;
  const [x] = list.items.splice(i, 1);
  list.items.splice(j, 0, x);
  saveLists(ls);
  renderListsScreen();
}

/* ====== تصدير واستعادة النسخة الاحتياطية الكاملة ====== */
function exportFullBackup() {
  const backup = {
    app: "اختبرني — نسخة احتياطية شاملة",
    version: "2.0",
    exportedAt: new Date().toISOString(),
    lists: loadLists(),
    history: loadHistory(),
    achievements: loadAchievements(),
    lastSession: loadLastSession(),
  };
  downloadFile("ihtibarani-backup-" + new Date().toISOString().slice(0, 10) + ".json", JSON.stringify(backup, null, 2), "application/json;charset=utf-8");
  toast("success", "تم تصدير النسخة الاحتياطية الكاملة بنجاح.");
}

async function importFullBackup(file) {
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    toast("error", "ملف النسخة الاحتياطية غير صالح.");
    return;
  }
  if (!data || typeof data !== "object" || (!data.lists && !data.history)) {
    toast("error", "الملف المختار لا يبدو نسخة احتياطية لتطبيق اختبرني.");
    return;
  }
  if (data.lists && Array.isArray(data.lists.lists)) {
    saveLists(data.lists);
  }
  if (Array.isArray(data.history)) {
    store.set("quiz_history", JSON.stringify(data.history.slice(0, 20)));
  }
  if (data.achievements && typeof data.achievements === "object") {
    saveAchievements({ ...loadAchievements(), ...data.achievements });
  }
  if (data.lastSession && data.lastSession.analysis) {
    store.set(RESUME_KEY, JSON.stringify(data.lastSession));
  }
  renderListsScreen();
  renderListsOverview();
  renderHistory();
  renderResume();
  toast("success", "تمت استعادة النسخة الاحتياطية بنجاح!");
}

/* ====== شاشة القوائم ====== */
const listsUi = { tabId: null };

function currentListId(ls) {
  const want = listsUi.tabId || ls.activeListId || "default";
  return findList(ls, want) ? want : ls.lists[0].id;
}

function renderListsScreen() {
  const ls = loadLists();
  const tabId = currentListId(ls);
  ls.activeListId = tabId;
  saveLists(ls);
  const list = findList(ls, tabId);
  if (!list) return;
  const total = ls.lists.reduce((n, l) => n + l.items.length, 0);
  el("lists-total").textContent = quizCountWord(total);

  const tabs = el("lists-tabs");
  tabs.innerHTML = "";
  ls.lists.forEach((l) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "list-tab" + (l.id === tabId ? " active" : "");
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", l.id === tabId ? "true" : "false");
    const nm = document.createElement("span");
    nm.className = "list-tab-name";
    nm.textContent = l.name;
    const ct = document.createElement("span");
    ct.className = "list-tab-count";
    ct.textContent = String(l.items.length);
    b.appendChild(nm);
    b.appendChild(ct);
    b.addEventListener("click", () => { listsUi.tabId = l.id; renderListsScreen(); });
    tabs.appendChild(b);
  });

  el("btn-list-rename").classList.toggle("hidden", !!list.builtin);
  el("btn-list-delete").classList.toggle("hidden", !!list.builtin);
  el("lists-active-hint").textContent = list.builtin
    ? `القائمة الافتراضية — لا تُحذف · ${quizCountWord(list.items.length)}.`
    : `${quizCountWord(list.items.length)} · أُنشئت ${fmtShortDate(list.createdAt)} — يمكن تعديل اسمها أو حذفها.`;

  const searchVal = String((el("lists-search") && el("lists-search").value) || "").trim().toLowerCase();
  const filteredItems = list.items.filter((it) => {
    if (!searchVal) return true;
    const hay = [it.name || "", it.text || "", it.ctx || "", it.analysis ? it.analysis.context : ""].join(" ").toLowerCase();
    return hay.includes(searchVal);
  });

  const ul = el("lists-items");
  const empty = el("lists-empty");
  ul.innerHTML = "";
  if (!filteredItems.length) {
    empty.classList.remove("hidden");
    ul.classList.add("hidden");
    return;
  }
  empty.classList.add("hidden");
  ul.classList.remove("hidden");
  filteredItems.forEach((it, idx) => ul.appendChild(buildListItemRow(list, it, idx)));
}

function addChip(parent, text, extra) {
  const c = document.createElement("span");
  c.className = "chip" + (extra ? " " + extra : "");
  c.textContent = text;
  parent.appendChild(c);
  return c;
}

function buildListItemRow(list, it, idx) {
  const li = document.createElement("li");
  li.className = "lib-item";
  li.style.animationDelay = Math.min(idx * 45, 400) + "ms";

  const info = document.createElement("div");
  info.className = "lib-info";

  const name = document.createElement("span");
  name.className = "lib-name";
  name.textContent = it.name || "اختبار محفوظ";
  name.title = "اضغط لفتح الاختبار";
  name.addEventListener("click", () => openLibraryItem(list.id, it.id));

  const meta = document.createElement("div");
  meta.className = "lib-meta";
  const count = it.source === "legacy"
    ? (it.questions || []).length
    : (it.analysis && Array.isArray(it.analysis.paragraphs) ? it.analysis.paragraphs.length : 0);
  addChip(meta, quizCountWord(count), "");
  const prog = it.source === "session" ? validateProgress(it) : null;
  if (prog) {
    addChip(meta, `استئناف: السؤال ${prog.resumeAt + 1} من ${prog.activeCount}${prog.score ? " · نقاط " + prog.score : ""}`, "ok");
  }
  if (it.bestPct) addChip(meta, "الأفضل: " + it.bestPct + "%", "ok");
  if (it.lastPct != null) addChip(meta, "الأخيرة: " + it.lastPct + "%", "");
  addChip(meta, it.plays ? playCountWord(it.plays) : "لم يُلعب بعد", "");
  if (it.source === "legacy") addChip(meta, "أسئلة فقط", "");
  addChip(meta, fmtShortDate(it.createdAt), "lib-date");

  info.appendChild(name);
  info.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "lib-actions";

  const open = document.createElement("button");
  open.className = "btn primary sm";
  open.type = "button";
  open.textContent = prog ? "استئناف" : "ابدأ";
  open.setAttribute("aria-label", (prog ? "استئناف " : "بدء اختبار ") + (it.name || "المحفوظ"));
  open.addEventListener("click", () => openLibraryItem(list.id, it.id));
  actions.appendChild(open);

  const hasQuestions = (it.source === "legacy" && (it.questions || []).length)
    || (it.progress && Array.isArray(it.progress.questions) && it.progress.questions.length);
  if (hasQuestions) {
    const exp = document.createElement("button");
    exp.className = "btn ghost sm";
    exp.type = "button";
    exp.textContent = "تصدير";
    exp.setAttribute("aria-label", "تصدير " + (it.name || "الاختبار") + " بصيغة JSON");
    exp.addEventListener("click", () => exportListItem(list.id, it.id));
    actions.appendChild(exp);
  }

  const others = loadLists().lists.filter((l) => l.id !== list.id);
  if (others.length) {
    const mv = document.createElement("select");
    mv.className = "move-select";
    mv.setAttribute("aria-label", "نقل الاختبار إلى قائمة أخرى");
    const ph = document.createElement("option");
    ph.value = "";
    ph.textContent = "نقل إلى…";
    ph.disabled = true;
    ph.selected = true;
    mv.appendChild(ph);
    others.forEach((l) => {
      const o = document.createElement("option");
      o.value = l.id;
      o.textContent = l.name + " (" + l.items.length + ")";
      mv.appendChild(o);
    });
    mv.addEventListener("change", () => {
      if (mv.value) moveItemTo(list.id, it.id, mv.value);
      mv.value = "";
    });
    actions.appendChild(mv);
  }

  const ren = document.createElement("button");
  ren.className = "icon-btn lib-ren";
  ren.type = "button";
  ren.title = "إعادة تسمية";
  ren.setAttribute("aria-label", "إعادة تسمية " + (it.name || "الاختبار"));
  ren.innerHTML = PENCIL_ICON;
  ren.addEventListener("click", () => startItemInlineRename(li, list.id, it.id));
  actions.appendChild(ren);

  const up = document.createElement("button");
  up.className = "icon-btn lib-move";
  up.type = "button";
  up.title = "تقديم في القائمة";
  up.setAttribute("aria-label", "تقديم " + (it.name || "الاختبار") + " في القائمة");
  up.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="18 15 12 9 6 15"/></svg>';
  up.disabled = idx === 0;
  up.addEventListener("click", () => reorderListItem(list.id, it.id, -1));
  actions.appendChild(up);

  const down = document.createElement("button");
  down.className = "icon-btn lib-move";
  down.type = "button";
  down.title = "تأخير في القائمة";
  down.setAttribute("aria-label", "تأخير " + (it.name || "الاختبار") + " في القائمة");
  down.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
  down.disabled = idx === list.items.length - 1;
  down.addEventListener("click", () => reorderListItem(list.id, it.id, 1));
  actions.appendChild(down);

  const del = document.createElement("button");
  del.className = "icon-btn lib-del";
  del.type = "button";
  del.setAttribute("aria-label", "حذف " + (it.name || "الاختبار") + " من القائمة");
  del.title = "حذف";
  del.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
  del.addEventListener("click", () => deleteListItem(list.id, it.id));
  actions.appendChild(del);

  li.appendChild(info);
  li.appendChild(actions);
  return li;
}

function renderListsOverview() {
  const wrap = el("lists-overview");
  if (!wrap) return;
  const ls = loadLists();
  const total = ls.lists.reduce((n, l) => n + l.items.length, 0);
  el("lists-overview-total").textContent = quizCountWord(total);
  wrap.innerHTML = "";
  ls.lists.forEach((l) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "list-pill";
    b.setAttribute("aria-label", `فتح قائمة ${l.name} (${quizCountWord(l.items.length)})`);
    const nm = document.createElement("span");
    nm.textContent = l.name;
    const ct = document.createElement("span");
    ct.className = "list-pill-count" + (l.items.length ? "" : " zero");
    ct.textContent = String(l.items.length);
    b.appendChild(nm);
    b.appendChild(ct);
    b.addEventListener("click", () => {
      listsUi.tabId = l.id;
      renderListsScreen();
      showScreen("lists");
    });
    wrap.appendChild(b);
  });
}

function startItemInlineRename(li, listId, itemId) {
  const nameSpan = li.querySelector(".lib-name");
  if (!nameSpan || li.querySelector(".lib-rename-input")) return;
  const l0 = findList(loadLists(), listId);
  const it0 = l0 ? l0.items.find((x) => x.id === itemId) : null;
  if (!it0) return;
  const oldName = it0.name || "";
  let done = false;

  const finish = (saveChanges) => {
    if (done) return;
    done = true;
    if (saveChanges) {
      const next = (input.value || "").trim().slice(0, 80) || oldName;
      if (next !== oldName) {
        withItem(listId, itemId, (it) => { it.name = next; it.updatedAt = Date.now(); });
        toast("success", `تم تحديث الاسم إلى «${next}».`);
      }
    }
    renderListsScreen();
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

/* ====== نافذة اسم القائمة ====== */
let listNameCtx = { mode: "create", listId: null };
let listNameReturnFocus = null;

function isListNameOpen() {
  return !el("list-name-overlay").classList.contains("hidden");
}

function openListNameModal(mode, listId) {
  if (isListNameOpen()) return;
  listNameCtx = { mode, listId: listId || null };
  const isRename = mode === "rename";
  el("list-name-title-text").textContent = isRename ? "إعادة تسمية القائمة" : "قائمة جديدة";
  el("btn-list-name-confirm").textContent = isRename ? "حفظ الاسم" : "إنشاء";
  let prefill = "";
  if (isRename) {
    const l = findList(loadLists(), listId);
    prefill = l ? l.name : "";
  }
  el("list-name-input").value = prefill;
  listNameReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  el("list-name-overlay").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  try { el("list-name-input").focus(); el("list-name-input").select(); } catch {}
}

function closeListNameModal() {
  const ov = el("list-name-overlay");
  if (ov.classList.contains("hidden")) return;
  ov.classList.add("hidden");
  document.body.style.overflow = "";
  if (listNameReturnFocus && document.contains(listNameReturnFocus)) {
    try { listNameReturnFocus.focus(); } catch {}
  }
  listNameReturnFocus = null;
}

function confirmListName() {
  const name = el("list-name-input").value.trim().slice(0, 40);
  if (!name) { toast("error", "أدخل اسم القائمة."); try { el("list-name-input").focus(); } catch {} return; }
  const ls = loadLists();
  if (listNameCtx.mode === "create") {
    if (ls.lists.length >= MAX_LISTS) { toast("error", `وصلت إلى الحد الأقصى (${MAX_LISTS} قوائم) — احذف قائمة أولًا.`); return; }
    if (ls.lists.some((l) => l.name === name)) { toast("error", "توجد قائمة بهذا الاسم بالفعل."); return; }
    const l = { id: uid("l"), name, createdAt: Date.now(), items: [] };
    ls.lists.push(l);
    listsUi.tabId = l.id;
    saveLists(ls);
    closeListNameModal();
    renderListsScreen();
    renderListsOverview();
    toast("success", `أُنشئت قائمة «${name}» — أضف إليها اختباراتك.`);
  } else {
    const l = findList(ls, listNameCtx.listId);
    if (!l || l.builtin) { closeListNameModal(); return; }
    if (l.name !== name && ls.lists.some((x) => x.id !== l.id && x.name === name)) {
      toast("error", "توجد قائمة أخرى بهذا الاسم.");
      return;
    }
    l.name = name;
    saveLists(ls);
    closeListNameModal();
    renderListsScreen();
    renderListsOverview();
    toast("success", `تم تحديث اسم القائمة إلى «${name}».`);
  }
}

function deleteActiveList() {
  const ls = loadLists();
  const list = findList(ls, currentListId(ls));
  if (!list || list.builtin) return;
  if (!confirm(`حذف قائمة «${list.name}» وكل اختباراتها (${list.items.length})؟ لا يمكن التراجع.`)) return;
  ls.lists = ls.lists.filter((l) => l.id !== list.id);
  if (!findList(ls, ls.activeListId)) ls.activeListId = "default";
  listsUi.tabId = "default";
  if (state.savedRef && state.savedRef.listId === list.id) {
    state.savedRef = null;
    patchResumeSavedRef(null);
  }
  saveLists(ls);
  renderListsScreen();
  renderListsOverview();
  toast("info", `حُذفت قائمة «${list.name}» وكل ما فيها.`);
}

function isOverlayVisibleById(id) {
  const n = el(id);
  return !!n && !n.classList.contains("hidden");
}

function trapOverlayTab(id, e) {
  const focusables = [...el(id).querySelectorAll("button, input, select, [tabindex='0']")]
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
      html += `<li><span class="ps-letter">${letters[oi] || (oi + 1)}</span> ${escHtml(o)}</li>`;
    });
    html += "</ul></li>";
  });
  html += "</ol>";
  html += '<section class="ps-key"><h2>مفتاح الإجابات والتعليل</h2><ol>';
  lastResults.answers.forEach((q, i) => {
    html += `<li><strong>${i + 1}) ${escHtml(q.options[q.correctIndex])}</strong>${q.explanation ? `<p class="ps-explain">${escHtml(q.explanation)}</p>` : ""}${q.userNote && q.userNote.trim() ? `<p class="ps-explain">ملاحظة: ${escHtml(q.userNote.trim())}</p>` : ""}</li>`;
  });
  html += "</ol></section>";
  html += '<footer class="ps-foot">أُنشئ بواسطة «اختبرني» — الإصدار 2.6</footer>';
  el("print-sheet").innerHTML = html;
  renderMathInTextNodes(el("print-sheet"));
}

function printQuiz() {
  if (!lastResults) return;
  buildPrintSheet();
  toast("info", "افتحت نافذة الطباعة — اختر «حفظ كملف PDF» من خيارات الطابعة.");
  window.print();
}

/* ====== استيراد اختبار من ملف JSON ====== */
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
      qType: raw.qType || (options.length === 2 ? "tf" : "mcq"),
      keyword: String(raw.keyword || "").trim(),
      question,
      options,
      correctIndex: ci,
      explanation: String(raw.explanation || "").trim(),
      userAnswer: null,
      correct: null,
      starred: !!raw.starred,
      userNote: String(raw.userNote || ""),
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

function startImported(questions, metaName, context, isLink, libId) {
  stopTimer();
  stopQuestionTimer(true);
  if (state.abortCtrl) { try { state.abortCtrl.abort(); } catch {} }
  state.staticQuestions = questions;
  state.importMeta = { name: metaName, link: !!isLink, libId: libId || null };
  state.savedRef = null;
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
        qType: options.length === 2 ? "tf" : "mcq",
        keyword: String(raw.k || "").trim(),
        question,
        options,
        correctIndex: ci,
        explanation: String(raw.e || "").trim(),
        userAnswer: null,
        correct: null,
        starred: false,
        userNote: "",
      });
    }
    return out.length ? out : null;
  }
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
  toast("success", `وصل اختبار مشترك من رابط — ${quizCountWord(questions.length)}. بالتوفيق!`);
  return true;
}

/* ====== بطاقات المراجعة (Flashcards) ====== */
const cardsState = { cards: [], order: [], pos: 0, recallOn: false, known: [], review: [] };

function buildFlashcards() {
  const cards = [];
  if (state.staticQuestions) {
    state.staticQuestions.forEach((q) => {
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

function looksLikePassageHeading(raw) {
  const t = String(raw || "").trim();
  if (!t) return false;
  if (/^#{1,6}\s+/.test(t)) return true;
  if (/[:：]$/.test(t)) return t.length <= 120;
  if (/[.!?…؟،؛]$/.test(t)) return false;
  return t.length <= 80;
}

/* ====== وحدة Markdown لعرض الفقرة — CommonMark + GFM (جداول/مهام/حواشي/إيموجي/روابط) + KaTeX + Mermaid ======
   النص الأصلي يبقى بصيغة Markdown في التخزين، والتحويل يحدث لحظة العرض فقط.
   إن تعذر تحميل مكتبات العرض (vendor) يعود العرض تلقائيًا إلى المسار النصي القديم دون أي فقد. */
function looksLikeMarkdownText(t) {
  const s = String(t || "");
  if (!s) return false;
  if (/(^|\n)[ \t]*#{1,6}[ \t]+\S/.test(s)) return true;                /* عناوين */
  if (/(^|\n)[ \t]*(>|[-*+]|\d{1,3}[.)])[ \t]+\S/.test(s)) return true; /* قوائم/اقتباسات */
  if (/```|~~~/.test(s)) return true;                                    /* أسيطة كود/mermaid */
  if ((s.match(/\|/g) || []).length >= 2) return true;                   /* جداول محتملة */
  if (/\*\*[^*\n]+\*\*|(^|\W)__[^_\n]+__/.test(s)) return true;          /* عريض */
  if (/(^|\W)~~[^~\n]+~~/.test(s)) return true;                          /* مشطوب */
  if (/\[[^\]\n]{1,200}\]\([^)\n]{1,500}\)/.test(s)) return true;        /* روابط */
  if (/<https?:\/\/\S+>|(www\.)\S{5,}/.test(s)) return true;             /* روابط تلقائية */
  if (/(^|\n)[ \t]*[-*+][ \t]+\[[ xX]\]/.test(s)) return true;           /* قوائم مهام */
  if (/\$\$[^$]+\$\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]/.test(s)) return true; /* رياضيات */
  if (/(^|\n)[ \t]*\[\^[^\]\n]+\]/.test(s)) return true;                 /* حواشي سفلية */
  if (/(^|\n)[ \t]*\[[^\]\n]+\]:[ \t]*\S/.test(s)) return true;          /* روابط مرجعية */
  if (/(^|\n)[ \t]*:{1,2}[a-z0-9_+-]+:{1,2}/i.test(s)) return true;      /* إيموجي بصيغة :name: */
  return false;
}

/* فاصل GFM قياسي بعد الترويسة — يدعم محاذاة :--- :---: ---: إن وُجدت في الأصل */
function mdIsTableSeparator(line) {
  return /^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/.test(line) && line.includes("|");
}

/* جداول متساهلة: إن كتب المستخدم صفوف أنابيب متساوية دون فاصل GFM (كالمثال «اللغة| الاستخدام| المستوى»)
   نُدرج فاصلًا افتراضيًا بعد أول سطر حتى تُعرض كجدول حقيقي — خارج أسيطة الكود فقط.
   ملاحظة: جدول GFM القياسي (ترويسة + فاصل) يُنسخ حرفيًا دون أي فاصل مزيف داخله. */
function mdInjectLenientTables(lines) {
  const isFence = (l) => /^[ \t]*(```|~~~)/.test(l);
  const pipeCount = (l) => (l.match(/\|/g) || []).length;
  const out = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isFence(line)) { inFence = !inFence; out.push(line); continue; }
    if (inFence) { out.push(line); continue; }
    /* جدول GFM قياسي (ترويسة يليها فاصل): انسخ الكتلة كاملة كما هي — إصلاح الفاصل الوهمي */
    if (line.includes("|") && !mdIsTableSeparator(line) &&
        i + 1 < lines.length && mdIsTableSeparator(lines[i + 1])) {
      out.push(line);
      out.push(lines[i + 1]);
      i += 2;
      while (i < lines.length && lines[i].includes("|") && !isFence(lines[i]) && !mdIsTableSeparator(lines[i])) {
        out.push(lines[i]);
        i++;
      }
      i--; /* يُعوّض في زيادة التكرار التالية */
      continue;
    }
    out.push(line);
    if (!line.includes("|") || mdIsTableSeparator(line)) continue;
    if (/^[ \t]*(>|#{1,6}[ \t]|[-*+][ \t]+|\d{1,3}[.)][ \t]+)/.test(line)) continue;
    const next = lines[i + 1];
    if (next === undefined || !next.includes("|") || mdIsTableSeparator(next)) continue;
    const cols = pipeCount(line);
    if (cols < 1) continue;
    let end = i + 1;
    while (end < lines.length && lines[end].includes("|") && !isFence(lines[end]) &&
      pipeCount(lines[end]) === cols && !mdIsTableSeparator(lines[end])) end++;
    if (end - (i + 1) >= 1) {
      out.push("|" + new Array(cols + 1).fill(" --- ").join("|") + "|");
      /* انقل الصفوف المكتشفة كما هي (ستعالج في الدورة التالية من الحلقة الخارجية) */
      for (let k = i + 1; k < end; k++) out.push(lines[k]);
      i = end - 1;
    }
  }
  return out;
}

function mdPreprocessSource(text) {
  const src = String(text || "").replace(/\r\n?/g, "\n");
  return mdInjectLenientTables(src.split("\n")).join("\n");
}

/* حجب مقاطع الرياضيات قبل محلل Markdown حتى لا تفسدها قواعده:
   \( و\[ تُعامل كـ escape فيُحذف الشرط، و| داخل $|x|$ يفسد عد أعمدة الجداول.
   نستبدلها مؤقتًا برموز بديلة محايدة ثم نعيد النص الأصلي بعد التصيير.
   كتل الكود (``` أو ~~~) مستبعدة من الحجب. */
const MATH_SCAN_G = /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$[^$\n]+?\$/g;

function mdExtractMath(src) {
  const store = [];
  const parts = String(src || "").split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$))/);
  const masked = parts.map((part, idx) => {
    if (idx % 2 === 1) return part; /* كتلة كود — دون تعديل */
    return part.replace(MATH_SCAN_G, (m) => {
      store.push(m);
      return "@@KTMATH" + (store.length - 1) + "@@";
    });
  }).join("");
  return { masked, store };
}

/* استعادة نصوص الرياضيات المحجوبة داخل عقد DOM النصية قبل تشغيل KaTeX auto-render */
function mdRestoreMathText(root, store) {
  if (!store || !store.length || !root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      return n.nodeValue && n.nodeValue.indexOf("@@KTMATH") !== -1 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const targets = [];
  let n;
  while ((n = walker.nextNode())) targets.push(n);
  targets.forEach((node) => {
    const frag = document.createDocumentFragment();
    node.nodeValue.split(/(@@KTMATH\d+@@)/).forEach((part) => {
      const m = part.match(/^@@KTMATH(\d+)@@$/);
      if (m) frag.appendChild(document.createTextNode(store[Number(m[1])] || ""));
      else if (part) frag.appendChild(document.createTextNode(part));
    });
    node.parentNode.replaceChild(frag, node);
  });
}

let _mdParser = null;
function ensureMarkdownParser() {
  if (_mdParser !== null) return _mdParser;
  const MarkdownIt = window.markdownit;
  if (typeof MarkdownIt !== "function") { _mdParser = false; return false; }
  try {
    const p = new MarkdownIt({
      html: false,      /* أمان: HTML خام ممنوع — يُهرَّب كنص */
      linkify: true,    /* روابط تلقائية */
      breaks: true,     /* سطر واحد = فاصل سطر (يحافظ على بنية الفقرات القديمة) */
      typographer: false,
    });
    if (typeof window.markdownitFootnote === "function") p.use(window.markdownitFootnote);
    if (typeof window.markdownitTaskLists === "function") p.use(window.markdownitTaskLists, { enabled: false, label: true });
    if (typeof window.markdownitEmoji === "function") p.use(window.markdownitEmoji);
    const defLink = p.renderer.rules.link_open;
    p.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
      tokens[idx].attrSet("target", "_blank");
      tokens[idx].attrSet("rel", "noopener noreferrer");
      return defLink ? defLink(tokens, idx, opts, env, self) : self.renderToken(tokens, idx, opts);
    };
    _mdParser = p;
    return p;
  } catch (e) {
    console.warn("[Markdown] parser init failed", e);
    _mdParser = false;
    return false;
  }
}

/* اتجاه كل كتلة حسب أول حرف قوي (دعم العربية/الإنجليزية/المختلطة) */
function applyMarkdownDirection(root) {
  root.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, blockquote, td, th, figcaption, dt, dd, .footnotes").forEach((b) => {
    b.setAttribute("dir", "auto");
  });
  root.querySelectorAll("pre").forEach((c) => c.setAttribute("dir", "ltr"));
}

/* جداول: غلاف بتمرير أفقي دون تجاوز الحاوية + قابلية تمرير بلوحة المفاتيح */
function wrapMarkdownTables(root) {
  root.querySelectorAll("table").forEach((tb) => {
    if (tb.parentElement && tb.parentElement.classList.contains("md-table-wrap")) return;
    const w = document.createElement("div");
    w.className = "md-table-wrap";
    w.setAttribute("role", "region");
    w.setAttribute("aria-label", "جدول — يمكن تمريره أفقيًا");
    w.setAttribute("tabindex", "0");
    tb.setAttribute("dir", "auto");
    tb.parentNode.insertBefore(w, tb);
    w.appendChild(tb);
  });
}

/* صور: تحميل مؤجل + بديل نصي أنيق عند تعذر التحميل */
function enhanceMarkdownMedia(root) {
  root.querySelectorAll("img").forEach((img) => {
    img.loading = "lazy";
    img.decoding = "async";
    img.addEventListener("error", () => {
      const span = document.createElement("span");
      span.className = "md-img-fallback";
      span.textContent = "🖼️ " + (img.getAttribute("alt") || "صورة غير متاحة");
      img.replaceWith(span);
    }, { once: true });
  });
}

/* تمييز الكلمة المفتاحية داخل DOM المُصيَّر (يحافظ على وظيفة التمييز القديمة) */
function highlightKeywordInMarkdown(root, keyword) {
  const kw = String(keyword || "").trim();
  if (!kw) return;
  const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let testRe;
  try { testRe = new RegExp(esc); } catch { return; }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const v = node.nodeValue;
      if (!v || !v.trim()) return NodeFilter.FILTER_REJECT;
      const p = node.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      if (p.closest("code, pre, .katex, .md-mermaid, mark, script, style, a.md-no-hl")) return NodeFilter.FILTER_REJECT;
      return testRe.test(v) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const targets = [];
  while (walker.nextNode()) targets.push(walker.currentNode);
  targets.forEach((node) => {
    const text = node.nodeValue;
    const re = new RegExp(esc, "g");
    const frag = document.createDocumentFragment();
    let last = 0, m, hits = 0;
    while ((m = re.exec(text)) && hits < 50) {
      if (!m[0].length) { re.lastIndex++; continue; }
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const mark = document.createElement("mark");
      mark.className = "kw-hl";
      mark.textContent = m[0];
      frag.appendChild(mark);
      last = m.index + m[0].length;
      hits++;
    }
    if (!hits) return;
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  });
}

/* استخراج أسيطة ```mermaid إلى حاويات تُرسم لاحقًا (تحميل Mermaid عند الحاجة فقط) */
function collectMermaidBlocks(root) {
  root.querySelectorAll("pre > code").forEach((code) => {
    const isMermaid = [...code.classList].some((c) => /^(language|lang)-mermaid$/i.test(c));
    if (!isMermaid) return;
    const pre = code.parentElement;
    const block = document.createElement("div");
    block.className = "md-mermaid";
    block.setAttribute("data-code", code.textContent);
    block.textContent = "⏳ جاري رسم المخطط…";
    pre.replaceWith(block);
  });
}

let _mermaidLoading = null;
function ensureMermaidLib() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (_mermaidLoading) return _mermaidLoading;
  _mermaidLoading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "vendor/mermaid/mermaid.min.js";
    s.async = true;
    s.onload = () => {
      try {
        const dark = document.documentElement.getAttribute("data-theme") === "dark";
        window.mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: dark ? "dark" : "default",
          fontFamily: "Cairo, sans-serif",
        });
        resolve(window.mermaid);
      } catch (e) { reject(e); }
    };
    s.onerror = () => { _mermaidLoading = null; reject(new Error("تعذر تحميل Mermaid")); };
    document.head.appendChild(s);
  });
  return _mermaidLoading;
}

function mermaidFallback(block) {
  block.classList.add("fail");
  block.innerHTML = "";
  const pre = document.createElement("pre");
  pre.className = "md-code";
  pre.setAttribute("dir", "ltr");
  pre.textContent = block.getAttribute("data-code") || "";
  block.appendChild(pre);
}

async function renderMermaidBlocks(root) {
  const blocks = [...root.querySelectorAll(".md-mermaid[data-code]")].filter((b) => !b.dataset.rendered);
  if (!blocks.length) return;
  let mm;
  try {
    mm = await ensureMermaidLib();
  } catch (e) {
    console.warn("[Mermaid]", e);
    blocks.forEach(mermaidFallback);
    return;
  }
  for (const block of blocks) {
    block.dataset.rendered = "1";
    const code = block.getAttribute("data-code") || "";
    try {
      const { svg } = await mm.render("mmd-" + Date.now() + "-" + Math.floor(Math.random() * 1e6), code);
      block.innerHTML = svg;
      block.classList.add("ok");
    } catch (err) {
      console.warn("[Mermaid] render", err);
      mermaidFallback(block);
    }
  }
}

/* المعادلات الرياضية — KaTeX auto-render على DOM المُعقّم */
function renderMarkdownMath(root) {
  if (typeof window.renderMathInElement !== "function") return;
  try {
    window.renderMathInElement(root, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "\\[", right: "\\]", display: true },
        { left: "\\(", right: "\\)", display: false },
        { left: "$", right: "$", display: false },
      ],
      ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code", "option"],
      ignoredClasses: ["md-mermaid", "md-code"],
      throwOnError: false,
    });
  } catch (e) { console.warn("[KaTeX]", e); }
}

/* =========================================================
   وحدة المعادلات الرياضية العامة (LaTeX/KaTeX) — في كل واجهات الاختبار:
   نص السؤال، الخيارات، التعليل، التلميح، قائمة المراجعة، بطاقات الكلمات،
   دليل الدراسة، وورقة الطباعة. النص الأصلي يبقى محفوظًا كما هو في التخزين،
   والتصيير يحدث لحظة العرض فقط. إن لم تتوفر KaTeX يبقى النص حرفيًا كما هو.
   ========================================================= */
const MATH_SCAN_RE = /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$[^$\n]+?\$/;

function hasMathSyntax(text) {
  return MATH_SCAN_RE.test(String(text || ""));
}

function katexReady() {
  return typeof window.katex === "object" && window.katex !== null && typeof window.katex.render === "function";
}

/* يقطع النص إلى مقاطع متتالية (رياضيات / نص عادي) — الأولوية: $$ ثم \[ \] ثم \( \) ثم $ */
function splitMathSegments(text) {
  const src = String(text || "");
  const segs = [];
  const re = /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$[^$\n]+?\$/g;
  let last = 0, m;
  while ((m = re.exec(src))) {
    if (m.index > last) segs.push({ math: false, text: src.slice(last, m.index) });
    const raw = m[0];
    let tex = raw;
    let display = false;
    if (raw.startsWith("$$")) { tex = raw.slice(2, -2); display = true; }
    else if (raw.startsWith("\\[")) { tex = raw.slice(2, -2); display = true; }
    else if (raw.startsWith("\\(")) { tex = raw.slice(2, -2); display = false; }
    else {
      tex = raw.slice(1, -1);
      display = false;
      /* قاعدة أمان $: لا يبدأ محتوى المعادلة ولا ينتهي بمسافة —
         يمنع التهام رموز الدولار في نص عادي مثل «السعر 5$ والخصم 10$»
         (النص السابق للمطابقة أُصدر فعليًا في السطر الذي قبل هذا الفرع) */
      if (/^\s|\s$/.test(tex)) {
        segs.push({ math: false, text: raw });
        last = m.index + raw.length;
        continue;
      }
    }
    segs.push({ math: true, tex: tex.trim(), display });
    last = m.index + raw.length;
  }
  if (last < src.length) segs.push({ math: false, text: src.slice(last) });
  return segs;
}

/* تصيير مقطع LaTeX واحد عبر KaTeX — دون innerHTML لأي نص خارجي (آمن) */
function katexSpan(tex, displayMode) {
  const span = document.createElement("span");
  span.className = "math-frag" + (displayMode ? " math-frag-display" : "");
  span.setAttribute("dir", "ltr");
  try {
    window.katex.render(tex, span, {
      displayMode: !!displayMode,
      throwOnError: false,
      strict: false,
      trust: false,          /* أمان: لا \href ولا \includegraphics */
      output: "htmlAndMathml",
    });
  } catch (e) {
    span.classList.add("math-frag-error");
    span.textContent = tex;  /* إبقاء الصيغة الأصلية ظاهرة عند الفشل */
  }
  return span;
}

/* شظية DOM لنص قصير (سؤال/خيار/تعليل/تلميح/سياق) مع تصيير المعادلات فقط
   — دون Markdown، حفاظًا على بنية النصوص القصيرة كما هي */
function mathRichFrag(text) {
  const frag = document.createDocumentFragment();
  const raw = String(text || "");
  if (!hasMathSyntax(raw) || !katexReady()) {
    frag.appendChild(document.createTextNode(raw));
    return frag;
  }
  splitMathSegments(raw).forEach((seg) => {
    if (!seg.math) {
      if (seg.text) frag.appendChild(document.createTextNode(seg.text));
      return;
    }
    if (seg.display) {
      const wrap = document.createElement("div");
      wrap.className = "math-display";
      wrap.setAttribute("dir", "ltr");
      wrap.appendChild(katexSpan(seg.tex, true));
      frag.appendChild(wrap);
    } else {
      frag.appendChild(katexSpan(seg.tex, false));
    }
  });
  return frag;
}

/* جملة بطاقة/سياق: تمييز الكلمة المفتاحية أو إخفاؤها مع تصيير المعادلات */
function mathAwareSentenceFrag(text, keyword, blankMode) {
  const raw = String(text || "");
  if (!hasMathSyntax(raw) || !katexReady()) {
    return blankMode ? blankKeywordFrag(raw, keyword) : highlightKeywordFrag(raw, keyword);
  }
  const frag = document.createDocumentFragment();
  splitMathSegments(raw).forEach((seg) => {
    if (seg.math) {
      frag.appendChild(katexSpan(seg.tex, seg.display));
      return;
    }
    frag.appendChild(blankMode ? blankKeywordFrag(seg.text, keyword) : highlightKeywordFrag(seg.text, keyword));
  });
  return frag;
}

/* إزالة محددات الرياضيات قبل القراءة الصوتية (TTS) — تُقرأ الصيغة نفسها لا علاماتها */
function stripMathDelimiters(text) {
  return String(text || "")
    .replace(/\$\$|\$|\\\(|\\\)|\\\[|\\\]/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/* تصيير المعادلات داخل عقد نصية موجودة (ورقة الطباعة وما شابه المبني بـ innerHTML) */
function renderMathInTextNodes(root) {
  if (!katexReady() || !root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !hasMathSyntax(node.nodeValue)) return NodeFilter.FILTER_REJECT;
      const p = node.parentElement;
      if (!p || p.closest("script, style, pre, code, .katex, .math-frag")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const targets = [];
  let n;
  while ((n = walker.nextNode())) targets.push(n);
  targets.forEach((node) => {
    const frag = document.createDocumentFragment();
    splitMathSegments(node.nodeValue).forEach((seg) => {
      if (!seg.math) {
        if (seg.text) frag.appendChild(document.createTextNode(seg.text));
        return;
      }
      frag.appendChild(katexSpan(seg.tex, seg.display));
    });
    node.parentNode.replaceChild(frag, node);
  });
}

function passageMarkdownFrag(text, keyword) {
  const wrap = document.createElement("div");
  wrap.className = "md-body";
  const parser = ensureMarkdownParser();
  let html;
  /* حجب الرياضيات أولًا (حتى لا يفسد المحلل \( و|) ثم جداول متساهلة ثم التصيير */
  const mathMask = mdExtractMath(text);
  try {
    html = parser.render(mdPreprocessSource(mathMask.masked));
  } catch (e) {
    console.warn("[Markdown] render failed", e);
    return passageLegacyFrag(text, keyword);
  }
  if (window.DOMPurify) {
    html = window.DOMPurify.sanitize(html, {
      ADD_ATTR: ["target", "rel", "dir", "align", "loading", "decoding"],
      FORBID_TAGS: ["style", "form", "iframe"],
      KEEP_CONTENT: true,
    });
  }
  wrap.innerHTML = html;
  mdRestoreMathText(wrap, mathMask.store);
  applyMarkdownDirection(wrap);
  wrapMarkdownTables(wrap);
  enhanceMarkdownMedia(wrap);
  collectMermaidBlocks(wrap);
  renderMarkdownMath(wrap); /* المعادلات قبل تمييز الكلمات ليتخطى التمييز عناصر .katex */
  highlightKeywordInMarkdown(wrap, keyword);
  void renderMermaidBlocks(wrap); /* غير متزامن — الحاوية تُظهر مؤقتًا «جاري الرسم» */
  const frag = document.createDocumentFragment();
  frag.appendChild(wrap);
  return frag;
}

function passageLegacyFrag(text, keyword) {
  const frag = document.createDocumentFragment();
  const lines = String(text || "").split(/\r?\n/);
  let added = 0;
  lines.forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) return;
    let content = line;
    const isHeading = looksLikePassageHeading(content);
    if (/^#{1,6}\s+/.test(content)) content = content.replace(/^#{1,6}\s+/, "");
    const p = document.createElement("p");
    p.className = isHeading ? "passage-heading" : "passage-line";
    p.appendChild(highlightKeywordFrag(content, keyword));
    frag.appendChild(p);
    added++;
  });
  if (!added) frag.appendChild(highlightKeywordFrag(text, keyword));
  return frag;
}

function passageRichFrag(text, keyword) {
  const raw = String(text || "");
  if (raw && looksLikeMarkdownText(raw) && ensureMarkdownParser()) {
    return passageMarkdownFrag(raw, keyword);
  }
  return passageLegacyFrag(raw, keyword);
}

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
    labelF.textContent = "وضع الاسترجاع";
    hintF.textContent = "تذكّر الكلمة ثم اقلب البطاقة";
    kwEl.style.display = "none";
    const blank = document.createElement("p");
    blank.className = "fc-blank";
    blank.id = "fc-blank";
    blank.appendChild(mathAwareSentenceFrag(card.sentence, card.keyword, true));
    front.insertBefore(blank, hintF);
    labelB.textContent = "الكلمة الصحيحة";
    hintB.textContent = "قيّم نفسك ثم تابع";
    const ans = document.createElement("strong");
    ans.className = "fc-answer";
    ans.id = "fc-answer";
    ans.textContent = card.keyword;
    back.insertBefore(ans, sentEl);
    sentEl.innerHTML = "";
    sentEl.appendChild(mathAwareSentenceFrag(card.sentence, card.keyword, false));
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
    sentEl.appendChild(mathAwareSentenceFrag(card.sentence, card.keyword, false));
  }
  refreshCardPassageButton(card);
  updateRecallChip();
}

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
   11) النصوص التجريبية المتنوعة + رفع الملفات + أحداث الواجهة
   ========================================================= */

const SAMPLE_TEXTS = {
  tech: `شهد العقد الأخير تحولًا جوهريًا في مشهد التعليم، حيث باتت منصات التعلم الإلكتروني تتنافس مع الفصول التقليدية على وقتهم واهتمام المتعلمين. لم يعد التعليم حكرًا على القاعات المدرسية، بل أصبح متاحًا بضغطة زر لأي شخص يمتلك اتصالًا بالإنترنت ورغبة في التعلم.

وتقف الذكاء الاصطناعي في قلب هذا التحول، إذ باتت الأنظمة الذكية قادرة على تخصيص المسار التعليمي لكل طالب على حدة، فتحلل نقاط قوته وضعفه، ثم تقترح له المحتوى الأنسب لمستواه. هذا التخصيص الفردي كان حلمًا بعيد المنال في زمن التعليم الموحد للجميع.

غير أن هذا التطور السريع أثار أسئلة جدية حول دور المعلم. فبعض المتفائلين يرون أن التقنية ستحرر المعلم من الأعمال الروتينية كالتصحيح وإعداد التقارير، ليتفرغ لما يتفرد به الإنسان: إلهام الطلاب، وبناء شخصياتهم، وتنمية مهاراتهم الاجتماعية والنفسية.

في المقابل، يحذر الباحثون من مخاطر الإفراط في الاعتماد على الشاشات، ومن تراجع قدرة الطلاب على التركيز العميق والصبر على التعلم الشاق. تشير دراسات حديثة إلى أن القراءة السريعة والمتنقلة تنتج فهمًا سطحيًا، بينما يبقى الفهم العميق مرتبطًا بالقراءة المتأنية والمناقشة الحوارية.

ويبدو أن مستقبل التعليم سيكون هجينًا يمزج بين مرونة التقنية ودفء العلاقة الإنسانية، فالمدرسة التي تتبنى الأدوات الذكية دون أن تفقد روحها الإنسانية هي الأقدر على إعداد جيل يواجه عالمًا يتغير بوتيرة متسارعة.`,

  neuro: `يمتلك الدماغ البشري خاصية مذهلة تُعرف في العلوم العصبية باسم «المرونة العصبية» (Neuroplasticity)، وهي قدرة الشبكات العصبية على إعادة تنظيم نفسها وتكوين وصلات مشبكية جديدة طوال حياة الإنسان استجابةً للتعلم والخبرة وحتى الإصابات الدماغية.

لطالما ساد الاعتقاد في القرن العشرين بأن بنية الدماغ تصبح ثابتة وغير قابلة للتغيير بعد انتهاء مرحلة الطفولة المبكرة، غير أن الأبحاث الحديثة باستخدام التصوير بالرنين المغناطيسي الوظيفي أثبتت أن تعلم مهارة جديدة كالعزف أو إتقان لغة أجنبية يغير الكثافة الرمادية في مناطق محددة من القشرة الدماغية.

وتعتمد عملية تقوية الروابط العصبية على مبدأ هيب الشهير: «الخلايا العصبية التي تنشط معًا ترتبط معًا». فعندما نمارس استرجاع المعلومة مرارًا عبر الاختبار الذاتي المتباعد، يزداد تغليف الألياف العصبية بمادة الميالين، مما يضاعف سرعة انتقال الإشارات الكهربائية ودقتها.

وفي المقابل، يخضع الدماغ لعملية موازية تُسمى «التقليم المشبكي»، حيث يتخلص تدريجيًا من المسارات العصبية المهملة التي لا تُستخدم لتوفير الطاقة الحيوية. ولهذا السبب يتلاشى الحفظ السطحي السريع بعد الامتحان، بينما ترسخ المعرفة التي جرى ربطها بسياقات متعددة وتطبيقات عملية.

ويؤكد علماء الأعصاب أن النوم العميق والنشاط البدني الهوائي عنصران حاسمان لنجاح المرونة العصبية؛ فخلال النوم يعيد الحُصين (Hippocampus) تشغيل الذكريات المكتسبة نهارًا وينقلها إلى القشرة المخية للتخزين طويل الأمد.`,

  history: `شكّل «بيت الحكمة» في بغداد خلال العصر العباسي الذهبي أول مؤسسة أكاديمية وبحثية كبرى جمعت بين خزانة الكتب، ومركز الترجمة، ومرصد الفلك، ومجلس المناظرة العلمية. وقد تطور من خزانة خاصة أسسها الخليفة هارون الرشيد ليبلغ ذروته في عهد المأمون مطلع القرن الثالث الهجري.

لم تقتصر جهود العلماء في بيت الحكمة على النقل الحرفي للمؤلفات اليونانية والفارسية والهندية، بل تجاوزتها إلى النقد والتمحيص والتصحيح والابتكار. ففي أروقته وضع محمد بن موسى الخوارزمي كتابه «الجبر والمقابلة» الذي أسس علم الجبر الحديث كفرع مستقل عن الهندسة.

وبرز في حركة الترجمة حنين بن إسحاق الذي أرسى منهجًا علميًا صارمًا يقوم على جمع النسخ المخطوطة المتعددة ومقابلتها، وترجمة المعنى الجملي السياقي بدل الترجمة الحرفية كلمةً بكلمة، مع نحت مصطلحات طبية وفلسفية عربية دقيقة لا تزال مستعملة حتى اليوم.

كما ارتبط ببيت الحكمة مرصد الشماسية في بغداد ومرصد جبل قاسيون في دمشق، حيث قاس الفلكيون ميل فلك البروج ومحيط الأرض بطريقة علمية اعتمدت على قياس طول الدرجة الأرضية في صحراء سنجار، فجاءت نتائجهم قريبة جدًا من القياسات المعاصرة.

وقد أسهم هذا المناخ العلمي المنفتح في حفظ التراث الإنساني من الضياع وتطوير المنهج التجريبي عند الحسن بن الهيثم والرازي والبيروني، قبل أن تنتقل هذه الذخائر العلمية عبر الأندلس وصقلية لتشعل جذوة النهضة الأوروبية.`,

  econ: `يفترض الاقتصاد الكلاسيكي أن الإنسان كائن عقلاني تمامًا يسعى دائمًا لتعظيم منفعته الاقتصادية بعد موازنة دقيقة بين التكاليف والعوائد. غير أن «الاقتصاد السلوكي» الذي أرسى دعائمه دانيال كانيمان وآموس تفرسكي وريتشارد ثالر كشف أن القرارات البشرية اليومية تخضع لانحيازات معرفية وعاطفية منهجية.

ومن أبرز هذه الظواهر «النفور من الخسارة» (Loss Aversion)، حيث يشعر الإنسان بألم نفسي عند خسارة مبلغ مالي يفوق بنحو الضعف حجم السعادة التي يشعر بها عند ربح المبلغ نفسه. وهذا يفسر تمسك المستثمرين بأسهم خاسرة أملًا في التعويض، أو تردد الأفراد في تغيير خياراتهم الافتراضية.

كما يؤدي «انحياز الإرساء» (Anchoring Bias) دورًا خفيًا في التفاوض والتسعير؛ إذ يميل العقل البشري إلى الاعتماد المفرط على أول رقم يُعرض عليه (المرساة) بوصفه نقطة مرجعية للحكم على القيمة، حتى لو كان هذا الرقم عشوائيًا أو مبالغًا فيه.

أما مفهوم «هندسة الاختيار» أو «النغز» (Nudge) الذي طوره ريتشارد ثالر، فيقوم على تصميم بيئة القرار بطريقة تحفز الأفراد على اتخاذ الخيار الأفضل لصحتهم أو مدخراتهم طوعًا ودون إكراه أو منع، مثل جعل الاشتراك في صندوق التقاعد خيارًا تلقائيًا مع بقاء حق الانسحاب متاحًا.`,

  space: `تُعد الثقوب السوداء من أكثر الأجرام الكونية إثارة للدهشة في الفيزياء الفلكية، وهي مناطق في الفضاء بلغت فيها الكتلة كثافة هائلة إلى حد أن جاذبيتها تمنع أي شيء من الإفلات منها، بما في ذلك الفوتونات الضوئية نفسها.

وتنشأ الثقوب السوداء النجمية عندما يستنفد نجم عملاق وقوده النووي فينهار قلبه تحت وطأة جاذبيته الذاتية في انفجار مستعر أعظم (سوبرنوفا). ويحيط بالثقب الأسود حدّ افتراضي يُعرف باسم «أفق الحدث» (Event Horizon)، وهو نقطة اللاعودة التي يستحيل بعدها لأي إشارة أن تصل إلى المراقب الخارجي.

ووفقًا لنظرية النسبية العامة لألبرت أينشتاين، فإن الكتلة الهائلة للثقب الأسود تحني نسيج الزمكان بشدة، مما يؤدي إلى ظاهرة «تمدد الزمن الثقالي»؛ فالساعة القريبة من أفق الحدث تدق ببطء شديد مقارنة بساعة بعيدة عنه في الفضاء المفتوح.

وفي عام 2019 نجح تلسكوب أفق الحدث (Event Horizon Telescope) — وهو شبكة عالمية من التلسكوبات الراديوية المتزامنة — في التقاط أول صورة مباشرة لظل الثقب الأسود الفائق الكتلة في مركز مجرة M87، مما قدم دليلًا رصديًا باهرًا يؤكد تنبؤات الفيزياء النظرية.`,
};

function updateCharCount() {
  const raw = el("input-text").value;
  const n = raw.length;
  const trimmed = raw.trim();
  const words = trimmed ? trimmed.split(/\s+/).length : 0;
  el("char-count").textContent = n + " حرف";
  const wc = el("word-count");
  if (wc) wc.textContent = words + " كلمة";
  const rt = el("read-time");
  if (rt) {
    if (words >= 30) {
      const mins = Math.max(1, Math.round(words / 180));
      rt.textContent = `~${mins} د قراءة`;
      rt.classList.remove("hidden");
    } else {
      rt.classList.add("hidden");
    }
  }
}

function fillSample() {
  const topicSel = el("sample-topic");
  const key = (topicSel && topicSel.value) || "tech";
  el("input-text").value = SAMPLE_TEXTS[key] || SAMPLE_TEXTS.tech;
  updateCharCount();
  toast("info", "تم إدراج النص التجريبي المختار — اضغط «ابدأ الاختبار».");
}

function clearText() {
  el("input-text").value = "";
  updateCharCount();
  el("input-text").focus();
}

async function handleTextFileUpload(file) {
  if (!file) return;
  try {
    const content = await file.text();
    if (!content.trim()) {
      toast("error", "الملف النصي فارغ.");
      return;
    }
    el("input-text").value = content.trim();
    updateCharCount();
    toast("success", `تم إدراج محتوى الملف «${file.name}» بنجاح.`);
  } catch {
    toast("error", "تعذر قراءة الملف النصي — تأكد أنه بترميز UTF-8.");
  }
}

function toggleKeyVisibility() {
  const input = el("api-key");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  el("icon-eye").classList.toggle("hidden", show);
  el("icon-eye-off").classList.toggle("hidden", !show);
}

/* ====== قائمة النماذج ====== */
function buildModelSelect() {
  const sel = el("model-select");
  sel.innerHTML = "";
  const hasCustom = loadCustomModels();
  const options = hasCustom
    ? [...AI_MODELS]
    : [...DEFAULT_AI_MODELS];

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
    el("custom-status").textContent = "النماذج المخصصة مطبقة.";
  } else {
    sel.value = DEFAULT_AI_MODELS[0].id;
    setActiveModel(DEFAULT_AI_MODELS[0].id);
  }
}

function onModelSelectChange() {
  const sel = el("model-select");
  if (sel.value === "__custom__") {
    sel.value = AI_MODELS[0].id;
    openCustomModelsModal();
  } else {
    setActiveModel(sel.value);
  }
}

/* ====== نافذة النماذج المخصصة ====== */
let customModelsReturnFocus = null;

function isCustomModelsOpen() {
  return !el("custom-models-overlay").classList.contains("hidden");
}

function openCustomModelsModal() {
  if (isCustomModelsOpen()) return;
  customModelsReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  el("custom-models-overlay").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  try { el("custom-primary").focus(); } catch {}
}

function closeCustomModelsModal() {
  const ov = el("custom-models-overlay");
  if (ov.classList.contains("hidden")) return;
  ov.classList.add("hidden");
  document.body.style.overflow = "";
  if (customModelsReturnFocus && document.contains(customModelsReturnFocus)) {
    try { customModelsReturnFocus.focus(); } catch {}
  }
  customModelsReturnFocus = null;
}

function trapCustomModelsTab(e) {
  const focusables = [...el("custom-models-overlay").querySelectorAll("button, input, [tabindex='0']")]
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

function applyCustomModels() {
  const primary = el("custom-primary").value.trim();
  const fallback = el("custom-fallback").value.trim();
  if (!primary || !fallback) {
    toast("error", "أدخل معرّف النموذج الأساسي والاحتياطي معًا.");
    return;
  }
  saveCustomModels(primary, fallback);
  buildModelSelect();
  closeCustomModelsModal();
  toast("success", `تم تطبيق النماذج المخصصة: ${primary} ثم ${fallback} عند الفشل.`);
}

function resetModels() {
  resetCustomModels();
  buildModelSelect();
  closeCustomModelsModal();
  el("custom-status").textContent = "استُعيدت النماذج الافتراضية.";
  toast("info", "استُعيدت النماذج الافتراضية.");
}

/* ====== لوحة المفاتيح ====== */
function onKeydown(e) {
  if (isOverlayVisibleById("shortcuts-overlay")) {
    if (e.key === "Escape") { e.preventDefault(); closeShortcutsModal(); }
    else if (e.key === "Tab") { trapOverlayTab("shortcuts-overlay", e); }
    return;
  }
  if (isOverlayVisibleById("study-guide-overlay")) {
    if (e.key === "Escape") { e.preventDefault(); closeStudyGuideModal(); }
    else if (e.key === "Tab") { trapOverlayTab("study-guide-overlay", e); }
    return;
  }
  if (isOverlayVisibleById("save-list-overlay")) {
    if (e.key === "Escape") { e.preventDefault(); closeSaveToListModal(); }
    else if (e.key === "Tab") { trapOverlayTab("save-list-overlay", e); }
    return;
  }
  if (isOverlayVisibleById("list-name-overlay")) {
    if (e.key === "Escape") { e.preventDefault(); closeListNameModal(); }
    else if (e.key === "Tab") { trapOverlayTab("list-name-overlay", e); }
    return;
  }
  if (isCustomModelsOpen()) {
    if (e.key === "Escape") { e.preventDefault(); closeCustomModelsModal(); }
    else if (e.key === "Tab") { trapCustomModelsTab(e); }
    return;
  }
  if (isPassageOpen()) {
    if (e.key === "Escape") {
      e.preventDefault();
      closePassageModal();
    } else if (e.key === "Tab") {
      trapPassageTab(e);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      passageGo(-1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      passageGo(1);
    }
    return;
  }

  const inInput = e.target && /^(input|textarea|select)$/i.test(e.target.tagName) && e.target.type !== "radio";
  if (!inInput && (e.key === "?" || e.key === "؟")) {
    e.preventDefault();
    openShortcutsModal();
    return;
  }

  if (el("screen-cards").classList.contains("active")) {
    if (e.key === "ArrowLeft") { e.preventDefault(); nextCard(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); prevCard(); }
    else if ((e.key === " " || e.key === "Enter") && document.activeElement === el("flashcard")) { e.preventDefault(); flipCard(); }
    return;
  }
  if (!el("screen-quiz").classList.contains("active") || !state.quiz) return;
  if (inInput) return;

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
  } else if (/^[fFف]$/.test(e.key)) {
    e.preventDefault();
    activateFiftyLifeline();
  } else if (/^[hHأ]$/.test(e.key)) {
    e.preventDefault();
    activateHintLifeline();
  } else if (/^[sSس]$/.test(e.key)) {
    e.preventDefault();
    toggleStarCurrentQuestion();
  } else if (/^[vVر]$/.test(e.key)) {
    e.preventDefault();
    speakCurrentQuestion();
  } else if (/^[pPح]$/.test(e.key)) {
    const q = state.rendered;
    if (q && q.userAnswer !== null) {
      e.preventDefault();
      openPassageModal(q);
    }
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

  /* النماذج ونمط الأسئلة */
  buildModelSelect();
  el("model-select").addEventListener("change", onModelSelectChange);
  el("btn-save-models").addEventListener("click", applyCustomModels);
  el("btn-reset-models").addEventListener("click", resetModels);
  el("btn-custom-models-close").addEventListener("click", closeCustomModelsModal);
  el("custom-models-overlay").addEventListener("click", (e) => {
    if (e.target === el("custom-models-overlay")) closeCustomModelsModal();
  });

  loadQType();
  syncQTypeUI();
  el("q-type").addEventListener("change", () => setQType(el("q-type").value));

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
    el("speed-seconds").value = String(speedSettings.secs);
    saveSpeedSettings();
    toast("info", "زمن السؤال: " + speedSettings.secs + " ثانية" + (speedSettings.on ? "." : " — فعّل وضع السرعة ليُطبّق."));
  });

  /* النص + رفع ملف + السحب والإفلات */
  el("input-text").addEventListener("input", updateCharCount);
  el("btn-sample").addEventListener("click", fillSample);
  el("btn-clear").addEventListener("click", clearText);
  el("btn-upload-txt").addEventListener("click", () => el("upload-txt-file").click());
  el("upload-txt-file").addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    handleTextFileUpload(f);
  });

  const dz = el("drop-zone");
  const dh = el("drop-hint");
  if (dz) {
    ["dragenter", "dragover"].forEach((ev) => {
      dz.addEventListener(ev, (e) => {
        e.preventDefault();
        dz.classList.add("dragover");
        if (dh) dh.classList.remove("hidden");
      });
    });
    ["dragleave", "drop"].forEach((ev) => {
      dz.addEventListener(ev, (e) => {
        e.preventDefault();
        dz.classList.remove("dragover");
        if (dh) dh.classList.add("hidden");
      });
    });
    dz.addEventListener("drop", (e) => {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleTextFileUpload(f);
    });
  }
  updateCharCount();

  /* أسلوب توليد الأسئلة + خلط الفقرات */
  loadKwMode();
  syncKwModeUI();
  el("kw-mode").addEventListener("change", () => setKwMode(el("kw-mode").value));
  el("shuffle-paragraphs").addEventListener("change", () => {
    shuffleParagraphsOn = el("shuffle-paragraphs").checked;
    store.set("quiz_shuffle_paras", shuffleParagraphsOn ? "1" : "0");
    toast("info", shuffleParagraphsOn ? "سيتم عرض فقرات الاختبار بترتيب عشوائي." : "سيتم عرض الفقرات حسب تسلسل النص الأصلي.");
  });

  /* تعليمات إضافية + القوالب السريعة */
  loadExtraInstructions();
  syncExtraInstructionsUI();
  let extraSaveTimer = null;
  el("extra-instructions").addEventListener("input", () => {
    const ta = el("extra-instructions");
    if (ta.value.length > MAX_EXTRA_INSTRUCTIONS) ta.value = ta.value.slice(0, MAX_EXTRA_INSTRUCTIONS);
    updateExtraCount(ta.value);
    clearTimeout(extraSaveTimer);
    extraSaveTimer = setTimeout(() => {
      setExtraInstructions(ta.value, true);
      flashExtraSaved();
    }, 600);
  });
  el("btn-extra-clear").addEventListener("click", () => {
    el("extra-instructions").value = "";
    setExtraInstructions("", false);
  });
  document.querySelectorAll(".preset-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const snippet = chip.dataset.preset || "";
      if (!snippet) return;
      const ta = el("extra-instructions");
      const cur = ta.value.trim();
      const next = cur ? (cur.includes(snippet) ? cur : cur + "\n" + snippet) : snippet;
      ta.value = next.slice(0, MAX_EXTRA_INSTRUCTIONS);
      setExtraInstructions(ta.value, false);
      flashExtraSaved();
    });
  });

  /* عدد الفقرات */
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

  /* لغة السؤال */
  loadQuizLang();
  syncQuizLangUI();
  el("quiz-lang").addEventListener("change", () => setQuizLang(el("quiz-lang").value));

  /* مستوى الصعوبة */
  loadDifficulty();
  syncDifficultyUI();
  el("difficulty-seg").querySelectorAll(".seg-btn").forEach((b) => {
    b.addEventListener("click", () => setDifficulty(b.dataset.level));
  });

  /* وسائل المساعدة وأدوات السؤال */
  el("btn-fifty").addEventListener("click", activateFiftyLifeline);
  el("btn-hint").addEventListener("click", activateHintLifeline);
  el("btn-tts-q").addEventListener("click", speakCurrentQuestion);
  el("btn-star-q").addEventListener("click", toggleStarCurrentQuestion);

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

  /* تصفية وبحث المراجعة */
  document.querySelectorAll(".rev-filter").forEach((btn) => {
    btn.addEventListener("click", () => {
      reviewFilter = btn.dataset.filter || "all";
      document.querySelectorAll(".rev-filter").forEach((b) => b.classList.toggle("active", b === btn));
      renderReviewList();
    });
  });
  el("review-search").addEventListener("input", renderReviewList);

  /* دليل الدراسة والاختصارات */
  el("btn-study-guide").addEventListener("click", openStudyGuideModal);
  el("btn-header-study").addEventListener("click", openStudyGuideModal);
  el("btn-resume-study").addEventListener("click", openStudyGuideModal);
  el("btn-study-guide-close").addEventListener("click", closeStudyGuideModal);
  el("btn-sg-done").addEventListener("click", closeStudyGuideModal);
  el("btn-sg-copy").addEventListener("click", copyStudyGuide);
  el("sg-search").addEventListener("input", () => renderStudyGuideParagraphs());
  el("study-guide-overlay").addEventListener("click", (e) => {
    if (e.target === el("study-guide-overlay")) closeStudyGuideModal();
  });

  el("btn-shortcuts").addEventListener("click", openShortcutsModal);
  el("btn-shortcuts-close").addEventListener("click", closeShortcutsModal);
  el("btn-shortcuts-ok").addEventListener("click", closeShortcutsModal);
  el("shortcuts-overlay").addEventListener("click", (e) => {
    if (e.target === el("shortcuts-overlay")) closeShortcutsModal();
  });

  /* البطاقات */
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
  el("btn-save-library").addEventListener("click", () => openSaveToListModal("results"));
  el("btn-print").addEventListener("click", printQuiz);
  el("btn-import").addEventListener("click", () => el("import-file").click());
  el("import-file").addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
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
  renderListsOverview();
  updateHeaderStudyBtn();

  /* قوائم الحفظ + البحث والنسخ الاحتياطي */
  loadLists();
  el("btn-open-lists").addEventListener("click", () => {
    listsUi.tabId = null;
    renderListsScreen();
    showScreen("lists");
  });
  el("btn-lists-back").addEventListener("click", () => {
    renderListsOverview();
    showScreen("setup");
  });
  el("lists-search").addEventListener("input", renderListsScreen);
  el("btn-backup-export").addEventListener("click", exportFullBackup);
  el("btn-backup-import").addEventListener("click", () => el("backup-import-file").click());
  el("backup-import-file").addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    importFullBackup(f);
  });
  el("btn-new-list").addEventListener("click", () => openListNameModal("create"));
  el("btn-list-rename").addEventListener("click", () => {
    const ls = loadLists();
    openListNameModal("rename", currentListId(ls));
  });
  el("btn-list-delete").addEventListener("click", deleteActiveList);
  el("btn-save-quiz").addEventListener("click", () => openSaveToListModal("quiz"));
  el("btn-resume-save").addEventListener("click", () => openSaveToListModal("last-session"));
  el("btn-save-list-close").addEventListener("click", closeSaveToListModal);
  el("btn-save-list-cancel").addEventListener("click", closeSaveToListModal);
  el("btn-save-list-confirm").addEventListener("click", confirmSaveToList);
  el("save-list-overlay").addEventListener("click", (e) => {
    if (e.target === el("save-list-overlay")) closeSaveToListModal();
  });
  el("save-list-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); confirmSaveToList(); }
  });
  el("save-list-new-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); confirmSaveToList(); }
  });
  el("btn-list-name-close").addEventListener("click", closeListNameModal);
  el("btn-list-name-cancel").addEventListener("click", closeListNameModal);
  el("btn-list-name-confirm").addEventListener("click", confirmListName);
  el("list-name-overlay").addEventListener("click", (e) => {
    if (e.target === el("list-name-overlay")) closeListNameModal();
  });
  el("list-name-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); confirmListName(); }
  });

  document.addEventListener("keydown", onKeydown);

  window.addEventListener("pagehide", () => updateSavedProgress());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") updateSavedProgress();
  });

  /* نافذة الفقرة المنبثقة */
  el("btn-passage-close").addEventListener("click", closePassageModal);
  el("btn-passage-continue").addEventListener("click", closePassageModal);
  el("btn-passage-prev").addEventListener("click", () => passageGo(-1));
  el("btn-passage-next").addEventListener("click", () => passageGo(1));
  el("btn-passage-tts").addEventListener("click", () => {
    /* استنساخ لاستبعاد MathML المخفي من KaTeX (تجنب القراءة المزدوجة) ومخططات Mermaid */
    const clone = el("passage-body").cloneNode(true);
    clone.querySelectorAll(".katex-mathml, .md-mermaid").forEach((n) => n.remove());
    const bodyText = (clone.innerText || clone.textContent || "").trim();
    speakText(bodyText, el("btn-passage-tts"));
  });
  el("passage-overlay").addEventListener("click", (e) => {
    if (e.target === el("passage-overlay")) closePassageModal();
  });

  checkHashQuiz();

  console.log("[اختبرني v2.6] جاهز — أدخل مفتاح API ثم ألصق نصك للبدء.");
}

document.addEventListener("DOMContentLoaded", init);
