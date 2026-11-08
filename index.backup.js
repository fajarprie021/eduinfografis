import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import pdfParse from "pdf-parse";

dotenv.config();
const app = express();
app.use(cors({ origin: process.env.CLIENT_ORIGIN || "http://localhost:5173" }));
app.use(express.json({ limit: "15mb" }));
const maxMb = Number(process.env.MAX_PDF_MB || 25);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxMb * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const isPdf = file.mimetype === "application/pdf" || file.originalname.toLowerCase().endsWith(".pdf");
    cb(isPdf ? null : new Error("File harus berupa PDF."), isPdf);
  }
});

function config() {
  const base = (process.env.OMNIROUTE_BASE_URL || "").replace(/\/+$/, "");
  const key = process.env.OMNIROUTE_API_KEY || "";
  if (!base || !key) throw new Error("OMNIROUTE_BASE_URL dan OMNIROUTE_API_KEY belum diisi pada server/.env.");
  return { base, key };
}
async function omniFetch(path, options = {}) {
  const { base, key } = config();
  return fetch(`${base}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${key}`, ...(options.headers || {}) }
  });
}
function cleanModelJson(content) {
  if (!content) return null;

  let text = content.trim();

  // hapus markdown fence jika ada
  text = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "");
  text = text.replace(/\s*```$/i, "");

  // ambil blok JSON dari { pertama sampai } terakhir
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1) return null;

  text = text.slice(first, last + 1);

  return text;
}

function safeParseJson(content) {
  try {
    return JSON.parse(content);
  } catch (err) {
    return null;
  }
}
app.get("/api/health", async (_req, res) => {
  try {
    const { base } = config();
    const r = await omniFetch("/v1/models?limit=1");
    res.json({ ok: r.ok, service: "eduinfographic-api", omniRoute: r.ok ? "reachable" : "auth-or-upstream-error", baseUrl: base });
  } catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});

app.get("/api/models", async (_req, res) => {
  try {
    const [chatRes, imageRes] = await Promise.all([
      omniFetch("/v1/models?kind=chat&prefix=alias"),
      omniFetch("/v1/models?kind=image&prefix=alias")
    ]);
    const [chatRaw, imageRaw] = await Promise.all([chatRes.text(), imageRes.text()]);
    if (!chatRes.ok) return res.status(chatRes.status).json({ error: "Gagal mengambil katalog model chat.", detail: chatRaw.slice(0, 1000) });
    if (!imageRes.ok) return res.status(imageRes.status).json({ error: "Gagal mengambil katalog model gambar.", detail: imageRaw.slice(0, 1000) });
    const chat = JSON.parse(chatRaw), image = JSON.parse(imageRaw);
    res.json({
      chat: (chat.data || []).map(x => ({ id: x.id, name: x.name || x.id, context_length: x.context_length, capabilities: x.capabilities || [] })),
      image: (image.data || []).map(x => ({ id: x.id, name: x.name || x.id }))
    });
  } catch (e) { res.status(503).json({ error: e.message || "Tidak dapat terhubung ke OmniRoute." }); }
});

app.post("/api/analyze-pdf", upload.single("pdf"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "PDF belum dipilih." });
    }

    const parsed = await pdfParse(req.file.buffer);
    const sourceText = (parsed.text || "").trim();

    if (sourceText.length < 100) {
      return res.status(422).json({
        error: "Teks PDF terlalu sedikit. Kemungkinan PDF berupa scan/gambar dan memerlukan OCR."
      });
    }

    const excerpt = sourceText.slice(0, 25000);
const prompt = `
Anda adalah editor pendidikan dan penyusun infografis profesional.

TUGAS:
Ubah materi buku pelajaran berikut menjadi konten infografis
berbahasa Indonesia yang akurat, menarik, dan mudah dipahami siswa.

ATURAN:
1. Gunakan hanya informasi dari materi sumber.
2. Jangan mengarang fakta atau angka.
3. Pertahankan istilah penting dari buku.
4. Kembalikan hanya JSON valid.
5. Jangan gunakan markdown.
6. Buat 3 sampai 5 bagian.
7. Setiap bagian maksimal 3 poin penting.

FORMAT JSON:
{
  "title": "judul infografis",
  "subtitle": "subjudul",
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

MATERI SUMBER:
${excerpt}
`;
    const response = await fetch(`${process.env.OMNIROUTE_BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OMNIROUTE_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OMNIROUTE_CHAT_MODEL,
        temperature: 0.2,
        messages: [
          { role: "system", content: "Kembalikan hanya JSON valid tanpa markdown." },
          { role: "user", content: prompt }
        ]
      })
    });

    const raw = await response.json();
    const content = raw?.choices?.[0]?.message?.content;

    if (!content) {
      return res.status(502).json({ error: "Model tidak mengembalikan konten." });
    }

    const cleaned = cleanModelJson(content);
    if (!cleaned) {
      return res.status(502).json({
        error: "Output model tidak mengandung JSON yang dapat dibaca.",
        modelOutput: content
      });
    }

    const infographic = safeParseJson(cleaned);
    if (!infographic) {
      return res.status(502).json({
        error: "JSON dari model belum valid.",
        cleanedOutput: cleaned
      });
    }

    return res.json({
      ok: true,
      infographic,
      pdf: {
        pages: parsed.numpages,
        extractedCharacters: sourceText.length
      }
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: error.message || "Terjadi kesalahan pada proses analisis PDF."
    });
  }
});
const prompt = `
Anda adalah editor pendidikan dan penyusun infografis.
Tugas Anda adalah mengubah materi buku pelajaran menjadi JSON infografis.

ATURAN WAJIB:
1. Kembalikan HANYA JSON valid.
2. Jangan beri penjelasan tambahan.
3. Jangan pakai markdown.
4. Semua struktur harus lengkap dan valid.
5. Jangan mengarang fakta di luar materi sumber.
6. Gunakan bahasa Indonesia yang ringkas, jelas, dan cocok untuk siswa.

Format JSON yang WAJIB diikuti:
{
  "title": "judul ringkas",
  "subtitle": "subjudul singkat",
  "subject": "mata pelajaran",
  "theme": "science|history|social|language|general",
  "sections": [
    {
      "heading": "judul bagian",
      "body": "penjelasan singkat maksimal 35 kata",
      "keyPoints": ["poin 1", "poin 2", "poin 3"],
      "visual": "deskripsi ilustrasi singkat"
    }
  ],
  "keyTakeaway": "kesimpulan utama maksimal 30 kata",
  "sourceNote": "bab atau topik sumber"
}

Buat 4 section.
Setiap section maksimal 3 keyPoints.

MATERI SUMBER:
${excerpt}
`;

app.post("/api/generate-image", async (req, res) => {
  try {
    const { model, prompt } = req.body || {};
    if (!model || !prompt) return res.status(400).json({ error: "Model gambar dan prompt wajib diisi." });
    const response = await omniFetch("/v1/images/generations", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: `${prompt}. Educational editorial illustration, clean shapes, high visual clarity, no text, no letters, no watermark.`, size: "1024x1024", n: 1, response_format: "b64_json" })
    });
    const raw = await response.text();
    if (!response.ok) return res.status(response.status).json({ error: `Image generation gagal (${response.status})`, detail: raw.slice(0, 1200) });
    const data = JSON.parse(raw), item = data.data?.[0];
    if (!item) return res.status(502).json({ error: "Model gambar tidak mengembalikan gambar." });
    const image = item.b64_json ? `data:image/png;base64,${item.b64_json}` : item.url;
    if (!image) return res.status(502).json({ error: "Format gambar dari provider tidak dikenali." });
    res.json({ image, revised_prompt: item.revised_prompt || null });
  } catch (e) { res.status(500).json({ error: e.message || "Gagal membuat ilustrasi." }); }
});

app.use((err, _req, res, _next) => res.status(400).json({ error: err.message || "Request tidak valid." }));
const port = Number(process.env.PORT || 8787);
app.listen(port, () => console.log(`EduInfographic API running on http://localhost:${port}`));
