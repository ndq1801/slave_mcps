import fs from "fs";
import path from "path";
import { apiRequest, config, login } from "./backlog-api.js";

// ---------- Helpers ----------

function redact(value) {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = /token|password|secret|authorization/i.test(key) ? "<redacted>" : redact(val);
    }
    return out;
  }
  return value;
}

function shapeOf(value) {
  if (Array.isArray(value)) {
    const first = value[0];
    const firstKeys = first && typeof first === "object" && !Array.isArray(first) ? Object.keys(first) : [];
    return { type: "array", count: value.length, firstKeys };
  }
  if (value && typeof value === "object") {
    return { type: "object", keys: Object.keys(value) };
  }
  return { type: value === null ? "null" : typeof value };
}

function describeShape(shape) {
  if (shape.type === "array") {
    return `array(${shape.count}) firstKeys=[${shape.firstKeys.join(", ")}]`;
  }
  if (shape.type === "object") {
    return `object keys=[${shape.keys.join(", ")}]`;
  }
  return shape.type;
}

// List responses are undocumented, so accept both a bare array and the common
// wrapper keys to find ids for the follow-up detail calls.
function extractItems(json) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== "object") return [];
  for (const key of ["data", "items", "results", "projects", "issues"]) {
    if (Array.isArray(json[key])) return json[key];
  }
  return [];
}

function firstId(items) {
  for (const item of items) {
    if (item && typeof item === "object" && item.id !== undefined) return item.id;
  }
  return null;
}

const records = [];

async function capture(label, pathUrl) {
  const result = await apiRequest(pathUrl);
  const shape = shapeOf(result.json);
  records.push({
    label,
    endpoint: pathUrl,
    status: result.status,
    shape,
    body: result.json !== null ? redact(result.json) : result.text,
  });
  console.log(`${label} -> HTTP ${result.status} ${describeShape(shape)}`);
  return result.json;
}

// ---------- Main ----------

if (!config.email || !config.password) {
  console.error("Missing BACKLOG_EMAIL / BACKLOG_PASSWORD. Copy .env.example to .env in mcp-backlog/ and fill them in.");
  process.exit(1);
}

try {
  const summary = await login();
  console.log(`Logged in as '${summary.user}'.`);
  // Login metadata (never the token) answers the company-selection question
  // before any data endpoint is called.
  records.push({
    label: "auth/login",
    endpoint: "/api/v1/auth/login",
    status: 200,
    shape: { type: "object", keys: ["user", "companyId", "requiresCompanySelection"] },
    body: {
      user: summary.user,
      companyId: summary.companyId,
      requiresCompanySelection: summary.requiresCompanySelection,
    },
  });
  console.log(`Company id: ${summary.companyId ?? "(none)"} - requires selection: ${summary.requiresCompanySelection}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

await capture("auth/me", "/api/v1/auth/me");
await capture("health", "/api/v1/health");
const projects = await capture("projects", "/api/v1/projects");
const projectsLimited = await capture("projects?limit=1", "/api/v1/projects?limit=1");
const issuesLimited = await capture("issues?limit=1", "/api/v1/issues?limit=1");

const projectId = firstId(extractItems(projects)) ?? firstId(extractItems(projectsLimited));
const issueId = firstId(extractItems(issuesLimited));

if (projectId !== null && issueId !== null) {
  await capture("projects/{id}", `/api/v1/projects/${projectId}`);
  await capture("projects/{id}/issues?limit=1", `/api/v1/projects/${projectId}/issues?limit=1`);
  await capture("issues/{id}", `/api/v1/issues/${issueId}`);
  await capture("issues/{id}/time-entries", `/api/v1/issues/${issueId}/time-entries`);
} else {
  console.log("Skipping project/issue detail calls: no project id or issue id found in the list responses.");
}

const now = new Date();
const two = (n) => String(n).padStart(2, "0");
const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
const capturesDir = path.join(import.meta.dirname, "captures");
fs.mkdirSync(capturesDir, { recursive: true });
const outFile = path.join(capturesDir, `schema-${stamp}.json`);
fs.writeFileSync(outFile, JSON.stringify({
  capturedAt: now.toISOString(),
  apiUrl: config.apiUrl,
  endpoints: records,
}, null, 2));
console.log(`\nWrote ${outFile}`);
