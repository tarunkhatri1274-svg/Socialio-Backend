import resend from "../config/resend.js";
import otpGenerator from "otp-generator";
import ENV from "../services/simpleENV.js";

const { fromemail } = ENV;

export const sendOtpEmail = async (email, otp) => {
  try {
    const { data, error } = await resend.emails.send({
      from: `Socialio <${fromemail}>`,
      to: email,
      subject: "Your OTP Code",
      html: `
        <h2>OTP Verification</h2>
        <p>Your OTP is:</p>
        <h1>${otp}</h1>
        <p>This OTP will expire in 5 minutes.</p>
      `,
    });

    if (error) {
      console.error(error);
      throw error;
    }

    console.log("Email Sent:", data);
  } catch (err) {
    console.log(err);
    throw err;
  }
};

export const generateOtp = () => {
  return otpGenerator.generate(6, {
    upperCaseAlphabets: false,
    lowerCaseAlphabets: false,
    specialChars: false,
  });
};