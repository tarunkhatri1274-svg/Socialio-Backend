import jwt from "jsonwebtoken";
import env from "../services/simpleENV.js";

const generateAccessToken = (userId) => {
  return jwt.sign({ id: userId }, env.accesstoken, {
    expiresIn: env.accesstokenexpire,
  });
};

const generateRefreshToken = (userId) => {
  return jwt.sign({ id: userId }, env.refreshtoken, {
    expiresIn: env.refreshtokenexpire,
  });
};

export default { generateAccessToken, generateRefreshToken }