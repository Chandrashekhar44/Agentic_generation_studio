import fs from "node:fs";
import dotenv from "dotenv";

const file = ".env";
const env = dotenv.parse(fs.readFileSync(file));

if (!env.ADMIN_DATABASE_URL || !env.APP_DB_PASSWORD || !env.SYSTEM_DB_PASSWORD) {
  console.error("Required database settings are missing. No changes made.");
  process.exit(1);
}

function makeUrl(username, password) {
  const url = new URL(env.ADMIN_DATABASE_URL);
  url.username = username;
  url.password = password;
  url.searchParams.set("sslmode", "require");
  return url.toString();
}

const values = {
  DATABASE_URL: makeUrl("studio_app", env.APP_DB_PASSWORD),
  SYSTEM_DATABASE_URL: makeUrl("studio_system", env.SYSTEM_DB_PASSWORD)
};

let content = fs.readFileSync(file, "utf8");
for (const [key, value] of Object.entries(values)) {
  const line = `${key}="${value}"`;
  const pattern = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
  if (pattern.test(content)) content = content.replace(pattern, line);
  else content = content.trimEnd() + `\n${line}\n`;
}
fs.writeFileSync(file, content);
console.log("DATABASE_URL and SYSTEM_DATABASE_URL restored. Credentials hidden.");
