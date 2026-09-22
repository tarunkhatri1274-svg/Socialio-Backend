// simpleENV.js
import dotenv from "dotenv";
dotenv.config(); // ✅ load .env right here

const port = process.env.PORT;
const mongodb = process.env.MONGODB_URL;
const accesstoken = process.env.ACCESS_TOKEN_SECRET;
const accesstokenexpire = process.env.ACCESS_TOKEN_EXPIRY;
const refreshtoken = process.env.REFRESH_TOKEN_SECRET;
const refreshtokenexpire = process.env.REFRESH_TOKEN_EXPIRY;
const owneremailhost = process.env.EMAIL_HOST;
const owneremailport = process.env.EMAIL_PORT;
const owneremail = process.env.EMAIL_USER;
const ownerpassword = process.env.EMAIL_PASS;
const cloudinaryurl = process.env.CLOUDINARY_URL;
const resendapikey = process.env.RESEND_API_KEY;
const fromemail = process.env.FROM_EMAIL;
export default {
  port, mongodb, accesstoken, accesstokenexpire,
  refreshtoken, refreshtokenexpire, owneremailhost,
  owneremailport, owneremail, ownerpassword, 
  cloudinaryurl, resendapikey, fromemail 
}
