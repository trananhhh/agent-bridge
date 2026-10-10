# agent-bridge

Cho bot Claude Code trên các máy khác nhau nói chuyện trực tiếp với nhau. Ví dụ: bot của bạn đang làm việc, cần check một thứ bên máy đồng nghiệp → nó hỏi thẳng bot bên đó, bot bên đó tra cứu rồi trả lời lại. Hai chiều, peer-to-peer qua Tailscale, không có server trung gian.

> **Setup:** mở Claude Code và nói: *"Đọc `SETUP.md` trong repo agent-bridge và setup cho tôi"*. Chi tiết từng bước nằm ở [SETUP.md](SETUP.md).

## Cách hoạt động

```
Claude session ─stdio─ agent-bridge channel ─http─▶ daemon (bạn) ──Tailscale──▶ daemon (đồng nghiệp)
                                                    ▲ ~/.agent-bridge/bridge.db        │
                                                    └──────────── reply ◀──────────────┘
```

Mỗi máy chạy 1 **daemon** (luôn bật, launchd). Mỗi session Claude Code có MCP server `agent-bridge` với 3 tool: `ask_peer`, `reply`, `peer_inbox`.

**Khi bên kia hỏi, câu hỏi đi vào đâu?**

| Tin đến | Đi vào |
|---|---|
| Câu trả lời cho câu mình hỏi | Session đã hỏi (push thẳng vào conversation). Session đã đóng → giữ lại, giao khi session đó mở lại, hoặc lấy bằng `peer_inbox` |
| Hỏi tiếp cùng thread | Đúng session đã trả lời lần trước |
| Câu hỏi mới | Haiku chọn session liên quan nhất trong các session đang mở + transcript 48h gần đây **thuộc các thư mục bạn cho phép peer đó**. Có → nhắn vào (`claude -p --resume`, fork nếu session vừa hoạt động <10 phút). Không → tạo session mới |

Session tự chạy khi bạn vắng mặt **chỉ đọc**: `Read, Grep, Glob, WebFetch, WebSearch, git log/show/diff/status`. Việc cần ghi sẽ được trả lời là "cần chủ máy duyệt".

## Hai chế độ dùng

| | Nhận tin tự động trong conversation | Cách mở |
|---|---|---|
| **Live** | ✅ push vào session đang mở | `claude-bridge` (= `claude --dangerously-load-development-channels server:agent-bridge`), xác nhận cảnh báo dev-channel mỗi lần mở |
| **Thường** (desktop app, `claude`) | ❌ | Tool vẫn dùng được; sau `ask_peer` bot gọi `peer_inbox` để chờ trả lời |

Live cần vì [Channels](https://code.claude.com/docs/en/channels-reference) của Claude Code đang research preview — channel tự build phải bật bằng flag dev.

## Lệnh

```
agent-bridge init --name <tên> --workdir <thư mục>...   tạo ~/.agent-bridge/config.json
agent-bridge add-peer <tên> <url> [--token T] [--workdir D]...
agent-bridge remove-peer <tên>
agent-bridge register-mcp          đăng ký MCP server cho Claude Code (user scope)
agent-bridge install-service       chạy daemon lúc login (macOS)
agent-bridge status                kiểm tra daemon + từng peer
agent-bridge daemon                chạy daemon foreground
```

## Config — `~/.agent-bridge/config.json` (chmod 600)

```json
{
  "name": "anh",
  "listenHost": "100.116.98.0",
  "workdirs": ["/Users/anh/Coding/shop"],
  "peers": [
    { "name": "cu", "url": "http://100.64.1.2:8790", "token": "…", "workdirs": ["/Users/anh/Coding/shop"] }
  ],
  "claudeBin": "/Users/anh/.local/bin/claude",
  "headless": { "allowedTools": ["Read", "Grep", "Glob"], "timeoutMs": 900000 },
  "routing": { "recentHours": 48, "recentLimit": 8, "activeWindowMin": 10, "classifierModel": "haiku" }
}
```

- `workdirs` (global hoặc riêng từng peer): **ranh giới dữ liệu**. Câu hỏi của peer chỉ được trả lời bằng session/thư mục nằm trong đây. Mặc định peer dùng `workdirs` global; muốn peer X chỉ thấy project Y thì đặt `workdirs` riêng cho peer đó.
- Mỗi cặp người một token riêng (`add-peer` tự sinh). Token xác định danh tính người gửi.

## Bảo mật — đọc trước khi bật

- Câu hỏi của peer = prompt chạy trên máy bạn. Session headless bị giới hạn read-only bằng allowlist; session live vẫn hỏi bạn trước khi ghi như bình thường.
- **Bot sẽ trả lời bằng bất cứ thứ gì nó đọc được trong `workdirs`**, kể cả `.env`. Chỉ đưa vào `workdirs` những project bạn sẵn sàng chia sẻ với peer đó.
- Daemon nghe trên IP Tailscale; ngoài tailnet không vào được. Token chặn các máy khác trong tailnet.
- Không bật permission relay — peer không thể duyệt tool call trên máy bạn.
- Chi phí: mỗi câu hỏi mới tốn 1 lần haiku (~6s) + 1 session trả lời, tính vào account **bên trả lời**.

## Vận hành

- Log: `~/.agent-bridge/daemon.log` — mỗi event 1 dòng JSON (`inbound` + `route`, `classified`, `headless_start`, `sent`, `queued`, `delivered_live`, `parked_reply`).
- Lịch sử: `~/.agent-bridge/bridge.db` (bảng `messages`, `threads`, `outbox`).
- Peer offline → tin vào `outbox`, gửi lại mỗi 30s theo thứ tự.
- Session headless lỗi/timeout (15 phút) → vẫn gửi reply báo lỗi để bên hỏi không treo.

## Yêu cầu

macOS (Linux chạy được, tự lo supervisor thay launchd) · Node ≥ 22.18 (chạy TypeScript trực tiếp, không build) · Claude Code ≥ 2.1.80 đăng nhập claude.ai · Tailscale.

## Phát triển

```bash
npm install
npm test          # unit + test 3 daemon nói chuyện in-process với runner giả
npm run typecheck
```
