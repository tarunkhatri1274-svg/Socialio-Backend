import jwt from "jsonwebtoken";
import User from "../models/user/user.model.js";
export const protect = async (req, res, next) => {
  try {let token;
    if (
      req.headers.authorization &&
      req.headers.authorization.startsWith("Bearer")
    ) {
      token = req.headers.authorization.split(" ")[1];
      const decoded = jwt.verify(
        token,
        process.env.ACCESS_TOKEN_SECRET
      );
      req.user = await User.findById(decoded.id).select("-password");
      if (!req.user) {
        return res.status(401).json({
          message: "User not found",
        });
      }
      next();
    } else {
      return res.status(401).json({
        message: "No token",
      });
    }
  } catch (error) {
  console.log("JWT ERROR:", error.message);
  return res.status(401).json({
    message: error.message,
  });
}
};