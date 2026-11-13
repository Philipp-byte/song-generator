// Song-Generator – Cloudflare Worker
// Hält den Gemini-API-Key und das Passwort geheim (als Cloudflare-Secrets),
// prüft die Anmeldung, zählt das Tageslimit und ruft Google Lyria auf.
//
// Secrets (nie im Code!):  GEMINI_API_KEY, PASSWORD
// Variablen (wrangler.toml): DAILY_LIMIT, ALLOWED_ORIGINS, MODEL
// KV-Speicher:              STORE

const LYRIA_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const API_REVISION = "2026-05-20";
const TOKEN_HOURS = 12;
const MAX_LOGIN_FAILS = 10; // pro IP und Stunde

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/login") return await login(request, env, cors);
      if (request.method === "POST" && url.pathname === "/song") return await song(request, env, cors);
      if (request.method === "GET" && url.pathname === "/status") return await status(request, env, cors);
      return json({ error: "Nicht gefunden." }, 404, cors);
    } catch (err) {
      return json({ error: "Interner Fehler: " + err.message }, 500, cors);
    }
  },
};

// ---------- Anmeldung ----------

async function login(request, env, cors) {
  if (!env.PASSWORD) return json({ error: "Kein Passwort eingerichtet." }, 500, cors);
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const failKey = "fail:" + ip;
  const fails = parseInt((await env.STORE.get(failKey)) || "0", 10);
  if (fails >= MAX_LOGIN_FAILS) {
    return json({ error: "Zu viele falsche Versuche. Bitte in einer Stunde nochmal probieren." }, 429, cors);
  }

  const body = await request.json().catch(() => ({}));
  const ok = await safeEqual(String(body.password || ""), env.PASSWORD);
  if (!ok) {
    await env.STORE.put(failKey, String(fails + 1), { expirationTtl: 3600 });
    return json({ error: "Passwort falsch." }, 401, cors);
  }

  const exp = Date.now() + TOKEN_HOURS * 3600 * 1000;
  const token = exp + "." + (await hmac(env.PASSWORD, String(exp)));
  return json({ token, left: await songsLeft(env) }, 200, cors);
}

async function checkToken(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  const [exp, sig] = token.split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, await hmac(env.PASSWORD, exp));
}

// ---------- Status ----------

async function status(request, env, cors) {
  if (!(await checkToken(request, env))) return json({ error: "Bitte neu anmelden." }, 401, cors);
  return json({ left: await songsLeft(env) }, 200, cors);
}

// ---------- Song erzeugen ----------

async function song(request, env, cors) {
  if (!(await checkToken(request, env))) return json({ error: "Bitte neu anmelden." }, 401, cors);

  const body = await request.json().catch(() => ({}));
  const wish = String(body.message || "").trim().slice(0, 4000);
  const previous = body.previous || null; // { prompt, lyrics } des letzten Songs
  if (!wish) return json({ error: "Bitte schreib, was für einen Song du willst." }, 400, cors);

  const day = new Date().toISOString().slice(0, 10);
  const countKey = "count:" + day;
  const used = parseInt((await env.STORE.get(countKey)) || "0", 10);
  const limit = parseInt(env.DAILY_LIMIT || "65", 10);
  if (used >= limit) {
    return json({ error: `Das Tageslimit von ${limit} Songs ist erreicht. Morgen geht es weiter!` }, 429, cors);
  }

  const prompt = buildPrompt(wish, previous);

  let result;
  if (env.MOCK === "1") {
    result = mockSong();
  } else {
    result = await callLyria(prompt, env);
    if (result.error) return json({ error: result.error }, 502, cors);
  }

  await env.STORE.put(countKey, String(used + 1), { expirationTtl: 3 * 86400 });
  return json({ ...result, prompt, left: Math.max(0, limit - used - 1) }, 200, cors);
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
  if (previous.lyrics) {
    parts.push("", "Bisheriger Songtext und Aufbau:", String(previous.lyrics).slice(0, 4000));
  }
  parts.push(
    "",
    "Gewünschte Änderungen (diese haben Vorrang):",
    wish,
    "",
    "Behalte alles bei, was nicht geändert werden soll."
  );
  return parts.join("\n");
}

async function callLyria(prompt, env) {
  if (!env.GEMINI_API_KEY) return { error: "Kein API-Key eingerichtet." };
  const res = await fetch(LYRIA_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Api-Revision": API_REVISION,
      "x-goog-api-key": env.GEMINI_API_KEY,
    },
    body: JSON.stringify({ model: env.MODEL || "lyria-3.5", input: prompt }),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok || !data) {
    const msg = data && data.error && data.error.message ? data.error.message : "HTTP " + res.status;
    return { error: friendlyError(msg) };
  }

  let audio = null;
  let mime = "audio/mpeg";
  const texts = [];
  for (const step of data.steps || []) {
    if (step.type !== "model_output") continue;
    for (const c of step.content || []) {
      if (c.type === "audio" && c.data) {
        audio = c.data;
        if (c.mime_type) mime = c.mime_type;
      } else if (c.type === "text" && c.text) {
        texts.push(c.text);
      }
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
  if (/quota|rate|exhausted/i.test(msg)) return "Google ist gerade ausgelastet. Bitte in einer Minute nochmal probieren.";
  return "Fehler bei Google: " + msg;
}

// Testmodus: 3 Sekunden Ton als WAV, ganz ohne Google und ohne Kosten.
function mockSong() {
  const rate = 8000, secs = 3, n = rate * secs;
  const buf = new Uint8Array(44 + n * 2);
  const v = new DataView(buf.buffer);
  const w = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true);
  v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, n * 2, true);
  const notes = [262, 330, 392, 523];
  for (let i = 0; i < n; i++) {
    const f = notes[Math.floor((i / n) * notes.length)];
    v.setInt16(44 + i * 2, Math.sin((2 * Math.PI * f * i) / rate) * 8000, true);
  }
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return {
    audio: btoa(bin),
    mime: "audio/wav",
    lyrics: "[Testmodus]\n[Strophe]\nDas ist nur ein Testton,\nder echte Song kommt von Google.\n\n[Refrain]\nLa la la, es funktioniert!",
  };
}

// ---------- Hilfsfunktionen ----------

async function songsLeft(env) {
  const day = new Date().toISOString().slice(0, 10);
  const used = parseInt((await env.STORE.get("count:" + day)) || "0", 10);
  return Math.max(0, parseInt(env.DAILY_LIMIT || "65", 10) - used);
}

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function safeEqual(a, b) {
  // Vergleicht über Hashes, damit die Laufzeit nichts verrät.
  const [ha, hb] = await Promise.all([hmac("cmp", a), hmac("cmp", b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const h = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (allowed.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
  });
}
