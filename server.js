const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const SEED_DATA_DIR = path.join(ROOT, "seed-data");
const MANUALS_DIR = path.join(DATA_DIR, "manuals");
const PHOTOS_DIR = path.join(DATA_DIR, "photos");
const PAGE_IMAGES_DIR = path.join(DATA_DIR, "page-images");
const INDEX_PATH = path.join(DATA_DIR, "index.json");
const NOTES_PATH = path.join(DATA_DIR, "notes.json");

loadDotEnv(path.join(ROOT, ".env"));

const PORT = Number(process.env.PORT || 8300);
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.6-sol";
const PYTHON_PATH = process.env.PYTHON_PATH || findPythonPath();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml"
};

ensureStorage();

const server = http.createServer(async (req, res) => {
  try {
    if (!isAuthorized(req)) {
      res.writeHead(401, {
        "WWW-Authenticate": 'Basic realm="830E Guru"',
        "Content-Type": "text/plain; charset=utf-8"
      });
      res.end("Authentication required");
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/api/status" && req.method === "GET") {
      const indexCount = readJson(INDEX_PATH, []).length;
      return json(res, 200, {
        ok: true,
        mode: process.env.OPENAI_API_KEY ? "ai" : "demo",
        model: OPENAI_MODEL,
        manuals: listManuals(),
        indexCount,
        seedIndexCount: getSeedIndexCount()
      });
    }

    if (url.pathname === "/api/chat" && req.method === "POST") {
      const body = await readJsonBody(req);
      const result = await handleChat(body);
      return json(res, 200, result);
    }

    if (url.pathname === "/api/documents" && req.method === "GET") {
      return json(res, 200, { manuals: listManuals() });
    }

    if (url.pathname === "/api/documents" && req.method === "POST") {
      const uploaded = await handleUpload(req);
      return json(res, 201, { uploaded, manuals: listManuals() });
    }

    if (url.pathname === "/api/reindex" && req.method === "POST") {
      const result = await rebuildManualIndex();
      return json(res, 200, result);
    }

    if (url.pathname === "/api/notes" && req.method === "GET") {
      return json(res, 200, { notes: readJson(NOTES_PATH, []) });
    }

    if (url.pathname === "/api/notes" && req.method === "POST") {
      const body = await readJsonBody(req, 20_000_000);
      const notes = readJson(NOTES_PATH, []);
      const photo = body.photoData ? savePhotoData(body.photoData, body.photoName) : null;
      const note = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        unit: String(body.unit || "").trim(),
        title: String(body.title || "").trim(),
        body: String(body.body || "").trim(),
        photo
      };
      notes.unshift(note);
      fs.writeFileSync(NOTES_PATH, JSON.stringify(notes, null, 2));
      return json(res, 201, { note, notes });
    }

    if (url.pathname.startsWith("/manuals/") && req.method === "GET") {
      const name = decodeURIComponent(url.pathname.replace("/manuals/", ""));
      return serveFile(res, path.join(MANUALS_DIR, path.basename(name)));
    }

    if (url.pathname.startsWith("/photos/") && req.method === "GET") {
      const name = decodeURIComponent(url.pathname.replace("/photos/", ""));
      return serveFile(res, path.join(PHOTOS_DIR, path.basename(name)));
    }

    if (url.pathname === "/api/page-image" && req.method === "GET") {
      const manual = path.basename(url.searchParams.get("manual") || "");
      const page = Number(url.searchParams.get("page") || 0);
      const imagePath = await ensurePageImage(manual, page);
      return serveFile(res, imagePath);
    }

    return serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: "Server error", detail: error.message });
  }
});

function isAuthorized(req) {
  const password = process.env.APP_PASSWORD;
  if (!password) return true;
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    const supplied = separator === -1 ? decoded : decoded.slice(separator + 1);
    return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(password));
  } catch {
    return false;
  }
}

function startServer() {
  server.listen(PORT, () => {
    console.log(`Komatsu 830E Guru running at http://localhost:${PORT}`);
    console.log(process.env.OPENAI_API_KEY ? `AI mode using ${OPENAI_MODEL}` : "Demo mode: set OPENAI_API_KEY in .env for live AI answers");
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  answerInDemoMode,
  searchIndex,
  startServer,
  synthesizeOfflineAnswer
};

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = rawValue.replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function ensureStorage() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(MANUALS_DIR, { recursive: true });
  fs.mkdirSync(PHOTOS_DIR, { recursive: true });
  fs.mkdirSync(PAGE_IMAGES_DIR, { recursive: true });
  seedBundledData();
  if (!fs.existsSync(INDEX_PATH)) fs.writeFileSync(INDEX_PATH, "[]\n");
  if (!fs.existsSync(NOTES_PATH)) fs.writeFileSync(NOTES_PATH, "[]\n");
}

function seedBundledData() {
  if (!fs.existsSync(SEED_DATA_DIR)) return;
  copyMissing(SEED_DATA_DIR, DATA_DIR);
  restoreSeedIndexIfBetter("index.json");
  restoreSeedIndexIfBetter("index-manifest.json");
}

function copyMissing(source, target) {
  if (!fs.existsSync(source)) return;
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      if (entry === "page-images" || entry === "photos") continue;
      copyMissing(path.join(source, entry), path.join(target, entry));
    }
    return;
  }
  if (!fs.existsSync(target)) {
    fs.copyFileSync(source, target);
  }
}

function restoreSeedIndexIfBetter(fileName) {
  const source = path.join(SEED_DATA_DIR, fileName);
  const target = path.join(DATA_DIR, fileName);
  if (!fs.existsSync(source)) return;
  if (!fs.existsSync(target)) {
    fs.copyFileSync(source, target);
    return;
  }
  if (fileName === "index.json") {
    const sourceCount = readJson(source, []).length;
    const targetCount = readJson(target, []).length;
    if (sourceCount > targetCount) fs.copyFileSync(source, target);
    return;
  }
  const sourceStat = fs.statSync(source);
  const targetStat = fs.statSync(target);
  if (sourceStat.size > targetStat.size) fs.copyFileSync(source, target);
}

function getSeedIndexCount() {
  return readJson(path.join(SEED_DATA_DIR, "index.json"), []).length;
}

function serveStatic(req, res, pathname) {
  const cleanPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, cleanPath));
  if (!filePath.startsWith(PUBLIC_DIR)) return notFound(res);
  return serveFile(res, filePath);
}

function serveFile(res, filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return notFound(res);
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
    "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=300"
  });
  fs.createReadStream(filePath).pipe(res);
}

function notFound(res) {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function readJsonBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function savePhotoData(photoData, photoName = "photo.jpg") {
  const match = String(photoData).match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
  if (!match) return null;
  const mime = match[1];
  const ext = mime === "image/png" ? ".png" : mime === "image/webp" ? ".webp" : ".jpg";
  const safeBase = path.basename(String(photoName), path.extname(String(photoName))).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") || "photo";
  const fileName = uniqueFileName(PHOTOS_DIR, `${safeBase}${ext}`);
  fs.writeFileSync(path.join(PHOTOS_DIR, fileName), Buffer.from(match[2], "base64"));
  return { name: fileName, url: `/photos/${encodeURIComponent(fileName)}`, mime };
}

function readBuffer(req, limitBytes = 400 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error("Upload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handleUpload(req) {
  const contentType = req.headers["content-type"] || "";
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) throw new Error("Expected multipart form data");
  const boundary = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`);
  const buffer = await readBuffer(req);
  const parts = splitMultipart(buffer, boundary);
  const uploaded = [];

  for (const part of parts) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const headers = part.slice(0, headerEnd).toString("utf8");
    const filenameMatch = headers.match(/filename="([^"]+)"/i);
    if (!filenameMatch) continue;
    const originalName = path.basename(filenameMatch[1]).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
    if (!originalName.toLowerCase().endsWith(".pdf")) continue;
    let content = part.slice(headerEnd + 4);
    if (content.slice(-2).toString() === "\r\n") content = content.slice(0, -2);
    const finalName = uniqueFileName(MANUALS_DIR, originalName);
    const finalPath = path.join(MANUALS_DIR, finalName);
    fs.writeFileSync(finalPath, content);
    uploaded.push({ name: finalName, size: content.length, url: `/manuals/${encodeURIComponent(finalName)}` });
  }

  return uploaded;
}

function splitMultipart(buffer, boundary) {
  const parts = [];
  let start = buffer.indexOf(boundary);
  while (start !== -1) {
    start += boundary.length;
    if (buffer[start] === 45 && buffer[start + 1] === 45) break;
    if (buffer[start] === 13 && buffer[start + 1] === 10) start += 2;
    const end = buffer.indexOf(boundary, start);
    if (end === -1) break;
    parts.push(buffer.slice(start, end - 2));
    start = end;
  }
  return parts;
}

function uniqueFileName(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = name;
  let count = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${base}-${count}${ext}`;
    count += 1;
  }
  return candidate;
}

function listManuals() {
  if (!fs.existsSync(MANUALS_DIR)) return [];
  return fs.readdirSync(MANUALS_DIR)
    .filter((name) => name.toLowerCase().endsWith(".pdf"))
    .map((name) => {
      const stat = fs.statSync(path.join(MANUALS_DIR, name));
      return {
        name,
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
        url: `/manuals/${encodeURIComponent(name)}`
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function rebuildManualIndex() {
  const scriptPath = path.join(ROOT, "scripts", "index_manuals.py");
  if (!fs.existsSync(scriptPath)) throw new Error("Indexer script not found");
  const output = await runProcessWithOutput(PYTHON_PATH, [scriptPath], ROOT, 10 * 60 * 1000);
  return {
    ok: true,
    output,
    indexCount: readJson(INDEX_PATH, []).length,
    manifest: readJson(path.join(DATA_DIR, "index-manifest.json"), null)
  };
}

async function handleChat(body) {
  const message = String(body.message || "").trim();
  const history = Array.isArray(body.history) ? body.history.slice(-8) : [];
  if (!message) return { answer: "Ask me about a fault code, torque spec, pressure, or procedure.", sources: [] };

  const matches = searchIndex(message);
  const indexCount = readJson(INDEX_PATH, []).length;
  if (!matches.length && indexCount === 0 && listManuals().length > 0) {
    return {
      answer: [
        "The PDFs are present, but the manuals are not indexed yet, so I cannot cite source pages.",
        "",
        "Click Reindex manuals in the Documents panel, wait for the page count to update, then ask again.",
        "",
        "If this is the hosted Render app, redeploy the latest commit first so the bundled seed index can restore automatically."
      ].join("\n"),
      sources: []
    };
  }
  if (process.env.OPENAI_API_KEY) {
    try {
      return await answerWithOpenAI(message, history, matches);
    } catch (error) {
      const fallback = answerInDemoMode(message, matches);
      return {
        answer: [
          "AI call failed, so I am falling back to local source-only mode.",
          `Reason: ${error.message}`,
          "",
          fallback.answer
        ].join("\n"),
        sources: fallback.sources
      };
    }
  }
  return answerInDemoMode(message, matches);
}

function searchIndex(query) {
  const words = queryWords(query);
  const phrase = words.join(" ");
  const intent = detectIntent(query);
  const topic = detectTopic(query);
  const records = readJson(INDEX_PATH, []);
  return records
    .map((record) => {
      const title = String(record.title || "").toLowerCase();
      const text = String(record.text || "").toLowerCase();
      const manualType = String(record.manualType || "").toLowerCase();
      const haystack = [
        record.title,
        record.truckVariant,
        record.manualFile,
        record.manualType,
        record.system,
        record.type,
        record.summary,
        record.text,
        record.source && record.source.quote,
        ...(record.keywords || [])
      ].join(" ").toLowerCase();
      const score = words.reduce((total, word) => {
        if (!word) return total;
        const exact = haystack.includes(word) ? 3 : 0;
        const titleHit = title.includes(word) ? 5 : 0;
        const typeHit = String(record.type || "").toLowerCase().includes(word) ? 4 : 0;
        return total + exact + titleHit + typeHit;
      }, 0)
        + (phrase && text.includes(phrase) ? 25 : 0)
        + (phrase && title.includes(phrase) ? 35 : 0)
        + (words.every((word) => haystack.includes(word)) ? 12 : 0)
        + (/kpa|\bpsi\b|mpa|pressure/i.test(haystack) && words.includes("pressure") ? 8 : 0)
        + (/charged to|charge pressure|precharge/i.test(haystack) && words.includes("accumulator") ? 18 : 0)
        + scoreIntent(intent, manualType, title, text, haystack)
        + scoreTopic(topic, haystack);
      return { record, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((item) => item.record)
    .concat(forcedSourceRecords(records, query))
    .filter((record, index, all) => all.findIndex((other) => other.id === record.id) === index)
    .slice(0, 10)
    .map((record) => withQueryExcerpt(record, query));
}

function forcedSourceRecords(records, query) {
  const lower = normalizeQuestion(query);
  const forcedPages = new Set();
  if (/steering/.test(lower) && /accumulator/.test(lower) && /pressure|precharge|charge/.test(lower)) {
    [677, 693, 694].forEach((page) => forcedPages.add(page));
  }
  if (/\b(strut|suspension|hydrair|ride height|oiling height|charging height)\b/.test(lower)) {
    [526, 530, 532, 536].forEach((page) => forcedPages.add(page));
  }
  if (/\b(capacity|capacities|oil amount|fluid amount|oil level|hydraulic oil|wheel motor oil|service capacities)\b/.test(lower)) {
    [13, 1061, 1077].forEach((page) => forcedPages.add(page));
  }
  if (!forcedPages.size) return [];
  return records.filter((record) => {
    const file = record.manualFile || (record.source && record.source.file);
    const page = record.source && record.source.page;
    return file === "ShopManual.pdf" && forcedPages.has(page);
  });
}

function detectIntent(query) {
  const lower = normalizeQuestion(query);
  if (/\b(part|parts|part number|item number|assembly|qty|quantity)\b/i.test(lower)) return "parts";
  if (/\b(fault|code|event|diagnostic|troubleshoot)\b/i.test(lower)) return "fault";
  if (/\b(torque|tighten|tightening|n\.?m|ft\.?\s?lb|foot pounds?)\b/i.test(lower)) return "torque";
  if (/\bpressure|psi|kpa|mpa|precharge|accumulator\b/i.test(lower) && /\bspec|pressure|precharge\b/i.test(lower)) return "pressure";
  if (/\b(height|level|amount|capacity|capacities|quantity|liters|gallons|oil|fluid|dimension|dimensions|strut|suspension)\b/i.test(lower)) return "spec";
  if (/\b(procedure|remove|removal|install|installation|replace|adjust|bleed|charge|test|check)\b/i.test(lower)) return "procedure";
  if (/\b(pressure|psi|kpa|mpa|charge|precharge|accumulator)\b/i.test(lower)) return "pressure";
  return "manual";
}

function detectTopic(query) {
  const lower = normalizeQuestion(query);
  const topics = {
    steering: ["steering", "steer"],
    hoist: ["hoist", "body", "power down", "power up"],
    brake: ["brake", "braking", "retarder"],
    alternator: ["alternator"],
    wheel: ["wheel", "motor", "wheel motor", "drive wheel"],
    accumulator: ["accumulator", "precharge"],
    hydraulic: ["hydraulic"],
    electrical: ["electrical", "propulsion", "inverter", "cabinet", "alternator"]
  };
  const wanted = [];
  for (const [name, needles] of Object.entries(topics)) {
    if (needles.some((needle) => lower.includes(needle))) wanted.push(name);
  }
  return wanted;
}

function scoreIntent(intent, manualType, title, text, haystack) {
  let score = 0;
  if (intent !== "parts" && /parts_book|engine_parts_book/.test(manualType)) score -= 28;
  if (intent === "parts" && /parts_book|engine_parts_book/.test(manualType)) score += 35;
  if (intent !== "parts" && manualType === "shop_manual") score += 12;
  if (intent === "torque" && manualType === "operation_maintenance") score += 8;
  if (intent === "torque" && /\btorque|tighten|tightening|n·m|n\.m|ft\s?lb/.test(haystack)) score += 28;
  if (intent === "pressure" && /\bkpa\b|\bpsi\b|pressure|precharge/.test(haystack)) score += 18;
  if (intent === "spec" && /\bheight|capacity|capacities|oil|level|liters?|gallons?|dimension|hydrair|suspension|extracted table\b/.test(haystack)) score += 26;
  if (intent === "procedure" && /procedure|removal|installation|adjustment|bleed|charging/.test(title)) score += 30;
  if (intent === "procedure" && /(^|\s)1\.\s/.test(text)) score += 12;
  if (intent === "procedure" && (/^section\b|^index\b|description page no/.test(title) || /\.{8,}/.test(text))) score -= 34;
  if (intent === "fault" && /fault|event code|diagnostic|troubleshooting/.test(haystack)) score += 30;
  return score;
}

function scoreTopic(topic, haystack) {
  if (!topic.length) return 0;
  const conflicts = {
    steering: ["hoist"],
    hoist: ["steering"],
    brake: ["hoist"],
    alternator: ["steering", "hoist", "brake"],
    wheel: ["hoist", "steering accumulator"],
    accumulator: ["hoist cylinder"],
  };
  let score = 0;
  for (const item of topic) {
    if (haystack.includes(item)) score += 18;
    for (const conflict of conflicts[item] || []) {
      if (haystack.includes(conflict) && !haystack.includes(item)) score -= 24;
    }
  }
  return score;
}

async function answerWithOpenAI(message, history, matches) {
  const intent = detectIntent(message);
  const deterministicAnswer = matches.length ? synthesizeOfflineAnswer(message, matches, intent) : "";
  const sourceContext = matches.map((item, index) => ({
    number: index + 1,
    id: item.id,
    title: item.title,
    truckVariant: item.truckVariant,
    system: item.system,
    type: item.type,
    summary: item.summary,
    source: item.source,
    excerpt: item.excerpt
  }));

  const systemPrompt = [
    "You are Komatsu 830E Guru, a careful maintenance assistant for Komatsu 830E-family mining trucks.",
    "Use only the supplied source context for factual manual claims.",
    "If deterministic extracted findings are provided, treat them as verified source extraction and do not contradict them unless another supplied source explicitly contradicts them.",
    "Do not say a value is missing when deterministic extracted findings include that value.",
    "If the source context is missing, say the manuals are not indexed yet and ask for the relevant PDF/manual page.",
    "For procedures, specs, pressures, torque values, and fault codes, include source manual and page when available.",
    "Call out safety-critical work involving high voltage, braking, steering, lifting, hydraulics, stored energy, and lockout/tagout.",
    "Do not invent torque specs, pressures, fault-code meanings, or procedures."
  ].join(" ");

  const input = [
    { role: "system", content: systemPrompt },
    ...history.map((item) => ({
      role: item.role === "assistant" ? "assistant" : "user",
      content: String(item.content || "").slice(0, 2000)
    })),
    {
      role: "user",
      content: [
        `Question: ${message}`,
        "",
        `Deterministic extracted findings:\n${deterministicAnswer || "None"}`,
        "",
        `Source context JSON: ${JSON.stringify(sourceContext, null, 2)}`,
        "",
        "Answer in a practical field-service style. Put the direct spec first when one is found. Finish with a Sources section if sources exist."
      ].join("\n")
    }
  ];

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    return {
      answer: `I could not reach the AI service. Server response ${response.status}. ${detail.slice(0, 300)}`,
      sources: matches.map(toSourceCard)
    };
  }

  const data = await response.json();
  return {
    answer: extractResponseText(data) || "I could not extract an answer from the model response.",
    sources: matches.map(toSourceCard),
    rawId: data.id
  };
}

function answerInDemoMode(message, matches) {
  const intentKey = detectIntent(message);
  const intent = intentLabel(intentKey);

  const hasMatches = matches.length > 0;
  const synthesis = hasMatches ? synthesizeOfflineAnswer(message, matches, intentKey) : "";
  const answer = hasMatches
    ? [
        `Offline manual answer for ${intent}.`,
        "",
        synthesis || "I found matching manual pages, but I could not safely extract a single value from the text. Check the cited pages below.",
        "",
        "Sources:",
        ...matches.slice(0, 5).map((source, index) => [
          `${index + 1}. ${source.source.manual} - page ${source.source.page}`,
          `${source.title}`,
          `${source.excerpt || source.summary || "No extracted text snippet."}`
        ].join("\n")),
        "",
        "Rule used: provided manuals only. If this is not the spec or procedure you meant, ask with the component name, system, and whether you want removal, installation, testing, or adjustment."
      ].join("\n\n")
    : [
        `Offline source search for ${intent}.`,
        "",
        "I could not find a matching indexed page in the provided manuals, so I will not guess the spec, pressure, procedure, or fault-code meaning.",
        "",
        "Try a different term from the manual, a component name, fault code number, or system name."
      ].join("\n");

  return { answer, sources: matches.map(toSourceCard) };
}

function synthesizeOfflineAnswer(message, matches, intent) {
  if (intent === "pressure") return synthesizePressureAnswer(message, matches);
  if (intent === "torque") return synthesizeTorqueAnswer(message, matches);
  if (intent === "procedure") return synthesizeProcedureAnswer(message, matches);
  if (intent === "spec") return synthesizeSpecAnswer(message, matches);
  return "";
}

function intentLabel(intent) {
  return {
    fault: "fault-code troubleshooting",
    torque: "torque lookup",
    pressure: "pressure-spec lookup",
    spec: "spec lookup",
    procedure: "procedure lookup",
    parts: "parts lookup",
    manual: "manual search"
  }[intent] || "manual search";
}

function synthesizePressureAnswer(message, matches) {
  const findings = extractPressureFindings(message, matches);
  if (!findings.length) return "";
  const primary = findings[0];
  const extras = findings.slice(1, 4);
  const lines = [
    `Short answer: ${primary.value}.`,
    `Manual context: ${primary.context}`,
    `Source: ${primary.manual} page ${primary.page}.`
  ];
  if (extras.length) {
    lines.push("");
    lines.push("Related pressures found nearby:");
    for (const item of extras) {
      lines.push(`- ${item.value} - ${item.context} (${item.manual} page ${item.page})`);
    }
  }
  if (/accumulator|steering|brake|hydraulic/i.test(message)) {
    lines.push("");
    lines.push("Safety: stop the engine, key OFF, wait at least 90 seconds, and confirm stored hydraulic pressure is relieved before loosening lines or accumulator hardware.");
  }
  return lines.join("\n");
}

function extractPressureFindings(message, matches) {
  const query = queryWords(message);
  const pressurePattern = /(\d{1,3}(?:\s?\d{3})*(?:\s*(?:to|-)\s*\d{1,3}(?:\s?\d{3})*)?)\s*kPa\s*\((.{0,60}?\bpsi)\)/gi;
  const findings = [];
  for (const record of matches) {
    const text = String(record.text || record.summary || "");
    let match;
    while ((match = pressurePattern.exec(text))) {
      const context = sentenceAround(text, match.index);
      const contextLower = context.toLowerCase();
      const queryHits = query.reduce((total, word) => total + (contextLower.includes(word) ? 1 : 0), 0);
      const value = formatPressureValue(match[1], match[2]);
      let score = queryHits * 8;
      if (/accumulator/i.test(context)) score += 15;
      if (/steering/i.test(context)) score += 12;
      if (/charged to|charge|precharge|nitrogen/i.test(context)) score += 18;
      if (/precharge warning|drops below/i.test(context)) score += 10;
      if (/circuit pressure|unloader|reaches/i.test(context)) score += 8;
      if (/low steering pressure switch|bleed down/i.test(context)) score += 4;
      if (/filter|bypass|element/i.test(context)) score -= 12;
      if (/first to|then to|storage|before removing|before removing or installing/i.test(context)) score -= 35;
      if (/accumulator/i.test(message) && pressureKpaNumber(match[1]) < 1000 && !/storage|remov|install/i.test(message)) score -= 30;
      if (/accumulator/i.test(message) && /9\s?653|1,400|1400/.test(value)) score += 30;
      findings.push({
        value,
        context: context.replace(/\s+/g, " ").trim(),
        manual: record.source && record.source.manual,
        page: record.source && record.source.page,
        score
      });
    }
  }
  const seen = new Set();
  return findings
    .filter((item) => {
      const key = `${item.value}-${item.page}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.score - a.score);
}

function synthesizeSpecAnswer(message, matches) {
  const findings = extractSpecFindings(message, matches);
  if (!findings.length) return "";
  const lines = ["Specs found in the manuals:"];
  for (const item of findings.slice(0, 8)) {
    lines.push(`- ${item.text}`);
    lines.push(`  Source: ${item.manual} page ${item.page}.`);
  }
  lines.push("");
  lines.push("Check the cited page image for the original table layout before using the value.");
  return lines.join("\n");
}

function extractSpecFindings(message, matches) {
  const terms = queryWords(message);
  const preciseFindings = [];
  for (const record of matches) {
    preciseFindings.push(...extractKnownSpecFindings(message, record));
  }
  const precise = dedupeSpecFindings(preciseFindings).sort((a, b) => b.score - a.score);
  if (precise.length) return precise;

  const findings = [];
  for (const record of matches) {
    const lines = String(record.text || record.summary || "")
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    for (let index = 0; index < lines.length; index += 1) {
      const windowLines = [lines[index - 2], lines[index - 1], lines[index], lines[index + 1], lines[index + 2]].filter(Boolean);
      const text = windowLines.join(" ");
      const hay = text.toLowerCase();
      const hasValue = /\d/.test(text) && /\b(mm|cm|in\.?|kpa|psi|liters?|l\b|gal|gallon|gallons|height|capacity|oil|hydraulic|coolant|fuel)\b/i.test(text);
      const hits = terms.reduce((total, term) => total + (hay.includes(term) ? 1 : 0), 0);
      if (!hasValue || hits < 2) continue;
      findings.push({
        text: text.slice(0, 560),
        manual: record.source && record.source.manual,
        page: record.source && record.source.page,
        score: hits * 10 + (/table|height|capacity|oiling|charging|service capacities|extracted table/i.test(text) ? 10 : 0)
      });
    }
  }
  return dedupeSpecFindings(findings).sort((a, b) => b.score - a.score);
}

function extractKnownSpecFindings(message, record) {
  const lower = normalizeQuestion(message).toLowerCase();
  const text = String(record.text || record.summary || "");
  const page = record.source && record.source.page;
  const manual = record.source && record.source.manual;
  const findings = [];
  const wantsFront = /\bfront\b/.test(lower);
  const wantsRear = /\brear\b/.test(lower);
  const wantsSuspension = /\b(strut|struts|suspension|hydrair|ride height|oiling height|charging height)\b/.test(lower);
  const wantsAmount = /\b(amount|capacity|capacities|quantity|liters?|gallons?|gal|oil|fluid)\b/.test(lower);
  const wantsCapacity = /\b(amount|capacity|capacities|quantity|liters?|gallons?|gal)\b/.test(lower);
  const wantsSuspensionDimension = /\b(height|dimension|dimensions|ride height|oiling height|charging height|charge|charging|pressure)\b/.test(lower) && wantsSuspension;
  const wantsLevel = /\blevel\b/.test(lower);

  if (wantsAmount) {
    const oilMatch = text.match(/\b(front|rear)\s+suspension\s+holds\s+approximately\s+([\d.]+)\s*l\s*\(([\d.]+)\s*gal\)\s+of\s+oil/i);
    if (oilMatch && (!wantsFront || oilMatch[1].toLowerCase() === "front") && (!wantsRear || oilMatch[1].toLowerCase() === "rear")) {
      findings.push({
        text: `${capitalize(oilMatch[1])} suspension oil amount: approximately ${oilMatch[2]} L (${oilMatch[3]} gal) of oil.`,
        manual,
        page,
        score: 170 + (wantsAmount ? 40 : 0)
      });
    }
  }

  if (wantsSuspensionDimension) {
    const tableMatch = text.match(/TABLE\s+([123]):\s+((?:FRONT|REAR)\s+SUSPENSION\s+DIMENSIONS[^\n]*)[\s\S]{0,240}?OILING HEIGHT\s*\|\s*CHARGING HEIGHT\s*\|\s*\*?CHARGING PRESSURE\s*\n([^\n]+)/i);
    if (tableMatch) {
      const tableNumber = tableMatch[1];
      const title = cleanSpecText(tableMatch[2]).replace(/\s*\|\s*/g, " ").trim();
      const columns = tableMatch[3].split("|").map((cell) => cleanSpecText(cell.replace(/^\s*\*\s*/, "")));
      if (columns.length >= 3) {
        const isFrontTable = /front/i.test(title);
        const isRearTable = /rear/i.test(title);
        if ((!wantsFront || isFrontTable) && (!wantsRear || isRearTable)) {
          const rodNote = tableNumber === "2" ? " rod up" : tableNumber === "3" ? " rod down" : "";
          findings.push({
            text: `${title}${rodNote}: oiling height ${columns[0]}; charging height ${columns[1]}; charging pressure ${columns[2]} (reference only, may vary depending on body weights).`,
            manual,
            page,
            score: 160 + (wantsFront && isFrontTable ? 35 : 0) + (wantsRear && isRearTable ? 35 : 0)
          });
        }
      }
    }
  }

  if (wantsCapacity || /\bservice capacities\b/.test(lower)) {
    for (const row of extractCapacityRows(text)) {
      const rowLower = row.label.toLowerCase();
      if (!capacityRowMatchesQuery(lower, rowLower)) continue;
      findings.push({
        text: `${row.label}: ${row.liters} L (${row.gallons} U.S. gal).`,
        manual,
        page,
        score: 150 + capacitySpecificityScore(lower, rowLower)
      });
    }

    const tankServiceMatch = text.match(/HYDRAULIC TANK[\s\S]{0,260}?approximate capacity\s+(\d+)\s*l\s*\((\d+)\s*gal\)/i);
    if (tankServiceMatch && /\bhydraulic\b|\btank\b/.test(lower)) {
      findings.push({
        text: `Hydraulic tank refill after draining: approximate capacity ${tankServiceMatch[1]} L (${tankServiceMatch[2]} gal).`,
        manual,
        page,
        score: 185
      });
    }
  }

  if (wantsLevel && /\bhydraulic\b|\btank\b|\boil\b/.test(lower)) {
    const levelMatch = text.match(/With the engine stopped,\s*key switch\s*OFF,\s*hydraulic system bled down and body down,\s*oil\s+should\s+be\s+visible\s+in\s+the\s+top\s+sight\s+gauge/i);
    if (levelMatch) {
      findings.push({
        text: "Hydraulic tank oil level: with engine stopped, key switch OFF, hydraulic system bled down, and body down, oil should be visible in the top sight gauge.",
        manual,
        page,
        score: 190
      });
    }
  }

  return findings;
}

function extractCapacityRows(text) {
  const rows = [];
  const tableRowPattern = /^([^|\n]*?(?:Crankcase|Cooling System|Hydraulic System|Hydraulic Tank|Wheel Motor|Fuel Tank|Retractable Ladder)[^|\n]*?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)/gim;
  let match;
  while ((match = tableRowPattern.exec(text))) {
    rows.push({
      label: cleanCapacityLabel(match[1]),
      liters: match[2],
      gallons: match[3]
    });
  }

  const plainRowPattern = /^(Hydraulic System|Hydraulic Tank|Wheel Motor Gear Box \(each\)|Fuel Tank)(?:\s*\.)+\s*(\d+(?:\.\d+)?)(?:\s*\.)*\s*\((\d+(?:\.\d+)?)\)/gim;
  while ((match = plainRowPattern.exec(text))) {
    rows.push({
      label: cleanCapacityLabel(match[1]),
      liters: match[2],
      gallons: match[3]
    });
  }
  return rows;
}

function capacityRowMatchesQuery(query, rowLabel) {
  if (/\bwheel motor\b/.test(query)) return /\bwheel motor\b/.test(rowLabel);
  if (/\bhydraulic\s+tank\b|\btank\b/.test(query)) return /\bhydraulic tank\b/.test(rowLabel);
  if (/\bhydraulic\b/.test(query)) return /\bhydraulic system\b|\bhydraulic tank\b/.test(rowLabel);
  if (/\bfuel\b/.test(query)) return /\bfuel\b/.test(rowLabel);
  if (/\bcoolant|cooling\b/.test(query)) return /\bcooling\b/.test(rowLabel);
  if (/\bcrankcase|engine oil\b/.test(query)) return /\bcrankcase\b/.test(rowLabel);
  return false;
}

function capacitySpecificityScore(query, rowLabel) {
  let score = 0;
  if (/\bhydraulic tank\b/.test(query) && /\bhydraulic tank\b/.test(rowLabel)) score += 45;
  if (/\bhydraulic\b/.test(query) && /\bhydraulic\b/.test(rowLabel)) score += 25;
  if (/\bwheel motor\b/.test(query) && /\bwheel motor\b/.test(rowLabel)) score += 45;
  return score;
}

function cleanCapacityLabel(value) {
  return cleanSpecText(value)
    .replace(/:\s*Refer to .*$/i, "")
    .replace(/:\s*(\()/, " $1")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/:$/, "");
}

function cleanSpecText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/(\d)\s*psi\b/gi, "$1 psi")
    .trim();
}

function capitalize(value) {
  const text = String(value || "");
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

function dedupeSpecFindings(findings) {
  const seen = new Set();
  return findings.filter((item) => {
    const key = `${item.page}-${item.text.slice(0, 120).toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function synthesizeTorqueAnswer(message, matches) {
  const findings = extractTorqueFindings(message, matches);
  if (!findings.length) return "";
  const bestPage = findings[0].page;
  const bestPageFindings = findings.filter((item) => item.page === bestPage);
  const topScore = findings[0].score;
  const primary = (bestPageFindings.length >= 2 ? bestPageFindings : findings.filter((item) => item.page === bestPage || item.score >= topScore - 12)).slice(0, 4);
  const needsMountingBolt = /\b(mounting|bolt|bolts|capscrew|cap screw)\b/i.test(message);
  const hasMountingBolt = primary.some((item) => /\b(mounting|bolt|bolts|capscrew|cap screw)\b/i.test(item.context));
  const lines = [];
  if (needsMountingBolt && !hasMountingBolt) {
    lines.push("I did not find an explicit mounting bolt torque in the matched source text. Closest torque values found:");
  } else {
    lines.push("Torque found in the manuals:");
  }
  for (const item of primary) {
    lines.push(`- ${item.value} - ${item.context}`);
    lines.push(`  Source: ${item.manual} page ${item.page}.`);
  }
  lines.push("");
  lines.push("Check whether the manual page is for removal, installation, standard torque, or a special tightening sequence before using the value.");
  return lines.join("\n");
}

function extractTorqueFindings(message, matches) {
  const query = queryWords(message);
  const findings = [];
  const torquePatterns = [
    /(\d{1,3}(?:\s?\d{3})*(?:\s*±\s*\d+)?)\s*N[·.]?m[\s\S]{0,120}?\((\d[\d,\s]*(?:\s*±\s*\d+)?)\s*ft\s*lb[s]?\)/gi,
    /\bto\s+(\d{1,3}(?:\s?\d{3})*(?:\s*±\s*\d+)?)[\s\S]{0,140}?N[·.]?m\s*\((\d[\d,\s]*(?:\s*±\s*\d+)?)\s*ft\s*lb[s]?\)/gi
  ];
  for (const record of matches) {
    const text = String(record.text || record.summary || "");
    for (const torquePattern of torquePatterns) {
      let match;
      while ((match = torquePattern.exec(text))) {
        const context = sentenceAround(text, match.index);
        const contextLower = context.toLowerCase();
        const queryHits = query.reduce((total, word) => total + (contextLower.includes(word) ? 1 : 0), 0);
        const value = formatTorqueValue(match[1], match[2]);
        let score = queryHits * 10;
        if (/torque|tighten|tightening/.test(contextLower)) score += 18;
        if (/wheel motor|mounting|cap screw|capscrew/.test(contextLower)) score += 12;
        if (/standard tightening torque/.test(contextLower)) score += 5;
        if (/engine power|peak torque/.test(contextLower)) score -= 35;
        findings.push({
          value,
          context: context.replace(/\s+/g, " ").trim(),
          manual: record.source && record.source.manual,
          page: record.source && record.source.page,
          score
        });
      }
    }
  }
  return dedupeFindings(findings).sort((a, b) => b.score - a.score);
}

function formatTorqueValue(nmRaw, ftlbRaw) {
  const nm = String(nmRaw || "").replace(/\s+/g, " ").trim();
  const ftlb = String(ftlbRaw || "").replace(/\s+/g, " ").trim();
  return `${nm} N.m (${ftlb} ft lb)`;
}

function synthesizeProcedureAnswer(message, matches) {
  const records = expandProcedureRecords(matches);
  const combined = records.map((record) => record.text || "").join("\n");
  const warnings = extractProcedureWarnings(combined);
  const steps = extractProcedureSteps(combined);
  if (!steps.length) return "";
  const sourceList = records.slice(0, 3).map((record) => `${record.source.manual} page ${record.source.page}`).join("; ");
  const lines = [];
  if (warnings.length) {
    lines.push("Before you start:");
    for (const warning of warnings.slice(0, 5)) lines.push(`- ${warning}`);
    lines.push("");
  }
  lines.push("Step-by-step:");
  steps.slice(0, 18).forEach((step, index) => {
    lines.push(`${index + 1}. ${step}`);
  });
  lines.push("");
  lines.push(`Source: ${sourceList}.`);
  lines.push("Do not skip any site lockout/isolation requirements or tooling limits shown on the cited manual page.");
  return lines.join("\n");
}

function expandProcedureRecords(matches) {
  if (!matches.length) return [];
  const first = matches[0];
  const all = readJson(INDEX_PATH, []);
  const file = first.manualFile || (first.source && first.source.file);
  const page = first.source && first.source.page;
  const adjacent = [];
  for (const record of all.filter((item) => item.manualFile === file && item.source.page >= page && item.source.page <= page + 2)) {
    if (record.source.page === page) {
      adjacent.push(record);
      continue;
    }
    const title = String(record.title || "");
    const continuation = /^\d+\.|^[a-z]/.test(title) || /\bcontinued\b/i.test(title);
    if (!continuation && /^[A-Z0-9 /&-]{12,}$/.test(title)) break;
    adjacent.push(record);
  }
  return adjacent.length ? adjacent : matches.slice(0, 3);
}

function extractProcedureWarnings(text) {
  const clean = String(text || "").replace(/\s+/g, " ");
  const warnings = [];
  const patterns = [
    /When lifting[^.]*\./gi,
    /The [^.]{0,80} weighs approximately [^.]*\./gi,
    /Ensure [^.]*\./gi,
    /Do not [^.]*\./gi,
    /DO NOT [^.]*\./g,
    /Failure to [^.]*\./gi,
    /Never [^.]*\./gi
  ];
  for (const pattern of patterns) {
    for (const match of clean.matchAll(pattern)) {
      const item = match[0].replace(/\s+/g, " ").trim();
      if (item.length > 20 && !warnings.some((existing) => existing.toLowerCase() === item.toLowerCase())) warnings.push(item);
    }
  }
  return warnings;
}

function extractProcedureSteps(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const steps = [];
  let current = null;
  let currentNumber = 0;
  let order = 0;
  for (const line of lines) {
    if (/^(FIGURE|TABLE)\b/i.test(line) || /^[A-Z]\d+-\d+\b/.test(line) || /\bPower Train\b|\bSteering Component Repair\b|\bRear Axle Housing\b/.test(line)) continue;
    const numbered = line.match(/^(\d{1,2})\.\s+(.+)$/);
    const substep = line.match(/^([a-z])\.\s+(.+)$/i);
    if (numbered) {
      const number = Number(numbered[1]);
      const body = numbered[2].trim();
      if (looksLikeInstruction(body)) {
        if (current) steps.push({ number: currentNumber, order: order++, body: trimStep(current) });
        currentNumber = number;
        current = body;
      }
      continue;
    }
    if (substep && current && looksLikeInstruction(substep[2])) {
      current += ` ${substep[1].toLowerCase()}. ${substep[2]}`;
      continue;
    }
    if (current && shouldAppendProcedureLine(line)) {
      current += ` ${line}`;
    }
  }
  if (current) steps.push({ number: currentNumber, order: order++, body: trimStep(current) });
  return steps
    .sort((a, b) => a.number - b.number || a.order - b.order)
    .map((step) => step.body.replace(/\s+/g, " ").trim())
    .filter((step) => step.length >= 12)
    .filter((step, index, all) => all.findIndex((other) => other.toLowerCase() === step.toLowerCase()) === index);
}

function looksLikeInstruction(text) {
  return /^(attach|block|loosen|remove|install|reach|rotate|take|keep|note|refer|be certain|ensure|close|open|hold|turn|after|with|set|adjust|operate|check|charge|fill|bleed|connect|disconnect|move|raise|lower|clean|tighten|verify|record|inspect)\b/i.test(text);
}

function shouldAppendProcedureLine(line) {
  if (/^\d+\.\s/.test(line)) return false;
  if (/^(FIGURE|TABLE|NOTE: Three turns|Capacity Fill time|Ambient Charging Pressure)\b/i.test(line)) return false;
  if (/^\d+\.\s*[A-Z][A-Za-z ]{1,35}(\s+\d+\.\s*[A-Z])?/.test(line)) return false;
  if (/^[A-Z0-9-]{4,}\s+\d{1,2}\/\d{2}/.test(line)) return false;
  return true;
}

function trimStep(step) {
  const cleaned = step
    .replace(/\s+FIGURE\s+\S+\.\s+[A-Z0-9 /-]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentences = cleaned.split(/(?<=\.)\s+/).filter(Boolean);
  if (sentences.length <= 2) return cleaned.slice(0, 520);
  return sentences.slice(0, 3).join(" ").slice(0, 620);
}

function dedupeFindings(findings) {
  const seen = new Set();
  return findings.filter((item) => {
    const key = `${item.value}-${item.page}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pressureKpaNumber(kpaRaw) {
  const number = String(kpaRaw || "").match(/\d[\d\s]*/);
  return number ? Number(number[0].replace(/\s+/g, "")) : 0;
}

function formatPressureValue(kpaRaw, psiRaw) {
  const kpa = String(kpaRaw || "").replace(/\s+/g, " ").trim();
  const psiMatch = String(psiRaw || "").match(/\d[\d,\s]*(?:\s*(?:to|-)\s*\d[\d,\s]*)?/);
  const psi = psiMatch ? psiMatch[0].replace(/\s+/g, " ").trim() : String(psiRaw || "").replace(/\s+/g, " ").replace(/\bpsi\b/i, "").trim();
  return `${kpa} kPa (${psi} psi)`;
}

function sentenceAround(text, index) {
  const clean = String(text || "").replace(/\s+/g, " ");
  const safeIndex = Math.min(index, clean.length - 1);
  const start = Math.max(0, clean.lastIndexOf(".", safeIndex - 1), clean.lastIndexOf("\n", safeIndex - 1));
  const endDot = clean.indexOf(".", safeIndex + 1);
  const end = endDot === -1 ? Math.min(clean.length, safeIndex + 260) : Math.min(clean.length, endDot + 1);
  return clean.slice(start > 0 ? start + 1 : 0, end).trim();
}

function queryWords(query) {
  const stop = new Set(["what", "whats", "is", "the", "a", "an", "for", "of", "to", "truck", "please", "tell", "me", "how", "do", "does", "on"]);
  const words = normalizeQuestion(query)
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((word) => word.length > 1 && !stop.has(word) && !/^\d{1,3}$/.test(word));
  return expandQueryWords(words);
}

function expandQueryWords(words) {
  const expansions = {
    strut: ["suspension", "hydrair"],
    struts: ["suspension", "hydrair"],
    amount: ["capacity", "liters", "gallons"],
    amounts: ["capacity", "liters", "gallons"],
    quantity: ["capacity", "liters", "gallons"],
    oil: ["lubrication", "service"],
    level: ["sight", "gauge"],
    levels: ["sight", "gauge"],
    height: ["oiling", "charging", "dimension"],
    heights: ["oiling", "charging", "dimension"]
  };
  const expanded = [];
  for (const word of words) {
    expanded.push(word);
    for (const extra of expansions[word] || []) expanded.push(extra);
  }
  return [...new Set(expanded)];
}

function normalizeQuestion(query) {
  return String(query || "").replace(/\btruck\s+[a-z0-9-]+\s*:\s*/i, " ");
}

function toSourceCard(record) {
  return {
    id: record.id,
    title: record.title,
    manual: record.source && record.source.manual,
    page: record.source && record.source.page,
    pageImage: record.source && record.source.pageImage,
    quote: record.source && record.source.quote,
    excerpt: record.excerpt,
    type: record.type,
    system: record.system
  };
}

function withQueryExcerpt(record, query) {
  const clone = { ...record };
  clone.excerpt = makeExcerpt(record.text || record.summary || "", query);
  if (clone.source) {
    clone.source = { ...clone.source, quote: clone.excerpt || clone.source.quote };
  }
  return clone;
}

function makeExcerpt(text, query) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const words = query.toLowerCase().split(/[^a-z0-9-]+/).filter((word) => word.length > 2);
  const lower = clean.toLowerCase();
  let index = -1;
  for (const word of words) {
    index = lower.indexOf(word);
    if (index !== -1) break;
  }
  if (index === -1) return clean.slice(0, 700);
  const start = Math.max(0, index - 260);
  const end = Math.min(clean.length, index + 520);
  return `${start > 0 ? "... " : ""}${clean.slice(start, end)}${end < clean.length ? " ..." : ""}`;
}

async function ensurePageImage(manual, page) {
  if (!manual || !Number.isInteger(page) || page < 1) throw new Error("Invalid manual page request");
  const pdfPath = path.join(MANUALS_DIR, path.basename(manual));
  if (!fs.existsSync(pdfPath)) throw new Error("Manual not found");
  const baseName = `${path.basename(manual, path.extname(manual)).replace(/[^a-z0-9_-]+/gi, "_")}-p${String(page).padStart(4, "0")}`;
  const simpleExpected = path.join(PAGE_IMAGES_DIR, `${baseName}.png`);
  if (fs.existsSync(simpleExpected)) return simpleExpected;
  const existingCandidates = fs.readdirSync(PAGE_IMAGES_DIR).filter((name) => name.startsWith(baseName) && name.endsWith(".png"));
  if (existingCandidates.length) {
    fs.renameSync(path.join(PAGE_IMAGES_DIR, existingCandidates[0]), simpleExpected);
    return simpleExpected;
  }

  const pdftoppm = getPdftoppmPath();
  const prefix = path.join(PAGE_IMAGES_DIR, baseName);
  await runProcess(pdftoppm, ["-f", String(page), "-l", String(page), "-scale-to", "260", "-png", pdfPath, prefix]);
  const candidates = fs.readdirSync(PAGE_IMAGES_DIR).filter((name) => name.startsWith(baseName) && name.endsWith(".png"));
  if (candidates.length) {
    const generated = path.join(PAGE_IMAGES_DIR, candidates[0]);
    if (generated !== simpleExpected) fs.renameSync(generated, simpleExpected);
    return simpleExpected;
  }
  throw new Error("Page image render failed");
}

function getPdftoppmPath() {
  const candidates = [
    process.env.PDFTOPPM_PATH,
    "C:\\Users\\ohpkx\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\native\\poppler\\Library\\bin\\pdftoppm.exe",
    "C:\\Program Files\\poppler\\Library\\bin\\pdftoppm.exe",
    "pdftoppm"
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === "pdftoppm" || fs.existsSync(candidate)) return candidate;
  }
  throw new Error("pdftoppm was not found. Install Poppler or set PDFTOPPM_PATH in .env.");
}

function findPythonPath() {
  const candidates = [
    "C:\\Users\\ohpkx\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe",
    "python3",
    "python"
  ];
  for (const candidate of candidates) {
    if (candidate.includes("\\") && !fs.existsSync(candidate)) continue;
    return candidate;
  }
  return "python3";
}

function runProcessWithOutput(command, args, cwd, timeoutMs) {
  const { spawn } = require("child_process");
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Command timed out"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve([stdout.trim(), stderr.trim()].filter(Boolean).join("\n"));
      else reject(new Error(stderr || stdout || `Command failed with code ${code}`));
    });
  });
}

function runProcess(command, args) {
  const { spawn } = require("child_process");
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `Command failed with code ${code}`));
    });
  });
}

function extractResponseText(data) {
  if (typeof data.output_text === "string") return data.output_text;
  if (!Array.isArray(data.output)) return "";
  return data.output.flatMap((item) => {
    if (!Array.isArray(item.content)) return [];
    return item.content.map((content) => content.text || "").filter(Boolean);
  }).join("\n");
}
