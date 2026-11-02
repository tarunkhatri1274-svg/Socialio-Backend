import jwt from "jsonwebtoken";
import User from "../models/user/user.model.js";

export const protect = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token" });
  }

  let user;
  try {
    const decoded = jwt.verify(header.split(" ")[1], process.env.ACCESS_TOKEN_SECRET, {
      algorithms: ["HS256"],
    });
    user = await User.findById(decoded.id).select(
      "-password -otp -otpExpires -resetTokenHash"
    );
  } catch (error) {
    const isJwtError = ["JsonWebTokenError", "TokenExpiredError", "NotBeforeError"].includes(error.name);
    if (isJwtError) return res.status(401).json({ message: "Invalid or expired token" });
    console.error("protect error:", error.message);
    return res.status(500).json({ message: "Server error" });
  }

  // no user, or a half-registered account (email verified but no username yet)
  if (!user || !user.username) {
    return res.status(401).json({ message: "User not found" });
  }

  req.user = user;
  next(); // outside the try, so route errors are no longer reported as auth errors
};