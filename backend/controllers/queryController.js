import Embedding from "../models/Embedding.js";
import { generateEmbedding } from "../utils/generateEmbedding.js";
import { cosineSimilarity } from "../utils/similarity.js";
import ChatSession from "../models/ChatSession.js";
import mongoose from "mongoose";
import Groq from "groq-sdk";

// Helper function to reconstruct malformed JSON
const reconstructMalformedJSON = (jsonString) => {
  try {
    // Try direct parse first
    return JSON.parse(jsonString);
  } catch {
    // Try to fix common LLM mistakes
    
    // 1. Remove bad escape sequences like "\ {" or "\n\ {"
    let fixed = jsonString.replace(/\\[\s]+\{/g, '{');
    
    // 2. Extract markdown content - find everything up to the first complete "chart" key
    const chartStart = fixed.indexOf('"chart"');
    if (chartStart > -1) {
      // Find the markdown string ending (look for ": " after markdown key)
      const markdownMatch = fixed.match(/"markdown"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      
      if (markdownMatch) {
        const markdownContent = markdownMatch[1];
        
        // Extract chart JSON
        const chartObjectStart = fixed.indexOf('{', chartStart);
        if (chartObjectStart > -1) {
          // Find the matching closing brace for chart
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
          
          // Reconstruct proper JSON
          return {
            markdown: markdownContent,
            chart: chart
          };
        }
      }
    }
    
    // If reconstruction fails, return null to trigger fallback
    return null;
  }
};

// Helper function to safely evaluate Math expressions and shorthand notation in JSON
const sanitizeAndEvaluateJSON = (jsonString) => {
  let result = jsonString;
  
  // Replace Math.round(...) and Math.floor(...) expressions with evaluated results
  result = result.replace(/Math\.(round|floor|ceil)\((.*?)\)/g, (match, func, expr) => {
    try {
      const evaluated = Function('"use strict"; return (' + expr + ')')();
      if (func === 'round') return Math.round(evaluated);
      if (func === 'floor') return Math.floor(evaluated);
      if (func === 'ceil') return Math.ceil(evaluated);
      return evaluated;
    } catch {
      return 0;
    }
  });
  
  // Replace basic arithmetic expressions (numbers with +, -, *, /)
  result = result.replace(/(\d+(?:\.\d+)?)\s*([+\-*/])\s*(\d+(?:\.\d+)?)/g, (match, a, op, b) => {
    try {
      const numA = parseFloat(a);
      const numB = parseFloat(b);
      let result;
      switch (op) {
        case '+': result = numA + numB; break;
        case '-': result = numA - numB; break;
        case '*': result = numA * numB; break;
        case '/': result = numA / numB; break;
        default: return match;
      }
      return result;
    } catch {
      return match;
    }
  });
  
  // Replace shorthand notation: 5.43M → 5430000, 2.5K → 2500, 1.2B → 1200000000
  result = result.replace(/(\d+\.?\d*)\s*([MKB])/gi, (match, num, suffix) => {
    const number = parseFloat(num);
    const multipliers = { 'M': 1000000, 'K': 1000, 'B': 1000000000 };
    const multiplier = multipliers[suffix.toUpperCase()] || 1;
    return Math.round(number * multiplier * 100) / 100; // round to 2 decimals
  });
  
  return result;
};

export const queryRAG = async (req, res) => {
  try {
    console.log("🔍 Raw request body:", JSON.stringify(req.body, null, 2));
    const { question, chatId } = req.body;

    if (!question || typeof question !== 'string') {
      return res.status(400).json({ error: 'Question is required and must be a string' });
    }

    const groq = new Groq({
      apiKey: process.env.GROQ_API_KEY,
    });

    // 🔹 1. Query embedding
    const queryEmbedding = await generateEmbedding(question);

    // 🔹 2. Fetch stored embeddings for this user
    const embeddingQuery = req.user?.role === "admin"
      ? {}
      : { userId: req.user?.id };

    const allDocs = await Embedding.find(embeddingQuery);

    // 🚀 STEP 1: Detect empty embeddings → fallback to general LLM
    if (!allDocs || allDocs.length === 0) {
      console.log("⚠️ No documents found → switching to general LLM mode");

      const completion = await groq.chat.completions.create({
        model: "llama-3.1-8b-instant",
        messages: [
          {
            role: "system",
            content: `
You are an intelligent AI assistant.

Answer the question using general knowledge.
Do not say "no data found".
Provide helpful, clear, and structured answers.
            `
          },
          {
            role: "user",
            content: question
          }
        ]
      });

      return res.json({
        answer: completion.choices[0].message.content,
        chart: null,
        sources: [],
        mode: "general"
      });
    }

    // 🔹 3. Similarity scoring
    const scored = allDocs.map(doc => ({
      text: doc.text,
      trial_id: doc.trial_id,
      score: cosineSimilarity(queryEmbedding, doc.embedding)
    }));

    // 🔹 4. Top chunks
    const topChunks = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    // 🚀 STEP 2: Handle "no relevant chunks" → fallback to general LLM
    const THRESHOLD = 0.3;
    const filteredChunks = topChunks.filter(c => c.score > THRESHOLD);

    if (filteredChunks.length === 0) {
      console.log("⚠️ No relevant context → fallback to general AI");

      const completion = await groq.chat.completions.create({
        model: "llama-3.1-8b-instant",
        messages: [
          {
            role: "system",
            content: `
You are an intelligent assistant.

No document context is available.
Answer using general knowledge.
            `
          },
          {
            role: "user",
            content: question
          }
        ]
      });

      return res.json({
        answer: completion.choices[0].message.content,
        chart: null,
        sources: [],
        mode: "general"
      });
    }

    // 🔹 5. Build context (use filtered chunks for RAG)
    const context = filteredChunks.map(c => c.text).join("\n\n");

    // 🔹 6. LLM Call (UPDATED PROMPT)
    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        {
          role: "system",
          content: `
You are an AI data analyst for clinical and structured datasets.

CRITICAL OUTPUT REQUIREMENTS:
- Return ONLY valid JSON with exactly TWO top-level keys: "markdown" and "chart"
- NEVER embed, nest, or mix markdown and chart content
- NEVER use escape sequences or special characters outside of strings
- NEVER use Math functions or shorthand notation in values

JSON Structure (STRICT):
{
  "markdown": "string here",
  "chart": {object or null}
}
`
        },
        {
          role: "user",
          content: `
Context:
${context}

Question:
${question}

YOUR RESPONSE MUST BE EXACTLY THIS FORMAT:

{
  "markdown": "## 🧠 Summary\\n...\\n\\n## 📄 Detailed Explanation\\n...\\n\\n## 📌 Key Insights\\n- ...\\n- ...\\n\\n## 📊 Data Interpretation\\n...\\n\\n## 📚 Sources\\n- trial_id: ...",
  "chart": {
    "type": "bar",
    "title": "Chart Title",
    "labels": ["label1", "label2"],
    "values": [10, 20]
  }
}

ABSOLUTE RULES (MUST FOLLOW):
1. The response MUST be valid JSON that JSON.parse() can read
2. ONLY TWO keys at the top level: "markdown" and "chart"
3. markdown MUST be a complete string (not split or embedded elsewhere)
4. chart MUST be a separate nested object with type/title/labels/values
5. All numbers in values MUST be complete decimals: 1000000 (NOT 1M, NOT 1e6, NOT Math.round, NOT 1+2, NOT 3*4)
6. DO NOT use any Math functions (Math.round, Math.floor, Math.ceil, etc.) in JSON
7. DO NOT use any arithmetic expressions (+, -, *, /) in JSON values
8. DO NOT use any escape sequences like \\ or \n outside string values
9. DO NOT embed the chart definition inside markdown
10. DO NOT include anything before or after the JSON object
11. chart.type options: "bar", "line", "pie", "scatter", or null
12. chart.labels MUST be an array of strings
13. chart.values MUST be an array of ONLY numbers
14. If no chart needed, set: "chart": null
15. All special characters (%, $, &) MUST be inside the markdown string only
16. Return NOTHING except the JSON object
17. Pre-calculate ALL mathematical expressions BEFORE putting them in JSON
18. Example CORRECT: {"values": [90, 9, 1]}
19. Example WRONG: {"values": [Math.floor(90.48), 1+2, 3*4]}
`
        }
      ]
    });

    // 🔹 7. Parse response
    const raw = completion.choices[0].message.content;

    let parsed;

    try {
      // 🔥 Extract JSON more robustly
      const jsonStart = raw.indexOf('{');
      const jsonEnd = raw.lastIndexOf('}');

      if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
        throw new Error("No valid JSON object found in response");
      }

      let jsonString = raw.substring(jsonStart, jsonEnd + 1);
      
      // Fix common JSON issues
      jsonString = jsonString
        .replace(/[\r\n]+/g, " ") // normalize whitespace
        .replace(/,\s*]/g, "]") // remove trailing commas in arrays
        .replace(/,\s*}/g, "}"); // remove trailing commas in objects
      
      // Fix incomplete arrays (e.g., [1.2M, 3.4K, becomes [1.2M, 3.4])
      // Match array values and ensure they're complete
      jsonString = jsonString.replace(/\[\s*([\d.,\sM\KBm\kb\-]+)(?=\s*[,\]}\]])/g, (match, contents) => {
        // Trim incomplete values
        const values = contents.split(',').map(v => v.trim()).filter(v => v && /^\d/.test(v));
        return '[' + values.join(', ');
      });
      
      // Sanitize Math expressions and shorthand notation
      jsonString = sanitizeAndEvaluateJSON(jsonString);

      // Try parsing with malformed JSON reconstruction
      let parseAttempt = reconstructMalformedJSON(jsonString);
      
      if (parseAttempt === null) {
        // Final attempt: direct JSON.parse
        parseAttempt = JSON.parse(jsonString);
      }
      
      parsed = parseAttempt;
      
      console.log("✅ JSON parsed successfully");
    

      // Ensure required fields
      if (!parsed.markdown) parsed.markdown = raw;
      if (!parsed.chart) parsed.chart = null;

    } catch (err) {
      console.error("❌ JSON parse failed:", err.message);
      console.error("❌ Raw response (first 800 chars):", raw.substring(0, 800));
      
      // Log the sanitized attempt if available
      try {
        const jsonStart = raw.indexOf('{');
        const jsonEnd = raw.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
          const attempted = raw.substring(jsonStart, jsonEnd + 1).substring(0, 800);
          console.error("❌ Attempted JSON parse (first 800 chars):", attempted);
        }
      } catch {}

      parsed = {
        markdown: raw,
        chart: null
      };
    }

    // 🔹 Handle Chat Session
    let sessionId = null;
    let chatResponse = null;
    let chat = null;

    if (chatId && mongoose.Types.ObjectId.isValid(chatId)) {
      const query = req.user?.role === "admin"
        ? { _id: chatId }
        : { _id: chatId, userId: req.user?.id };

      chat = await ChatSession.findOne(query);
    }

    if (chat) {
      if (!chat.messages || chat.messages.length === 0) {
        try {
          const titleRes = await groq.chat.completions.create({
            model: "llama-3.1-8b-instant",
            messages: [
              {
                role: "system",
                content: "Generate a short chat title (max 6 words)"
              },
              {
                role: "user",
                content: `Question: ${question}\nAnswer: ${parsed.markdown}`
              }
            ]
          });

          const generatedTitle = titleRes.choices[0].message.content
            .replace(/\*\*/g, "")     // 🔥 remove **
            .replace(/[#`]/g, "")     // remove markdown symbols
            .replace(/\n/g, " ")
            .trim()
            .slice(0, 50);

          chat.title = generatedTitle || question.slice(0, 40);
        } catch (titleError) {
          console.error("Title generation failed", titleError);
          chat.title = question.slice(0, 40);
        }
      }

      chat.messages.push(
        { type: "user", text: question },
        {
          type: "bot",
          text: parsed.markdown,
          chart: parsed.chart
        }
      );

      try {
        await chat.save();
        sessionId = chat._id;
        chatResponse = {
          _id: chat._id,
          title: chat.title
        };
      } catch (saveError) {
        console.error("❌ Chat save failed:", saveError.message);
      }
    }

    // 🔹 8. Send response
    res.json({
      answer: parsed.markdown,
      chart: parsed.chart,
      sources: filteredChunks,
      sessionId: sessionId,
      chat: chatResponse,
      mode: "rag"
    });

  } catch (err) {
    console.error("❌ Query error:", err);
    res.status(500).json({ error: "Query failed" });
  }
};