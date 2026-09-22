import mongoose from "mongoose";

// ================= MEMORY GROUP (Instagram "Highlight") =================
// This is the bubble shown on the profile below Edit Profile. Clicking
// "+ Add memory" creates ONE of these plus its first MemoryItem. Every
// later "Add another memory" (from inside the viewer's ⋮ menu) adds
// another MemoryItem into this SAME group — it does NOT create a new
// group. A brand new group is only created by tapping the big
// "+ Add memory" button again.
const memoryGroupSchema = new mongoose.Schema(
  {
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true, trim: true, maxlength: 40 },
  },
  { timestamps: true }
);

export default mongoose.model("MemoryGroup", memoryGroupSchema);