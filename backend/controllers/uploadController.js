import axios from "axios";
import path from "path";
import getSupabaseClient from "../config/supabaseClient.js";
import Document from "../models/Document.js";
import { ingestDocumentFromSource } from "./ingestionController.js";

export const uploadFile = async (req, res) => {
  try {
    console.log("\n========== 📤 UPLOAD STARTED ==========");
    const userId = req.user?.id;
    const file = req.file;
    console.log("📋 Request details:");
    console.log("   - userId:", userId);
    console.log("   - fileName:", file?.originalname);
    console.log("   - fileSize:", file?.size, "bytes");
    console.log("   - mimeType:", file?.mimetype);

    if (!userId) {
      console.log("❌ ERROR: Authentication required");
      return res.status(401).json({ message: "Authentication required" });
    }

    if (!file) {
      console.log("❌ ERROR: No file uploaded");
      return res.status(400).json({ message: "No file uploaded" });
    }

    // ✅ Validate file type
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExt = [".pdf", ".csv", ".xlsx", ".jpg", ".jpeg", ".png"];

    if (!allowedExt.includes(ext)) {
      console.log("❌ ERROR: Invalid file type:", ext);
      return res.status(400).json({
        error: "Only PDF, CSV, XLSX, JPG, JPEG, PNG files are allowed"
      });
    }
    console.log("✅ File type validated:", ext);
    
    const supabase = getSupabaseClient();
    const fileName = `${Date.now()}_${file.originalname}`;
    console.log("📤 Uploading to Supabase with filename:", fileName);
    console.log("📤 Supabase bucket:", process.env.SUPABASE_BUCKET);

    // Upload to Supabase
    const { error } = await supabase.storage
      .from(process.env.SUPABASE_BUCKET)
      .upload(fileName, file.buffer, {
        contentType: file.mimetype,
      });

    if (error) {
      console.log("❌ ERROR: Supabase upload failed:", error.message);
      throw error;
    }
    console.log("✅ File uploaded to Supabase successfully");

    // Get public URL
    const { data: urlData } = supabase.storage
      .from(process.env.SUPABASE_BUCKET)
      .getPublicUrl(fileName);

    const fileUrl = urlData.publicUrl;
    console.log("🔗 Public URL:", fileUrl);

    // Save metadata
    console.log("💾 Saving metadata to MongoDB (trails_metadata collection)...");
    const doc = await Document.create({
      userId,
      file_path: fileUrl,
    });

    console.log("✅ Document metadata saved to MongoDB:");
    console.log("   - _id:", doc._id);
    console.log("   - userId:", doc.userId);
    console.log("   - file_path:", doc.file_path);
    console.log("   - createdAt:", doc.createdAt);

    // 🔄 Process ingestion immediately
    console.log("\n🔄 Starting immediate ingestion process...");
    try {
      await ingestDocumentFromSource({
        filePath: fileUrl,
        userId
      });
      console.log("✅ Immediate ingestion completed successfully");
    } catch (ingestError) {
      console.error("❌ Immediate ingestion failed:", ingestError.message);
      console.error("❌ Ingestion stack:", ingestError.stack);
      // Don't fail the upload, but log the error
    }

    // ✅ Send fileType to n8n (optional, for other processing)
    const n8nWebhookUrl = `https://${process.env.N8N_DOMAIN_URL}/webhook/ingest-doc`;
    console.log("\n📡 Sending webhook to n8n:", n8nWebhookUrl);
    console.log("📡 Webhook payload:", { filePath: fileUrl, userId, fileType: ext });

    axios.post(
      n8nWebhookUrl,
      {
        filePath: fileUrl,
        userId,
        fileType: ext
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.N8N_SECRET_TOKEN}`
        }
      }
    )
    .then(() => {
      console.log("✅ N8N webhook sent successfully");
    })
    .catch(err => {
      console.error("⚠️ N8N webhook error:", err.message);
    });

    console.log("\n========== 📤 UPLOAD COMPLETED ==========\n");

    res.status(200).json({
      message: "File uploaded successfully",
      document: doc,
    });

  } catch (err) {
    console.error("\n❌❌❌ UPLOAD FAILED ❌❌❌");
    console.error("Error:", err.message);
    console.error("Stack:", err.stack);
    res.status(500).json({ error: err.message });
  }
};

export const getDocuments = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const docs = await Document.find({ userId }).sort({ createdAt: -1 });
    res.json(docs);
  } catch (err) {
    console.error("Get documents error:", err);
    res.status(500).json({ error: "Failed to fetch documents" });
  }
};