import Embedding from "../models/Embedding.js";
import { generateEmbedding } from "../utils/generateEmbedding.js";
import { cosineSimilarity } from "../utils/similarity.js";
import ChatSession from "../models/ChatSession.js";
import mongoose from "mongoose";
import Groq from "groq-sdk";

// Helper function to reconstruct malformed JSON
const reconstructMalformedJSON = (jsonString) => {
  try {
    return JSON.parse(jsonString);
  } catch {
    let fixed = jsonString.replace(/\\[\s]+\{/g, '{');
    const chartStart = fixed.indexOf('"chart"');
    if (chartStart > -1) {
      const markdownMatch = fixed.match(/"markdown"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (markdownMatch) {
        const markdownContent = markdownMatch[1];
        const chartObjectStart = fixed.indexOf('{', chartStart);
        if (chartObjectStart > -1) {
          let braceCount = 0;
          let chartEnd = chartObjectStart;
          for (let i = chartObjectStart; i < fixed.length; i++) {
            if (fixed[i] === '{') braceCount++;
            if (fixed[i] === '}') {
              braceCount--;
              if (braceCount === 0) {
                chartEnd = i + 1;
                break;
              }
            }
          }
          const chartContent = fixed.substring(chartObjectStart, chartEnd);
          const chart = JSON.parse(chartContent);
          return { markdown: markdownContent, chart };
        }
      }
    }
    return null;
  }
};

const sanitizeAndEvaluateJSON = (jsonString) => {
  let result = jsonString;
  result = result.replace(/Math\.(round|floor|ceil)\((.*?)\)/g, (match, func, expr) => {
    try {
      const evaluated = Function('"use strict"; return (' + expr + ')')();
      if (func === 'round') return Math.round(evaluated);
      if (func === 'floor') return Math.floor(evaluated);
      if (func === 'ceil') return Math.ceil(evaluated);
      return evaluated;
    } catch { return 0; }
  });
  result = result.replace(/(\d+(?:\.\d+)?)\s*([+\-*/])\s*(\d+(?:\.\d+)?)/g, (match, a, op, b) => {
    try {
      const numA = parseFloat(a), numB = parseFloat(b);
      switch (op) {
        case '+': return numA + numB;
        case '-': return numA - numB;
        case '*': return numA * numB;
        case '/': return numA / numB;
        default: return match;
      }
    } catch { return match; }
  });
  result = result.replace(/(\d+\.?\d*)\s*([MKB])/gi, (match, num, suffix) => {
    const number = parseFloat(num);
    const multipliers = { M: 1000000, K: 1000, B: 1000000000 };
    return Math.round(number * (multipliers[suffix.toUpperCase()] || 1) * 100) / 100;
  });
  return result;
};

// 🔄 Reusable chat session saver
const saveChatSession = async ({ chatId, question, answer, chart, mode, userId, role, groq }) => {
  let sessionId = null;
  let chatResponse = null;

  console.log("💾 saveChatSession called:", { chatId, userId, role: role || "none", mode });

  try {
    let chat = null;
    let isFirstMessage = false;

    // Try to find existing chat
    if (chatId && mongoose.Types.ObjectId.isValid(chatId)) {
      const query = role === "admin" ? { _id: chatId } : { _id: chatId, userId };
      chat = await ChatSession.findOne(query);
    }

    // If no chat found, create a new one
    if (!chat) {
      console.log("🆕 Creating new chat session");
      isFirstMessage = true;

      let title = question.slice(0, 40);

      // Try to generate a smarter title
      try {
        const titleRes = await groq.chat.completions.create({
          model: "llama-3.1-8b-instant",
          messages: [
            { role: "system", content: "Generate a short chat title (max 6 words)" },
            { role: "user", content: `Question: ${question}\nAnswer: ${answer}` }
          ]
        });
        const generatedTitle = titleRes.choices[0].message.content
          .replace(/\*\*/g, "")
          .replace(/[#`]/g, "")
          .replace(/\n/g, " ")
          .trim()
          .slice(0, 50);
        if (generatedTitle) title = generatedTitle;
      } catch (titleError) {
        console.error("Title generation failed", titleError);
      }

      chat = await ChatSession.create({
        userId,
        title,
        messages: []
      });
    } else {
      isFirstMessage = !chat.messages || chat.messages.length === 0;
      console.log("✅ saveChatSession: existing chat found", chat._id.toString(), "current messages:", chat.messages?.length || 0);
    }

    // Generate title if this is the first message
    let newTitle = chat.title;
    if (isFirstMessage) {
      try {
        const titleRes = await groq.chat.completions.create({
          model: "llama-3.1-8b-instant",
          messages: [
            { role: "system", content: "Generate a short chat title (max 6 words)" },
            { role: "user", content: `Question: ${question}\nAnswer: ${answer}` }
          ]
        });
        newTitle = titleRes.choices[0].message.content
          .replace(/\*\*/g, "")
          .replace(/[#`]/g, "")
          .replace(/\n/g, " ")
          .trim()
          .slice(0, 50);
        if (!newTitle) newTitle = question.slice(0, 40);
      } catch (titleError) {
        console.error("Title generation failed", titleError);
        newTitle = question.slice(0, 40);
      }
    }

    const newMessages = [
      { type: "user", text: question },
      { type: "bot", text: answer, chart: chart || null, mode: mode || null }
    ];

    const updateOps = { $push: { messages: { $each: newMessages } } };
    if (isFirstMessage) updateOps.$set = { title: newTitle };

    const updated = await ChatSession.findByIdAndUpdate(chat._id, updateOps, { new: true });

    if (updated) {
      console.log("✅ saveChatSession: chat updated, messages count:", updated.messages?.length);
      sessionId = updated._id;
      chatResponse = { _id: updated._id, title: updated.title };
    } else {
      console.log("⚠️ saveChatSession: findByIdAndUpdate returned null");
    }
  } catch (err) {
    console.error("❌ saveChatSession error:", err.message, err.stack);
  }

  return { sessionId, chatResponse };
};

export const queryRAG = async (req, res) => {
  try {
    console.log("🔍 Raw request body:", JSON.stringify(req.body, null, 2));
    const { question, chatId } = req.body;

    if (!question || typeof question !== 'string') {
      return res.status(400).json({ error: 'Question is required and must be a string' });
    }

    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const queryEmbedding = await generateEmbedding(question);

    const embeddingQuery = req.user?.role === "admin" ? {} : { userId: req.user?.id };
    const allDocs = await Embedding.find(embeddingQuery);

    let finalAnswer = "";
    let chart = null;
    let mode = "general";
    let sources = [];

    // 🚀 STEP 1: No documents → general LLM
    if (!allDocs || allDocs.length === 0) {
      console.log("⚠️ No documents found → switching to general LLM mode");
      const completion = await groq.chat.completions.create({
        model: "llama-3.1-8b-instant",
        messages: [
          { role: "system", content: "You are an intelligent AI assistant. Answer using general knowledge. Do not say 'no data found'. Provide helpful, clear, and structured answers." },
          { role: "user", content: question }
        ]
      });
      finalAnswer = completion.choices[0].message.content;
      chart = null;
      mode = "general";
      sources = [];
    } else {
      // 🔹 Similarity scoring
      const scored = allDocs.map(doc => ({
        text: doc.text,
        score: cosineSimilarity(queryEmbedding, doc.embedding)
      }));

      const topChunks = scored.sort((a, b) => b.score - a.score).slice(0, 5);
      const THRESHOLD = 0.3;
      const filteredChunks = topChunks.filter(c => c.score > THRESHOLD);

      // 🚀 STEP 2: No relevant chunks → general LLM
      if (filteredChunks.length === 0) {
        console.log("⚠️ No relevant context → fallback to general AI");
        const completion = await groq.chat.completions.create({
          model: "llama-3.1-8b-instant",
          messages: [
            { role: "system", content: "You are an intelligent assistant. No document context is available. Answer using general knowledge." },
            { role: "user", content: question }
          ]
        });
        finalAnswer = completion.choices[0].message.content;
        chart = null;
        mode = "general";
        sources = [];
      } else {
        // 🔹 RAG path
        const context = filteredChunks.map(c => c.text).join("\n\n");

        const completion = await groq.chat.completions.create({
          model: "llama-3.1-8b-instant",
          messages: [
            {
              role: "system",
              content: `You are an AI data analyst for clinical and structured datasets.
CRITICAL OUTPUT REQUIREMENTS:
- Return ONLY valid JSON with exactly TWO top-level keys: "markdown" and "chart"
- NEVER embed, nest, or mix markdown and chart content
- NEVER use escape sequences or special characters outside of strings
- NEVER use Math functions or shorthand notation in values

JSON Structure (STRICT):
{
  "markdown": "string here",
  "chart": {object or null}
}`
            },
            {
              role: "user",
              content: `Context:\n${context}\n\nQuestion:\n${question}\n\nYOUR RESPONSE MUST BE EXACTLY THIS FORMAT:\n\n{\n  "markdown": "## 🧠 Summary\\n...\\n\\n## 📄 Detailed Explanation\\n...\\n\\n## 📌 Key Insights\\n- ...\\n- ...\\n\\n## 📊 Data Interpretation\\n...\\n\\n## 📚 Sources\\n- source: ...",\n  "chart": {\n    "type": "bar",\n    "title": "Chart Title",\n    "labels": ["label1", "label2"],\n    "values": [10, 20]\n  }\n}\n\nABSOLUTE RULES (MUST FOLLOW):\n1. The response MUST be valid JSON that JSON.parse() can read\n2. ONLY TWO keys at the top level: "markdown" and "chart"\n3. markdown MUST be a complete string (not split or embedded elsewhere)\n4. chart MUST be a separate nested object with type/title/labels/values\n5. All numbers in values MUST be complete decimals: 1000000 (NOT 1M, NOT 1e6, NOT Math.round, NOT 1+2, NOT 3*4)\n6. DO NOT use any Math functions (Math.round, Math.floor, Math.ceil, etc.) in JSON\n7. DO NOT use any arithmetic expressions (+, -, *, /) in JSON values\n8. DO NOT use any escape sequences like \\ or \n outside string values\n9. DO NOT embed the chart definition inside markdown\n10. DO NOT include anything before or after the JSON object\n11. chart.type options: "bar", "line", "pie", "scatter", or null\n12. chart.labels MUST be an array of strings\n13. chart.values MUST be an array of ONLY numbers\n14. If no chart needed, set: "chart": null\n15. All special characters (%, $, &) MUST be inside the markdown string only\n16. Return NOTHING except the JSON object\n17. Pre-calculate ALL mathematical expressions BEFORE putting them in JSON\n18. Example CORRECT: {"values": [90, 9, 1]}\n19. Example WRONG: {"values": [Math.floor(90.48), 1+2, 3*4]}`
            }
          ]
        });

        const raw = completion.choices[0].message.content;
        let parsed;

        try {
          const jsonStart = raw.indexOf('{');
          const jsonEnd = raw.lastIndexOf('}');
          if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
            throw new Error("No valid JSON object found in response");
          }
          let jsonString = raw.substring(jsonStart, jsonEnd + 1);
          jsonString = jsonString
            .replace(/[\r\n]+/g, " ")
            .replace(/,\s*]/g, "]")
            .replace(/,\s*}/g, "}");
          jsonString = jsonString.replace(/\[\s*([\d.,\sM\KBm\kb\-]+)(?=\s*[,\]\}\]])/g, (match, contents) => {
            const values = contents.split(',').map(v => v.trim()).filter(v => v && /^\d/.test(v));
            return '[' + values.join(', ');
          });
          jsonString = sanitizeAndEvaluateJSON(jsonString);
          let parseAttempt = reconstructMalformedJSON(jsonString);
          if (parseAttempt === null) parseAttempt = JSON.parse(jsonString);
          parsed = parseAttempt;
          if (!parsed.markdown) parsed.markdown = raw;
          if (!parsed.chart) parsed.chart = null;
        } catch (err) {
          console.error("❌ JSON parse failed:", err.message);
          console.error("❌ Raw response (first 800 chars):", raw.substring(0, 800));
          parsed = { markdown: raw, chart: null };
        }

        finalAnswer = parsed.markdown;
        chart = parsed.chart;
        mode = "rag";
        sources = filteredChunks;
      }
    }

    // 🚀 COMMON SAVE STEP (for ALL paths)
    const { sessionId, chatResponse } = await saveChatSession({
      chatId, question, answer: finalAnswer, chart, mode,
      userId: req.user?.id, role: req.user?.role, groq
    });

    // 🚀 COMMON RESPONSE STEP (for ALL paths)
    res.json({
      answer: finalAnswer,
      chart,
      sources,
      chatId: sessionId,
      chat: chatResponse,
      mode
    });

  } catch (err) {
    console.error("❌ Query error:", err);
    res.status(500).json({ error: "Query failed" });
  }
};

