import { Resend } from "resend";
import ENV from "../services/simpleENV.js";

const { resendapikey } = ENV;

const resend = new Resend(resendapikey);

export default resend;