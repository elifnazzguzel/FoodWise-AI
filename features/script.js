/* FoodWise AI (MVP) — Single-file app logic.
   Constraints: only index.html + app.js, localStorage persistence, Gemini fetch. */

// API key resolution order:
// 1) window.FOODWISE_API_KEY (optional, set from console)
// 2) localStorage key "foodwise.apiKey" (optional)
// 3) DEFAULT_API_KEY (hardcoded placeholder)
const DEFAULT_API_KEY = "..."; // NEVER commit real keys

// Model fallback: names differ by API/project access; we pick the first available.
const GEMINI_MODEL_CANDIDATES = [
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
  "gemini-1.5-flash-latest",
  "gemini-1.5-pro-latest",
];
const DEBUG_AI = false;
const DEBUG_UI_HITTEST = false;

const STORAGE_KEYS = {
  inventory: "foodwise.inventory.v1", // legacy (pre-split)
  market: "foodwise.market.v1",
  fridge: "foodwise.fridge.v1",
  totals: "foodwise.totals.v1",
  settings: "foodwise.settings.v1",
  chart: "foodwise.chart.v1",
  habits: "foodwise.habits.v1",
  planner: "foodwise.planner.v1",
  profile: "foodwise.profile.v1",
  events: "foodwise.events.v1",
  feedback: "foodwise.feedback.v1",
};

const CO2_SAVED_PER_ITEM_KG = 2.5;

function $(id) {
  return document.getElementById(id);
}

function getApiKey() {
  return (
    (typeof window !== "undefined" && window.FOODWISE_API_KEY) ||
    localStorage.getItem("foodwise.apiKey") ||
    DEFAULT_API_KEY
  );
}

function getApiKeySource() {
  if (typeof window !== "undefined" && window.FOODWISE_API_KEY) return "window.FOODWISE_API_KEY";
  if (localStorage.getItem("foodwise.apiKey")) return "localStorage(foodwise.apiKey)";
  return "DEFAULT_API_KEY";
}

function maskKey(key) {
  const k = String(key || "");
  if (k.length <= 8) return k ? "***" : "(empty)";
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

let listenersBound = false;
let initialized = false;
let uiRaf = 0;
let uiDirty = false;

// Gemini rate-limit control (free-tier friendly)
const GEMINI_MIN_INTERVAL_MS = 3500; // free-tier friendly minimum delay
const GEMINI_MAX_RETRIES = 0; // no retries; fail fast + fallback
const GEMINI_FETCH_TIMEOUT_MS = 12000;
const GEMINI_TOTAL_WAIT_CAP_MS = 9000; // cap backoff + retries
let geminiQueue = Promise.resolve();
let geminiLastRequestAt = 0;
let geminiCooldownUntil = 0;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(ms) {
  const j = Math.floor(Math.random() * 120);
  return ms + j;
}

function isRateLimitError(status, text) {
  const t = String(text || "").toLowerCase();
  // Be strict: avoid misclassifying auth/model errors as quota.
  return status === 429 || t.includes("resource_exhausted");
}

function summarizeHttpError(err) {
  const status = err?.status;
  const model = err?.model;
  const raw = String(err?.bodyText || err?.message || "");
  const snippet = raw.length > 260 ? `${raw.slice(0, 260)}…` : raw;
  return `HTTP: ${status ?? "?"}${model ? ` • model: ${model}` : ""}\n${snippet}`;
}

let resolvedGeminiModel = null;

async function listGeminiModels(apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`ListModels hata: ${res.status} ${res.statusText}${text ? ` • ${text}` : ""}`);
    err.status = res.status;
    err.bodyText = text;
    throw err;
  }
  const data = await res.json();
  return Array.isArray(data?.models) ? data.models : [];
}

async function resolveGeminiModel(apiKey) {
  if (resolvedGeminiModel) return resolvedGeminiModel;

  // 1) Try explicit candidates fast (no extra request).
  for (const m of GEMINI_MODEL_CANDIDATES) {
    try {
      // "ping" with minimal prompt and 1 token
      await (async () => {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
          m
        )}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: "ping" }] }],
            generationConfig: { maxOutputTokens: 1, temperature: 0.0 },
          }),
        });
        if (res.ok) return;
        const text = await res.text().catch(() => "");
        const err = new Error("ping failed");
        err.status = res.status;
        err.bodyText = text;
        throw err;
      })();
      resolvedGeminiModel = m;
      if (DEBUG_AI) console.log("[FoodWise AI] resolved model (ping):", m);
      return m;
    } catch (e) {
      // if auth/quota, don't keep trying here
      if (e?.status === 401 || e?.status === 403) throw e;
      if (isRateLimitError(e?.status, e?.bodyText || e?.message)) throw e;
      // else continue
    }
  }

  // 2) ListModels and pick any generateContent flash-like model.
  const models = await listGeminiModels(apiKey);
  const supported = models
    .filter((mm) => Array.isArray(mm?.supportedGenerationMethods) && mm.supportedGenerationMethods.includes("generateContent"))
    .map((mm) => String(mm?.name || "").replace(/^models\//, ""))
    .filter(Boolean);

  const preferred =
    supported.find((n) => /flash/i.test(n) && /latest/i.test(n)) ||
    supported.find((n) => /flash/i.test(n)) ||
    supported.find((n) => /pro/i.test(n) && /latest/i.test(n)) ||
    supported[0];

  if (!preferred) throw new Error("Uygun Gemini modeli bulunamadı (ListModels boş).");
  resolvedGeminiModel = preferred;
  if (DEBUG_AI) console.log("[FoodWise AI] resolved model (listModels):", preferred);
  return preferred;
}

function isInCooldown() {
  return Date.now() < geminiCooldownUntil;
}

function startCooldown(ms = 10000) {
  geminiCooldownUntil = Math.max(geminiCooldownUntil, Date.now() + ms);
}

function demoFallbackText({ title, bullets }) {
  const lines = [
    `${title}`,
    "",
    ...bullets.map((b) => `- ${b}`),
    "",
    "(AI şu an kota/limit nedeniyle devre dışı; bu örnek içerik offline fallback'tir.)",
  ];
  return lines.join("\n");
}

function offlineRecipeAlternatives({ product, activityMode, academicMode }) {
  const name = product?.name || "ürün";
  const sporty = activityMode === "Spor";
  const pantry = compactList(state.fridgeList?.map((x) => x.name) || [], { maxItems: 6, maxLen: 24 });

  if (academicMode) {
    const baseIngredients = sporty
      ? [`${name}`, "yoğurt veya süt", "1 yumurta (ops.)", "tuz/karabiber", "zeytinyağı", "1 hızlı yeşillik"]
      : [`${name}`, "1 dilim ekmek / lavaş", "yoğurt veya peynir", "tuz/karabiber", "zeytinyağı", "limon (ops.)"];

    return [
      `Academic Mode • <10 dk • Minimal bulaşık`,
      "",
      `A) ${sporty ? "Protein Hızlı Bowl" : "Tek Tavada Hızlı Öğün"}`,
      `Süre: 8-10 dk`,
      `Minimal bulaşık: 1 tava + 1 kase (veya tek tabak).`,
      `Malzemeler: ${baseIngredients.slice(0, 6).join(", ")}`,
      `Adımlar:`,
      `1) ${name} küçük doğra/çöz (varsa).`,
      `2) Tavada 2-3 dk çevir; tuz/karabiber ekle.`,
      `3) Kasede yoğurt/sütle karıştır; üstüne tavadan ekle.`,
      `4) Yeşillik/ekmekle tamamla.`,
      `5) 1 dk “toparla”: aynı kaseyi servis kasesi yap.`,
      `B planı: ${pantry.length ? `Dolapta ${pantry[0]} varsa onunla aynı formatı uygula.` : "Dolap boşsa: yumurta + ekmek + yoğurtla 6 dk tost-bowl yap."}`,
      `Kalanı nasıl saklarsın? Porsiyonla, kapalı kapta 24 saat içinde tüket (veya dondur).`,
    ].join("\n");
  }

  // Standard mode: A/B recipes
  const aTitle = sporty ? "A) Sporcu Tabağı (yüksek protein)" : "A) Hızlı Sandviç / Wrap";
  const bTitle = sporty ? "B) 1 Tencere Hızlı (karbonhidrat + protein)" : "B) Tek Tavada Hızlı Sote";
  return [
    "A/B Hızlı Tarif Alternatifleri",
    "",
    aTitle,
    "Süre: 8-10 dk",
    `Malzemeler: ${name}, yoğurt/peynir, tuz/karabiber, zeytinyağı, (ops.) yeşillik`,
    "Adımlar:",
    `1) ${name} hazırla (doğra/çöz).`,
    "2) 2-3 dk tavada çevir veya direkt karıştır.",
    "3) Ekmek/lavaş içine koy, yoğurt/peynir ekle, kapat.",
    "",
    bTitle,
    "Süre: 9-12 dk",
    `Malzemeler: ${name}, 1 küçük soğan (ops.), 1 kaşık salça (ops.), baharat, (Spor ise) 1 yumurta`,
    "Adımlar:",
    "1) Tavayı ısıt, yağı ekle.",
    `2) ${name} + baharatı 5-6 dk çevir.`,
    "3) (Ops.) yumurta kır, 2 dk pişir, kapat.",
    "",
    "Atık azaltma ipucu: Porsiyonla ve görünür yere koy (ön raf).",
    "Kalanı saklama: Soğutup kapalı kapta 24-48 saat; uygun ürünse dondur.",
    "",
    "(AI kota/limit nedeniyle devre dışı; bu tarifler offline fallback.)",
  ].join("\n");
}

function ensureHabits() {
  if (state.habits && state.habits.version === 1) return;
  state.habits = {
    version: 1,
    items: [
      { id: "front_shelf", label: "SKT yakın ürünleri ön rafa koy", emoji: "👀" },
      { id: "plan_one_meal", label: "Yarın için 1 hızlı öğün planla", emoji: "🗓️" },
      { id: "portion_freeze", label: "Porsiyonla / dondur (gerekirse)", emoji: "🧊" },
    ],
    // doneByDate: { "YYYY-MM-DD": { front_shelf: true, ... } }
    doneByDate: {},
  };
  saveState({ habits: state.habits });
}

function getTodayKey() {
  return todayLocalISODate();
}

function getTodayHabitMap() {
  ensureHabits();
  const k = getTodayKey();
  state.habits.doneByDate[k] = state.habits.doneByDate[k] || {};
  return state.habits.doneByDate[k];
}

function computeHabitScore() {
  ensureHabits();
  const map = getTodayHabitMap();
  const total = state.habits.items.length;
  const done = state.habits.items.reduce((acc, it) => acc + (map[it.id] ? 1 : 0), 0);
  return { done, total };
}

function setMarketSummary(text) {
  const el = $("market-summary");
  if (!el) return;
  el.textContent = text || "—";
}

function spawnConfetti(containerId) {
  const host = $(containerId);
  if (!host) return;
  host.innerHTML = "";
  const colors = ["#10b981", "#22c55e", "#60a5fa", "#f59e0b", "#f43f5e"];
  for (let i = 0; i < 18; i += 1) {
    const p = document.createElement("i");
    p.style.left = `${Math.floor(Math.random() * 96)}%`;
    p.style.background = colors[i % colors.length];
    p.style.transform = `rotate(${Math.floor(Math.random() * 120)}deg)`;
    p.style.animationDelay = `${Math.floor(Math.random() * 120)}ms`;
    host.appendChild(p);
  }
  setTimeout(() => {
    host.innerHTML = "";
  }, 1100);
}

function computeStreak() {
  ensureHabits();
  let streak = 0;
  for (let i = 0; i < 365; i += 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const key = `${yyyy}-${mm}-${dd}`;
    const map = state.habits.doneByDate?.[key];
    if (!map) break;
    const allDone = state.habits.items.every((it) => !!map[it.id]);
    if (!allDone) break;
    streak += 1;
  }
  return streak;
}

function renderHabits() {
  const ul = $("habits-list");
  if (!ul) return;
  ensureHabits();
  const map = getTodayHabitMap();

  ul.innerHTML = state.habits.items
    .map((it) => {
      const checked = map[it.id] ? "checked" : "";
      const label = escapeHtml(it.label);
      return `<li class="item" data-habit="${it.id}">
  <div class="item-meta">
    <div class="item-name">${escapeHtml(it.emoji)} ${label}</div>
    <div class="pill" style="border-color:rgba(255,255,255,0.10)">
      <i class="fa-solid fa-circle-check"></i> Bugün işaretle
    </div>
  </div>
  <div class="actions">
    <label class="btn secondary" style="gap:10px; cursor:pointer; user-select:none;">
      <input type="checkbox" data-action="toggle-habit" ${checked} style="display:none;" />
      <i class="fa-solid ${map[it.id] ? "fa-square-check" : "fa-square"}"></i>
      ${map[it.id] ? "Tamamlandı" : "Yapıldı"}
    </label>
  </div>
</li>`;
    })
    .join("");

  const score = computeHabitScore();
  const streak = computeStreak();
  const scoreEl = $("habit-score");
  const streakEl = $("habit-streak");
  if (scoreEl) scoreEl.textContent = `${score.done}/${score.total}`;
  if (streakEl) streakEl.textContent = String(streak);

  const wrap = $("habits-wrap");
  if (wrap) {
    const allDone = score.done === score.total;
    wrap.classList.toggle("success-glow", allDone);
    if (allDone) spawnConfetti("habits-effects");
  }
}

function toggleHabit(id) {
  const map = getTodayHabitMap();
  map[id] = !map[id];
  saveState({ habits: state.habits });
  renderHabits();
}

function resetHabits() {
  state.habits = null;
  localStorage.removeItem(STORAGE_KEYS.habits);
  ensureHabits();
  renderHabits();
}

function ensurePlanner() {
  if (state.planner && state.planner.version === 1) return;
  state.planner = {
    version: 1,
    // days: 0=Mon ... 6=Sun
    days: Array.from({ length: 7 }, () => ({
      schedule: [], // { id, start:"09:00", end:"11:00", title:"..." }
      meals: {
        breakfast: { summary: "", durationMin: "", recipe: "" },
        lunch: { summary: "", durationMin: "", recipe: "" },
        dinner: { summary: "", durationMin: "", recipe: "" },
      },
    })),
  };
  saveState({ planner: state.planner });
}

function normalizePlannerMeals() {
  ensurePlanner();
  for (const day of state.planner.days) {
    for (const k of ["breakfast", "lunch", "dinner"]) {
      const v = day.meals?.[k];
      if (typeof v === "string") {
        day.meals[k] = { summary: v, durationMin: "", recipe: "" };
      } else if (!v || typeof v !== "object") {
        day.meals[k] = { summary: "", durationMin: "", recipe: "" };
      } else {
        day.meals[k] = {
          summary: String(v.summary || ""),
          durationMin: String(v.durationMin || ""),
          recipe: String(v.recipe || ""),
        };
      }
    }
  }
  saveState({ planner: state.planner });
}

const DAY_NAMES = ["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"];

function timeToMin(t) {
  const m = String(t || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  return hh * 60 + mm;
}

function isBusyDay(schedule) {
  // Busy if there's a continuous-ish block covering 12:00-17:00 or total minutes >= 300.
  const blocks = (schedule || [])
    .map((s) => ({ a: timeToMin(s.start), b: timeToMin(s.end) }))
    .filter((x) => x.a != null && x.b != null && x.b > x.a)
    .sort((x, y) => x.a - y.a);

  let total = 0;
  for (const bl of blocks) total += bl.b - bl.a;
  if (total >= 300) return true;

  const noon = 12 * 60;
  const five = 17 * 60;
  for (const bl of blocks) {
    if (bl.a <= noon && bl.b >= five) return true;
  }
  return false;
}

function hasMiddayClass(schedule) {
  // true if any slot overlaps 12:00–14:00
  const a0 = 12 * 60;
  const b0 = 14 * 60;
  return (schedule || []).some((s) => {
    const a = timeToMin(s.start);
    const b = timeToMin(s.end);
    if (a == null || b == null || b <= a) return false;
    return a < b0 && b > a0; // overlap
  });
}

function renderPlanner() {
  const host = $("planner-grid");
  if (!host) return;
  ensurePlanner();
  normalizePlannerMeals();

  host.innerHTML = state.planner.days
    .map((day, idx) => {
      const busy = isBusyDay(day.schedule);
      const midday = hasMiddayClass(day.schedule);
      const slots = (day.schedule || [])
        .slice(0, 6)
        .map(
          (s) => `<div class="slot" data-sid="${s.id}">
  <div><b>${escapeHtml(s.start)}–${escapeHtml(s.end)}</b> <span class="small">${escapeHtml(s.title)}</span></div>
  <button class="btn secondary" type="button" data-action="del-slot" data-day="${idx}" data-id="${s.id}" style="padding:8px 10px; border-radius:12px;">
    <i class="fa-solid fa-xmark"></i>
  </button>
</div>`
        )
        .join("");

      return `<div class="day" data-day="${idx}">
  <h3>${DAY_NAMES[idx]} ${busy ? '<span class="pill" style="margin-left:8px; border-color:rgba(249,115,22,0.25); background:rgba(249,115,22,0.06)"><strong style="color:var(--warning)">Yoğun</strong></span>' : ""}</h3>
  <div class="small">Ders/Çalışma</div>
  ${slots || '<div class="small" style="margin-top:8px;">Henüz ders eklenmedi.</div>'}

  <div class="mini-row">
    <input type="time" id="t-start-${idx}" />
    <input type="time" id="t-end-${idx}" />
  </div>
  <div class="mini-row">
    <input type="text" id="t-title-${idx}" placeholder="Örn: Veri Yapıları" />
    <button class="btn secondary" type="button" data-action="add-slot" data-day="${idx}" style="padding:10px 12px; border-radius:12px;">
      <i class="fa-solid fa-plus"></i> Ekle
    </button>
  </div>

  <div class="meal">
    <div class="meal-title"><span>Kahvaltı</span><span class="small">${busy ? "hızlı" : "normal"}</span></div>
    <textarea data-action="meal" data-day="${idx}" data-meal="breakfast" placeholder="Kahvaltı planı...">${escapeHtml(day.meals.breakfast?.summary || "")}</textarea>
    <button class="btn secondary" type="button" data-action="open-meal" data-day="${idx}" data-meal="breakfast" style="margin-top:8px; width:100%; justify-content:center;">
      <i class="fa-solid fa-book-open"></i> Tarif & Süre
    </button>
  </div>
  <div class="meal ${midday ? "fast" : ""}">
    <div class="meal-title"><span>Öğle</span><span class="small">${midday ? "Pratik / Hızlı Öğün" : busy ? "pratik öner" : ""}</span></div>
    <textarea data-action="meal" data-day="${idx}" data-meal="lunch" placeholder="Öğle planı...">${escapeHtml(day.meals.lunch?.summary || "")}</textarea>
    <button class="btn secondary" type="button" data-action="open-meal" data-day="${idx}" data-meal="lunch" style="margin-top:8px; width:100%; justify-content:center;">
      <i class="fa-solid fa-book-open"></i> Tarif & Süre
    </button>
  </div>
  <div class="meal">
    <div class="meal-title"><span>Akşam</span><span class="small"></span></div>
    <textarea data-action="meal" data-day="${idx}" data-meal="dinner" placeholder="Akşam planı...">${escapeHtml(day.meals.dinner?.summary || "")}</textarea>
    <button class="btn secondary" type="button" data-action="open-meal" data-day="${idx}" data-meal="dinner" style="margin-top:8px; width:100%; justify-content:center;">
      <i class="fa-solid fa-book-open"></i> Tarif & Süre
    </button>
  </div>
</div>`;
    })
    .join("");
}

function addScheduleSlot(dayIdx) {
  ensurePlanner();
  const s = $(`t-start-${dayIdx}`)?.value || "";
  const e = $(`t-end-${dayIdx}`)?.value || "";
  const title = $(`t-title-${dayIdx}`)?.value?.trim() || "";
  if (!s || !e || !title) {
    flashRecipeBox("Ders eklemek için başlangıç/bitiş ve başlık gir.");
    return;
  }
  state.planner.days[dayIdx].schedule.push({ id: uuid(), start: s, end: e, title });
  saveState({ planner: state.planner });
  renderPlanner();
}

function deleteScheduleSlot(dayIdx, slotId) {
  ensurePlanner();
  state.planner.days[dayIdx].schedule = state.planner.days[dayIdx].schedule.filter((x) => x.id !== slotId);
  saveState({ planner: state.planner });
  renderPlanner();
}

function setMeal(dayIdx, mealKey, value) {
  ensurePlanner();
  normalizePlannerMeals();
  state.planner.days[dayIdx].meals[mealKey].summary = value;
  saveState({ planner: state.planner });
}

function clearPlanner() {
  state.planner = null;
  localStorage.removeItem(STORAGE_KEYS.planner);
  ensurePlanner();
  normalizePlannerMeals();
  renderPlanner();
}

function openMealModal(title, body) {
  const modal = $("meal-modal");
  if (!modal) return;
  $("meal-modal-title").textContent = title || "Tarif";
  $("meal-modal-body").textContent = body || "—";
  modal.style.display = "flex";
}

function closeMealModal() {
  const modal = $("meal-modal");
  if (!modal) return;
  modal.style.display = "none";
}

function formatDetailedRecipe({ title, durationMin, ingredients, steps, minimalDish, tip }) {
  const dur = durationMin ? `${durationMin} dk` : "—";
  const lines = [
    title || "Tarif",
    `Süre: ${dur}`,
    minimalDish ? `Minimal bulaşık: ${minimalDish}` : "",
    "",
    "Malzemeler:",
    ...(ingredients || []).map((x) => `- ${x}`),
    "",
    "Adımlar:",
    ...(steps || []).map((x, i) => `${i + 1}) ${x}`),
    "",
    tip ? `İpucu: ${tip}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

function buildOfflineRecipeSpec({ mealKey, sporty, academic, busy, core }) {
  const base = {
    core: core || "yoğurt",
    salty: ["tuz", "karabiber", "zeytinyağı"],
    quickVeg: ["marul/yeşillik", "domates (ops.)", "salatalık (ops.)"],
  };

  if (mealKey === "breakfast") {
    if (sporty) {
      return {
        title: "Protein Kahvaltı Bowl",
        durationMin: academic ? 6 : 10,
        minimalDish: "1 kase + 1 kaşık",
        ingredients: [base.core, "yulaf", "muz veya meyve", "kuruyemiş (ops.)", "tarçın (ops.)"],
        steps: [
          "Kasede yoğurt + yulafı karıştır.",
          "Üstüne meyveyi doğra, ekle.",
          "Kuruyemiş/tarçın serpiştir.",
          "2 dk beklet (yulaf yumuşar) ve ye.",
        ],
        tip: "Yulafı 1 gece önceden hazırlarsan sabah 2 dk’da çıkar (overnight).",
      };
    }
    return {
      title: "Tek Tabak Hızlı Kahvaltı",
      durationMin: academic ? 7 : 12,
      minimalDish: "1 tabak + 1 bıçak",
      ingredients: [base.core, "ekmek/lavaş", "peynir (ops.)", "domates/salatalık", ...base.salty],
      steps: [
        "Tabağa yoğurt/peyniri koy.",
        "Domates/salatalığı doğra, ekle.",
        "Ekmek/lavaşla birlikte servis et.",
      ],
      tip: "Bulaşık azaltmak için doğrama yerine hazır salata da olur.",
    };
  }

  if (mealKey === "lunch" && busy) {
    if (sporty) {
      return {
        title: "Pratik Protein Wrap (Yoğun Gün Öğle)",
        durationMin: 8,
        minimalDish: "1 tabak (veya tek peçete)",
        ingredients: ["lavaş", base.core, "ton balığı/tavuk (ops.)", "yeşillik", "limon (ops.)", ...base.salty],
        steps: [
          "Lavaşın içine yoğurdu ince sür.",
          "Yeşillik + (varsa) ton/tavuk ekle.",
          "Tuz/karabiber + limon sık.",
          "Sar, ikiye kes, tek tabakta ye.",
        ],
        tip: "Protein eklemek için 1 haşlanmış yumurta da iş görür.",
      };
    }
    return {
      title: "Pratik Sandviç/Wrap (Yoğun Gün Öğle)",
      durationMin: 7,
      minimalDish: "1 tabak",
      ingredients: ["ekmek/lavaş", base.core, "peynir (ops.)", "yeşillik", ...base.salty],
      steps: ["Ekmek/lavaş içine yoğurt/peynir sür.", "Yeşillik ekle.", "Tuz/karabiber, kapat ve ye."],
      tip: "Yanına 1 meyve eklemek enerjiyi dengeler.",
    };
  }

  // dinner / normal lunch
  if (sporty) {
    return {
      title: "Tek Tavada Protein + Sebze",
      durationMin: academic ? 12 : 18,
      minimalDish: "1 tava + 1 tabak",
      ingredients: ["dondurulmuş sebze veya mevsim sebzesi", "yumurta veya ton/tavuk (ops.)", base.core, ...base.salty],
      steps: [
        "Tavayı ısıt, 1 tatlı kaşığı yağ ekle.",
        "Sebzeyi 6-8 dk çevir (donmuşsa kapağı kapat).",
        "Protein ekle (yumurta kır veya ton/tavuk ekle), 3-4 dk pişir.",
        "Yanına yoğurtla servis et.",
      ],
      tip: "Sebzeyi dondurulmuş seçmek hem ucuz hem israfı azaltır.",
    };
  }
  return {
    title: "Tek Tencere/Tava Sürdürülebilir Tabak",
    durationMin: academic ? 13 : 20,
    minimalDish: "1 tava veya 1 tencere",
    ingredients: ["bakliyat (konserve nohut/mercimek ops.)", "sebze", base.core, ...base.salty],
    steps: [
      "Sebzeyi 5-6 dk tavada çevir.",
      "Konserve bakliyatı ekle, 3-4 dk ısıt.",
      "Baharatla tatlandır, yanında yoğurtla ye.",
    ],
    tip: "Konserve bakliyat ‘yoğun gün’ kurtarıcısıdır; son kullanma riskini azaltır.",
  };
}

function offlineMealRecipe({ dayIdx, mealKey }) {
  const dayName = DAY_NAMES[dayIdx] || "Gün";
  const sporty = state.settings.activityMode === "Spor";
  const academic = !!state.settings.academicMode;
  const busy = isBusyDay(state.planner.days[dayIdx]?.schedule || []);
  const core = compactList(state.fridgeList.map((x) => x.name), { maxItems: 1, maxLen: 24 })[0] || "yoğurt";

  const title = `${dayName} • ${mealKey.toUpperCase()} • ${sporty ? "Spor" : "Ders"}${academic ? " • Academic" : ""}`;
  const spec = buildOfflineRecipeSpec({ mealKey, sporty, academic, busy, core });
  return {
    title,
    recipe: formatDetailedRecipe(spec),
  };
}

async function showMealDetails(dayIdx, mealKey) {
  ensurePlanner();
  normalizePlannerMeals();
  const meal = state.planner.days?.[dayIdx]?.meals?.[mealKey];
  const summary = meal?.summary || "";
  const duration = meal?.durationMin ? `${meal.durationMin} dk` : "";
  const recipe = meal?.recipe || "";

  const looksDetailed = /Malzemeler?:/i.test(recipe) && /Adımlar?:/i.test(recipe);
  const looksTooShort = recipe && recipe.trim().length < 90;

  // If we have an old/short recipe saved, regenerate a detailed offline version for clarity.
  if (recipe && duration && !looksDetailed && looksTooShort) {
    const off = offlineMealRecipe({ dayIdx, mealKey });
    openMealModal(`${DAY_NAMES[dayIdx]} • ${mealKey.toUpperCase()} • ${duration}`, off.recipe);
    return;
  }

  if (recipe && duration) {
    openMealModal(`${DAY_NAMES[dayIdx]} • ${mealKey.toUpperCase()} • ${duration}`, recipe);
    return;
  }

  // If missing details, try AI once; if 429 -> offline fallback.
  const product = { name: summary || "Hızlı öğün", kg: 0.0, expiryISO: "" };
  const prompt = [
    "Sen FoodWise AI'sın. Bu öğün için kısa tarif ve süre ver.",
    `AKTİF MOD: ${state.settings.activityMode}`,
    `ACADEMIC MODE: ${state.settings.academicMode ? "AÇIK" : "KAPALI"}`,
    `SPOR HEDEFİ: ${state.settings.sportGoal || "(yok)"}`,
    `PROTEİN HEDEFİ (g/gün): ${state.settings.proteinTarget || "(yok)"}`,
    `ÖĞÜN: ${mealKey} • Özet: ${summary || "(boş)"}`,
    `DOLAP: ${compactList(state.fridgeList.map((x) => x.name), { maxItems: 12, maxLen: 28 }).join(", ") || "(boş)"}`,
    "",
    "Çıktı formatı:",
    "- Süre: <dakika> dk",
    "- Tarif: 4-6 adım, her adım 1 satır",
    "- Minimal bulaşık (1 cümle)",
  ].join("\n");

  try {
    const out = await getAISuggestion(prompt);
    // If AI output is unstructured, wrap it with a minimal template for readability.
    const hasSteps = /Adımlar?:/i.test(out) || /\n\d+\)/.test(out);
    const hasIng = /Malzemeler?:/i.test(out) || /İçindekiler/i.test(out);
    const dur = String(out.match(/Süre:\s*(\d+)\s*dk/i)?.[1] || "");
    const wrapped = hasSteps || hasIng ? out : `Süre: ${dur || "—"} dk\n\nTarif:\n${out}`;

    state.planner.days[dayIdx].meals[mealKey].recipe = wrapped;
    state.planner.days[dayIdx].meals[mealKey].durationMin = dur;
    saveState({ planner: state.planner });
    openMealModal(`${DAY_NAMES[dayIdx]} • ${mealKey.toUpperCase()}`, wrapped);
  } catch (err) {
    const status = err?.status;
    const bodyText = err?.bodyText || err?.message || "";
    if (isRateLimitError(status, bodyText)) {
      const off = offlineMealRecipe({ dayIdx, mealKey });
      openMealModal(off.title, off.recipe);
      return;
    }
    const off = offlineMealRecipe({ dayIdx, mealKey });
    openMealModal(off.title, `${off.recipe}\n\n---\nAI hata: ${String(err?.message || err)}`);
  }
}
function offlineWeeklyMealPlan() {
  ensurePlanner();
  normalizePlannerMeals();
  const fridge = compactList(state.fridgeList.map((x) => x.name), { maxItems: 10, maxLen: 24 });
  const core = fridge.length ? fridge[0] : "yoğurt";
  const sporty = state.settings.activityMode === "Spor";
  const academic = !!state.settings.academicMode;

  // Sustainable, varied templates (plant-forward + leftovers).
  const breakfastTemplates = sporty
    ? ["yoğurt + yulaf + muz", "yumurta + tam tahıl tost", "peynir + zeytin + salata", "protein smoothie"]
    : ["peynir + ekmek + domates", "yulaf lapası + meyve", "menemen (tek tava)", "tost + yeşillik"];
  const lunchBusyTemplates = sporty
    ? ["protein wrap (ton/tavuk) + yeşillik", "yoğurtlu bowl + bakliyat", "yumurtalı sandviç", "ton balıklı salata kutusu"]
    : ["pratik sandviç + ayran", "tek kap makarna salatası", "nohutlu wrap", "peynirli tost + salata"];
  const lunchNormalTemplates = sporty
    ? ["tavuk/ton salata", "mercimek + yoğurt", "kinoa/pirinç bowl", "sebze sote + yumurta"]
    : ["sebzeli makarna + yoğurt", "mercimek çorbası + ekmek", "nohutlu salata", "sebze omlet"];
  const dinnerTemplates = sporty
    ? ["tek tava tavuk + sebze", "bakliyat bowl + yoğurt", "fırın/airfryer sebze + protein", "ton balığı + makarna (kontrollü)"]
    : ["sebze sote + pilav", "bakliyat yemeği + salata", "tek tencere çorba + ekmek", "fırın sebze + yoğurt"];

  // If there are SKT-critical items, prioritize them early week.
  const critical = state.fridgeList
    .map((x) => ({ name: x.name, d: daysUntil(x.expiryISO) }))
    .filter((x) => x.d < 2)
    .map((x) => x.name)
    .slice(0, 3);

  for (let i = 0; i < 7; i += 1) {
    const busy = isBusyDay(state.planner.days[i].schedule);
    const bTemp = breakfastTemplates[i % breakfastTemplates.length];
    const lTemp = busy
      ? lunchBusyTemplates[i % lunchBusyTemplates.length]
      : lunchNormalTemplates[i % lunchNormalTemplates.length];
    const dTemp = dinnerTemplates[(i + 1) % dinnerTemplates.length];
    const criticalNote = i < critical.length ? ` (öncelik: ${critical[i]})` : "";

    state.planner.days[i].meals.breakfast = {
      summary: academic
        ? `5-7 dk: ${bTemp}`
        : `${bTemp}`,
      durationMin: academic ? "5" : "10",
      recipe: formatDetailedRecipe(
        buildOfflineRecipeSpec({
          mealKey: "breakfast",
          sporty,
          academic,
          busy: false,
          core,
        })
      ),
    };
    state.planner.days[i].meals.lunch = {
      summary: busy
        ? `${lTemp}${criticalNote}`
        : `${lTemp}${criticalNote}`,
      durationMin: busy ? "8" : "15",
      recipe: formatDetailedRecipe(
        buildOfflineRecipeSpec({
          mealKey: "lunch",
          sporty,
          academic,
          busy,
          core,
        })
      ),
    };
    state.planner.days[i].meals.dinner = {
      summary: `${dTemp}${criticalNote}`,
      durationMin: academic ? "12" : "20",
      recipe: formatDetailedRecipe(
        buildOfflineRecipeSpec({
          mealKey: "dinner",
          sporty,
          academic,
          busy: false,
          core,
        })
      ),
    };
  }
  saveState({ planner: state.planner });
  renderPlanner();
}

function extractKeywords(text) {
  const t = String(text || "").toLowerCase();
  const map = [
    ["yoğurt", ["yoğurt"]],
    ["yulaf", ["yulaf"]],
    ["muz", ["muz"]],
    ["yumurta", ["yumurta"]],
    ["tavuk", ["tavuk"]],
    ["ton", ["ton balığı"]],
    ["makarna", ["makarna"]],
    ["pirinç", ["pirinç"]],
    ["mercimek", ["mercimek"]],
    ["nohut", ["nohut"]],
    ["salata", ["hazır salata", "marul"]],
    ["ekmek", ["ekmek/lavaş"]],
    ["peynir", ["peynir"]],
    ["sebze", ["dondurulmuş sebze", "mevsim sebzesi"]],
  ];
  const out = new Set();
  for (const [k, vals] of map) {
    if (t.includes(k)) vals.forEach((v) => out.add(v));
  }
  // Sustainability staples (reduce waste, flexible)
  ["zeytinyağı", "limon", "baharat"].forEach((x) => out.add(x));
  return [...out];
}

function generateMarketFromPlanOffline() {
  ensurePlanner();
  normalizePlannerMeals();
  const needed = new Set();
  for (let i = 0; i < 7; i += 1) {
    for (const k of ["breakfast", "lunch", "dinner"]) {
      const s = state.planner.days[i].meals[k]?.summary || "";
      extractKeywords(s).forEach((x) => needed.add(x));
    }
  }
  // Remove items already in fridge (rough match).
  const fridgeLower = state.fridgeList.map((x) => String(x.name).toLowerCase());
  const final = [...needed].filter((n) => !fridgeLower.some((f) => f.includes(String(n).toLowerCase())));
  return final.slice(0, 10);
}

async function generateMarketFromPlan() {
  const ctx = analyzeMarketContext();
  try {
    // Make sure UI isn't stuck in "loading" from other flows.
    if (state.settings.marketLoading) {
      state.settings.marketLoading = false;
      saveState({ settings: state.settings });
    }
    const scheduleSummary = state.planner?.days
      ?.map((d, i) => `${DAY_NAMES[i]}: B:${d.meals.breakfast?.summary || ""} L:${d.meals.lunch?.summary || ""} D:${d.meals.dinner?.summary || ""}`)
      .join("\n");
    const prompt = [
      "Sen FoodWise AI'sın. Görev: haftalık yemek planından market listesi çıkar.",
      "ÇIKTI sadece liste olsun. Her satır 1 ürün adı. En fazla 10 satır.",
      "",
      `AKTİF MOD: ${ctx.activityMode}`,
      `ACADEMIC MODE: ${ctx.academicMode ? "AÇIK" : "KAPALI"}`,
      `SPOR HEDEFİ: ${state.settings.sportGoal || "(yok)"}`,
      `PROTEİN HEDEFİ: ${state.settings.proteinTarget || "(yok)"}`,
      `KRİTİK (SKT<2g): ${ctx.critical.length ? ctx.critical.join(", ") : "(yok)"}`,
      "",
      "HAFTALIK PLAN:",
      scheduleSummary || "(boş)",
      "",
      `DOLAP: ${compactList(state.fridgeList.map((x) => x.name), { maxItems: 14, maxLen: 28 }).join(", ") || "(boş)"}`,
      "Kural: Dolapta zaten olanları tekrar yazma; sürdürülebilir, az ve net öner.",
    ].join("\n");
    const out = await getAISuggestion(prompt);
    const names = parseSimpleList(out).slice(0, 10);
    if (!names.length) throw new Error("AI market listesi boş geldi.");
    state.marketList = names.map((n) => ({ id: uuid(), name: n, expiryISO: "", kg: 0.5, createdAt: Date.now() }));
    saveState({ marketList: state.marketList });
    setMarketSummary(`Plan → Market (AI): ${offlineMarketSummary(ctx)}`);
  } catch {
    const list = generateMarketFromPlanOffline();
    if (list.length) {
      state.marketList = list.map((n) => ({ id: uuid(), name: n, expiryISO: "", kg: 0.5, createdAt: Date.now() }));
      saveState({ marketList: state.marketList });
    }
    setMarketSummary(`Plan → Market (Demo): ${offlineMarketSummary(analyzeMarketContext())}`);
  } finally {
    scheduleUIUpdate();
  }
}

async function aiWeeklyMealPlan() {
  ensurePlanner();
  normalizePlannerMeals();
  const critical = state.fridgeList.filter((x) => daysUntil(x.expiryISO) < 2).map((x) => x.name).slice(0, 6);
  const soon = state.fridgeList
    .filter((x) => daysUntil(x.expiryISO) >= 2 && daysUntil(x.expiryISO) < 5)
    .map((x) => x.name)
    .slice(0, 6);
  const scheduleSummary = state.planner.days
    .map((d, i) => `${DAY_NAMES[i]}: ${(d.schedule || []).map((s) => `${s.start}-${s.end} ${s.title}`).join(" | ") || "(boş)"}`)
    .join("\n");

  const prompt = [
    "Sen FoodWise AI'sın. Görev: Haftalık yemek planı üret.",
    "Kullanıcı üniversite öğrencisi; karar yorgunluğunu azalt.",
    "",
    `AKTİF MOD: ${state.settings.activityMode}`,
    `ACADEMIC MODE: ${state.settings.academicMode ? "AÇIK" : "KAPALI"}`,
    `SPOR HEDEFİ: ${state.settings.sportGoal || "(yok)"}`,
    `PROTEİN HEDEFİ (g/gün): ${state.settings.proteinTarget || "(yok)"}`,
    `DOLAPTAKİ ÜRÜNLER: ${compactList(state.fridgeList.map((x) => x.name), { maxItems: 14, maxLen: 28 }).join(", ") || "(boş)"}`,
    `KRİTİK (SKT<2g): ${critical.length ? critical.join(", ") : "(yok)"}`,
    `YAKIN (SKT<5g): ${soon.length ? soon.join(", ") : "(yok)"}`,
    "",
    "DERS PROGRAMI:",
    scheduleSummary,
    "",
    "Kural: Eğer bir gün 12:00-17:00 arası dolu/yoğunsa, öğle yemeği mutlaka pratik/sandviç/tek kap olsun.",
    "Çıktı formatı: JSON ver. Anahtarlar: mon..sun.",
    "Her gün için: breakfast/lunch/dinner objeleri olsun: { summary, durationMin, recipe }.",
  ].join("\n");

  try {
    const out = await getAISuggestion(prompt);
    let json = null;
    try {
      json = JSON.parse(out);
    } catch {
      // attempt to extract JSON block
      const m = out.match(/\{[\s\S]*\}/);
      if (m) json = JSON.parse(m[0]);
    }
    if (!json) throw new Error("AI JSON formatı okunamadı.");

    const keys = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
    for (let i = 0; i < 7; i += 1) {
      const day = json[keys[i]] || json[DAY_NAMES[i]] || null;
      if (!day) continue;
      const b = day.breakfast || {};
      const l = day.lunch || {};
      const d = day.dinner || {};
      state.planner.days[i].meals.breakfast = {
        summary: String(b.summary || ""),
        durationMin: String(b.durationMin || ""),
        recipe: String(b.recipe || ""),
      };
      state.planner.days[i].meals.lunch = {
        summary: String(l.summary || ""),
        durationMin: String(l.durationMin || ""),
        recipe: String(l.recipe || ""),
      };
      state.planner.days[i].meals.dinner = {
        summary: String(d.summary || ""),
        durationMin: String(d.durationMin || ""),
        recipe: String(d.recipe || ""),
      };
    }
    saveState({ planner: state.planner });
    renderPlanner();
    flashRecipeBox("Haftalık plan AI ile güncellendi.");
  } catch {
    offlineWeeklyMealPlan();
    flashRecipeBox("AI kota/limit nedeniyle plan offline (demo) şekilde dolduruldu.");
  }
}

function offlineMarketSuggestions({ activityMode, academicMode, habitScore }) {
  // Lightweight heuristic suggestions, mode-aware.
  const sporty = activityMode === "Spor";
  const fast = academicMode;
  const base = sporty
    ? ["yoğurt", "yumurta", "ton balığı", "yulaf", "muz", "kuruyemiş"]
    : ["ekmek/lavaş", "peynir", "yoğurt", "domates", "salatalık", "makarna"];
  const extra = fast ? ["hazır salata", "konserve nohut", "dondurulmuş sebze"] : ["soğan", "baharat", "zeytinyağı"];
  const nudge = habitScore.done < habitScore.total ? ["etiket/kalem (SKT için)", "saklama kabı"] : [];
  return [...base, ...extra, ...nudge].slice(0, 6);
}

function analyzeMarketContext() {
  const activityMode = state.settings.activityMode;
  const academicMode = state.settings.academicMode;
  const habitScore = computeHabitScore();

  const critical = state.fridgeList
    .map((x) => ({ name: x.name, d: daysUntil(x.expiryISO) }))
    .filter((x) => x.d < 2)
    .slice(0, 3)
    .map((x) => x.name);

  const soon = state.fridgeList
    .map((x) => ({ name: x.name, d: daysUntil(x.expiryISO) }))
    .filter((x) => x.d >= 2 && x.d < 5)
    .slice(0, 3)
    .map((x) => x.name);

  const staples = ["yoğurt", "yumurta", "ekmek", "peynir", "pirinç", "makarna", "tavuk", "ton balığı"];
  const fridgeLower = state.fridgeList.map((x) => String(x.name).toLowerCase());
  const missingStaples = staples.filter((s) => !fridgeLower.some((n) => n.includes(s))).slice(0, 3);

  return { activityMode, academicMode, habitScore, critical, soon, missingStaples };
}

function offlineMarketSummary(ctx) {
  const mode = `${ctx.activityMode}${ctx.academicMode ? " • Academic" : ""}`;
  const c = ctx.critical.length ? `KRİTİK: ${ctx.critical.join(", ")}.` : "";
  const s = ctx.soon.length ? `Yakın SKT: ${ctx.soon.join(", ")}.` : "";
  const m = ctx.missingStaples.length ? `Eksik temel: ${ctx.missingStaples.join(", ")}.` : "";
  const h = `Alışkanlık: ${ctx.habitScore.done}/${ctx.habitScore.total}.`;
  return `${mode} • ${h} ${c} ${s} ${m}`.replace(/\s+/g, " ").trim();
}

async function refreshMarketSuggestions({ reason = "manual" } = {}) {
  state.settings.marketLoading = true;
  saveState({ settings: state.settings });
  scheduleUIUpdate();

  const ctx = analyzeMarketContext();
  try {
    const prompt = [
      getSystemInstruction(),
      getProfilePromptBlock(),
      "",
      "Görev: Market önerisi üret.",
      "ÇIKTI: SADECE JSON. Şema:",
      '{"summary":"tek cümle", "items":[{"name":"...", "qty":"...", "note":"..."}]}',
      "",
      `SEBEP: ${reason}`,
      `AKTİF MOD: ${ctx.activityMode}`,
      `ACADEMIC MODE: ${ctx.academicMode ? "AÇIK" : "KAPALI"}`,
      `ALIŞKANLIK SKORU (bugün): ${ctx.habitScore.done}/${ctx.habitScore.total}`,
      `KRİTİK (SKT<2g): ${ctx.critical.length ? ctx.critical.join(", ") : "(yok)"}`,
      `YAKIN (SKT<5g): ${ctx.soon.length ? ctx.soon.join(", ") : "(yok)"}`,
      `EKSİK TEMEL ÜRÜNLER: ${ctx.missingStaples.length ? ctx.missingStaples.join(", ") : "(yok)"}`,
      `DOLAPTAKİLER: ${compactList(state.fridgeList.map((x) => x.name), { maxItems: 10, maxLen: 28 }).join(", ") || "(boş)"}`,
      `MEVCUT MARKET: ${compactList(state.marketList.map((x) => x.name), { maxItems: 10, maxLen: 28 }).join(", ") || "(boş)"}`,
      "",
      "Kurallar:",
      "- Spor ise protein+kolay hazırlanır ürünleri öne çıkar.",
      "- Academic Mode açık ise <10dk, minimal bulaşık uyumlu ürün seç.",
      "- İsrafı azalt: az sayıda, net ürün öner.",
    ].join("\n");

    const out = await getAISuggestion(prompt);
    let data = null;
    try {
      data = extractJsonLoose(out);
    } catch {
      data = null;
    }
    const items = Array.isArray(data?.items) ? data.items : [];
    if (items.length) {
      state.marketList = items.slice(0, 10).map((it) => ({
        id: uuid(),
        name: String(it.name || "").trim() || "Ürün",
        expiryISO: "",
        kg: 0.5,
        note: it.note ? String(it.note) : "",
        qty: it.qty ? String(it.qty) : "",
        createdAt: Date.now(),
      }));
      saveState({ marketList: state.marketList });
      setMarketSummary(String(data?.summary || `AI Özeti: ${offlineMarketSummary(ctx)}`));
    } else {
      // fallback if AI returns unusable output
      const offline = offlineMarketSuggestions({
        activityMode: ctx.activityMode,
        academicMode: ctx.academicMode,
        habitScore: ctx.habitScore,
      });
      state.marketList = offline.map((n) => ({ id: uuid(), name: n, expiryISO: "", kg: 0.5, createdAt: Date.now() }));
      saveState({ marketList: state.marketList });
      setMarketSummary(`Demo Özeti: ${offlineMarketSummary(ctx)}`);
    }
  } catch (err) {
    // On 429 or any error: keep app responsive and provide offline suggestions.
    const ctx2 = analyzeMarketContext();
    const offline = offlineMarketSuggestions({
      activityMode: ctx2.activityMode,
      academicMode: ctx2.academicMode,
      habitScore: ctx2.habitScore,
    });
    state.marketList = offline.map((n) => ({ id: uuid(), name: n, expiryISO: "", kg: 0.5, createdAt: Date.now() }));
    saveState({ marketList: state.marketList });
    setMarketSummary(`Demo Özeti: ${offlineMarketSummary(ctx2)}`);
  } finally {
    state.settings.marketLoading = false;
    saveState({ settings: state.settings });
    scheduleUIUpdate();
  }
}

function isPayloadTooLargeHint(status, text) {
  const t = String(text || "").toLowerCase();
  return (
    status === 400 &&
    (t.includes("too large") ||
      t.includes("request is too large") ||
      t.includes("invalid argument") ||
      t.includes("token") ||
      t.includes("max") ||
      t.includes("limit"))
  );
}

function compactList(items, { maxItems = 10, maxLen = 42 } = {}) {
  return (items || [])
    .filter(Boolean)
    .map((x) => String(x).trim())
    .filter(Boolean)
    .slice(0, maxItems)
    .map((x) => (x.length > maxLen ? `${x.slice(0, maxLen - 1)}…` : x));
}

// Global AI status (not persisted; session-only)
const aiStatus = {
  available: true,
  mode: "ok", // ok | degraded | unavailable
  message: "",
  lastErrorAt: 0,
};

function setAiStatus({ available, mode, message }) {
  aiStatus.available = !!available;
  aiStatus.mode = mode || (available ? "ok" : "unavailable");
  aiStatus.message = message || "";
  aiStatus.lastErrorAt = Date.now();
}

function todayLocalISODate() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseKg(value) {
  const normalized = String(value ?? "")
    .trim()
    .replace(",", ".");
  const n = Number.parseFloat(normalized);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function daysUntil(expiryISO) {
  if (!expiryISO) return Infinity;
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const [y, m, d] = expiryISO.split("-").map((x) => Number.parseInt(x, 10));
  if (!y || !m || !d) return Infinity;
  const end = new Date(y, m - 1, d);
  const ms = end.getTime() - start.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function safeJsonParse(raw, fallback) {
  try {
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function loadState() {
  const legacyInventory = safeJsonParse(localStorage.getItem(STORAGE_KEYS.inventory), []);
  const marketList = safeJsonParse(localStorage.getItem(STORAGE_KEYS.market), []);
  const fridgeList = safeJsonParse(localStorage.getItem(STORAGE_KEYS.fridge), []);
  const totals = safeJsonParse(localStorage.getItem(STORAGE_KEYS.totals), {
    savedKg: 0,
    savedCO2Kg: 0,
    consumedCount: 0,
  });
  const settings = safeJsonParse(localStorage.getItem(STORAGE_KEYS.settings), {
    academicMode: false,
    activityMode: "Ders",
    marketLoading: false,
    sportGoal: "",
    proteinTarget: "",
  });
  const chart = safeJsonParse(localStorage.getItem(STORAGE_KEYS.chart), null);
  const habits = safeJsonParse(localStorage.getItem(STORAGE_KEYS.habits), null);
  const planner = safeJsonParse(localStorage.getItem(STORAGE_KEYS.planner), null);
  const profile = safeJsonParse(localStorage.getItem(STORAGE_KEYS.profile), null);
  const events = safeJsonParse(localStorage.getItem(STORAGE_KEYS.events), null);

  // Migration: old single-list inventory -> fridgeList (once)
  const needsMigration =
    Array.isArray(legacyInventory) &&
    legacyInventory.length > 0 &&
    (!Array.isArray(fridgeList) || fridgeList.length === 0) &&
    (!Array.isArray(marketList) || marketList.length === 0);

  if (needsMigration) {
    return {
      marketList: [],
      fridgeList: legacyInventory,
      totals,
      settings,
      chart,
      habits: habits || null,
      planner: planner || null,
      profile: profile || null,
      events: events || null,
    };
  }

  return {
    marketList: Array.isArray(marketList) ? marketList : [],
    fridgeList: Array.isArray(fridgeList) ? fridgeList : [],
    totals,
    settings: { marketLoading: false, sportGoal: "", proteinTarget: "", ...settings },
    chart,
    habits: habits || null,
    planner: planner || null,
    profile: profile || null,
    events: events || null,
  };
}

function saveState(partial) {
  if (partial.marketList) localStorage.setItem(STORAGE_KEYS.market, JSON.stringify(partial.marketList));
  if (partial.fridgeList) localStorage.setItem(STORAGE_KEYS.fridge, JSON.stringify(partial.fridgeList));
  if (partial.totals) localStorage.setItem(STORAGE_KEYS.totals, JSON.stringify(partial.totals));
  if (partial.settings) localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(partial.settings));
  if (partial.chart) localStorage.setItem(STORAGE_KEYS.chart, JSON.stringify(partial.chart));
  if (partial.habits) localStorage.setItem(STORAGE_KEYS.habits, JSON.stringify(partial.habits));
  if (partial.planner) localStorage.setItem(STORAGE_KEYS.planner, JSON.stringify(partial.planner));
  if (partial.profile) localStorage.setItem(STORAGE_KEYS.profile, JSON.stringify(partial.profile));
  if (partial.events) localStorage.setItem(STORAGE_KEYS.events, JSON.stringify(partial.events));
  if (partial.feedback) localStorage.setItem(STORAGE_KEYS.feedback, JSON.stringify(partial.feedback));
}

function resetImpactState({ clearChart = true } = {}) {
  state.totals.savedKg = 0;
  state.totals.savedCO2Kg = 0;
  state.totals.consumedCount = 0;
  saveState({ totals: state.totals });

  if (clearChart) {
    state.chart = { labels: [], savedKg: [], savedCO2Kg: [] };
    localStorage.removeItem(STORAGE_KEYS.chart);
    if (window.myChart) {
      window.myChart.destroy();
      window.myChart = null;
    }
  }

  scheduleUIUpdate();
}

function clearAllData() {
  state.marketList = [];
  state.fridgeList = [];
  state.settings.marketLoading = false;
  saveState({ marketList: state.marketList, fridgeList: state.fridgeList, settings: state.settings });

  localStorage.removeItem(STORAGE_KEYS.market);
  localStorage.removeItem(STORAGE_KEYS.fridge);
  localStorage.removeItem(STORAGE_KEYS.inventory); // legacy
  localStorage.removeItem(STORAGE_KEYS.settings);
  localStorage.removeItem(STORAGE_KEYS.totals);
  localStorage.removeItem(STORAGE_KEYS.chart);
  localStorage.removeItem(STORAGE_KEYS.habits);
  localStorage.removeItem(STORAGE_KEYS.planner);
  localStorage.removeItem(STORAGE_KEYS.profile);
  localStorage.removeItem(STORAGE_KEYS.events);
  localStorage.removeItem(STORAGE_KEYS.feedback);

  resetImpactState({ clearChart: true });
  setRecipeOutput("—");
}

function ensureFeedback() {
  if (state.feedback && state.feedback.version === 1) return;
  state.feedback = { version: 1, items: [] }; // {ts,type,title,body}
  saveState({ feedback: state.feedback });
}

function openModal(id) {
  const el = $(id);
  if (!el) return;
  el.style.display = "flex";
}

function closeModal(id) {
  const el = $(id);
  if (!el) return;
  el.style.display = "none";
}

function ensureProfile() {
  if (state.profile && state.profile.version === 1) return;
  state.profile = {
    version: 1,
    allergies: [],
    dislikes: [],
    dietNotes: "",
    sportGoal: "",
    proteinTarget: "",
  };
  saveState({ profile: state.profile });
}

function ensureEvents() {
  if (state.events && state.events.version === 1) return;
  state.events = { version: 1, history: [] }; // {ts,type,meta}
  saveState({ events: state.events });
}

function logEvent(type, meta) {
  ensureEvents();
  state.events.history.unshift({ ts: Date.now(), type, meta: meta || {} });
  state.events.history = state.events.history.slice(0, 40);
  saveState({ events: state.events });
}

function getProfilePromptBlock() {
  ensureProfile();
  const p = state.profile;
  const allergies = (p.allergies || []).join(", ") || "(yok)";
  const dislikes = (p.dislikes || []).join(", ") || "(yok)";
  const diet = p.dietNotes || "(yok)";
  const sport = p.sportGoal || state.settings.sportGoal || "(yok)";
  const protein = p.proteinTarget || state.settings.proteinTarget || "(yok)";
  const lastEvents = (state.events?.history || []).slice(0, 6);
  const eventsLine = lastEvents.length
    ? lastEvents.map((e) => `${new Date(e.ts).toISOString().slice(0, 10)} ${e.type}`).join(" | ")
    : "(yok)";

  return [
    "KULLANICI PROFİLİ (bellek):",
    `- Alerjiler: ${allergies}`,
    `- Sevmedikleri: ${dislikes}`,
    `- Diyet notu: ${diet}`,
    `- Spor hedefi: ${sport}`,
    `- Protein hedefi: ${protein}`,
    `- Son olaylar: ${eventsLine}`,
  ].join("\n");
}

function getSystemInstruction() {
  return [
    "SYSTEM:",
    "Sen 'Sürdürülebilirlik ve Verimlilik Odaklı Yaşam Mühendisi'sin.",
    "Amaç: karar yorgunluğunu azalt, minimal bulaşık ve hızlı uygulanabilir çözümler üret, israfı düşür.",
    "Kullanıcı profilini (alerji/tercih/hedef) kesinlikle uygula.",
    "Her zaman yapılandırılmış JSON döndür; ek açıklama metni ekleme.",
  ].join("\n");
}

function extractJsonLoose(text) {
  const raw = String(text || "");
  try {
    return JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("JSON parse edilemedi.");
  }
}

function maybeAutoResetImpactWhenEmpty() {
  const isEmpty = (state.marketList?.length || 0) === 0 && (state.fridgeList?.length || 0) === 0;
  if (!isEmpty) return;
  // Requirement: when all products are deleted, reset impact counters.
  resetImpactState({ clearChart: true });
}

function uuid() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `id_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function format1(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "0.0";
  return x.toFixed(1);
}

function getUrgency(expiryISO) {
  const d = daysUntil(expiryISO);
  if (d < 0) return { level: "expired", label: "SKT geçti", color: "var(--danger)" };
  if (d < 2) return { level: "now", label: `${d} gün kaldı`, color: "var(--danger)" };
  if (d < 5) return { level: "soon", label: `${d} gün kaldı`, color: "var(--warning)" };
  if (Number.isFinite(d)) return { level: "ok", label: `${d} gün kaldı`, color: "var(--ok)" };
  return { level: "unknown", label: "SKT yok", color: "rgba(255,255,255,0.5)" };
}

function buildGeminiPrompt({ product, inventoryNames, activityMode, academicMode }) {
  const inv = compactList(inventoryNames, { maxItems: 10, maxLen: 36 });
  const base = [
    getSystemInstruction(),
    getProfilePromptBlock(),
    "",
    "Görev: ACİL ürün için 2 alternatif hızlı tarif üret (A/B).",
    "",
    `ACİL ÜRÜN: ${product.name} (kg: ${product.kg}, SKT: ${product.expiryISO || "bilinmiyor"})`,
    `DOLAPTAKİ ÜRÜNLER (kısa): ${inv.length ? inv.join(", ") : "(boş)"}`,
    `AKTİF AKTİVİTE MODU: ${activityMode}`, // Spor/Ders
    `ACADEMIC MODE (Vize/Final): ${academicMode ? "AÇIK" : "KAPALI"}`,
    "",
    "ÇIKTI: SADECE JSON. Şema:",
    "{",
    '  "mode": {"activity":"Spor|Ders","academic":true|false},',
    '  "recipes": [',
    '    {"title":"...", "durationMin": 9, "minimalDish":"...", "ingredients":["..."], "steps":["..."], "wasteTip":"...", "storageTip":"..."},',
    '    {"title":"...", "durationMin": 8, "minimalDish":"...", "ingredients":["..."], "steps":["..."], "wasteTip":"...", "storageTip":"..."}',
    "  ]",
    "}",
  ];

  if (academicMode) {
    base.push(
      "",
      "FORMAT (Academic Mode zorunlu):",
      "- Başlık (1 satır)",
      "- Süre: <10 dk",
      "- Minimal bulaşık (1 cümle)",
      "- Malzemeler: en fazla 6 madde",
      "- Adımlar: en fazla 5 adım, her adım 1 satır",
      "- 1 tane 'B planı' (ürün yoksa/eksikse)",
      "- Son satır: 'Kalanı nasıl saklarsın?' (1 cümle)"
    );
  } else {
    base.push(
      "",
      "FORMAT:",
      "- 2 farklı hızlı tarif (A/B)",
      "- Her biri için: süre, malzeme listesi, 4-6 adım",
      "- Atık azaltma ipucu (1 madde)",
      "- Kalanı saklama önerisi (1 madde)"
    );
  }

  return base.join("\n");
}

function buildSustainabilityFactPrompt({ product, activityMode, academicMode }) {
  return [
    "Sen FoodWise AI'sın: sürdürülebilirlik odaklı, kısa ve net bilgi veren bir koçsun.",
    "Kullanıcı üniversite öğrencisi; metin maksimum 5-6 satır olsun.",
    "",
    `BİLGİ İSTEĞİ: Bu ürün tüketildi → sürdürülebilirlik odaklı kısa bir bilgi ver.`,
    `ÜRÜN: ${product.name} (kg: ${product.kg}, SKT: ${product.expiryISO || "bilinmiyor"})`,
    `AKTİF AKTİVİTE MODU: ${activityMode}`,
    `ACADEMIC MODE: ${academicMode ? "AÇIK" : "KAPALI"}`,
    `DOLAP ÖZETİ: ${compactList(state.fridgeList?.map((x) => x.name) || [], { maxItems: 8, maxLen: 28 }).join(", ") || "(boş)"}`,
    `MARKET ÖZETİ: ${compactList(state.marketList?.map((x) => x.name) || [], { maxItems: 8, maxLen: 28 }).join(", ") || "(boş)"}`,
    "",
    "FORMAT:",
    "- 1 cümle: neden iyi bir aksiyon (israf/CO₂ açısından)",
    "- 1 madde: pratik mikro-alışkanlık (yarın için)",
    "- 1 madde: saklama/planlama tüyosu (kalan alışveriş için)",
  ].join("\n");
}

function sanitizeTotalsOnLoad() {
  const t = state.totals || {};
  const savedKg = Number(t.savedKg || 0);
  const savedCO2Kg = Number(t.savedCO2Kg || 0);
  const consumedCount = Number(t.consumedCount || 0);
  const listEmpty = (state.marketList?.length || 0) === 0 && (state.fridgeList?.length || 0) === 0;

  // Zombie/default guard: if lists are empty and we have suspicious non-zero totals, reset.
  const suspicious =
    listEmpty &&
    consumedCount === 0 &&
    (savedKg > 0.001 || savedCO2Kg > 0.001);

  if (suspicious || !Number.isFinite(savedKg) || !Number.isFinite(savedCO2Kg) || !Number.isFinite(consumedCount)) {
    resetImpactState({ clearChart: true });
  }
}

async function geminiGenerateText(prompt) {
  const apiKey = getApiKey();
  if (!apiKey || apiKey === "...") {
    throw new Error("API_KEY yok. app.js içindeki API_KEY alanını doldurun.");
  }
  const p = String(prompt || "").trim();
  if (!p) throw new Error("AI prompt boş gönderildi (prompt injection/bağlantı hatası).");

  if (DEBUG_AI) {
    // You can verify which key is being used without leaking it fully.
    console.log("[FoodWise AI] apiKey source:", getApiKeySource(), "apiKey:", maskKey(apiKey));
    console.log("[FoodWise AI] model candidates:", GEMINI_MODEL_CANDIDATES);
  }

  const modelToUse = await resolveGeminiModel(apiKey);

  async function callModel(modelName) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      modelName
    )}:generateContent?key=${encodeURIComponent(apiKey)}`;

    if (DEBUG_AI) console.log("[FoodWise AI] request url:", url.replace(apiKey, maskKey(apiKey)));

    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), GEMINI_FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: p }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 450,
        },
      }),
    });
    clearTimeout(to);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err = new Error(
        `Gemini hata: ${res.status} ${res.statusText}${text ? ` • ${text}` : ""}`
      );
      err.status = res.status;
      err.bodyText = text;
      err.model = modelName;
      throw err;
    }

    const data = await res.json();
    const out =
      data?.candidates?.[0]?.content?.parts?.map((pp) => pp?.text).filter(Boolean).join("") ?? "";
    if (!out.trim()) throw new Error("Gemini yanıtı boş geldi.");
    return out.trim();
  }

  return await callModel(modelToUse);
}

async function getAISuggestion(prompt) {
  // Serialize + throttle all Gemini requests to avoid 429 on free tier.
  geminiQueue = geminiQueue.then(async () => {
    if (isInCooldown()) {
      const left = Math.ceil((geminiCooldownUntil - Date.now()) / 1000);
      const err = new Error(`Cooldown aktif. ${left}s sonra tekrar deneyin.`);
      err.status = 429;
      err.bodyText = "RESOURCE_EXHAUSTED (client cooldown)";
      throw err;
    }

    const now = Date.now();
    const wait = GEMINI_MIN_INTERVAL_MS - (now - geminiLastRequestAt);
    if (wait > 0) await sleep(wait);

    let attempt = 0;
    let lastErr = null;
    const startedAt = Date.now();

    while (attempt <= GEMINI_MAX_RETRIES) {
      try {
        geminiLastRequestAt = Date.now();
        const out = await geminiGenerateText(prompt);
        setAiStatus({ available: true, mode: "ok", message: "" });
        return out;
      } catch (e) {
        lastErr = e;
        const status = e?.status;
        const bodyText = e?.bodyText || e?.message || "";

        if (isRateLimitError(status, bodyText)) {
          startCooldown(10000);
          setAiStatus({
            available: true,
            mode: "degraded",
            message:
              "AI kotası dolu olabilir (429). 10 saniye sonra tekrar deneyin veya manuel devam edin.",
          });
          throw e;
        }

        if (status === 401 || status === 403) {
          setAiStatus({
            available: false,
            mode: "unavailable",
            message:
              "AI yetkilendirme hatası (401/403). API key geçersiz/kısıtlı olabilir. Manuel devam edin.",
          });
          throw e;
        }

        if (isPayloadTooLargeHint(status, bodyText)) {
          setAiStatus({
            available: true,
            mode: "degraded",
            message: "AI isteği çok büyük. Bağlamı azaltıp tekrar deneyin.",
          });
          const err = new Error(
            "İstek boyutu çok büyük olabilir. Dolap bağlamını kısaltıp tekrar deneyin."
          );
          err.cause = e;
          throw err;
        }

        setAiStatus({
          available: false,
          mode: "unavailable",
          message:
            "AI bağlantısı şu an sorunlu. Manuel devam edin (detay için hata özetine bakın).",
        });
        throw e;
      }
    }

    throw lastErr || new Error("Gemini isteği başarısız.");
  });

  return await geminiQueue;
}

let state = loadState();
let chartInstance = null;
window.myChart = window.myChart ?? null;

// ensure optional slices exist
ensureFeedback();

function getChartDataTemplate() {
  const fallback = {
    labels: [],
    savedKg: [],
    savedCO2Kg: [],
  };
  if (!state.chart) return fallback;
  if (!Array.isArray(state.chart.labels)) return fallback;
  return {
    labels: state.chart.labels.slice(0, 14),
    savedKg: Array.isArray(state.chart.savedKg) ? state.chart.savedKg.slice(0, 14) : [],
    savedCO2Kg: Array.isArray(state.chart.savedCO2Kg) ? state.chart.savedCO2Kg.slice(0, 14) : [],
  };
}

function ensureMockChartDataIfEmpty() {
  const cd = getChartDataTemplate();
  if (cd.labels.length) return;
  const labels = [];
  const savedKg = [];
  const savedCO2Kg = [];
  let totalKg = 2.2;
  let totalCO2 = 5.0;
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    labels.push(`${mm}-${dd}`);
    // small realistic increments
    totalKg += 0.2 + (i % 3) * 0.05;
    totalCO2 += 0.5 + (i % 4) * 0.12;
    savedKg.push(Number(totalKg.toFixed(2)));
    savedCO2Kg.push(Number(totalCO2.toFixed(2)));
  }
  state.chart = { labels, savedKg, savedCO2Kg, __mock: true };
  saveState({ chart: state.chart });
}

let chartVersion = 0;

function ensureChart({ forceRecreate = false } = {}) {
  const canvas = $("impact-chart");
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  const cd = getChartDataTemplate();

  // FIX: do not recreate chart on every update (prevents scaling/responsive loops).
  if (!forceRecreate && window.myChart && window.myChart.canvas === canvas) {
    window.myChart.data.labels = cd.labels;
    window.myChart.data.datasets[0].data = cd.savedKg;
    window.myChart.data.datasets[1].data = cd.savedCO2Kg;
    window.myChart.update("none");
    chartInstance = window.myChart;
    return;
  }

  if (window.myChart) {
    window.myChart.destroy();
    window.myChart = null;
  }

  window.myChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: cd.labels,
      datasets: [
        {
          label: "Kurtarılan (kg)",
          data: cd.savedKg,
          borderColor: "rgba(16, 185, 129, 0.95)",
          backgroundColor: "rgba(16, 185, 129, 0.12)",
          fill: true,
          tension: 0.35,
          pointRadius: 3,
        },
        {
          label: "CO₂ Tasarrufu (kg)",
          data: cd.savedCO2Kg,
          borderColor: "rgba(255, 255, 255, 0.55)",
          backgroundColor: "rgba(255, 255, 255, 0.08)",
          fill: true,
          tension: 0.35,
          pointRadius: 3,
        },
      ],
    },
    options: {
      // REQUIRED: avoids layout/scale thrash when canvas is in fixed-height wrapper.
      responsive: true,
      maintainAspectRatio: false,
      resizeDelay: 150,
      animation: false,
      plugins: {
        legend: {
          labels: { color: "rgba(255,255,255,0.7)" },
        },
        tooltip: {
          mode: "index",
          intersect: false,
        },
      },
      scales: {
        x: {
          ticks: { color: "rgba(255,255,255,0.55)" },
          grid: { color: "rgba(255,255,255,0.06)" },
        },
        y: {
          ticks: { color: "rgba(255,255,255,0.55)" },
          grid: { color: "rgba(255,255,255,0.06)" },
        },
      },
    },
  });

  chartInstance = window.myChart;
}

function bumpChartOnConsume({ kgDelta, co2Delta }) {
  const label = todayLocalISODate().slice(5); // MM-DD
  const cd = getChartDataTemplate();

  // If we had mock data, start from current KPI totals to avoid jumps.
  const prevTotalKg = cd.savedKg.length ? cd.savedKg[0] : Number(state.totals.savedKg || 0);
  const prevTotalCO2 = cd.savedCO2Kg.length ? cd.savedCO2Kg[0] : Number(state.totals.savedCO2Kg || 0);

  if (cd.labels[0] === label) {
    cd.savedKg[0] = Number((prevTotalKg + kgDelta).toFixed(3));
    cd.savedCO2Kg[0] = Number((prevTotalCO2 + co2Delta).toFixed(3));
  } else {
    cd.labels.unshift(label);
    cd.savedKg.unshift(Number((prevTotalKg + kgDelta).toFixed(3)));
    cd.savedCO2Kg.unshift(Number((prevTotalCO2 + co2Delta).toFixed(3)));
  }

  cd.labels = cd.labels.slice(0, 14);
  cd.savedKg = cd.savedKg.slice(0, 14);
  cd.savedCO2Kg = cd.savedCO2Kg.slice(0, 14);

  state.chart = cd;
  saveState({ chart: state.chart });
  chartVersion += 1;
  ensureChart({ forceRecreate: chartVersion % 1 === 0 }); // force repaint for reliability
}

function updateRecipeHint() {
  const el = $("recipe-mode-hint");
  if (!el) return;
  el.textContent = state.settings.academicMode ? "• Vize/Final formatı" : "• Standart format";
}

function updateKPIs() {
  $("saved-kg").textContent = format1(state.totals.savedKg);
  $("saved-co2").textContent = format1(state.totals.savedCO2Kg);
  $("items-count").textContent = String(state.fridgeList.length);
}

function updateImpactCounters() {
  updateKPIs();
}

function calculateSustainabilityMetrics() {
  // Keep derived totals consistent (and ensure UI refresh happens through one path).
  // Previously tied CO2 to consumedCount; now we support partial consumption, so keep CO2 as its own accumulator.
  if (!Number.isFinite(Number(state.totals.savedKg))) state.totals.savedKg = 0;
  if (!Number.isFinite(Number(state.totals.savedCO2Kg))) state.totals.savedCO2Kg = 0;
  if (!Number.isFinite(Number(state.totals.consumedCount))) state.totals.consumedCount = 0;
}

function buildSportMarketPrompt({ activityMode, academicMode, fridgeNames, marketNames }) {
  const fridge = compactList(fridgeNames, { maxItems: 10, maxLen: 28 });
  const market = compactList(marketNames, { maxItems: 10, maxLen: 28 });
  return [
    "Sen FoodWise AI'sın: hızlı alışveriş planı öneren bir koçsun.",
    "ÇIKTI sadece liste olsun. Her satır 1 ürün adı. En fazla 6 satır.",
    "",
    `AKTİF MOD: ${activityMode}`,
    `ACADEMIC MODE: ${academicMode ? "AÇIK" : "KAPALI"}`,
    `DOLAPTAKİLER: ${fridge.length ? fridge.join(", ") : "(boş)"}`,
    `MEVCUT MARKET LİSTESİ: ${market.length ? market.join(", ") : "(boş)"}`,
    "",
    "Hedef: Eğer 'Spor' ise protein/kolay hazırlanır ürünlere ağırlık ver. Eğer 'Ders' ise minimal bulaşık + hızlı ürünler.",
  ].join("\n");
}

function parseSimpleList(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^[-*\d.]+\s*/, ""))
    .filter(Boolean)
    .slice(0, 6);
}

function getAIOutputEl() {
  return $("ai-output") || $("recipe-output");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return c;
    }
  });
}

function renderMarketList() {
  const list = $("market-list");
  const items = Array.isArray(state.marketList) ? state.marketList : [];

  if (state.settings?.marketLoading) {
    list.innerHTML =
      '<li class="item"><div class="item-meta"><div class="item-name">Market önerileri yükleniyor…</div><div class="pill"><i class="fa-solid fa-rotate"></i> Spor/Ders moduna göre güncelleniyor</div></div><div class="actions"><button class="btn secondary" type="button" disabled><i class="fa-solid fa-hourglass"></i> Bekle</button></div></li>';
    return;
  }

  if (!items.length) {
    list.innerHTML =
      '<li class="item"><div class="item-meta"><div class="item-name">Market list boş</div><div class="pill"><i class="fa-solid fa-lightbulb"></i> Marketten alınacakları buraya ekle.</div></div><div class="actions"><button class="btn secondary" type="button" disabled><i class="fa-solid fa-plus"></i> Ekle</button></div></li>';
    return;
  }

  const html = items
    .map((item) => {
      const name = escapeHtml(item.name);
      const kg = escapeHtml(item.kg);
      const qty = item.qty ? `<div class="pill" style="border-color:rgba(255,255,255,0.10)"><i class="fa-solid fa-scale-balanced"></i> ${escapeHtml(item.qty)}</div>` : "";
      const note = item.note
        ? `<div class="pill" style="border-color:rgba(249,115,22,0.25); background: rgba(249,115,22,0.06)"><strong style="color:var(--warning)">${escapeHtml(item.note)}</strong></div>`
        : "";
      return `<li class="item" data-id="${item.id}">
  <div class="item-meta">
    <div class="item-name">${name}</div>
    <div class="pill" style="border-color:rgba(255,255,255,0.10)">
      <i class="fa-solid fa-cart-shopping"></i> Market • ${kg} kg
    </div>
    ${qty}
    ${note}
  </div>
  <div class="actions">
    <button class="btn" type="button" data-action="to-fridge">
      <i class="fa-solid fa-box-open"></i> Dolaba Taşı
    </button>
    <button class="btn secondary" type="button" data-action="remove-market">
      <i class="fa-solid fa-trash"></i> Kaldır
    </button>
  </div>
</li>`;
    })
    .join("");

  list.innerHTML = html;
}

function renderFridgeList() {
  const list = $("fridge-list");
  if (!list) return;

  const sorted = [...state.fridgeList].sort((a, b) => {
    const da = daysUntil(a.expiryISO);
    const db = daysUntil(b.expiryISO);
    return da - db;
  });

  if (!sorted.length) {
    list.innerHTML =
      '<li class="item"><div class="item-meta"><div class="item-name">Dolap boş</div><div class="pill"><i class="fa-solid fa-box"></i> Dolaba ürün ekle veya marketten taşı.</div></div><div class="actions"><button class="btn secondary" type="button" disabled><i class="fa-solid fa-bolt"></i> Şimdi Tüket</button></div></li>';
    return;
  }

  list.innerHTML = sorted
    .map((item) => {
      const urgency = getUrgency(item.expiryISO);
      const d = daysUntil(item.expiryISO);
      const isCritical = d < 2;
      const isFreezeSoon = d < 5;
      const name = escapeHtml(item.name);
      const expiry = escapeHtml(item.expiryISO || "—");
      const kg = escapeHtml(item.kg);
      const criticalBadge =
        d < 2
          ? `<div class="badge-critical"><span class="pulse-dot"></span> KRİTİK</div>`
          : "";
      const freezeHint = isFreezeSoon
        ? `<div class="pill" style="border-color:rgba(249,115,22,0.25); background: rgba(249,115,22,0.06)"><i class="fa-solid fa-snowflake"></i> <strong style="color:var(--warning)">Saklama önerisi</strong> • SKT yakın</div>`
        : `<div class="pill" style="border-color:rgba(255,255,255,0.10)"><i class="fa-solid fa-info-circle"></i> Saklama ipucu (opsiyonel)</div>`;

      return `<li class="item" data-id="${item.id}">
  <div class="item-meta">
    <div class="item-name">${name}</div>
    ${criticalBadge}
    <div class="pill" style="border-color:rgba(255,255,255,0.10)">
      <i class="fa-regular fa-clock"></i>
      <strong style="color:${urgency.color}">${escapeHtml(urgency.label)}</strong>
      • ${kg} kg • SKT: ${expiry}
    </div>
    ${freezeHint}
  </div>
  <div class="actions">
    <button class="btn ${isCritical ? "danger" : ""}" type="button" data-action="consume">
      <i class="fa-solid ${isCritical ? "fa-bolt" : "fa-check"}"></i> ${isCritical ? "🔴 ŞİMDİ TÜKET" : "✅ TÜKETİLDİ"}
    </button>
    <button class="btn ${isFreezeSoon ? "warning" : "secondary"}" type="button" data-action="freeze" title="${isFreezeSoon ? "SKT yaklaştı: sakla/dondur" : "İstersen saklama ipucu al"}">
      <i class="fa-solid fa-snowflake"></i> ${isFreezeSoon ? "🟠 DONDUR/SAKLA" : "💡 SAKLAMA İPUCU"}
    </button>
    <button class="btn secondary" type="button" data-action="remove-fridge">
      <i class="fa-solid fa-trash"></i> Kaldır
    </button>
  </div>
</li>`;
    })
    .join("");
}

function scheduleUIUpdate() {
  uiDirty = true;
  if (uiRaf) return;
  uiRaf = requestAnimationFrame(() => {
    uiRaf = 0;
    if (!uiDirty) return;
    uiDirty = false;
    updateUI();
  });
}

function updateUI() {
  calculateSustainabilityMetrics();
  updateKPIs();
  renderMarketList();
  renderFridgeList();
  ensureChart();
  renderHabits();
  renderPlanner();
}

function addItemFromInputs() {
  const name = $("item-name").value.trim();
  const expiryISO = $("item-expiry").value || "";
  const kg = parseKg($("item-weight").value);
  const location = $("item-location")?.value || "fridge";

  if (!name) {
    flashRecipeBox("Ürün adı boş olamaz.");
    return;
  }
  if (!kg) {
    flashRecipeBox("Ağırlık (kg) gir. Örn: 0.5");
    return;
  }

  const item = { id: uuid(), name, expiryISO: location === "market" ? "" : expiryISO, kg, createdAt: Date.now() };
  if (location === "market") state.marketList.push(item);
  else state.fridgeList.push(item);

  saveState({ marketList: state.marketList, fridgeList: state.fridgeList });
  $("item-name").value = "";
  $("item-weight").value = "";
  $("item-expiry").value = "";

  scheduleUIUpdate();
}

function removeMarketItem(id) {
  state.marketList = state.marketList.filter((x) => x.id !== id);
  saveState({ marketList: state.marketList });
  scheduleUIUpdate();
  maybeAutoResetImpactWhenEmpty();
}

function removeFridgeItem(id) {
  state.fridgeList = state.fridgeList.filter((x) => x.id !== id);
  saveState({ fridgeList: state.fridgeList });
  scheduleUIUpdate();
  maybeAutoResetImpactWhenEmpty();
}

function moveMarketToFridge(id) {
  const idx = state.marketList.findIndex((x) => x.id === id);
  if (idx === -1) return;
  const item = state.marketList[idx];
  state.marketList.splice(idx, 1);
  // When moving, set an expiry only if user had chosen one previously; otherwise keep empty.
  state.fridgeList.push({ ...item, expiryISO: item.expiryISO || "" });
  saveState({ marketList: state.marketList, fridgeList: state.fridgeList });
  scheduleUIUpdate();
}

function freezeSuggestion(id) {
  const item = state.fridgeList.find((x) => x.id === id);
  if (!item) return;

  const d = daysUntil(item.expiryISO);
  const msg = [
    `“${item.name}” için hızlı saklama önerisi:`,
    "",
    d < 2
      ? "- KRİTİK: Bugün porsiyonlayıp dondur. Etiketle (tarih + içerik)."
      : d < 5
        ? "- SKT yakın: Porsiyonla, hava almayan kap/poşet kullan, etiketle (tarih + içerik)."
        : "- Opsiyonel: Daha uzun dayanması için porsiyonla ve kapalı kapta sakla.",
    "- Buzdolabı: öne koy (görünürlük = karar yorgunluğu azalır).",
    "- Dondurucu: düzleştirerek dondur (daha hızlı çözünür).",
    "",
    "Not: Bu buton her zaman aktiftir; SKT yaklaştığında turuncu olarak vurgulanır.",
  ].join("\n");

  setRecipeOutput(msg);
}

function flashRecipeBox(text) {
  setRecipeOutput(text);
  const pre = $("recipe-output");
  if (!pre) return;
  pre.style.opacity = "0.75";
  setTimeout(() => {
    pre.style.opacity = "1";
  }, 380);
}

function setRecipeOutput(text) {
  const el = getAIOutputEl();
  if (!el) return;
  el.textContent = text;
}

async function consumeItem(id) {
  const idx = state.fridgeList.findIndex((x) => x.id === id);
  if (idx === -1) return;

  const product = state.fridgeList[idx];
  const originalKg = Number(product.kg || 0);
  if (!Number.isFinite(originalKg) || originalKg <= 0) {
    flashRecipeBox("Ürün ağırlığı geçersiz. Lütfen ürünü düzenleyip tekrar deneyin.");
    return;
  }

  // Portion control: allow partial consumption.
  const input = prompt(
    `Ne kadar tükettin? (kg)\n\nÜrün: ${product.name}\nMevcut: ${originalKg} kg\n\nTamamını tükettiysen ${originalKg} yaz.`,
    String(originalKg)
  );
  if (input === null) return; // cancelled
  const consumedKg = parseKg(input);
  if (!consumedKg || consumedKg <= 0) {
    flashRecipeBox("Geçersiz miktar. Örn: 0.5");
    return;
  }
  const finalConsumed = Math.min(consumedKg, originalKg);
  const remainingKg = Number((originalKg - finalConsumed).toFixed(3));

  if (remainingKg > 0.0001) {
    // keep item in fridge with updated weight
    state.fridgeList[idx] = { ...product, kg: remainingKg };
    logEvent("consumed_partial", { name: product.name, consumedKg: finalConsumed, remainingKg });
  } else {
    // remove from fridge
    state.fridgeList.splice(idx, 1);
    // add missing to market with note
    state.marketList.push({
      id: uuid(),
      name: `${product.name} (Eksik)`,
      expiryISO: "",
      kg: originalKg,
      note: "Eksik",
      qty: "yenile",
      createdAt: Date.now(),
    });
    logEvent("consumed_empty", { name: product.name, consumedKg: finalConsumed });
  }

  const kgDelta = finalConsumed;
  const co2Delta = Number((CO2_SAVED_PER_ITEM_KG * (finalConsumed / originalKg)).toFixed(3));

  state.totals.savedKg = Number((state.totals.savedKg + kgDelta).toFixed(3));
  state.totals.savedCO2Kg = Number((state.totals.savedCO2Kg + co2Delta).toFixed(3));
  state.totals.consumedCount = Number((state.totals.consumedCount ?? 0) + (finalConsumed / originalKg));

  saveState({ fridgeList: state.fridgeList, marketList: state.marketList, totals: state.totals });
  bumpChartOnConsume({ kgDelta, co2Delta });
  scheduleUIUpdate();
  updateImpactCounters();
  // Automation bridge: next market suggestion should consider the consumption.
  refreshMarketSuggestions({ reason: "post_consume_bridge" });

  setRecipeOutput("Acil tarif hazırlanıyor…");

  try {
    // Manual flow must continue even if AI is unavailable (this only fills the AI box).
    const prompt = buildGeminiPrompt({
      product,
      inventoryNames: state.fridgeList.map((x) => x.name),
      activityMode: state.settings.activityMode,
      academicMode: state.settings.academicMode,
    });
    const out = await getAISuggestion(prompt);
    setRecipeOutput(out);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = err?.status;
    const bodyText = err?.bodyText || err?.message || "";

    if (isRateLimitError(status, bodyText)) {
      setRecipeOutput(
        offlineRecipeAlternatives({
          product,
          activityMode: state.settings.activityMode,
          academicMode: state.settings.academicMode,
        })
      );
      return;
    }

    const diag = DEBUG_AI ? `\n\n---\n${summarizeHttpError(err)}` : "";
    setRecipeOutput(`${aiStatus.message ? `${aiStatus.message}\n\n` : ""}AI cevap üretemedi.\n\nHata: ${msg}${diag}`);
  }
}

// Backward compatibility for earlier wiring
async function consumeNow(id) {
  return await consumeItem(id);
}

function hydrateSettingsUI() {
  const academicToggle = $("academic-toggle");
  academicToggle.checked = !!state.settings.academicMode;
  const activityMode = $("activity-mode");
  activityMode.value = state.settings.activityMode || "Ders";
  updateRecipeHint();

  const sg = $("sport-goal-input");
  if (sg) sg.value = state.settings.sportGoal || "";
  const pt = $("protein-target-input");
  if (pt) pt.value = state.settings.proteinTarget || "";

  ensureProfile();
  const a = $("allergies-input");
  if (a) a.value = (state.profile.allergies || []).join(", ");
  const d = $("dislikes-input");
  if (d) d.value = (state.profile.dislikes || []).join(", ");
  const dn = $("diet-notes-input");
  if (dn) dn.value = state.profile.dietNotes || "";
}

function bindUI() {
  if (listenersBound) return;
  listenersBound = true;

  $("item-expiry").min = todayLocalISODate();
  $("add-btn").addEventListener("click", addItemFromInputs);
  $("clear-ai-btn")?.addEventListener("click", () => setRecipeOutput("—"));
  $("reset-impact-btn")?.addEventListener("click", () => resetImpactState({ clearChart: true }));
  $("reset-btn")?.addEventListener("click", () => clearAllData());

  $("save-key-btn")?.addEventListener("click", () => {
    const v = $("api-key-input")?.value?.trim();
    if (!v) {
      flashRecipeBox("API Key boş. Lütfen key yapıştırın.");
      return;
    }
    localStorage.setItem("foodwise.apiKey", v);
    if (typeof window !== "undefined") window.FOODWISE_API_KEY = v;
    resolvedGeminiModel = null; // force re-resolve with new key
    flashRecipeBox("API Key kaydedildi. Şimdi tekrar AI aksiyonu deneyin.");
  });

  $("refresh-market-btn")?.addEventListener("click", () => {
    refreshMarketSuggestions({ reason: "manual_refresh" });
  });
  $("reset-habits-btn")?.addEventListener("click", () => {
    resetHabits();
    refreshMarketSuggestions({ reason: "habits_reset" });
  });

  $("habits-list")?.addEventListener("click", (e) => {
    const li = e.target?.closest?.("li.item[data-habit]");
    if (!li) return;
    const id = li.dataset.habit;
    if (!id) return;
    toggleHabit(id);
    refreshMarketSuggestions({ reason: "habit_toggle" });
  });

  $("academic-toggle").addEventListener("change", (e) => {
    state.settings.academicMode = !!e.target.checked;
    saveState({ settings: state.settings });
    updateRecipeHint();
    flashRecipeBox(
      state.settings.academicMode
        ? "Academic Mode aktif: tarifler <10 dk + minimal bulaşık formatında üretilecek."
        : "Academic Mode kapalı: tarifler standart formatta üretilecek."
    );
    refreshMarketSuggestions({ reason: "academic_toggle" });
  });

  $("activity-mode").addEventListener("change", (e) => {
    state.settings.activityMode = e.target.value || "Ders";
    saveState({ settings: state.settings });
    flashRecipeBox(`Aktivite modu: ${state.settings.activityMode} • Market önerileri yenileniyor…`);
    refreshMarketSuggestions({ reason: "activity_mode_change" });
  });

  $("item-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addItemFromInputs();
  });
  $("item-weight").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addItemFromInputs();
  });

  $("market-list").addEventListener("click", (e) => {
    const btn = e.target?.closest?.("button[data-action]");
    if (!btn) return;
    const li = btn.closest("li.item[data-id]");
    const id = li?.dataset?.id;
    if (!id) return;

    const action = btn.dataset.action;
    if (action === "to-fridge") moveMarketToFridge(id);
    else if (action === "remove-market") removeMarketItem(id);
  });

  $("fridge-list")?.addEventListener("click", (e) => {
    const btn = e.target?.closest?.("button[data-action]");
    if (!btn) return;
    const li = btn.closest("li.item[data-id]");
    const id = li?.dataset?.id;
    if (!id) return;

    const action = btn.dataset.action;
    if (action === "consume") consumeItem(id);
    else if (action === "freeze") freezeSuggestion(id);
    else if (action === "remove-fridge") removeFridgeItem(id);
  });

  $("ai-plan-btn")?.addEventListener("click", () => {
    aiWeeklyMealPlan();
  });
  $("clear-plan-btn")?.addEventListener("click", () => {
    clearPlanner();
  });
  $("plan-to-market-btn")?.addEventListener("click", () => {
    flashRecipeBox("Plan’dan market listesi çıkarılıyor…");
    generateMarketFromPlan();
  });
  $("plan-variety-btn")?.addEventListener("click", () => {
    offlineWeeklyMealPlan();
    flashRecipeBox("Çeşitli & sürdürülebilir offline plan oluşturuldu.");
  });

  // Defensive: also bind via onclick in case some overlay blocks delegated clicks
  const ptm = $("plan-to-market-btn");
  if (ptm) {
    ptm.onclick = () => {
      flashRecipeBox("Plan’dan market listesi çıkarılıyor…");
      generateMarketFromPlan();
    };
  }

  $("sport-goal-input")?.addEventListener("input", (e) => {
    state.settings.sportGoal = e.target.value;
    saveState({ settings: state.settings });
  });
  $("protein-target-input")?.addEventListener("input", (e) => {
    state.settings.proteinTarget = e.target.value;
    saveState({ settings: state.settings });
  });

  $("save-profile-btn")?.addEventListener("click", () => {
    ensureProfile();
    const allergies = ($("allergies-input")?.value || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    const dislikes = ($("dislikes-input")?.value || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    const dietNotes = ($("diet-notes-input")?.value || "").trim();
    state.profile.allergies = allergies;
    state.profile.dislikes = dislikes;
    state.profile.dietNotes = dietNotes;
    state.profile.sportGoal = state.settings.sportGoal || state.profile.sportGoal || "";
    state.profile.proteinTarget = state.settings.proteinTarget || state.profile.proteinTarget || "";
    saveState({ profile: state.profile });
    flashRecipeBox("Profil kaydedildi. AI artık tercihlerini hatırlayacak.");
  });

  $("meal-modal-close")?.addEventListener("click", () => closeMealModal());
  $("meal-modal")?.addEventListener("click", (e) => {
    if (e.target?.id === "meal-modal") closeMealModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMealModal();
  });

  // Feedback
  $("feedback-btn")?.addEventListener("click", () => openModal("feedback-modal"));
  $("feedback-footer-btn")?.addEventListener("click", () => openModal("feedback-modal"));
  $("feedback-close")?.addEventListener("click", () => closeModal("feedback-modal"));
  $("feedback-modal")?.addEventListener("click", (e) => {
    if (e.target?.id === "feedback-modal") closeModal("feedback-modal");
  });
  $("feedback-clear")?.addEventListener("click", () => {
    $("feedback-title").value = "";
    $("feedback-body").value = "";
  });
  $("feedback-submit")?.addEventListener("click", () => {
    ensureFeedback();
    const title = ($("feedback-title")?.value || "").trim();
    const body = ($("feedback-body")?.value || "").trim();
    const type = $("feedback-type")?.value || "Other";
    if (!title && !body) {
      flashRecipeBox("Geri bildirim boş. Başlık veya açıklama yaz.");
      return;
    }
    state.feedback.items.unshift({ ts: Date.now(), type, title, body });
    state.feedback.items = state.feedback.items.slice(0, 100);
    saveState({ feedback: state.feedback });
    flashRecipeBox("Geri bildirim kaydedildi. Teşekkürler!");
    $("feedback-title").value = "";
    $("feedback-body").value = "";
    closeModal("feedback-modal");
  });

  $("planner-grid")?.addEventListener("click", (e) => {
    const btn = e.target?.closest?.("button[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const dayIdx = Number(btn.dataset.day);
    if (!Number.isFinite(dayIdx)) return;
    if (action === "add-slot") addScheduleSlot(dayIdx);
    if (action === "del-slot") deleteScheduleSlot(dayIdx, btn.dataset.id);
    if (action === "open-meal") showMealDetails(dayIdx, btn.dataset.meal);
  });

  $("planner-grid")?.addEventListener("input", (e) => {
    const ta = e.target?.closest?.("textarea[data-action='meal']");
    if (!ta) return;
    const dayIdx = Number(ta.dataset.day);
    const meal = ta.dataset.meal;
    if (!Number.isFinite(dayIdx) || !meal) return;
    setMeal(dayIdx, meal, ta.value);
  });
}

function init() {
  if (initialized) return;
  initialized = true;
  sanitizeTotalsOnLoad();
  ensureMockChartDataIfEmpty();
  hydrateSettingsUI();
  bindUI();
  updateUI();
  ensureChart();

  if (DEBUG_UI_HITTEST) {
    setTimeout(() => {
      const btn = $("plan-to-market-btn");
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      const x = Math.floor(r.left + r.width / 2);
      const y = Math.floor(r.top + r.height / 2);
      const topEl = document.elementFromPoint(x, y);
      console.log("[UI HitTest] plan-to-market-btn center:", { x, y });
      console.log("[UI HitTest] elementFromPoint:", topEl);
      if (topEl && topEl !== btn && !btn.contains(topEl)) {
        console.warn("[UI HitTest] Button is covered by:", topEl?.outerHTML?.slice(0, 200));
      }
    }, 600);
  }
}

document.addEventListener("DOMContentLoaded", init);
