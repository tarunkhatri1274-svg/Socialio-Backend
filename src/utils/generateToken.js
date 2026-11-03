import jwt from "jsonwebtoken";
import env from "../services/simpleENV.js";

const generateAccessToken = (userId) =>
  jwt.sign({ id: userId }, env.accesstoken, {
    expiresIn: env.accesstokenexpire,
    algorithm: "HS256",
  });

const generateRefreshToken = (userId) =>
  jwt.sign({ id: userId }, env.refreshtoken, {
    expiresIn: env.refreshtokenexpire,
    algorithm: "HS256",
  });

export default { generateAccessToken, generateRefreshToken };