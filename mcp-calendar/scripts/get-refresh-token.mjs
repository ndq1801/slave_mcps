#!/usr/bin/env node
/**
 * get-refresh-token.mjs
 *
 * One-time setup helper for mcp-calendar: obtains a Google OAuth refresh
 * token for the configured Desktop OAuth client.
 *
 * Run this on a machine WITH a browser (your PC, not a headless server):
 *
 *   GOOGLE_CALENDAR_CLIENT_ID=xxx GOOGLE_CALENDAR_CLIENT_SECRET=yyy \
 *     node scripts/get-refresh-token.mjs
 *
 * It also loads .env from this server's own directory (dotenv), so you can
 * instead put GOOGLE_CALENDAR_CLIENT_ID / GOOGLE_CALENDAR_CLIENT_SECRET into
 * the .env next to index.js and just run the script.
 *
 * Steps: it starts a tiny local HTTP server on localhost, prints a Google
 * consent URL, waits for you to sign in and approve from your browser, then
 * exchanges the code for tokens and prints ONLY the refresh token.
 *
 * The refresh token is a secret - copy it into your .env; never paste it into
 * chat or commit it.
 */
import dotenv from "dotenv";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });

const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(
    "Missing credentials. Set GOOGLE_CALENDAR_CLIENT_ID and GOOGLE_CALENDAR_CLIENT_SECRET\n" +
      "(in the .env next to index.js, or as environment variables)."
  );
  process.exit(1);
}

const SCOPE = "https://www.googleapis.com/auth/calendar";
const PORT = Number(process.env.PORT || 5500);
const redirectUri = `http://localhost:${PORT}`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, redirectUri);
  if (url.pathname !== "/") {
    res.writeHead(404).end("Not found");
    return;
  }
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (error) {
    res.writeHead(400).end(`Authorization failed: ${error}`);
    console.error(`Authorization failed: ${error}`);
    process.exit(1);
  }
  if (!code) {
    res.writeHead(400).end("No authorization code received.");
    return;
  }

  // Exchange the code for tokens. Never log the client secret.
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const tokens = await tokenRes.json();
  if (!tokens.refresh_token) {
    res.writeHead(500).end("Token exchange failed.");
    console.error("Token exchange failed:", JSON.stringify(tokens));
    process.exit(1);
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end("<h3>Done! You can close this tab.</h3>");
  console.log("");
  console.log("==================================================");
  console.log("GOOGLE_CALENDAR_REFRESH_TOKEN=" + tokens.refresh_token);
  console.log("==================================================");
  console.log("");
  console.log(
    "Copy that value into your .env (GOOGLE_CALENDAR_REFRESH_TOKEN). It is a secret -\n" +
      "do not paste it into chat or commit it."
  );
  server.close();
  process.exit(0);
});

server.listen(PORT, "127.0.0.1", () => {
  const authUrl =
    "https://accounts.google.com/o/oauth2/auth?" +
    new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: SCOPE,
      access_type: "offline",
      prompt: "consent",
    });
  console.log(`Listening on ${redirectUri} - open the URL below in your browser and sign in`);
  console.log("as the Google account whose calendar you want to use:");
  console.log("");
  console.log(authUrl);
  console.log("");
  console.log("Waiting for the authorization redirect... (timeout 5 minutes)");
  setTimeout(() => {
    console.error("Timeout: no authorization received.");
    server.close();
    process.exit(1);
  }, 5 * 60 * 1000).unref();
});