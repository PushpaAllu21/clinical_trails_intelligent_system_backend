// models/ChatSession.js
import mongoose from "mongoose";

const messageSchema = new mongoose.Schema({
  type: String, // user | bot
  text: String,
  chart: Object,
  mode: { type: String, enum: ["rag", "general"], default: null }, // tracks if bot msg came from RAG or general LLM
  createdAt: { type: Date, default: Date.now }
});

const chatSessionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  title: String,
  messages: [messageSchema],
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model("ChatSession", chatSessionSchema);