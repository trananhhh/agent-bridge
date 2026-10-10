# agent-bridge

Cho bot Claude Code của bạn nói chuyện trực tiếp với bot Claude Code của đồng nghiệp, mỗi người một máy. Bot của bạn cần check gì bên máy đồng nghiệp thì hỏi thẳng bot bên đó, và ngược lại.

## Dùng thế nào

1. **Cài Tailscale** và đăng nhập ([tailscale.com/download](https://tailscale.com/download)).
2. **Cài agent-bridge**: nói với Claude Code *"Setup agent-bridge theo https://github.com/trananhhh/agent-bridge/blob/main/SETUP.md"*.
3. **Kết nối**: nói với Claude *"kết nối với Cừ"*. Claude hỏi bạn chọn folder Cừ được xem, rồi đưa bạn một mã `ab1_…` để gửi cho Cừ. Cừ dán mã vào Claude của họ, chọn folder bạn được xem, bấm **Allow**. Xong.
4. Từ đó cứ nói tự nhiên: *"hỏi bot của Cừ xem bảng orders có cột provider_id không"*.

## Quyền

- Mỗi kết nối, **mỗi bên tự chọn** 1 hoặc nhiều folder mà bot bên kia được **đọc**.
- Bot bên kia hỏi lúc bạn vắng: Claude mở một session **chỉ đọc**, bị khoá trong đúng các folder đó bằng `claude --restricted --add-dir <folder>`. Ở chế độ này Write/Edit/Bash không tồn tại, và đọc ngoài folder bị chặn ở mức tool, không phụ thuộc model có tự giác hay không.
- Cần ghi/sửa/chạy lệnh → bot trả lời rằng chủ máy phải tự duyệt. Trong session bạn đang mở, Claude Code vẫn hỏi bạn trước mọi thao tác ghi như bình thường.
- Bot bên kia đọc được **mọi thứ** trong folder bạn chọn, kể cả `.env`. Chỉ chọn những gì bạn sẵn sàng chia sẻ.

## Câu hỏi đến được trả lời ở đâu

| Tin đến | Đi vào |
|---|---|
| Câu trả lời cho câu bạn hỏi | Session đã hỏi (tự hiện trong conversation nếu mở bằng `claude-bridge`). Session đã đóng → giữ lại, giao khi mở lại hoặc khi bot gọi `peer_inbox` |
| Hỏi tiếp cùng mạch | Đúng session đã trả lời lần trước |
| Câu hỏi mới | Haiku chọn session gần đây (48h) liên quan nhất **trong các folder đã chia sẻ** → nhắn vào đó (fork nếu session vừa hoạt động <10 phút). Không có → tạo session mới |

## Hai cách mở Claude Code

- **`~/Coding/agent-bridge/bin/claude-bridge`** (thay cho `claude`): tin của đồng nghiệp **tự hiện trong conversation**. Lần đầu mỗi phiên phải xác nhận một cảnh báo "development channels", vì [Channels](https://code.claude.com/docs/en/channels-reference) của Claude Code đang research preview.
- **Bình thường** (`claude`, desktop app): mọi tool vẫn dùng được, chỉ là câu trả lời không tự hiện; Claude tự gọi `peer_inbox` để chờ.

## Kết nối mạng

Daemon nghe trên IP Tailscale (port 8790), ngoài tailnet không ai vào được. Hai máy phải "thấy" nhau trong Tailscale:
- **Cùng một tailnet** (khuyên dùng cho team): admin mời từng người vào tailnet, người đó bấm accept 1 lần là thấy được cả team.
- **Khác tailnet**: mỗi người share máy mình cho người kia (admin console → Machines → `…` → Share), bên kia bấm accept.

## Lệnh (Claude chạy hộ; bạn hiếm khi cần gõ)

```
bin/agent-bridge setup --name <tên>     cài 1 lần: config + daemon nền (launchd) + MCP cho Claude Code
bin/agent-bridge invite --folder <dir>...         tạo mã mời
bin/agent-bridge accept <ab1_…> --folder <dir>... nhận mã mời
bin/agent-bridge peers | status
bin/agent-bridge folders <peer> --folder <dir>... đổi folder peer được xem
bin/agent-bridge remove-peer <peer>
bin/agent-bridge uninstall
```

Tool MCP Claude dùng: `create_invite`, `accept_invite`, `list_peers`, `set_peer_folders`, `remove_peer`, `ask_peer`, `reply`, `peer_inbox`.

## Vận hành

- Dữ liệu: `~/.agent-bridge/` gồm `config.json`, `bridge.db` (peers, lịch sử tin, outbox) và `daemon.log` (mỗi event một dòng JSON).
- Mã mời dùng 1 lần, hết hạn sau 24h. Token của từng cặp được sinh ra từ mã mời, không cần copy tay.
- Peer offline → tin xếp hàng, tự gửi lại mỗi 30s.
- Session tự chạy lỗi/quá 15 phút → vẫn trả lời báo lỗi để bên hỏi không bị treo.
- Chi phí: mỗi câu hỏi mới tốn 1 lần chạy haiku và 1 session trả lời, tính vào account của **bên trả lời**.

## Yêu cầu

macOS (Linux chạy được nhưng tự lo supervisor), Node ≥ 22.18, Claude Code ≥ 2.1.80 đăng nhập claude.ai, Tailscale.

## Phát triển

```bash
npm install && npm test && npm run typecheck
```
