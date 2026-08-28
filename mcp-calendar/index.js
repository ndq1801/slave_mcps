import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import dotenv from "dotenv";
import path from "path";
import { google } from "googleapis";

// Load .env from this server's own directory (works no matter what cwd the
// client spawns the process in). Values already present in the real
// environment (e.g. set via opencode.json "environment") take precedence.
dotenv.config({ path: path.join(import.meta.dirname, ".env") });

const config = {
  clientId: process.env.GOOGLE_CALENDAR_CLIENT_ID || "",
  clientSecret: process.env.GOOGLE_CALENDAR_CLIENT_SECRET || "",
  refreshToken: process.env.GOOGLE_CALENDAR_REFRESH_TOKEN || "",
  calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
  timezone: process.env.GOOGLE_CALENDAR_TIMEZONE || "Asia/Ho_Chi_Minh",
};

const server = new Server(
  { name: "mcp-calendar", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ---------- Auth & client ----------
// Cheap functional check: are OAuth credentials present? Returns false without
// building the client so the server still boots and tools can report status.
function isConfigured() {
  return Boolean(config.clientId && config.clientSecret && config.refreshToken);
}

function getCalendarClient() {
  if (!isConfigured()) {
    throw new Error(
      "Google Calendar is not configured. Set GOOGLE_CALENDAR_CLIENT_ID, GOOGLE_CALENDAR_CLIENT_SECRET and GOOGLE_CALENDAR_REFRESH_TOKEN in the .env next to index.js (see .env.example)."
    );
  }
  const auth = new google.auth.OAuth2(config.clientId, config.clientSecret, "http://localhost");
  auth.setCredentials({ refresh_token: config.refreshToken });
  return google.calendar({ version: "v3", auth });
}

function isoString(v) {
  // Accept an ISO string as-is; otherwise fall back to now / +7d.
  if (v && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return null;
}

function fmtEvent(ev) {
  return {
    id: ev.id || null,
    summary: ev.summary || "(no title)",
    description: ev.description || null,
    location: ev.location || null,
    status: ev.status || "confirmed",
    start: ev.start || null,
    end: ev.end || null,
    created: ev.created || null,
    updated: ev.updated || null,
    attendees: (ev.attendees || []).map((a) => ({ email: a.email, displayName: a.displayName || null, responseStatus: a.responseStatus || null })),
    eventType: ev.eventType || null,
  };
}

// ---------- Tool implementations ----------

async function getCalendarInfo() {
  const configured = isConfigured();
  const info = { configured, configuredFields: { clientId: !!config.clientId, clientSecret: !!config.clientSecret, refreshToken: !!config.refreshToken }, calendarId: config.calendarId, timezone: config.timezone };
  if (!configured) return info;
  const cal = getCalendarClient();
  const res = await cal.calendarList.get({ calendarId: config.calendarId });
  return {
    ...info,
    calendarSummary: res.data.summary || null,
    timeZone: res.data.timeZone || config.timezone,
  };
}

async function listEvents(args) {
  const cal = getCalendarClient();
  const now = Date.now();
  const defaultFrom = new Date(now).toISOString();
  const defaultTo = new Date(now + 7 * 24 * 3600 * 1000).toISOString();
  const timeMin = isoString(args.timeMin) || defaultFrom;
  const timeMax = isoString(args.timeMax) || defaultTo;
  const res = await cal.events.list({
    calendarId: args.calendarId || config.calendarId,
    timeMin,
    timeMax,
    q: args.query || undefined,
    maxResults: args.maxResults || 50,
    singleEvents: true,
    orderBy: "startTime",
    timeZone: config.timezone,
  });
  return { timeMin, timeMax, total: (res.data.items || []).length, events: (res.data.items || []).map(fmtEvent) };
}

async function getEvent(args) {
  const cal = getCalendarClient();
  if (!args.eventId) throw new Error("eventId is required");
  const res = await cal.events.get({ calendarId: args.calendarId || config.calendarId, eventId: args.eventId });
  return fmtEvent(res.data);
}

async function createEvent(args) {
  const cal = getCalendarClient();
  if (!args.summary) throw new Error("summary is required");
  if (!args.start || !args.end) throw new Error("start and end are required (ISO 8601)");
  const ev = {
    summary: args.summary,
    description: args.description || undefined,
    location: args.location || undefined,
    start: { dateTime: args.start, timeZone: args.tz || config.timezone },
    end: { dateTime: args.end, timeZone: args.tz || config.timezone },
  };
  const res = await cal.events.insert({ calendarId: args.calendarId || config.calendarId, requestBody: ev });
  return fmtEvent(res.data);
}

async function updateEvent(args) {
  const cal = getCalendarClient();
  if (!args.eventId) throw new Error("eventId is required");
  const body = {};
  if (args.summary !== undefined) body.summary = args.summary;
  if (args.description !== undefined) body.description = args.description;
  if (args.location !== undefined) body.location = args.location;
  if (args.start !== undefined) body.start = { dateTime: args.start, timeZone: args.tz || config.timezone };
  if (args.end !== undefined) body.end = { dateTime: args.end, timeZone: args.tz || config.timezone };
  const res = await cal.events.patch({ calendarId: args.calendarId || config.calendarId, eventId: args.eventId, requestBody: body });
  return fmtEvent(res.data);
}

async function deleteEvent(args) {
  const cal = getCalendarClient();
  if (!args.eventId) throw new Error("eventId is required");
  await cal.events.delete({ calendarId: args.calendarId || config.calendarId, eventId: args.eventId });
  return { deleted: true, eventId: args.eventId };
}

// ---------- Tool declarations ----------

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_calendar_info",
        description:
          "Returns the Google Calendar configuration state: whether credentials are set, the default calendar id, timezone, and (when configured) the calendar summary/timezone. Call this FIRST to confirm the server is wired to the right calendar before reading or writing events. Does not expose credentials. If it returns configured=false, set the GOOGLE_CALENDAR_* env vars first.",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "list_events",
        description:
          "Lists events in a date range (default: now to +7 days). Accepts timeMin/timeMax as ISO 8601, an optional query (match summary/description/location), calendar_id, and maxResults. Returns summary/start/end/details per event. Use to see what is scheduled, check an upcoming meeting, or find free time. Read-only.",
        inputSchema: {
          type: "object",
          properties: {
            timeMin: { type: "string", description: "Start of range, ISO 8601 (default: now)." },
            timeMax: { type: "string", description: "End of range, ISO 8601 (default: +7 days)." },
            query: { type: "string", description: "Optional text to search in event summary/description/location." },
            calendar_id: { type: "string", description: "Calendar id (default: the configured one)." },
            maxResults: { type: "number", description: "Max events to return (default 50)." },
          },
          required: [],
        },
      },
      {
        name: "get_event",
        description:
          "Gets a single event by its event id. Use to read the full detail of a specific event (description, attendees, location). Requires the event id (from list_events).",
        inputSchema: {
          type: "object",
          properties: {
            eventId: { type: "string", description: "The event id." },
            calendar_id: { type: "string", description: "Calendar id (default: the configured one)." },
          },
          required: ["eventId"],
        },
      },
      {
        name: "create_event",
        description:
          "Creates a new event. Requires summary and a start/end (ISO 8601). Optional description, location and calendar_id. Use to add meetings, deadlines or reminders to the calendar; it will appear on any device synced to this Google calendar.",
        inputSchema: {
          type: "object",
          properties: {
            summary: { type: "string", description: "Event title." },
            start: { type: "string", description: "Start date-time, ISO 8601 (e.g. 2026-08-28T10:00:00)." },
            end: { type: "string", description: "End date-time, ISO 8601." },
            description: { type: "string", description: "Optional description." },
            location: { type: "string", description: "Optional location." },
            tz: { type: "string", description: "Time zone for the event (default: the configured one)." },
            calendar_id: { type: "string", description: "Calendar id (default: the configured one)." },
          },
          required: ["summary", "start", "end"],
        },
      },
      {
        name: "update_event",
        description:
          "Updates an existing event (partial): change summary, description, location, and/or start/end. Requires the event id. Any field omitted is left unchanged.",
        inputSchema: {
          type: "object",
          properties: {
            eventId: { type: "string", description: "The event id to update." },
            summary: { type: "string", description: "New title." },
            description: { type: "string", description: "New description." },
            location: { type: "string", description: "New location." },
            start: { type: "string", description: "New start date-time, ISO 8601." },
            end: { type: "string", description: "New end date-time, ISO 8601." },
            tz: { type: "string", description: "Time zone for the new times." },
            calendar_id: { type: "string", description: "Calendar id (default: the configured one)." },
          },
          required: ["eventId"],
        },
      },
      {
        name: "delete_event",
        description:
          "Deletes an event by its event id. Use to remove a meeting/reminder. This is destructive - confirm the id from a prior list_events/get_event before deleting.",
        inputSchema: {
          type: "object",
          properties: {
            eventId: { type: "string", description: "The event id to delete." },
            calendar_id: { type: "string", description: "Calendar id (default: the configured one)." },
          },
          required: ["eventId"],
        },
      },
    ],
  };
});

// ---------- Tool dispatch ----------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    let result;
    switch (name) {
      case "get_calendar_info":
        result = await getCalendarInfo();
        break;
      case "list_events":
        result = await listEvents(args);
        break;
      case "get_event":
        result = await getEvent(args);
        break;
      case "create_event":
        result = await createEvent(args);
        break;
      case "update_event":
        result = await updateEvent(args);
        break;
      case "delete_event":
        result = await deleteEvent(args);
        break;
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return { content: [{ type: "text", text: `[ERROR] ${error.message}` }], isError: true };
  }
});

// ---------- Start ----------

const transport = new StdioServerTransport();
await server.connect(transport);
