import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import dotenv from "dotenv";
import path from "path";

// Load .env from this server's own directory (works no matter what cwd
// opencode spawns the process in). Values already present in the real
// environment (e.g. set via opencode.json "environment") take precedence.
dotenv.config({ path: path.join(import.meta.dirname, ".env") });

const config = {
  baseUrl: (process.env.DAILY_REPORT_BASE_URL || "https://daily-report.wpdevelop.online").replace(/\/+$/, ""),
  username: process.env.DAILY_REPORT_USERNAME || "",
  password: process.env.DAILY_REPORT_PASSWORD || "",
  loginField: process.env.DAILY_REPORT_LOGIN_FIELD || "email",
};

// Session state (in-memory, lives for the lifetime of this server process)
const cookies = {};
let csrfToken = "";
let isLoggedIn = false;
let lastLoginError = "";
let appName = "Daily Report";

const server = new Server(
  { name: "mcp-daily-report", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ---------- HTTP helpers (session cookie jar, CSRF, Inertia page data) ----------

function storeCookies(setCookieHeaders) {
  for (const raw of setCookieHeaders || []) {
    const pair = raw.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq > 0) cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
}

function cookieHeader() {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
}

async function httpFetch(pathUrl, options = {}) {
  const rawUrl = /^https?:\/\//i.test(pathUrl) ? pathUrl : config.baseUrl + pathUrl;
  const u = new URL(rawUrl);
  const base = new URL(config.baseUrl);
  // Scope guard: only requests to the configured app host are allowed.
  if (u.host !== base.host) {
    throw new Error(`Only requests to host '${base.host}' are allowed (got '${u.host}').`);
  }
  const headers = { ...(options.headers || {}) };
  const cookie = cookieHeader();
  if (cookie) headers["Cookie"] = cookie;
  const res = await fetch(u.toString(), { ...options, headers, redirect: "manual" });
  storeCookies(res.headers.getSetCookie ? res.headers.getSetCookie() : []);
  return res;
}

async function fetchWithRedirects(pathUrl, options = {}, maxRedirects = 5) {
  let current = /^https?:\/\//i.test(pathUrl) ? pathUrl : config.baseUrl + pathUrl;
  for (let i = 0; i < maxRedirects; i++) {
    const res = await httpFetch(current, options);
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      // Follow per HTTP semantics: after a 302/303, drop the POST body and GET the target.
      options = { method: "GET", headers: options.headers || {} };
      current = new URL(location, res.url).toString();
      continue;
    }
    return res;
  }
  throw new Error("Too many redirects.");
}

function unescapeHtmlEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

// Inertia pages embed their page data (component name + props) in a JSON script tag.
function extractPageData(html) {
  const m = html.match(/<script data-page="[^"]*" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(unescapeHtmlEntities(m[1]));
  } catch {
    return null;
  }
}

function extractCsrf(html) {
  const m = html.match(/<meta name="csrf-token" content="([^"]+)"/);
  return m ? m[1] : "";
}

function previewText(text, max = 20000) {
  return text.length > max ? text.slice(0, max) + "\n...[truncated]..." : text;
}
// Send a form mutation (POST/PUT/DELETE) with CSRF + session, prefer JSON responses.
async function sendMutation(pathUrl, method, fields = {}) {
  await ensureLoggedIn();
  // Refresh the CSRF token from the dashboard: it always renders a meta
  // csrf-token for the current session, while resource pages may 403 without
  // one. Laravel regenerates the session id after login, so a token captured
  // before login is no longer valid.
  const page = await fetchWithRedirects("/");
  const html = await page.text();
  csrfToken = extractCsrf(html) || csrfToken;

  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) {
      for (const item of v) form.append(`${k}[]`, String(item));
    } else if (v !== undefined && v !== null) {
      form.set(k, String(v));
    }
  }
  form.set("_token", csrfToken);

  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    "Accept": "application/json",
    "X-Requested-With": "XMLHttpRequest",
  };
  // Cookie-based CSRF header (the XSRF-TOKEN cookie matches the current session).
  const xsrfCookie = cookies["XSRF-TOKEN"];
  if (xsrfCookie) headers["X-XSRF-TOKEN"] = decodeURIComponent(xsrfCookie);

  const res = await fetchWithRedirects(pathUrl, {
    method,
    headers,
    body: form.toString(),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* HTML or empty response */ }
  return {
    status: res.status,
    finalUrl: res.url,
    json: parsed,
    bodyPreview: parsed ? null : previewText(text),
  };
}

// ---------- Mutation serialization ----------
// Write operations always run one at a time, even when the model fires
// several tool calls in parallel: each mutation is queued and completes
// before the next one starts, keeping flash messages and verification clear.
let mutationChain = Promise.resolve();

function serialMutation(task) {
  const run = mutationChain.then(task, task);
  mutationChain = run.then(() => {}, () => {});
  return run;
}

// ---------- Auth ----------

async function login() {
  // Already authenticated: a second POST /login against a live session gets
  // rejected with 419 (CSRF), so never re-login while the session is valid.
  if (isLoggedIn) return true;

  // 1. Fetch the login page to obtain the session cookie + CSRF token.
  const page = await fetchWithRedirects("/login");
  const html = await page.text();
  csrfToken = extractCsrf(html) || csrfToken;
  const pageData = extractPageData(html);
  if (pageData && pageData.props && pageData.props.name) appName = pageData.props.name;

  // 2. Submit credentials as a standard Laravel form POST.
  const form = new URLSearchParams();
  form.set("_token", csrfToken);
  form.set(config.loginField, config.username);
  form.set("password", config.password);

  const res = await fetchWithRedirects("/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  const finalPath = new URL(res.url).pathname;
  if (finalPath.includes("/login")) {
    const body = await res.text();
    const data = extractPageData(body);
    const errors = data && data.props && data.props.errors;
    const detail = errors && Object.keys(errors).length
      ? JSON.stringify(errors)
      : `redirected back to ${finalPath} (status ${res.status})`;
    lastLoginError = `Login failed: ${detail}`;
    return false;
  }

  isLoggedIn = true;
  lastLoginError = "";
  return true;
}

async function ensureLoggedIn() {
  if (isLoggedIn) {
    // The app session may have expired while we were idle: probe the dashboard
    // and re-login if we get redirected to /login.
    const probe = await fetchWithRedirects("/");
    const body = await probe.text();
    const path = new URL(probe.url).pathname;
    if (!path.includes("/login")) return;
    isLoggedIn = false;
    csrfToken = "";
  }
  if (!config.username || !config.password) {
    throw new Error(
      "Credentials are not configured. Create a .env file next to index.js with DAILY_REPORT_USERNAME and DAILY_REPORT_PASSWORD (see .env.example), then restart opencode."
    );
  }
  const ok = await login();
  if (!ok) throw new Error(lastLoginError);
}

// ---------- Tool declarations ----------

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "check_login",
        description: "Logs in to the Daily Report app with the configured account and reports whether the credentials work.",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "get_session_status",
        description: "Shows connection state (base URL, account, login status) without exposing any secrets.",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "get_app_map",
        description: "Returns the known map of the Daily Report app: routes, request fields, data availability and known limitations. Call this FIRST when exploring the app or answering questions about it (e.g. leave balance), so you do not search for data that does not exist.",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "get_page",
        description: "Fetches a page from the app (e.g. '/admin', '/admin/users') with the active session. Returns status, the Inertia page component name when available, page props, and optionally a body preview. Use AFTER calling get_app_map, when you need to read data from a specific route that has no dedicated tool (e.g. GET /profile, GET /daily-reports). Call this for reading only - do NOT use it to mutate data.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path within the app, e.g. '/admin' or '/admin/users'. Must stay on the app host." },
            includeBody: { type: "boolean", description: "Include a preview of the raw response body (default false)." },
          },
          required: ["path"],
        },
      },
      {
        name: "post_data",
        description: "Low-level fallback that submits raw data (form fields or JSON body) to the app with the active session and CSRF token. Returns status and response preview. Use ONLY for mutations NOT covered by the dedicated submit_daily_report / submit_request / register_overtime tools (e.g. PUT /user-requests/{id} to edit a pending request). Prefer the dedicated tools whenever they fit - do NOT use this to duplicate their functionality.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path within the app, e.g. '/admin/leaves'." },
            form: { type: "object", description: "Form fields as key/value object (sent as application/x-www-form-urlencoded)." },
            json: { type: "object", description: "JSON body (sent as application/json)." },
          },
          required: ["path"],
        },
      },
      {
        name: "submit_daily_report",
        description: "Creates or updates a daily work report. Without 'id' it POSTs /daily-reports; with 'id' it PUTs /daily-reports/{id}. Required: project_id, report_date (YYYY-MM-DD), content, estimated_hours.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "number", description: "Report id to update. Omit to create a new report." },
            project_id: { type: "number", description: "Id of the project the work belongs to." },
            report_date: { type: "string", description: "Report date, format YYYY-MM-DD." },
            content: { type: "string", description: "Work content description." },
            estimated_hours: { type: "number", description: "Estimated hours (> 0)." },
            actual_hours: { type: "number", description: "Actual hours (when set, status becomes 'done')." },
            status: { type: "string", description: "Status: 'doing' or 'done' (default 'doing')." },
            notes: { type: "string", description: "Optional notes." },
          },
          required: ["project_id", "report_date", "content", "estimated_hours"],
        },
      },
      {
        name: "submit_request",
        description: "Creates a leave/remote request via POST /user-requests. request_type: leave_full, leave_morning, leave_afternoon, remote_full, remote_morning, remote_afternoon, late_arrival, early_departure, go_out, compensatory. start_time/end_time required for late_arrival, early_departure, go_out, compensatory.",
        inputSchema: {
          type: "object",
          properties: {
            request_type: { type: "string", description: "One of: leave_full, leave_morning, leave_afternoon, remote_full, remote_morning, remote_afternoon, late_arrival, early_departure, go_out, compensatory." },
            request_date: { type: "string", description: "First request date, format YYYY-MM-DD." },
            request_dates: { type: "array", items: { type: "string" }, description: "Full list of dates (optional; defaults to [request_date])." },
            start_time: { type: "string", description: "Start time HH:MM (required for late_arrival, go_out, compensatory)." },
            end_time: { type: "string", description: "End time HH:MM (required for early_departure, go_out, compensatory)." },
            reason: { type: "string", description: "Reason for the request (required)." },
            compensatory_for_date: { type: "string", description: "Date being compensated (for 'compensatory' type), YYYY-MM-DD." },
          },
          required: ["request_type", "request_date", "reason"],
        },
      },
      {
        name: "register_overtime",
        description: "Registers or updates overtime hours via /overtimes. Without 'id' it POSTs, with 'id' it PUTs /overtimes/{id}.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "number", description: "Overtime id to update. Omit to create a new record." },
            date: { type: "string", description: "Overtime date, format YYYY-MM-DD." },
            hours: { type: "number", description: "Overtime hours." },
            note: { type: "string", description: "Note / work content (optional)." },
          },
          required: ["date", "hours"],
        },
      },
      {
        name: "delete_record",
        description: "Deletes a record by type: 'daily_report' (DELETE /daily-reports/{id}), 'request' (DELETE /user-requests/{id}) or 'overtime' (DELETE /overtimes/{id}).",
        inputSchema: {
          type: "object",
          properties: {
            type: { type: "string", description: "Record type: daily_report | request | overtime." },
            id: { type: "number", description: "Record id to delete." },
          },
          required: ["type", "id"],
        },
      },
    ],
  };
});

// ---------- Tool execution ----------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {
      case "check_login": {
        if (!config.username || !config.password) {
          return {
            content: [{
              type: "text",
              text: "Credentials are not configured yet. Create a .env file next to index.js with DAILY_REPORT_USERNAME and DAILY_REPORT_PASSWORD (see .env.example), then restart opencode.",
            }],
            isError: true,
          };
        }
        try {
          await ensureLoggedIn();
          return {
            content: [{
              type: "text",
              text: `Logged in as '${config.username}' (app: ${appName}).`,
            }],
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: `Login failed: ${error.message}` }],
            isError: true,
          };
        }
      }

      case "get_session_status": {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              baseUrl: config.baseUrl,
              account: config.username || "(not set)",
              loginField: config.loginField,
              isLoggedIn,
              csrfTokenPresent: !!csrfToken,
              cookieCount: Object.keys(cookies).length,
            }, null, 2),
          }],
        };
      }

      case "get_app_map": {
        return {
          content: [{
            type: "text",
            text: `APP MAP - Daily Report (Laravel 13 + Inertia + React, session auth)

== USER ROUTES (employee account) ==
- GET /                       -> User/Dashboard/Index. Props: reports, requests, timekeeps, projects, company, date, viewType, userStats. Use /?date=YYYY-MM-DD to view a specific date.
- POST /daily-reports         fields: project_id, report_date (YYYY-MM-DD), content, estimated_hours (>0), actual_hours, notes, status (doing|done)
- PUT /daily-reports/{id}     update report (set actual_hours to mark done)
- DELETE /daily-reports/{id}  delete report
- POST /user-requests         fields: request_type, request_date, request_dates[], start_time, end_time, reason (required), compensatory_for_date
  request_type values: leave_full | leave_morning | leave_afternoon | remote_full | remote_morning | remote_afternoon | late_arrival | early_departure | go_out | compensatory
  start_time required for: late_arrival, go_out, compensatory. end_time required for: early_departure, go_out, compensatory.
- PUT /user-requests/{id}     update request
- DELETE /user-requests/{id}  delete request (pending only)
- POST /overtimes             fields: date (YYYY-MM-DD), hours, note
- PUT /overtimes/{id}         update overtime
- DELETE /overtimes/{id}      delete overtime
- GET /profile                profile settings
- GET /login, GET /register, POST /logout

== ADMIN/STAFF ROUTES (403 for employee accounts) ==
- /admin/*, /system/* (users, companies, candidates, projects, requests approve/reject, timekeeps import, gemini-keys, chatbots...)

== KNOWN LIMITATIONS (answer immediately, do NOT keep searching) ==
1. NO leave-balance data: the app does NOT store or expose 'remaining leave days'. It only tracks used dates in dashboard userStats: leaveFullDates, leaveMorningDates, leaveAfternoonDates, lateDates, earlyDates, remoteFullDates, remoteMorningDates, remoteAfternoonDates, plus requiredHours, actualHours, compensationHours, lateEarlyOutHours. If asked for remaining leave days: reply that the app does not provide this information and only records used leave dates; suggest asking HR/admin for the yearly quota. Do not look for other routes/fields.
2. GET /daily-reports returns HTTP 500 (server-side issue). Read reports via GET /?date=YYYY-MM-DD instead.
3. Multi-day requests are stored as ONE record per date (a 5-day leave creates 5 records).
4. CSRF + session are handled automatically by this server (refreshed from "/" plus X-XSRF-TOKEN cookie). Mutations are serialized one at a time.`,
          }],
        };
      }

      case "get_page": {
        await ensureLoggedIn();
        const res = await fetchWithRedirects(args.path);
        const text = await res.text();
        const pageData = extractPageData(text);
        const info = {
          status: res.status,
          finalUrl: res.url,
          component: pageData ? pageData.component : null,
          propsKeys: pageData && pageData.props ? Object.keys(pageData.props) : null,
          contentType: res.headers.get("content-type") || "",
        };
        let out = JSON.stringify(info, null, 2);
        if (pageData) {
          out += "\n\nPAGE DATA (component + props):\n" + previewText(JSON.stringify(pageData, null, 2));
        }
        if (args.includeBody) {
          out += "\n\nRAW BODY PREVIEW:\n" + previewText(text);
        }
        return { content: [{ type: "text", text: out }] };
      }

      case "post_data": {
        await ensureLoggedIn();
        if (!csrfToken) {
          // Fetch the target page first so we have a CSRF token for this session.
          const page = await fetchWithRedirects(args.path);
          const html = await page.text();
          csrfToken = extractCsrf(html) || csrfToken;
        }

        let options = {};
        if (args.form) {
          const form = new URLSearchParams();
          for (const [k, v] of Object.entries(args.form)) form.set(k, String(v));
          form.set("_token", csrfToken);
          options = {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: form.toString(),
          };
        } else if (args.json) {
          options = {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Accept": "application/json",
              "X-Requested-With": "XMLHttpRequest",
              "X-XSRF-TOKEN": decodeURIComponent(cookies["XSRF-TOKEN"] || ""),
            },
            body: JSON.stringify(args.json),
          };
        } else {
          throw new Error("Provide either 'form' or 'json'.");
        }

        const res = await fetchWithRedirects(args.path, options);
        const text = await res.text();
        const pageData = extractPageData(text);
        let out = `Status: ${res.status}\nFinal URL: ${res.url}\nContent-Type: ${res.headers.get("content-type") || ""}`;
        if (pageData) {
          out += `\nComponent: ${pageData.component}\nProps: ${JSON.stringify(pageData.props, null, 2)}`;
        }
        out += "\n\nBODY PREVIEW:\n" + previewText(text);
        return { content: [{ type: "text", text: out }] };
      }

      case "submit_daily_report": {
        const fields = {
          project_id: args.project_id,
          report_date: args.report_date,
          content: args.content,
          estimated_hours: args.estimated_hours,
          actual_hours: args.actual_hours,
          notes: args.notes,
          status: args.status || "doing",
        };
        return await serialMutation(() => handleMutation(args, () => sendMutation(
          args.id ? `/daily-reports/${args.id}` : "/daily-reports",
          args.id ? "PUT" : "POST",
          fields
        )));
      }

      case "submit_request": {
        const dates = args.request_dates || [args.request_date];
        const fields = {
          request_type: args.request_type,
          request_date: args.request_date,
          request_dates: dates,
          start_time: args.start_time,
          end_time: args.end_time,
          reason: args.reason,
          compensatory_for_date: args.compensatory_for_date,
        };
        return await serialMutation(() => handleMutation(args, () => sendMutation("/user-requests", "POST", fields)));
      }

      case "register_overtime": {
        const fields = { date: args.date, hours: args.hours, note: args.note };
        return await serialMutation(() => handleMutation(args, () => sendMutation(
          args.id ? `/overtimes/${args.id}` : "/overtimes",
          args.id ? "PUT" : "POST",
          fields
        )));
      }

      case "delete_record": {
        const paths = {
          daily_report: `/daily-reports/${args.id}`,
          request: `/user-requests/${args.id}`,
          overtime: `/overtimes/${args.id}`,
        };
        const path = paths[args.type];
        if (!path) throw new Error(`Unknown record type: ${args.type}`);
        return await serialMutation(() => handleMutation(args, () => sendMutation(path, "DELETE", {})));
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
  }
});

// ---------- Mutation tools ----------

async function handleMutation(args, build) {
  const result = await build();
  const lines = [`Status: ${result.status}`, `Final URL: ${result.finalUrl}`];
  if (result.json) {
    lines.push(`Response JSON:\n${JSON.stringify(result.json, null, 2)}`);
  }
  if (result.bodyPreview) {
    lines.push(`Body preview:\n${result.bodyPreview}`);
  }
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    isError: result.status >= 400,
  };
}

function handleMutationError(error) {
  return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
}

// ---------- Start ----------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Daily Report MCP Server ready. Credentials are read from .env, never exposed to the model.");
