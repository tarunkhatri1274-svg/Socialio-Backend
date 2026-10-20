// routes/file.routes.js
// Mount in your server entry file (public — no auth middleware, because
// <Image>/<Video> components load these URLs without an Authorization header):
//
//   import fileRoutes from "./routes/file.routes.js";
//   app.use("/files", fileRoutes);

import express from "express";
import { streamFile } from "../controllers/file.controller.js";

const FileRouter = express.Router();

FileRouter.get("/:id", streamFile);

export default FileRouter