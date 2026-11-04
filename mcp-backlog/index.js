import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  apiRequest,
  config,
  formatApiError,
  getTokenInfo,
  login,
  startupHint,
} from "./backlog-api.js";

const server = new Server(
  { name: "mcp-backlog", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ---------- Helpers ----------

function previewText(text, max = 20000) {
  return text.length > max ? text.slice(0, max) + "\n...[truncated]..." : text;
}

// Write operations always run one at a time, even when the model fires
// several tool calls in parallel: each mutation is queued and completes
// before the next one starts.
let mutationChain = Promise.resolve();

function serialMutation(task) {
  const run = mutationChain.then(task, task);
  mutationChain = run.then(() => {}, () => {});
  return run;
}

function assertApiPath(pathValue) {
  if (typeof pathValue !== "string" || !/^\/api\/v1\//.test(pathValue)) {
    throw new Error("Path must start with '/api/v1/' (e.g. '/api/v1/projects?per_page=5').");
  }
}

// Build a query string, skipping absent values and URL-encoding the rest.
function query(params = {}) {
  const parts = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

function renderResult(result) {
  const lines = [`Status: ${result.status}`];
  if (result.json !== null) {
    lines.push(`Response JSON:\n${JSON.stringify(result.json, null, 2)}`);
  } else if (result.text) {
    lines.push(`Body preview:\n${previewText(result.text)}`);
  }
  if (!result.ok) {
    lines.push(`Error: ${formatApiError(result)}`);
  }
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    isError: !result.ok,
  };
}

// All typed writes share the mutation queue and the same result rendering.
function handleWrite(build) {
  return serialMutation(build).then(renderResult);
}

// Fields shared by create_issue and update_issue. Numeric ids come from
// get_project_config; nullable fields accept null to be cleared on update.
const issueFieldProps = {
  description: { type: "string", description: "Issue description (free text)." },
  issue_type_id: { type: "number", description: "Numeric issue type id from get_project_config." },
  status_id: { type: "number", description: "Numeric status id from get_project_config." },
  priority_id: { type: "number", description: "Numeric priority id from get_project_config." },
  assignee_id: { type: ["number", "null"], description: "Numeric assignee user id; null clears the assignee on update." },
  tester_id: { type: ["number", "null"], description: "Numeric tester user id; null clears the tester on update." },
  category_id: { type: ["number", "null"], description: "Numeric category id from get_project_config; null clears it on update." },
  milestone_id: { type: ["number", "null"], description: "Numeric milestone id from get_project_config; null clears it on update." },
  start_date: { type: ["string", "null"], description: "Start date YYYY-MM-DD; null clears it on update." },
  due_date: { type: ["string", "null"], description: "Due date YYYY-MM-DD; null clears it on update." },
  estimated_hours: { type: "number", description: "Estimated hours (number)." },
};

// ---------- Tool declarations ----------

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "check_login",
        description: "Logs in to Backlog with the configured account and reports the logged-in e-mail, company id, whether company selection is required, and the API version. Use this FIRST to verify credentials and connectivity before calling any other Backlog tool. Returns no secrets.",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "get_session_status",
        description: "Shows the current Backlog connection state: API URL, configured account e-mail, language, whether an access token is present and when it was obtained. Use this when you need to check auth state without triggering a login. Never returns the token.",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "get_api_map",
        description: "Returns the verified map of the Backlog REST API: base URL, key-based addressing, auth flow, list envelope, known endpoints, create-issue and time-entry fields, error envelope, and the NOT EXPOSED areas. Call this FIRST when exploring Backlog, before guessing endpoints or response fields. Prefer the typed tools for normal work.",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "api_get",
        description: "Read-only GET against a Backlog '/api/v1/...' path (e.g. '/projects?limit=5'). Returns the HTTP status and parsed JSON body (or only the raw JSON when raw=true). This is a discovery/fallback tool for endpoints that have no dedicated typed tool yet - prefer dedicated tools once they exist. Use it ONLY to read; it never mutates. Rejects paths outside '/api/v1/' and other hosts.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "API path starting with '/api/v1/', e.g. '/projects?limit=5'." },
            raw: { type: "boolean", description: "Return only the JSON body instead of the human-readable summary (default false)." },
          },
          required: ["path"],
        },
      },
      {
        name: "api_write",
        description: "Serialized raw mutation (POST/PUT/PATCH/DELETE) against a Backlog '/api/v1/...' path with an optional JSON body. WARNING: mutates real company data. Use it ONLY for operations that have no typed tool (e.g. delete_issue, update/delete time entry, watch/unwatch, project/member admin) - prefer create_issue, update_issue, add_comment and log_time for those. Writes run one at a time so verification stays unambiguous. Rejects paths outside '/api/v1/' and other hosts.",
        inputSchema: {
          type: "object",
          properties: {
            method: { type: "string", enum: ["POST", "PUT", "PATCH", "DELETE"], description: "HTTP method to use." },
            path: { type: "string", description: "API path starting with '/api/v1/', e.g. '/issues'." },
            body: { type: "object", description: "Optional JSON body." },
          },
          required: ["method", "path"],
        },
      },
      {
        name: "list_projects",
        description: "Lists Backlog projects with optional search/filter and pagination. Returns the {items,total,page,per_page} envelope. Use it to discover the project_key values needed by get_project_config, list_issues and create_issue. Read-only; it never mutates.",
        inputSchema: {
          type: "object",
          properties: {
            q: { type: "string", description: "Search text." },
            status: { type: "string", description: "Filter by project status." },
            page: { type: "number", description: "Page number (default 1)." },
            per_page: { type: "number", description: "Page size (the API uses per_page, not limit)." },
          },
          required: [],
        },
      },
      {
        name: "get_project_config",
        description: "Returns a project's configuration: issue types, statuses, priorities, categories and milestones, each with its numeric id, name, display_name, color and position. REQUIRED before create_issue/update_issue so you can pass valid numeric ids (issue_type_id, status_id, priority_id, category_id, milestone_id). Read-only.",
        inputSchema: {
          type: "object",
          properties: {
            project_key: { type: "string", description: "Project key, e.g. 'TSUKASHIA'." },
          },
          required: ["project_key"],
        },
      },
      {
        name: "list_issues",
        description: "Lists issues with optional filters and pagination, either scoped to a project (when project_key is given) or across all projects. Returns the {items,total,page,per_page} envelope. Use it to find issue_key values for get_issue and the write tools. Read-only.",
        inputSchema: {
          type: "object",
          properties: {
            project_key: { type: "string", description: "Optional project key; scopes the request to /projects/{project_key}/issues." },
            project_id: { type: "number", description: "Optional numeric project id filter." },
            status_id: { type: "number", description: "Optional numeric status id filter (from get_project_config)." },
            assignee_id: { type: "number", description: "Optional numeric assignee user id filter." },
            q: { type: "string", description: "Search text." },
            page: { type: "number", description: "Page number (default 1)." },
            per_page: { type: "number", description: "Page size (the API uses per_page, not limit)." },
          },
          required: [],
        },
      },
      {
        name: "get_issue",
        description: "Returns the full detail of one issue by issue_key: summary, description, type/status/priority, assignee/tester/reporter, dates, hours, attachments, watchers, children and permissions. Use it after list_issues to inspect a single issue. Read-only.",
        inputSchema: {
          type: "object",
          properties: {
            issue_key: { type: "string", description: "Issue key, e.g. 'TSUKASHIA-1'." },
          },
          required: ["issue_key"],
        },
      },
      {
        name: "create_issue",
        description: "Creates a real issue in a project. 'summary' is the ONLY required field; all others are optional. Numeric ids (issue_type_id, status_id, priority_id, assignee_id, tester_id, category_id, milestone_id) MUST come from get_project_config first. This mutates real data and runs one write at a time.",
        inputSchema: {
          type: "object",
          properties: {
            project_key: { type: "string", description: "Project key where the issue is created, e.g. 'TSUKASHIA'." },
            summary: { type: "string", description: "Issue summary/title (required, min 1 character)." },
            ...issueFieldProps,
          },
          required: ["project_key", "summary"],
        },
      },
      {
        name: "update_issue",
        description: "Partially updates an issue by issue_key. Only the provided fields change; pass null to clear nullable fields (assignee_id, tester_id, category_id, milestone_id, start_date, due_date). Numeric ids must come from get_project_config. This mutates real data and runs one write at a time.",
        inputSchema: {
          type: "object",
          properties: {
            issue_key: { type: "string", description: "Issue key to update, e.g. 'TSUKASHIA-1'." },
            summary: { type: "string", description: "New summary/title (min 1 character)." },
            ...issueFieldProps,
          },
          required: ["issue_key"],
        },
      },
      {
        name: "add_comment",
        description: "Adds a comment to an issue. 'content' is the comment text; attachment_ids and notified_user_ids are numeric arrays; changes is an array of property-change objects. All fields are optional in the UI. This mutates real data and runs one write at a time.",
        inputSchema: {
          type: "object",
          properties: {
            issue_key: { type: "string", description: "Issue key, e.g. 'TSUKASHIA-1'." },
            content: { type: "string", description: "Comment text." },
            attachment_ids: { type: "array", items: { type: "number" }, description: "Numeric attachment ids." },
            notified_user_ids: { type: "array", items: { type: "number" }, description: "Numeric user ids to notify." },
            changes: { type: "array", items: { type: "object" }, description: "Array of property-change objects." },
          },
          required: ["issue_key"],
        },
      },
      {
        name: "list_comments",
        description: "Lists comments on an issue. Returns {items,total,has_more}. Use it to read the discussion before adding a comment. Read-only.",
        inputSchema: {
          type: "object",
          properties: {
            issue_key: { type: "string", description: "Issue key, e.g. 'TSUKASHIA-1'." },
          },
          required: ["issue_key"],
        },
      },
      {
        name: "list_time_entries",
        description: "Lists time entries logged on an issue. Returns {items,total_hours,estimated_hours,can_log}; each item has a numeric id used by PUT/DELETE /time-entries/{entry_id}. Read-only.",
        inputSchema: {
          type: "object",
          properties: {
            issue_key: { type: "string", description: "Issue key, e.g. 'TSUKASHIA-1'." },
          },
          required: ["issue_key"],
        },
      },
      {
        name: "log_time",
        description: "Logs time on an issue. Required: work_date (YYYY-MM-DD) and hours (number); optional note. This mutates real data and runs one write at a time.",
        inputSchema: {
          type: "object",
          properties: {
            issue_key: { type: "string", description: "Issue key, e.g. 'TSUKASHIA-1'." },
            work_date: { type: "string", description: "Work date YYYY-MM-DD (required)." },
            hours: { type: "number", description: "Hours to log (required)." },
            note: { type: "string", description: "Optional note." },
          },
          required: ["issue_key", "work_date", "hours"],
        },
      },
      {
        name: "get_dashboard",
        description: "Returns the caller's dashboard summary: assigned_open, overdue, due_soon, completed_week, hours_week, week_start and due_issues. Use it for a quick personal overview of current work. Read-only.",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "get_my_timesheet",
        description: "Returns the caller's timesheet for a date range. Both date_from and date_to are REQUIRED (YYYY-MM-DD). Read-only.",
        inputSchema: {
          type: "object",
          properties: {
            date_from: { type: "string", description: "Start date YYYY-MM-DD (required)." },
            date_to: { type: "string", description: "End date YYYY-MM-DD (required)." },
          },
          required: ["date_from", "date_to"],
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
        if (!config.email || !config.password) {
          return {
            content: [{ type: "text", text: startupHint() }],
            isError: true,
          };
        }
        const summary = await login();
        const health = await apiRequest("/api/v1/health");
        const version = health.ok && health.json ? health.json.version : "unknown";
        const lines = [
          `Logged in as '${summary.user}' (API: ${config.apiUrl}).`,
          `Company id: ${summary.companyId ?? "(none returned)"}.`,
          `API version: ${version}.`,
        ];
        if (summary.requiresCompanySelection) {
          lines.push("WARNING: this account requires company selection (requires_company_selection=true); company-scoped calls may fail until a company is selected.");
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      case "get_session_status": {
        const token = getTokenInfo();
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              apiUrl: config.apiUrl,
              account: config.email || "(not set)",
              language: config.language,
              tokenPresent: token.hasToken,
              tokenObtainedAt: token.obtainedAt,
            }, null, 2),
          }],
        };
      }

      case "get_api_map": {
        return {
          content: [{
            type: "text",
            text: `BACKLOG API MAP - Backlog (Next.js frontend + JSON REST API)

== BASICS ==
- Frontend: https://backlog.innofly-software.com
- API base: ${config.apiUrl} (all data lives under /api/v1)
- Login: POST /api/v1/auth/login with JSON {"email","password"} -> access_token, current_company_id, requires_company_selection.
- Every data call: "Authorization: Bearer <access_token>", "Accept: application/json", "Accept-Language: <language>".
- Expired session: HTTP 401 with {"error":{"code":"TOKEN_INVALID",...}}. This server re-logs in once and retries automatically.
- Error envelope: {"error":{"code":"...","message":"...","details":...}}. Validation errors use details: [{"field","code","message"}].
- No CSRF token, no OpenAPI/docs endpoints.

== ADDRESSING (key-based, NOT numeric id) ==
- Projects and issues are addressed by KEY in URLs: project_key (e.g. TSUKASHIA), issue_key (e.g. TSUKASHIA-1).
- Numeric ids exist in payloads and are used as foreign keys in request bodies (issue_type_id, status_id, ...), but NOT in single-resource routes.
- /api/v1/projects/10 -> 404; /api/v1/projects/TSUKASHIA -> 200.

== LIST ENVELOPE ==
- {items, total, page, per_page}. Page size uses per_page; limit is ignored.

== VERIFIED ENDPOINTS ==
- GET  /api/v1/health                      (no auth) -> {"status","database","version"}
- GET  /api/v1/auth/me
- PUT  /api/v1/auth/me
- POST /api/v1/auth/switch-company
- POST /api/v1/auth/refresh
- POST /api/v1/auth/logout
- GET  /api/v1/projects?q=&status=&page=&per_page=
- GET  /api/v1/projects/{project_key}/config -> {issue_types, statuses, priorities, categories, milestones}
- GET  /api/v1/issues?project_id=&project_key=&status_id=&assignee_id=&q=&page=&per_page=
- GET  /api/v1/projects/{project_key}/issues?project_id=&status_id=&assignee_id=&q=&page=&per_page=
- GET  /api/v1/issues/{issue_key}
- POST /api/v1/projects/{project_key}/issues
- PUT  /api/v1/issues/{issue_key}
- DELETE /api/v1/issues/{issue_key}
- GET  /api/v1/issues/{issue_key}/comments -> {items, total, has_more}
- POST /api/v1/issues/{issue_key}/comments
- GET  /api/v1/issues/{issue_key}/time-entries -> {items, total_hours, estimated_hours, can_log}
- POST /api/v1/issues/{issue_key}/time-entries
- PUT  /api/v1/time-entries/{entry_id}
- DELETE /api/v1/time-entries/{entry_id}
- GET  /api/v1/dashboard -> {assigned_open, overdue, due_soon, completed_week, hours_week, week_start, due_issues}
- GET  /api/v1/me/timesheet?date_from=&date_to=
- GET  /api/v1/reports/time?date_from=&date_to=
- GET  /api/v1/notifications/unread-count -> {count}

== CREATE ISSUE FIELDS ==
- summary (REQUIRED, min 1 char), description, issue_type_id, status_id, priority_id, assignee_id, tester_id, category_id, milestone_id, start_date (YYYY-MM-DD), due_date (YYYY-MM-DD), estimated_hours.
- Call get_project_config FIRST to obtain the numeric ids.

== TIME ENTRY FIELDS ==
- POST /api/v1/issues/{issue_key}/time-entries body: work_date (YYYY-MM-DD, required), hours (number, required), note.

== NOT EXPOSED / OUT OF SCOPE ==
- Webhook / integration management
- Wiki
- Push subscriptions
- Roles / admin
Do not guess endpoints for these; they are not covered by this server.

== TOOLING ==
- Typed read/write tools are implemented (Phase 2). Prefer them over api_get/api_write.
- Use api_get/api_write only for endpoints that have no typed tool.`,
          }],
        };
      }

      case "api_get": {
        assertApiPath(args.path);
        const result = await apiRequest(args.path);
        if (args.raw) {
          return {
            content: [{
              type: "text",
              text: result.json !== null ? JSON.stringify(result.json) : result.text,
            }],
            isError: !result.ok,
          };
        }
        const lines = [`Status: ${result.status}`];
        if (result.json !== null) {
          lines.push(`Response JSON:\n${JSON.stringify(result.json, null, 2)}`);
        } else {
          lines.push(`Body preview:\n${previewText(result.text)}`);
        }
        if (!result.ok) {
          lines.push(`Error: ${formatApiError(result)}`);
        }
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          isError: !result.ok,
        };
      }

      case "api_write": {
        const method = String(args.method || "").toUpperCase();
        if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
          throw new Error("Method must be one of: POST, PUT, PATCH, DELETE.");
        }
        assertApiPath(args.path);
        const result = await serialMutation(() => apiRequest(args.path, { method, body: args.body }));
        const lines = [`Status: ${result.status}`];
        if (result.json !== null) {
          lines.push(`Response JSON:\n${JSON.stringify(result.json, null, 2)}`);
        } else if (result.text) {
          lines.push(`Body preview:\n${previewText(result.text)}`);
        }
        if (!result.ok) {
          lines.push(`Error: ${formatApiError(result)}`);
        }
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          isError: !result.ok,
        };
      }

      case "list_projects": {
        const qs = query({
          q: args.q,
          status: args.status,
          page: args.page,
          per_page: args.per_page,
        });
        return renderResult(await apiRequest(`/api/v1/projects${qs}`));
      }

      case "get_project_config": {
        return renderResult(await apiRequest(
          `/api/v1/projects/${encodeURIComponent(args.project_key)}/config`
        ));
      }

      case "list_issues": {
        const base = args.project_key
          ? `/api/v1/projects/${encodeURIComponent(args.project_key)}/issues`
          : "/api/v1/issues";
        const qs = query({
          project_id: args.project_id,
          status_id: args.status_id,
          assignee_id: args.assignee_id,
          q: args.q,
          page: args.page,
          per_page: args.per_page,
        });
        return renderResult(await apiRequest(`${base}${qs}`));
      }

      case "get_issue": {
        return renderResult(await apiRequest(
          `/api/v1/issues/${encodeURIComponent(args.issue_key)}`
        ));
      }

      case "create_issue": {
        const body = {
          summary: args.summary,
          description: args.description,
          issue_type_id: args.issue_type_id,
          status_id: args.status_id,
          priority_id: args.priority_id,
          assignee_id: args.assignee_id,
          tester_id: args.tester_id,
          category_id: args.category_id,
          milestone_id: args.milestone_id,
          start_date: args.start_date,
          due_date: args.due_date,
          estimated_hours: args.estimated_hours,
        };
        return handleWrite(() => apiRequest(
          `/api/v1/projects/${encodeURIComponent(args.project_key)}/issues`,
          { method: "POST", body }
        ));
      }

      case "update_issue": {
        const body = {
          summary: args.summary,
          description: args.description,
          issue_type_id: args.issue_type_id,
          status_id: args.status_id,
          priority_id: args.priority_id,
          assignee_id: args.assignee_id,
          tester_id: args.tester_id,
          category_id: args.category_id,
          milestone_id: args.milestone_id,
          start_date: args.start_date,
          due_date: args.due_date,
          estimated_hours: args.estimated_hours,
        };
        return handleWrite(() => apiRequest(
          `/api/v1/issues/${encodeURIComponent(args.issue_key)}`,
          { method: "PUT", body }
        ));
      }

      case "add_comment": {
        const body = {
          content: args.content,
          attachment_ids: args.attachment_ids,
          notified_user_ids: args.notified_user_ids,
          changes: args.changes,
        };
        return handleWrite(() => apiRequest(
          `/api/v1/issues/${encodeURIComponent(args.issue_key)}/comments`,
          { method: "POST", body }
        ));
      }

      case "list_comments": {
        return renderResult(await apiRequest(
          `/api/v1/issues/${encodeURIComponent(args.issue_key)}/comments`
        ));
      }

      case "list_time_entries": {
        return renderResult(await apiRequest(
          `/api/v1/issues/${encodeURIComponent(args.issue_key)}/time-entries`
        ));
      }

      case "log_time": {
        const body = {
          work_date: args.work_date,
          hours: args.hours,
          note: args.note,
        };
        return handleWrite(() => apiRequest(
          `/api/v1/issues/${encodeURIComponent(args.issue_key)}/time-entries`,
          { method: "POST", body }
        ));
      }

      case "get_dashboard": {
        return renderResult(await apiRequest("/api/v1/dashboard"));
      }

      case "get_my_timesheet": {
        const qs = query({ date_from: args.date_from, date_to: args.date_to });
        return renderResult(await apiRequest(`/api/v1/me/timesheet${qs}`));
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
  }
});

// ---------- Start ----------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Backlog MCP Server ready. Credentials are read from .env, never exposed to the model.");
