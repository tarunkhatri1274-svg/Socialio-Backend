import "./src/config/env.js";
import mongoose from "mongoose";
import connectDB from "./src/db/mongodb.js";
import { sweepOrphanFiles } from "./src/utils/sweepOrphans.js";

await connectDB();
const apply = process.argv.includes("--apply");
console.log(await sweepOrphanFiles({ apply }));
if (!apply) console.log("DRY RUN: nothing deleted. Run with --apply to delete.");
await mongoose.disconnect();
process.exit(0);