import fs from "fs";
import path from "path";
import stream from "stream";
import csv from "csv-parser";
import XLSX from "xlsx";
import Tesseract from "tesseract.js";

import { extractTextFromPDF } from "../utils/extractText.js";
import { chunkText } from "../utils/chunkText.js";
import { generateEmbedding } from "../utils/generateEmbedding.js";
import getSupabaseClient from "../config/supabaseClient.js";
import Embedding from "../models/Embedding.js";


// 🔽 Download file from Supabase
const downloadSupabaseFile = async (fileUrl) => {
  const url = new URL(fileUrl);

  const match = url.pathname.match(/\/storage\/v1\/object\/public\/([^/]+)\/(.+)/);
  if (!match) {
    throw new Error("Unsupported Supabase storage URL format");
  }

  const bucket = match[1];
  const objectPath = decodeURIComponent(match[2]);

  const supabase = getSupabaseClient();
  const { data, error } = await supabase.storage.from(bucket).download(objectPath);

  if (error) {
    throw new Error(`Supabase download failed: ${error.message}`);
  }

  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
};


// 🔽 Parse CSV (buffer)
const parseCSVBuffer = (buffer) => {
  return new Promise((resolve) => {
    const results = [];

    const readable = new stream.Readable();
    readable.push(buffer);
    readable.push(null);

    readable
      .pipe(csv())
      .on("data", (data) => results.push(data))
      .on("end", () => resolve(results));
  });
};


// 🔽 Convert structured data → text
const convertToText = (rows) => {
  return rows
    .map((row) =>
      Object.entries(row)
        .map(([key, value]) => `${key}: ${value}`)
        .join(", ")
    )
    .join("\n");
};


// 🚀 MAIN INGEST LOGIC
export const ingestDocumentFromSource = async ({ filePath, userId }) => {
  console.log("\n========== 🔄 INGESTION STARTED ==========");
  console.log("🔄 Processing ingest from source:");
  console.log("   filePath:", filePath);
  console.log("   userId:", userId);

  if (!filePath) {
    console.log("❌ ERROR: No file source provided. filePath is required.");
    throw new Error("No file source provided. filePath is required.");
  }

  let source = filePath;

  // 🔽 Download file if URL
  if (typeof source === "string" && /^https?:\/\//i.test(source)) {
    console.log("📥 Downloading file from Supabase...");
    console.log("   URL:", source);
    try {
      source = await downloadSupabaseFile(source);
      console.log("✅ File downloaded as buffer, size:", source.length, "bytes");
    } catch (downloadErr) {
      console.error("❌ ERROR: Failed to download file from Supabase:", downloadErr.message);
      throw downloadErr;
    }
  } else {
    console.log("📁 Using local file path");
  }

  // 🔽 Detect file type
  const ext = typeof filePath === "string"
    ? path.extname(filePath).toLowerCase()
    : ".pdf";

  console.log("📂 Detected file type:", ext);

  let text = "";

  // 🟢 PDF
  if (ext === ".pdf") {
    console.log("📄 Extracting text from PDF...");
    try {
      text = await extractTextFromPDF(source);
      console.log("✅ PDF text extracted, length:", text.length, "characters");
    } catch (pdfErr) {
      console.error("❌ ERROR: PDF extraction failed:", pdfErr.message);
      throw pdfErr;
    }
  }

  // 🟢 CSV
  else if (ext === ".csv") {
    console.log("📄 Parsing CSV file...");
    try {
      const rows = await parseCSVBuffer(source);
      console.log("✅ CSV parsed, rows:", rows.length);
      text = convertToText(rows);
      console.log("✅ CSV converted to text, length:", text.length, "characters");
    } catch (csvErr) {
      console.error("❌ ERROR: CSV parsing failed:", csvErr.message);
      throw csvErr;
    }
  }

  // 🟢 XLSX
  else if (ext === ".xlsx") {
    console.log("📄 Parsing XLSX file...");
    try {
      const workbook = XLSX.read(source, { type: "buffer" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet);
      console.log("✅ XLSX parsed, rows:", rows.length);
      text = convertToText(rows);
      console.log("✅ XLSX converted to text, length:", text.length, "characters");
    } catch (xlsxErr) {
      console.error("❌ ERROR: XLSX parsing failed:", xlsxErr.message);
      throw xlsxErr;
    }
  }

  // 🟢 IMAGE (JPG / PNG / JPEG)
  else if (ext === ".jpg" || ext === ".jpeg" || ext === ".png") {
    console.log("🖼️ Running OCR on image...");
    try {
      const result = await Tesseract.recognize(source, "eng", {
        logger: m => console.log("   OCR:", m.status)
      });
      text = result.data.text;
      console.log("✅ OCR completed, text length:", text.length, "characters");
    } catch (ocrErr) {
      console.error("❌ ERROR: OCR failed:", ocrErr.message);
      throw ocrErr;
    }
  }

  // ❌ Unsupported
  else {
    console.log("❌ ERROR: Unsupported file type:", ext);
    throw new Error(`Unsupported file type: ${ext}`);
  }

  // 🔽 Validate extracted text
  if (!text || text.trim().length === 0) {
    console.log("❌ ERROR: No text could be extracted from the file");
    throw new Error("No text could be extracted from the file");
  }

  console.log("🔎 Extracted Text Preview:", text.slice(0, 500));

  // 🔽 Chunking
  console.log("\n✂️ Starting text chunking...");
  const chunks = chunkText(text, 150);
  console.log(`📄 Text chunked into ${chunks.length} segments`);

  const docs = [];

  // 🔽 Generate embeddings
  console.log("\n🧠 Generating embeddings for chunks...");
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk.trim().length < 20) {
      console.log(`   ⏭️ Skipping chunk ${i + 1}/${chunks.length} (too short: ${chunk.trim().length} chars)`);
      continue;
    }

    console.log(`   🔄 Processing chunk ${i + 1}/${chunks.length} (${chunk.trim().length} chars)...`);
    try {
      const embedding = await generateEmbedding(chunk);
      console.log(`   ✅ Chunk ${i + 1} embedded, vector length:`, embedding?.length || "unknown");

      docs.push({
        userId,
        section: "general",
        text: chunk,
        embedding,
      });
    } catch (embedErr) {
      console.error(`   ❌ ERROR: Failed to embed chunk ${i + 1}:`, embedErr.message);
      // Continue with other chunks
    }
  }

  console.log(`\n✅ Created ${docs.length} embeddings out of ${chunks.length} chunks`);

  if (docs.length > 0) {
    console.log("💾 Saving embeddings to MongoDB (trails_embeddings collection)...");
    try {
      const result = await Embedding.insertMany(docs);
      console.log(`✅ Inserted ${result.length} documents into MongoDB`);
      console.log("   First doc _id:", result[0]?._id);
      console.log("   Last doc _id:", result[result.length - 1]?._id);
    } catch (insertErr) {
      console.error("❌ ERROR: Failed to insert embeddings into MongoDB:", insertErr.message);
      throw insertErr;
    }
  } else {
    console.log("❌ ERROR: No valid chunks extracted");
    throw new Error("No valid chunks extracted");
  }

  console.log("\n========== 🔄 INGESTION COMPLETED ==========\n");
};

// 🚀 API CONTROLLER
export const ingestDocument = async (req, res) => {
  console.log("\n========== 📥 API /ingest CALLED ==========");
  try {
    console.log("📥 Ingest request received:");
    console.log("   Headers:", JSON.stringify(req.headers, null, 2));
    console.log("   Body:", JSON.stringify(req.body, null, 2));

    const userId = req.body.userId || req.user?.id;
    console.log("   Resolved userId:", userId);
    console.log("   req.user exists:", !!req.user);
    console.log("   req.user.role:", req.user?.role);

    if (!userId) {
      console.log("❌ ERROR: Authentication required. Provide userId in request body.");
      return res.status(401).json({ error: "Authentication required. Provide userId in request body." });
    }

    // Only check user role match if authenticated via JWT (req.user exists)
    if (req.user && req.body.userId && req.user?.role !== "admin" && req.body.userId !== req.user?.id) {
      console.log("❌ ERROR: User ID does not match authenticated user");
      return res.status(403).json({ error: "User ID does not match authenticated user" });
    }

    console.log("🚀 Calling ingestDocumentFromSource...");
    await ingestDocumentFromSource({
      ...req.body,
      userId
    });

    console.log("✅ API /ingest completed successfully");
    console.log("========== 📥 API /ingest END ==========\n");

    res.json({ message: "Ingestion completed successfully" });

  } catch (err) {
    console.error("\n❌❌❌ API /ingest FAILED ❌❌❌");
    console.error("Error:", err.message);
    console.error("Stack:", err.stack);
    console.log("========== 📥 API /ingest END (ERROR) ==========\n");

    const status = err.message?.includes("No file source") ? 400 : 500;

    res.status(status).json({
      error: err.message || "Ingestion failed"
    });
  }
};
