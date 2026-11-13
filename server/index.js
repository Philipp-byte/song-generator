// Song-Studio – Server für Google Cloud Run
// Hält den Gemini-API-Key und das Passwort geheim (aus dem Google Secret Manager),
// prüft die Anmeldung, zählt das Tageslimit und ruft Google Lyria auf.
//
// Geheimnisse (Secret Manager, nie im Code): GEMINI_API_KEY, PASSWORD
// Einstellungen (Umgebungsvariablen):         DAILY_LIMIT, ALLOWED_ORIGINS, MODEL, MOCK

const http = require("node:http");
const { createHmac, timingSafeEqual } = require("node:crypto");

const LYRIA_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const API_REVISION = "2026-05-20";
const TOKEN_HOURS = 12;
const MAX_LOGIN_FAILS = 10; // pro IP und Stunde

const env = process.env;
const DAILY_LIMIT = parseInt(env.DAILY_LIMIT || "65", 10);
const ALLOWED = (env.ALLOWED_ORIGINS || "https://philipp-byte.github.io,http://localhost:8000")
  .split(",").map((s) => s.trim()).filter(Boolean);

// Zähler im Speicher (Cloud Run läuft mit genau einer Instanz).
// Die harte Kostengrenze ist zusätzlich das Ausgabenlimit bei Google.
const counter = { day: "", used: 0 };
const fails = new Map(); // ip -> { n, until }

function today() { return new Date().toISOString().slice(0, 10); }
function used() {
  if (counter.day !== today()) { counter.day = today(); counter.used = 0; }
  return counter.used;
}
function left() { return Math.max(0, DAILY_LIMIT - used()); }

// ---------- Server ----------

const server = http.createServer(async (req, res) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  const path = new URL(req.url, "http://x").pathname;
  try {
    if (req.method === "POST" && path === "/login") return await login(req, res, cors);
    if (req.method === "POST" && path === "/song") return await song(req, res, cors);
    if (req.method === "GET" && path === "/status") return status(req, res, cors);
    if (req.method === "GET" && path === "/") return send(res, 200, cors, { ok: true, name: "Song-Studio" });
    return send(res, 404, cors, { error: "Nicht gefunden." });
  } catch (err) {
    console.error(err);
    return send(res, 500, cors, { error: "Interner Fehler: " + err.message });
  }
});
server.requestTimeout = 0;
server.listen(parseInt(env.PORT || "8080", 10), () => console.log("Song-Studio läuft"));

// ---------- Anmeldung ----------

async function login(req, res, cors) {
  if (!env.PASSWORD) return send(res, 500, cors, { error: "Kein Passwort eingerichtet." });
  const ip = clientIp(req);
  const f = fails.get(ip);
  if (f && f.until > Date.now() && f.n >= MAX_LOGIN_FAILS) {
    return send(res, 429, cors, { error: "Zu viele falsche Versuche. Bitte in einer Stunde nochmal probieren." });
  }
  const body = await readJson(req);
  if (!safeEqual(String(body.password || ""), env.PASSWORD)) {
    const cur = f && f.until > Date.now() ? f : { n: 0, until: Date.now() + 3600 * 1000 };
    cur.n++;
    fails.set(ip, cur);
    return send(res, 401, cors, { error: "Passwort falsch." });
  }
  const exp = String(Date.now() + TOKEN_HOURS * 3600 * 1000);
  return send(res, 200, cors, { token: exp + "." + hmac(env.PASSWORD, exp), left: left() });
}

function checkToken(req) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const [exp, sig] = token.split(".");
  if (!exp || !sig || !env.PASSWORD || Number(exp) < Date.now()) return false;
  return safeEqual(sig, hmac(env.PASSWORD, exp));
}

function status(req, res, cors) {
  if (!checkToken(req)) return send(res, 401, cors, { error: "Bitte neu anmelden." });
  return send(res, 200, cors, { left: left() });
}

// ---------- Song erzeugen ----------

async function song(req, res, cors) {
  if (!checkToken(req)) return send(res, 401, cors, { error: "Bitte neu anmelden." });
  const body = await readJson(req);
  const wish = String(body.message || "").trim().slice(0, 4000);
  const previous = body.previous || null; // { prompt, lyrics } des letzten Songs
  if (!wish) return send(res, 400, cors, { error: "Bitte schreib, was für einen Song du willst." });
  if (used() >= DAILY_LIMIT) {
    return send(res, 429, cors, { error: `Das Tageslimit von ${DAILY_LIMIT} Songs ist erreicht. Morgen geht es weiter!` });
  }

  counter.used++; // vorab zählen, damit parallele Anfragen das Limit nicht überholen
  const prompt = buildPrompt(wish, previous);
  const result = env.MOCK === "1" ? mockSong() : await callLyria(prompt);
  if (result.error) {
    counter.used--;
    return send(res, 502, cors, { error: result.error });
  }
  return send(res, 200, cors, { ...result, prompt, left: left() });
}

// Lyria kann keinen Song nachträglich bearbeiten. Bei Änderungswünschen
// bauen wir deshalb einen neuen Prompt aus altem Wunsch, altem Text und Änderung.
function buildPrompt(wish, previous) {
  if (!previous || !previous.prompt) return wish;
  const parts = [
    "Erzeuge eine überarbeitete Version eines Songs.",
    "",
    "Ursprüngliche Beschreibung des Songs:",
    String(previous.prompt).slice(0, 4000),
  ];
  if (previous.lyrics) parts.push("", "Bisheriger Songtext und Aufbau:", String(previous.lyrics).slice(0, 4000));
  parts.push("", "Gewünschte Änderungen (diese haben Vorrang):", wish, "", "Behalte alles bei, was nicht geändert werden soll.");
  return parts.join("\n");
}

async function callLyria(prompt) {
  if (!env.GEMINI_API_KEY) return { error: "Kein API-Key eingerichtet." };
  const r = await fetch(LYRIA_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Api-Revision": API_REVISION,
      "x-goog-api-key": env.GEMINI_API_KEY.trim(),
    },
    body: JSON.stringify({ model: env.MODEL || "lyria-3.5", input: prompt }),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok || !data) {
    const msg = data && data.error && data.error.message ? data.error.message : "HTTP " + r.status;
    console.error("Lyria-Fehler:", msg);
    return { error: friendlyError(msg) };
  }

  let audio = null;
  let mime = "audio/mpeg";
  const texts = [];
  for (const step of data.steps || []) {
    if (step.type !== "model_output") continue;
    for (const c of step.content || []) {
      if (c.type === "audio" && c.data) { audio = c.data; if (c.mime_type) mime = c.mime_type; }
      else if (c.type === "text" && c.text) texts.push(c.text);
    }
  }
  if (!audio) {
    return { error: "Google hat keinen Song geliefert. Vielleicht wurde der Wunsch vom Sicherheitsfilter blockiert (z. B. bekannte Künstler oder geschützte Songtexte). Formuliere ihn bitte anders." };
  }
  if (mime === "audio/mp3") mime = "audio/mpeg";
  return { audio, mime, lyrics: texts.join("\n\n") };
}

function friendlyError(msg) {
  if (/safety|blocked|policy/i.test(msg)) {
    return "Der Wunsch wurde vom Sicherheitsfilter blockiert. Bekannte Künstlerstimmen und geschützte Songtexte gehen nicht. Formuliere ihn bitte anders.";
  }
  if (/quota|rate|exhausted|spend|budget/i.test(msg)) return "Das Tagesbudget bei Google ist erreicht oder Google ist ausgelastet. Bitte später nochmal probieren.";
  return "Fehler bei Google: " + msg;
}

// Testmodus: 3 Sekunden Ton als WAV, ganz ohne Google und ohne Kosten.
function mockSong() {
  const rate = 8000, n = rate * 3;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8); buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  const notes = [262, 330, 392, 523];
  for (let i = 0; i < n; i++) {
    const f = notes[Math.floor((i / n) * notes.length)];
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * f * i) / rate) * 8000), 44 + i * 2);
  }
  return {
    audio: buf.toString("base64"),
    mime: "audio/wav",
    lyrics: "[Testmodus]\n[Strophe]\nDas ist nur ein Testton,\nder echte Song kommt von Google.\n\n[Refrain]\nLa la la, es funktioniert!",
  };
}

// ---------- Hilfsfunktionen ----------

function hmac(secret, msg) { return createHmac("sha256", secret).update(msg).digest("hex"); }

function safeEqual(a, b) {
  // Vergleicht über Hashes, damit die Laufzeit nichts verrät.
  return timingSafeEqual(createHmac("sha256", "cmp").update(a).digest(), createHmac("sha256", "cmp").update(b).digest());
}

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "local").split(",")[0].trim();
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 100000) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

function corsHeaders(req) {
  const origin = req.headers.origin || "";
  const h = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (ALLOWED.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function send(res, status, cors, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...cors });
  res.end(JSON.stringify(obj));
}
