import mongoose from "mongoose";
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URL);
    console.log("MongoDB connected");
  } catch (error) {
    console.error("DB error:", error.message);
    process.exit(1); // stop server if DB fails
  }
};
export default connectDB;