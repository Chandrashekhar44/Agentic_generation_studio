import 'dotenv/config';
import fs from 'node:fs';

const file = '.env';
const contents = fs.readFileSync(file, 'utf8');
const adminUrl = process.env.ADMIN_DATABASE_URL;
const appPassword = process.env.APP_DB_PASSWORD;
const systemPassword = process.env.SYSTEM_DB_PASSWORD;

if (!adminUrl || !appPassword || !systemPassword) {
  throw new Error('ADMIN_DATABASE_URL or a role password is missing from .env');
}

function makeUrl(username, password) {
  const url = new URL(adminUrl);
  url.username = username;
  url.password = password;
  url.pathname = '/postgres';
  url.searchParams.set('sslmode', 'require');
  return url.toString();
}

const values = {
  DATABASE_URL: makeUrl('studio_app', appPassword),
  SYSTEM_DATABASE_URL: makeUrl('studio_system', systemPassword),
};

let updated = contents;

for (const [key, value] of Object.entries(values)) {
  const line = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');

  if (line.test(updated)) {
    updated = updated.replace(line, `${key}=${value}`);
  } else {
    updated += `\n${key}=${value}\n`;
  }
}

fs.writeFileSync(file, updated, 'utf8');
console.log('DATABASE_URL and SYSTEM_DATABASE_URL configured in .env');
console.log('Connection passwords were not displayed.');
