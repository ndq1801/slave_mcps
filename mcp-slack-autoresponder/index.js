import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import pkg from "@slack/bolt";
const { App } = pkg;
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

// Tải biến môi trường từ .env nếu có
dotenv.config();

// Cấu hình mặc định
const config = {
  slackBotToken: process.env.SLACK_BOT_TOKEN || "",
  slackAppToken: process.env.SLACK_APP_TOKEN || "",
  slackUserToken: process.env.SLACK_USER_TOKEN || "",
  slackUserId: process.env.SLACK_USER_ID || "",
  timeoutMinutes: parseFloat(process.env.AUTO_REPLY_TIMEOUT_MINUTES || "5"),
  defaultReplyText:
    process.env.DEFAULT_REPLY_TEXT ||
    "Tôi hiện chưa có mặt, tôi sẽ xem tin nhắn và phản hồi lại bạn sau ít phút nữa.",
  enabled: true,
};

// Trạng thái ứng dụng Slack Bolt & Hàng đợi Timer đếm ngược
let boltApp = null;
let isListenerRunning = false;
// Map lưu trữ: key = `${channel}:${thread_ts}`, value = { timer, channel, thread_ts, sender, text, createdAt, expiresAt }
const pendingTimers = new Map();

// 1. Khởi tạo MCP Server
const server = new Server(
  {
    name: "mcp-slack-autoresponder",
    version: "1.0.0",
  },
  {
    capabilities: { tools: {} },
  }
);

// Khởi tạo dịch vụ Slack Bolt Socket Mode
async function startSlackListener() {
  const botToken = config.slackBotToken;
  const appToken = config.slackAppToken;

  if (!botToken || !appToken) {
    throw new Error(
      "Thiếu SLACK_BOT_TOKEN hoặc SLACK_APP_TOKEN. Vui lòng cấu hình trong file .env hoặc gọi tool configure_autoresponder."
    );
  }

  if (isListenerRunning && boltApp) {
    return "Bộ lắng nghe Slack đang hoạt động sẵn.";
  }

  boltApp = new App({
    token: botToken,
    appToken: appToken,
    socketMode: true,
  });

  // Lắng nghe tất cả tin nhắn
  boltApp.message(async ({ message, client }) => {
    try {
      await handleSlackMessage(message, client);
    } catch (err) {
      console.error("Lỗi khi xử lý tin nhắn Slack:", err);
    }
  });

  // Lắng nghe sự kiện được mention trong kênh
  boltApp.event("app_mention", async ({ event, client }) => {
    try {
      await handleSlackMessage(event, client);
    } catch (err) {
      console.error("Lỗi khi xử lý app_mention:", err);
    }
  });

  await boltApp.start();
  isListenerRunning = true;
  console.error("⚡ Slack Auto-Responder Listener Socket Mode đã khởi chạy!");
  return "Đã kết nối thành công Slack Socket Mode và đang lắng nghe tin nhắn!";
}

// Dừng lắng nghe Slack
async function stopSlackListener() {
  if (boltApp && isListenerRunning) {
    await boltApp.stop();
    isListenerRunning = false;
    boltApp = null;

    // Hủy tất cả timer hiện tại
    for (const [key, pending] of pendingTimers.entries()) {
      clearTimeout(pending.timer);
    }
    pendingTimers.clear();

    return "Đã dừng bộ lắng nghe Slack và xóa toàn bộ đếm ngược đang chờ.";
  }
  return "Bộ lắng nghe Slack hiện chưa được bật.";
}

// Xử lý logic đếm ngược & hủy đếm ngược tin nhắn Slack
async function handleSlackMessage(message, client) {
  if (!config.enabled) return;

  const sender = message.user;
  const channel = message.channel;
  const threadTs = message.thread_ts || message.ts;
  const messageTs = message.ts;
  const text = message.text || "";
  const targetUserId = config.slackUserId;
  const channelType = message.channel_type || (channel?.startsWith("D") ? "im" : channel?.startsWith("G") ? "mpim" : "channel");

  // Log sự kiện nhận được để debug
  console.error(
    `[Slack Event Log] 📩 Channel: ${channel} (${channelType}) | Sender: ${sender} | Text: "${text.substring(0, 60)}..."`
  );

  // Bỏ qua tin nhắn từ Bot hoặc tin nhắn không có sender
  if (!sender || message.bot_id || message.subtype === "bot_message") {
    return;
  }

  // TRƯỜNG HỢP 1: Người dùng (bạn) đăng tin nhắn -> Hủy đếm ngược cho thread/channel này
  if (targetUserId && sender === targetUserId) {
    const timerKey = `${channel}:${threadTs}`;
    if (pendingTimers.has(timerKey)) {
      const pending = pendingTimers.get(timerKey);
      clearTimeout(pending.timer);
      pendingTimers.delete(timerKey);
      console.error(
        `[Slack Auto-Responder] 🛑 Đã hủy đếm ngược cho thread ${threadTs} trong channel ${channel} vì bạn (${sender}) đã tự phản hồi.`
      );
    }
    return;
  }

  // TRƯỜNG HỢP 2: Người khác nhắn tin -> Kiểm tra xem có áp dụng tự động trả lời không
  // Áp dụng khi:
  // a) Tin nhắn riêng (DM - channel_type 'im', 'mpim' hoặc ID bắt đầu bằng 'D', 'G')
  // b) Người dùng được @mention trong bất kỳ channel nào (text có chứa `<@targetUserId>`)
  // c) Sự kiện `app_mention` trực tiếp
  const isDirectMessage = channelType === "im" || channelType === "mpim" || channel.startsWith("D") || channel.startsWith("G");
  const isMentioned = targetUserId ? text.includes(`<@${targetUserId}>`) : false;

  if (isDirectMessage || isMentioned) {
    const timerKey = `${channel}:${threadTs}`;

    // Nếu đã có đếm ngược cho thread này, reset hoặc giữ nguyên timer
    if (pendingTimers.has(timerKey)) {
      console.error(
        `[Slack Auto-Responder] Nhận thêm tin nhắn mới từ ${sender} trong thread ${threadTs}. Tiếp tục đếm ngược...`
      );
      return;
    }

    const timeoutMs = Math.max(0.1, config.timeoutMinutes) * 60 * 1000;
    const expiresAt = new Date(Date.now() + timeoutMs);

    console.error(
      `[Slack Auto-Responder] Đã tạo đếm ngược ${config.timeoutMinutes} phút cho tin nhắn từ ${sender} tại channel ${channel} (Hết hạn lúc: ${expiresAt.toLocaleTimeString()}).`
    );

    const timer = setTimeout(async () => {
      await executeAutoReply(timerKey, client);
    }, timeoutMs);

    pendingTimers.set(timerKey, {
      timer,
      channel,
      thread_ts: threadTs,
      message_ts: messageTs,
      sender,
      text,
      createdAt: new Date().toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
  }
}

// Hàm gửi tin nhắn Slack thông minh (tự động xử lý Token & lỗi channel_not_found cho DM 1-1)
async function postSlackMessage({ channel, threadTs, text, sender }) {
  const slackClient = boltApp?.client;
  if (!slackClient) {
    throw new Error("Slack Client chưa được khởi tạo.");
  }

  // Ưu tiên dùng User Token (xoxp-...) nếu có để gửi được vào DM riêng 1-1 của bạn, nếu không dùng Bot Token (xoxb-...)
  const tokenToUse = config.slackUserToken || config.slackBotToken;

  try {
    const payload = {
      token: tokenToUse,
      channel: channel,
      text: text,
    };
    if (threadTs) {
      payload.thread_ts = threadTs;
    }
    return await slackClient.chat.postMessage(payload);
  } catch (err) {
    const isChannelNotFound =
      err.message?.includes("channel_not_found") ||
      err.data?.error === "channel_not_found" ||
      err.data?.error === "not_in_channel";

    if (isChannelNotFound) {
      console.error(
        `[Slack Auto-Responder] ⚠️ Lỗi '${err.data?.error || err.message}' khi gửi tới channel ${channel}. Đang tự động xử lý...`
      );

      // Thử dùng User Token nếu lượt đầu dùng Bot Token
      if (config.slackUserToken && tokenToUse !== config.slackUserToken) {
        try {
          console.error(`[Slack Auto-Responder] 🔄 Thử gửi bằng User Token (xoxp-...)...`);
          return await slackClient.chat.postMessage({
            token: config.slackUserToken,
            channel: channel,
            thread_ts: threadTs,
            text: text,
          });
        } catch (userTokenErr) {
          console.error(`[Slack Auto-Responder] Lỗi User Token:`, userTokenErr.message);
        }
      }

      // Thử mở DM trực tiếp với sender từ Bot Token
      if (sender) {
        try {
          console.error(`[Slack Auto-Responder] 🔄 Đang mở đường truyền DM trực tiếp tới user ${sender}...`);
          const openDmRes = await slackClient.conversations.open({
            token: config.slackBotToken,
            users: sender,
          });
          if (openDmRes && openDmRes.channel?.id) {
            return await slackClient.chat.postMessage({
              token: config.slackBotToken,
              channel: openDmRes.channel.id,
              text: text,
            });
          }
        } catch (openDmErr) {
          console.error(`[Slack Auto-Responder] Lỗi conversations.open:`, openDmErr.message);
        }
      }
    }
    throw err;
  }
}

// Tự động phát tin nhắn trả lời lên Slack khi hết thời gian đếm ngược
async function executeAutoReply(timerKey, client) {
  const pending = pendingTimers.get(timerKey);
  if (!pending) return;

  pendingTimers.delete(timerKey);

  try {
    const replyText = config.defaultReplyText;
    await postSlackMessage({
      channel: pending.channel,
      threadTs: pending.thread_ts,
      text: replyText,
      sender: pending.sender,
    });

    console.error(
      `[Slack Auto-Responder] 🤖 Đã tự động gửi trả lời tới channel/DM ${pending.channel} sau ${config.timeoutMinutes} phút thành công!`
    );
  } catch (err) {
    console.error(`[Slack Auto-Responder] Lỗi khi gửi tự động trả lời Slack:`, err);
  }
}

// 2. Khai báo danh sách MCP Tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "start_slack_listener",
        description: "Khởi chạy kết nối lắng nghe tin nhắn Slack qua Socket Mode để đếm ngược 5 phút tự động trả lời.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "stop_slack_listener",
        description: "Dừng bộ lắng nghe tin nhắn Slack và hủy tất cả đếm ngược đang chờ.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "get_slack_status",
        description: "Kiểm tra trạng thái kết nối Slack, danh sách cấu hình và số lượng tin nhắn đang đếm ngược.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "configure_autoresponder",
        description: "Cấu hình tham số cho bộ tự động trả lời Slack (thời gian đếm ngược, nội dung phản hồi, Slack User ID...).",
        inputSchema: {
          type: "object",
          properties: {
            timeoutMinutes: { type: "number", description: "Thời gian đếm ngược (tính bằng phút). Mặc định là 5." },
            defaultReplyText: { type: "string", description: "Nội dung tin nhắn tự động trả lời lên Slack." },
            slackUserId: { type: "string", description: "ID tài khoản Slack của bạn (ví dụ: U1234567890) để nhận biết khi bạn tự trả lời." },
            slackBotToken: { type: "string", description: "Token Slack Bot (xoxb-...)" },
            slackAppToken: { type: "string", description: "Token Slack App-Level (xapp-...)" },
            enabled: { type: "boolean", description: "Bật hoặc tắt tính năng tự động trả lời." }
          },
        },
      },
      {
        name: "get_pending_replies",
        description: "Xem chi tiết danh sách các tin nhắn đang trong hàng đếm ngược (chờ bạn trả lời trong 5 phút).",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "cancel_pending_reply",
        description: "Hủy thủ công đếm ngược tự động trả lời cho một channel/thread cụ thể.",
        inputSchema: {
          type: "object",
          properties: {
            channel: { type: "string", description: "ID của Slack Channel." },
            threadTs: { type: "string", description: "Timestamp của thread tin nhắn (thread_ts)." }
          },
          required: ["channel", "threadTs"],
        },
      },
      {
        name: "send_slack_message",
        description: "Gửi ngay một tin nhắn thủ công tới Slack channel hoặc thread cụ thể (không chờ đếm ngược auto-reply). Dùng khi cần phản hồi tức thì. Yêu cầu bộ lắng nghe đang chạy: nếu chưa kết nối, gọi start_slack_listener trước.",
        inputSchema: {
          type: "object",
          properties: {
            channel: { type: "string", description: "ID của Slack Channel." },
            text: { type: "string", description: "Nội dung tin nhắn cần gửi." },
            threadTs: { type: "string", description: "Timestamp của thread nếu muốn trả lời trong thread (tùy chọn)." }
          },
          required: ["channel", "text"],
        },
      }
    ],
  };
});

// 3. Xử lý logic gọi MCP Tools
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "start_slack_listener": {
        const msg = await startSlackListener();
        return { content: [{ type: "text", text: msg }] };
      }

      case "stop_slack_listener": {
        const msg = await stopSlackListener();
        return { content: [{ type: "text", text: msg }] };
      }

      case "get_slack_status": {
        const pendingList = Array.from(pendingTimers.entries()).map(([key, item]) => ({
          timerKey: key,
          channel: item.channel,
          threadTs: item.thread_ts,
          sender: item.sender,
          text: item.text,
          createdAt: item.createdAt,
          expiresAt: item.expiresAt,
        }));

        const statusInfo = {
          isListenerRunning,
          enabled: config.enabled,
          timeoutMinutes: config.timeoutMinutes,
          slackUserIdConfigured: !!config.slackUserId,
          defaultReplyText: config.defaultReplyText,
          pendingTimersCount: pendingTimers.size,
          pendingMessages: pendingList,
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(statusInfo, null, 2),
            },
          ],
        };
      }

      case "configure_autoresponder": {
        if (args.timeoutMinutes !== undefined) config.timeoutMinutes = args.timeoutMinutes;
        if (args.defaultReplyText !== undefined) config.defaultReplyText = args.defaultReplyText;
        if (args.slackUserId !== undefined) config.slackUserId = args.slackUserId;
        if (args.slackBotToken !== undefined) config.slackBotToken = args.slackBotToken;
        if (args.slackAppToken !== undefined) config.slackAppToken = args.slackAppToken;
        if (args.enabled !== undefined) config.enabled = args.enabled;

        return {
          content: [
            {
              type: "text",
              text: `Đã cập nhật cấu hình thành công!\n\n${JSON.stringify(
                {
                  timeoutMinutes: config.timeoutMinutes,
                  slackUserId: config.slackUserId,
                  enabled: config.enabled,
                  defaultReplyText: config.defaultReplyText,
                },
                null,
                2
              )}`,
            },
          ],
        };
      }

      case "get_pending_replies": {
        const pendingList = Array.from(pendingTimers.entries()).map(([key, item]) => ({
          timerKey: key,
          channel: item.channel,
          threadTs: item.thread_ts,
          sender: item.sender,
          text: item.text,
          createdAt: item.createdAt,
          expiresAt: item.expiresAt,
        }));

        return {
          content: [
            {
              type: "text",
              text:
                pendingList.length > 0
                  ? JSON.stringify(pendingList, null, 2)
                  : "Không có tin nhắn nào đang trong hàng đếm ngược.",
            },
          ],
        };
      }

      case "cancel_pending_reply": {
        const timerKey = `${args.channel}:${args.threadTs}`;
        if (pendingTimers.has(timerKey)) {
          const pending = pendingTimers.get(timerKey);
          clearTimeout(pending.timer);
          pendingTimers.delete(timerKey);
          return {
            content: [
              {
                type: "text",
                text: `Đã hủy đếm ngược tự động trả lời cho channel ${args.channel}, thread ${args.threadTs}.`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Không tìm thấy đếm ngược đang chờ cho channel ${args.channel}, thread ${args.threadTs}.`,
            },
          ],
        };
      }

      case "send_slack_message": {
        if (!boltApp || !boltApp.client) {
          return {
            content: [
              {
                type: "text",
                text: "Bộ lắng nghe Slack chưa được kết nối. Vui lòng gọi tool start_slack_listener trước.",
              },
            ],
            isError: true,
          };
        }

        const result = await postSlackMessage({
          channel: args.channel,
          threadTs: args.threadTs,
          text: args.text,
        });

        return {
          content: [
            {
              type: "text",
              text: `Đã gửi tin nhắn tới Slack thành công! Message TS: ${result.ts}`,
            },
          ],
        };
      }

      default:
        throw new Error(`Công cụ không tồn tại: ${name}`);
    }
  } catch (error) {
    return {
      content: [{ type: "text", text: `Đã xảy ra lỗi hệ thống: ${error.message}` }],
      isError: true,
    };
  }
});

// Auto-start nếu token đã cấu hình sẵn trong .env
if (config.slackBotToken && config.slackAppToken) {
  startSlackListener().catch((err) => {
    console.error("Không thể khởi động kết nối Slack tự động:", err.message);
  });
}

// 4. Kết nối Transport Stdio
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Slack Auto-Responder MCP Server đã kích hoạt thành công!");
