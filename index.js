
import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import pdfParse from "pdf-parse";
import { readFile } from "node:fs/promises";

dotenv.config();

const app = express();

app.use(cors({
  origin: process.env.CLIENT_ORIGIN || "http://localhost:5173"
}));
app.use(express.json({ limit: "15mb" }));

const maxMb = Number(process.env.MAX_PDF_MB || 25);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxMb * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const isPdf =
      file.mimetype === "application/pdf" ||
      file.originalname.toLowerCase().endsWith(".pdf");

    if (!isPdf) {
      return cb(new Error("File harus berupa PDF."));
    }

    cb(null, true);
  }
});

// ==========================================
// OMNIROUTE CONFIGURATION
// ==========================================
function getOmniConfig() {
  const base = (process.env.OMNIROUTE_BASE_URL || "").replace(/\/+$/, "");
  const key = process.env.OMNIROUTE_API_KEY || "";

  if (!base) {
    throw new Error("OMNIROUTE_BASE_URL belum diisi pada server/.env.");
  }

  if (!key) {
    throw new Error("OMNIROUTE_API_KEY belum diisi pada server/.env.");
  }

  return { base, key };
}

async function omniFetch(path, options = {}) {
  const { base, key } = getOmniConfig();

  return fetch(`${base}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(options.headers || {})
    }
  });
}

// ==========================================
// BUILD PROMPT FOR PDF ANALYSIS
// ==========================================
function buildInfographicPrompt(excerpt) {
  return `
Anda adalah editor pendidikan dan penyusun infografis profesional.

TUGAS:
Ubah materi buku pelajaran di bawah menjadi konten infografis
berbahasa Indonesia yang akurat, ringkas, dan mudah dipahami siswa.

ATURAN WAJIB:
1. Gunakan hanya informasi yang didukung oleh materi sumber.
2. Jangan mengarang fakta, angka, nama, definisi, atau proses.
3. Pertahankan istilah penting yang digunakan dalam buku.
4. Kembalikan HANYA satu objek JSON valid.
5. Jangan menambahkan markdown, code fence, atau penjelasan di luar JSON.
6. Buat 3 sampai 5 bagian (sections).
7. Setiap bagian maksimal 3 keyPoints.
8. Penjelasan body maksimal sekitar 35 kata.
9. Deskripsi visual merupakan arahan ilustrasi, bukan teks yang harus dicetak pada gambar.
10. Jika informasi tidak tersedia dalam sumber, jangan mengada-adakannya.

FORMAT JSON:
{
  "title": "judul infografis",
  "subtitle": "subjudul singkat",
  "subject": "mata pelajaran",
  "theme": "science",
  "sections": [
    {
      "heading": "judul bagian",
      "body": "penjelasan singkat",
      "keyPoints": ["poin 1", "poin 2"],
      "visual": "deskripsi ilustrasi"
    }
  ],
  "keyTakeaway": "kesimpulan utama",
  "sourceNote": "bab atau topik sumber"
}

Nilai theme hanya boleh salah satu dari:
science, history, social, language, general.

MATERI SUMBER:
${excerpt}
`;
}

// ==========================================
// PARSE AND VALIDATE AI JSON
// ==========================================
function parseInfographic(content) {
  if (typeof content !== "string" || !content.trim()) {
    return {
      ok: false,
      error: "Model tidak mengembalikan teks konten."
    };
  }

  let cleaned = content.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");

  if (firstBrace < 0 || lastBrace < firstBrace) {
    return {
      ok: false,
      error: "Output model tidak mengandung objek JSON."
    };
  }

  cleaned = cleaned.slice(firstBrace, lastBrace + 1);

  let data;

  try {
    data = JSON.parse(cleaned);
  } catch (error) {
    return {
      ok: false,
      error: "JSON dari model belum valid.",
      detail: error.message,
      modelOutput: cleaned
    };
  }

  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    !Array.isArray(data.sections) ||
    data.sections.length === 0
  ) {
    return {
      ok: false,
      error: "Struktur JSON tidak memiliki sections yang valid."
    };
  }

  const allowedThemes = [
    "science",
    "history",
    "social",
    "language",
    "general"
  ];

  data.title = String(data.title || "Infografis Pembelajaran");
  data.subtitle = String(data.subtitle || "");
  data.subject = String(data.subject || "Umum");
  data.theme = String(data.theme || "general").toLowerCase();

  if (!allowedThemes.includes(data.theme)) {
    data.theme = "general";
  }

  data.sections = data.sections.slice(0, 5).map((section, index) => ({
    heading: String(section.heading || `Bagian ${index + 1}`),
    body: String(section.body || ""),
    keyPoints: Array.isArray(section.keyPoints)
      ? section.keyPoints.map(point => String(point)).slice(0, 3)
      : [],
    visual: String(section.visual || "")
  }));

  data.keyTakeaway = String(data.keyTakeaway || "");
  data.sourceNote = String(
    data.sourceNote || "Buku paket yang diunggah"
  );

  return {
    ok: true,
    data
  };
}

// ==========================================
// BASIC ROUTES
// ==========================================
app.get("/", (_req, res) => {
  res.send("EduInfographic AI Backend is Running!");
});

app.get("/api/health", async (_req, res) => {
  try {
    const { base } = getOmniConfig();

    let reachable = false;
    let upstreamStatus = null;

    try {
      const response = await fetch(base, { method: "GET" });
      reachable = true;
      upstreamStatus = response.status;
    } catch {
      reachable = false;
    }

    res.json({
      ok: true,
      service: "eduinfographic-api",
      omniRoute: reachable ? "host-reachable" : "host-unreachable",
      omniRouteHttpStatus: upstreamStatus,
      baseUrl: base
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      service: "eduinfographic-api",
      error: error.message
    });
  }
});

// ==========================================
// MODEL CATALOG
// ==========================================
app.get("/api/models", async (_req, res) => {
  try {
    const [chatRes, imageRes] = await Promise.all([
      omniFetch("/v1/models?kind=chat&prefix=alias"),
      omniFetch("/v1/models?kind=image&prefix=alias")
    ]);

    const [chatText, imageText] = await Promise.all([
      chatRes.text(),
      imageRes.text()
    ]);

    if (!chatRes.ok) {
      return res.status(chatRes.status).json({
        error: "Gagal mengambil katalog model chat.",
        detail: chatText.slice(0, 1200)
      });
    }

    if (!imageRes.ok) {
      return res.status(imageRes.status).json({
        error: "Gagal mengambil katalog model gambar.",
        detail: imageText.slice(0, 1200)
      });
    }

    const chat = JSON.parse(chatText);
    const image = JSON.parse(imageText);

    res.json({
      chat: (chat.data || []).map(item => ({
        id: item.id,
        name: item.name || item.id,
        context_length: item.context_length,
        capabilities: item.capabilities || []
      })),
      image: (image.data || []).map(item => ({
        id: item.id,
        name: item.name || item.id
      }))
    });
  } catch (error) {
    res.status(503).json({
      error: error.message || "Tidak dapat terhubung ke OmniRoute."
    });
  }
});

// ==========================================
// ANALYZE UPLOADED PDF
// ==========================================
app.post("/api/analyze-pdf", upload.single("pdf"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: "PDF belum dipilih."
      });
    }

    const model = process.env.OMNIROUTE_CHAT_MODEL;

    if (!model) {
      return res.status(503).json({
        error: "OMNIROUTE_CHAT_MODEL belum diisi pada server/.env."
      });
    }

    const parsed = await pdfParse(req.file.buffer);
    const sourceText = (parsed.text || "")
      .replace(/\u0000/g, "")
      .trim();

    if (sourceText.length < 100) {
      return res.status(422).json({
        error: "Teks PDF terlalu sedikit. PDF mungkin berupa scan/gambar dan memerlukan OCR.",
        pages: parsed.numpages || null,
        extractedCharacters: sourceText.length
      });
    }

    const excerpt = sourceText.slice(0, 25000);
    const prompt = buildInfographicPrompt(excerpt);

    const response = await omniFetch("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 4000,
        stream: false,
        messages: [
          {
            role: "system",
            content: "Anda adalah editor pendidikan. Kembalikan satu objek JSON valid saja tanpa markdown."
          },
          {
            role: "user",
            content: prompt
          }
        ]
      })
    });

    const rawText = await response.text();

    if (!response.ok) {
      return res.status(response.status).json({
        error: `Permintaan OmniRoute gagal (${response.status}).`,
        detail: rawText.slice(0, 1600)
      });
    }

    let apiData;

    try {
      apiData = JSON.parse(rawText);
    } catch {
      return res.status(502).json({
        error: "Respons OmniRoute bukan JSON valid.",
        detail: rawText.slice(0, 1200)
      });
    }

    const choice = apiData?.choices?.[0];
    const content = choice?.message?.content;

    if (typeof content !== "string" || !content.trim()) {
      return res.status(502).json({
        error: "Model tidak mengembalikan konten infografis.",
        model: apiData?.model || model,
        finishReason: choice?.finish_reason || null,
        reasoningContentPresent: Boolean(choice?.message?.reasoning_content),
        usage: apiData?.usage || null
      });
    }

    const result = parseInfographic(content);

    if (!result.ok) {
      return res.status(502).json({
        error: result.error,
        detail: result.detail || null,
        modelOutput: result.modelOutput || content.slice(0, 5000),
        finishReason: choice?.finish_reason || null
      });
    }

    return res.json({
      ok: true,
      infographic: result.data,
      pdf: {
        pages: parsed.numpages || null,
        extractedCharacters: sourceText.length,
        charactersSentToAI: excerpt.length
      },
      ai: {
        model: apiData?.model || model,
        finishReason: choice?.finish_reason || null,
        usage: apiData?.usage || null
      }
    });
  } catch (error) {
    console.error("PDF analysis error:", error);

    return res.status(500).json({
      error: error.message || "Terjadi kesalahan pada proses analisis PDF."
    });
  }
});

// ==========================================
// MODEL LABORATORY: LOCAL IMAGE CATALOG
// ==========================================
app.get("/api/image-catalog", async (_req, res) => {
  try {
    const catalogPath =
      process.env.OMNIROUTE_IMAGE_CATALOG ||
      new URL("./omniroute-image-catalog.txt", import.meta.url);

    const raw = await readFile(catalogPath, "utf8");
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));

    const models = (parsed.data || [])
      .filter(item => item.type === "image" && item.id)
      .map(item => ({
        id: item.id,
        name: item.name || item.id,
        provider: item.owned_by || item.id.split("/")[0],
        sizes: item.supported_sizes || [],
        input_modalities: item.input_modalities || [],
        output_modalities: item.output_modalities || []
      }));

    res.json({
      ok: true,
      count: models.length,
      models
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: "Katalog lokal tidak dapat dibaca.",
      detail: error.message
    });
  }
});

// ==========================================
// MODEL LABORATORY: TEST ONE IMAGE MODEL
// ==========================================
app.post("/api/test-image-model", async (req, res) => {
  const startedAt = Date.now();

  try {
    const {
      model,
      prompt,
      size = "1024x1024"
    } = req.body || {};

    if (
      typeof model !== "string" ||
      !model.trim() ||
      typeof prompt !== "string" ||
      !prompt.trim()
    ) {
      return res.status(400).json({
        ok: false,
        category: "invalid_request",
        error: "Model dan prompt wajib diisi."
      });
    }

    const response = await omniFetch("/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: model.trim(),
        prompt: prompt.trim(),
        size,
        n: 1,
        response_format: "b64_json"
      })
    });

    const raw = await response.text();
    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
      const category =
        response.status === 401 || response.status === 403
          ? "permission_denied"
          : response.status === 429
            ? "rate_limited"
            : response.status >= 500
              ? "provider_error"
              : "request_rejected";

      return res.status(response.status).json({
        ok: false,
        model: model.trim(),
        status: response.status,
        category,
        latencyMs,
        error: `Image generation gagal (HTTP ${response.status}).`,
        detail: raw.slice(0, 1800)
      });
    }

    let payload;

    try {
      payload = JSON.parse(raw);
    } catch {
      return res.status(502).json({
        ok: false,
        model: model.trim(),
        status: 502,
        category: "invalid_response",
        latencyMs,
        error: "Respons provider bukan JSON yang valid.",
        detail: raw.slice(0, 1000)
      });
    }

    const item = payload?.data?.[0] || payload?.images?.[0] || payload;

    const image = item?.b64_json
      ? `data:image/png;base64,${item.b64_json}`
      : item?.url || item?.image_url || null;

    if (!image) {
      return res.status(502).json({
        ok: false,
        model: model.trim(),
        status: 502,
        category: "no_image_returned",
        latencyMs,
        error: "Request diterima, tetapi gambar tidak ditemukan pada respons.",
        detail: raw.slice(0, 1200)
      });
    }

    return res.json({
      ok: true,
      model: model.trim(),
      status: response.status,
      category: "success",
      latencyMs,
      image,
      revised_prompt: item?.revised_prompt || null
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      category: "server_error",
      latencyMs: Date.now() - startedAt,
      error: error.message || "Pengujian model gagal."
    });
  }
});

// ==========================================
// GENERATE IMAGE / ILLUSTRATION
// ==========================================
app.post("/api/generate-image", async (req, res) => {
  try {
    const { model, prompt } = req.body || {};

    if (!model || !prompt) {
      return res.status(400).json({
        error: "Model gambar dan prompt wajib diisi."
      });
    }

    const response = await omniFetch("/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        prompt: `${prompt}. Educational editorial illustration, clean shapes, high visual clarity, no text, no letters, no watermark.`,
        size: "1024x1024",
        n: 1,
        response_format: "b64_json"
      })
    });

    const raw = await response.text();

    if (!response.ok) {
      return res.status(response.status).json({
        error: `Image generation gagal (${response.status}).`,
        detail: raw.slice(0, 1200)
      });
    }

    let data;

    try {
      data = JSON.parse(raw);
    } catch {
      return res.status(502).json({
        error: "Respons model gambar bukan JSON yang valid.",
        detail: raw.slice(0, 1200)
      });
    }

    const item =
      data?.data?.[0] ||
      data?.images?.[0] ||
      data?.output?.[0] ||
      data;

    const base64 =
      item?.b64_json ||
      item?.base64 ||
      item?.image_base64;

    const image = base64
      ? `data:image/png;base64,${base64}`
      : item?.url ||
        item?.image_url ||
        item?.image ||
        null;

    if (!image) {
      return res.status(502).json({
        error: "Model menerima permintaan tetapi tidak mengembalikan gambar dalam format yang dikenali.",
        detail: raw.slice(0, 1200)
      });
    }

    res.json({
      image,
      revised_prompt: item.revised_prompt || null
    });

  } catch (error) {
    res.status(500).json({
      error: error.message || "Gagal membuat ilustrasi."
    });
  }
});

// ==========================================
// ERROR HANDLER
// ==========================================
app.use((error, _req, res, _next) => {
  res.status(400).json({
    error: error.message || "Request tidak valid."
  });
});

const port = Number(process.env.PORT || 8787);

app.listen(port, () => {
  console.log(`EduInfographic API running on http://localhost:${port}`);
});
