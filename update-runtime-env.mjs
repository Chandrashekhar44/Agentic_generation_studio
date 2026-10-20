import fs from "node:fs";
import dotenv from "dotenv";

const env = dotenv.parse(fs.readFileSync(".env", "utf8"));

if (!env.ADMIN_DATABASE_URL || !env.APP_DB_PASSWORD || !env.SYSTEM_DB_PASSWORD) {
  console.error("Required environment variables are missing. No changes made.");
  process.exit(1);
}

const admin = new URL(env.ADMIN_DATABASE_URL);
const app = new URL(env.ADMIN_DATABASE_URL);
const sys = new URL(env.ADMIN_DATABASE_URL);

app.username = "studio_app";
app.password = env.APP_DB_PASSWORD;
sys.username = "studio_system";
sys.password = env.SYSTEM_DB_PASSWORD;

for (const url of [app, sys]) {
  url.searchParams.set("sslmode", "require");
}

fs.writeFileSync(
  ".env.runtime",
  `DATABASE_URL=${app.toString()}\nSYSTEM_DATABASE_URL=${sys.toString()}\n`,
  "utf8"
);

console.log("Updated .env.runtime using the Session pooler host. Values hidden.");
