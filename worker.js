// 截图 MCP 服务器（Cloudflare Workers + KV）
// SECRET 在部署时填写（或用 wrangler secret put 设置），不写在代码里
// 上传地址：https://你的域名.workers.dev/upload/SECRET
// MCP 地址：https://你的域名.workers.dev/mcp/SECRET

const KEEP_SECONDS = 86400;       // 截图保留 24 小时后自动删除
const MAX_BYTES = 5 * 1024 * 1024; // 单张上限 5MB

export default {
  async fetch(request, env) {
    const SECRET = env.SECRET;
    if (!SECRET || SECRET.length < 16) {
      return new Response("SECRET 未设置或太短（至少 16 位）", { status: 500 });
    }
    const parts = new URL(request.url).pathname.split("/").filter(Boolean);
    if (parts.length !== 2 || parts[1] !== SECRET) {
      return new Response("Not found", { status: 404 });
    }
    if (parts[0] === "upload" && request.method === "POST") return upload(request, env);
    if (parts[0] === "mcp") return mcp(request, env);
    return new Response("Not found", { status: 404 });
  },
};

// ---------- 上传 ----------
async function upload(request, env) {
  const buf = await request.arrayBuffer();
  if (buf.byteLength === 0) return new Response("空文件", { status: 400 });
  if (buf.byteLength > MAX_BYTES) return new Response("图片太大", { status: 413 });
  const type = sniff(buf);
  if (!type) return new Response("不是 PNG/JPEG 图片", { status: 415 });

  // 倒序时间戳做 key，列表时最新的排在最前
  const rev = String(9999999999999 - Date.now()).padStart(13, "0");
  await env.SHOTS.put("shot:" + rev, buf, {
    metadata: { type, time: new Date().toISOString() },
    expirationTtl: KEEP_SECONDS,
  });
  return new Response("已上传");
}

function sniff(buf) {
  const b = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  return null;
}

// ---------- MCP（JSON-RPC over HTTP） ----------
async function mcp(request, env) {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }
  let msg;
  try {
    msg = await request.json();
  } catch {
    return rpcError(null, -32700, "Parse error");
  }
  if (msg.id === undefined || msg.id === null) {
    return new Response(null, { status: 202 }); // 通知类消息，无需回复
  }

  switch (msg.method) {
    case "initialize":
      return rpcResult(msg.id, {
        protocolVersion: msg.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "screenshot-mcp", version: "1.0.0" },
      });
    case "ping":
      return rpcResult(msg.id, {});
    case "tools/list":
      return rpcResult(msg.id, { tools: [TOOL] });
    case "tools/call":
      if (msg.params?.name !== TOOL.name) return rpcError(msg.id, -32602, "Unknown tool");
      return rpcResult(msg.id, await getScreenshots(env, msg.params?.arguments?.count));
    default:
      return rpcError(msg.id, -32601, "Method not found");
  }
}

const TOOL = {
  name: "get_screenshots",
  description:
    "获取用户从手机上传的最近截图（最新的在前），通常是用户正在阅读的论文页面。" +
    "当用户说“看截图”“看这一页”“这张图”等时调用。",
  inputSchema: {
    type: "object",
    properties: {
      count: { type: "integer", minimum: 1, maximum: 5, default: 1, description: "要获取的张数" },
    },
  },
};

async function getScreenshots(env, count) {
  const n = Math.min(Math.max(parseInt(count) || 1, 1), 5);
  const { keys } = await env.SHOTS.list({ prefix: "shot:", limit: n });
  if (keys.length === 0) {
    return { content: [{ type: "text", text: "暂无截图（可能还没上传，或刚上传还没同步，稍等几十秒再试）。" }] };
  }
  const content = [{ type: "text", text: `共 ${keys.length} 张截图，最新的在前。` }];
  for (const k of keys) {
    const { value, metadata } = await env.SHOTS.getWithMetadata(k.name, "arrayBuffer");
    if (!value) continue;
    content.push({ type: "text", text: `上传时间：${metadata?.time || "未知"}` });
    content.push({ type: "image", data: toBase64(value), mimeType: metadata?.type || "image/jpeg" });
  }
  return { content };
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function rpcResult(id, result) {
  return Response.json({ jsonrpc: "2.0", id, result });
}
function rpcError(id, code, message) {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } });
}
