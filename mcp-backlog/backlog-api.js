import dotenv from "dotenv";
import path from "path";

// Load .env from this server's own directory (works no matter what cwd the
// host spawns the process in). Values already present in the real environment
// take precedence over the file.
dotenv.config({ path: path.join(import.meta.dirname, ".env") });

export const config = {
  apiUrl: (process.env.BACKLOG_API_URL || "https://backlog-api.innofly-software.com").replace(/\/+$/, ""),
  email: process.env.BACKLOG_EMAIL || "",
  password: process.env.BACKLOG_PASSWORD || "",
  language: process.env.BACKLOG_LANGUAGE || "vi",
  companyId: process.env.BACKLOG_COMPANY_ID || "",
};

// Session state (in-memory, lives for the lifetime of this process).
// The access token is never returned by any exported function.
let accessToken = "";
let tokenObtainedAt = null;
let currentCompanyId = null;
let requiresCompanySelection = false;

export function getTokenInfo() {
  return {
    hasToken: !!accessToken,
    obtainedAt: tokenObtainedAt,
  };
}

export function startupHint() {
  return "Backlog credentials are not configured. Copy .env.example to .env in mcp-backlog/ and set BACKLOG_EMAIL and BACKLOG_PASSWORD, then restart the host.";
}

export async function login() {
  if (!config.email || !config.password) {
    throw new Error(startupHint());
  }

  const res = await fetch(`${config.apiUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Accept-Language": config.language,
    },
    body: JSON.stringify({ email: config.email, password: config.password }),
    signal: AbortSignal.timeout(30000),
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON error page: keep the text for the error message.
  }

  if (!res.ok || !json || !json.access_token) {
    const detail = json ? formatApiError({ status: res.status, ok: res.ok, json, text }) : `HTTP ${res.status}`;
    throw new Error(`Login failed: ${detail}`);
  }

  accessToken = json.access_token;
  tokenObtainedAt = new Date().toISOString();
  currentCompanyId = json.current_company_id ?? config.companyId ?? null;
  requiresCompanySelection = !!json.requires_company_selection;

  const userEmail = json.user && typeof json.user.email === "string" ? json.user.email : config.email;
  return {
    ok: true,
    user: userEmail,
    companyId: currentCompanyId,
    requiresCompanySelection,
  };
}

export async function apiRequest(pathUrl, { method = "GET", body, headers } = {}) {
  if (!accessToken) {
    await login();
  }
  return requestOnce(pathUrl, { method, body, headers }, false);
}

async function requestOnce(pathUrl, { method, body, headers }, isRetry) {
  const rawUrl = /^https?:\/\//i.test(pathUrl)
    ? pathUrl
    : config.apiUrl + (pathUrl.startsWith("/") ? pathUrl : `/${pathUrl}`);
  const u = new URL(rawUrl);
  const base = new URL(config.apiUrl);
  // Scope guard: only requests to the configured API host are allowed.
  if (u.host !== base.host) {
    throw new Error(`Only requests to host '${base.host}' are allowed (got '${u.host}').`);
  }

  const requestHeaders = {
    "Accept": "application/json",
    "Accept-Language": config.language,
    "Authorization": `Bearer ${accessToken}`,
    ...(headers || {}),
  };
  let requestBody;
  if (body !== undefined) {
    requestHeaders["Content-Type"] = "application/json";
    requestBody = JSON.stringify(body);
  }

  const res = await fetch(u.toString(), {
    method,
    headers: requestHeaders,
    body: requestBody,
    signal: AbortSignal.timeout(30000),
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Plain-text or empty response: the caller can use `text`.
  }

  // Expired session: re-login once and retry the same request.
  if (
    res.status === 401 &&
    !isRetry &&
    json &&
    json.error &&
    json.error.code === "TOKEN_INVALID"
  ) {
    accessToken = "";
    tokenObtainedAt = null;
    await login();
    return requestOnce(pathUrl, { method, body, headers }, true);
  }

  return { status: res.status, ok: res.ok, json, text };
}

export function formatApiError(result) {
  const error = result && result.json && result.json.error;
  if (error && (error.code || error.message)) {
    const head = [error.code, error.message].filter(Boolean).join(": ");
    return error.details ? `${head} (${JSON.stringify(error.details)})` : head;
  }
  const preview = (result && result.text ? result.text : "").replace(/\s+/g, " ").trim().slice(0, 200);
  const status = result && result.status ? result.status : "?";
  return `HTTP ${status}${preview ? ` - ${preview}` : ""}`;
}
