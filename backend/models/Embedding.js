import mongoose from "mongoose";

const embeddingSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  section: String,
  text: String,
  embedding: Array
});

export default mongoose.model("Embedding", embeddingSchema, "trails_embeddings");