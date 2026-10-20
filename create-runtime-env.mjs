import fs from "node:fs";
import dotenv from "dotenv";

const env = dotenv.parse(fs.readFileSync(".env"));

if (!env.DATABASE_URL || !env.SYSTEM_DATABASE_URL) {
  console.error("Database URLs missing. No file created.");
  process.exit(1);
}

fs.writeFileSync(
  ".env.runtime",
  `DATABASE_URL=${env.DATABASE_URL}\nSYSTEM_DATABASE_URL=${env.SYSTEM_DATABASE_URL}\n`
);

console.log("Created .env.runtime with both database URLs; values hidden.");
