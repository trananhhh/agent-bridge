# agent-bridge

Cho agent Claude Code của bạn hỏi thẳng agent Claude Code của đồng nghiệp (máy khác, account khác), và ngược lại. Kết nối peer-to-peer qua Tailscale, không có server trung gian.

## Cài (mỗi người, một lần)

**1. Tailscale.** Cài app tại https://tailscale.com/download, đăng nhập bằng account của bạn.

**2. Share máy cho nhau, cả hai chiều.** Mỗi người làm:
1. Mở https://login.tailscale.com/admin/machines
2. Ở dòng máy của mình, bấm `⋯` → **Share…** → copy share link (hoặc nhập email người kia)
3. Gửi link cho người kia; họ mở link và bấm **Accept**

Phải share cả hai chiều, vì Tailscale chỉ cho máy được share *nhận* kết nối chứ không cho nó *chủ động gọi lại*. Kiểm tra: `tailscale status` thấy máy người kia là được.

**3. Cài agent-bridge.** Cần Node ≥ 22.13 và Claude Code.

```bash
npm install -g github:trananhhh/agent-bridge
agent-bridge
```

Lần đầu chạy, CLI hỏi tên của bạn rồi tự cài daemon chạy nền (tự bật khi đăng nhập) và đăng ký MCP cho Claude Code. Nếu macOS hỏi *"Allow node to accept incoming connections"* → bấm **Allow**.

## Kết nối

**Người mời** chạy `agent-bridge`:
1. CLI quét Tailscale và liệt kê những máy đang chạy agent-bridge; chọn người cần kết nối.
2. Chọn folder người đó được **đọc**.
3. Gửi yêu cầu rồi chờ.

**Người được mời** nhận thông báo trên macOS, chạy `agent-bridge`:
1. CLI hiện ai đang mời, kèm danh tính Tailscale thật (không phải tên tự khai) và folder họ chia sẻ.
2. Chấp nhận, rồi chọn folder người mời được **đọc**.

Xong thì **cả hai** CLI đều in ra một đoạn hướng dẫn (đã tự copy vào clipboard). Dán đoạn đó vào Claude Code để agent lưu vào memory: nó nói chuyện được với ai, hỏi về folder nào, và dùng tool gì.

## Dùng

Cứ nói tự nhiên với Claude Code: *"hỏi agent của Cừ xem bảng orders có cột provider_id không"*.

- **Muốn tin của đồng nghiệp tự hiện trong conversation đang mở:** mở Claude bằng `claude-bridge` thay cho `claude`. Lệnh này thêm flag `--dangerously-load-development-channels`, và mỗi lần mở phải xác nhận một cảnh báo, vì [Channels](https://code.claude.com/docs/en/channels-reference) của Claude Code đang research preview.
- **Session thường hoặc desktop app:** vẫn dùng được; Claude tự gọi `peer_inbox` để chờ câu trả lời.
- **Đồng nghiệp hỏi lúc bạn không mở session nào:** daemon tự mở một session chỉ đọc để trả lời. Nếu câu hỏi liên quan một session gần đây (48h) thì tiếp tục ngay trong session đó.

## Quyền

- Mỗi kết nối, mỗi bên tự chọn folder bên kia được đọc. Đọc được **mọi thứ** trong đó, kể cả `.env`.
- Session trả lời đồng nghiệp chạy bằng `claude --restricted --add-dir <folder>`: không có Write/Edit/Bash, và đọc ngoài folder bị CLI chặn. Đã kiểm chứng ở mức tool, không phụ thuộc model có tự giác hay không.
- Cần ghi/sửa → agent trả lời rằng chủ máy phải tự làm. Trong session bạn đang mở, Claude Code vẫn hỏi bạn trước mọi thao tác ghi.

## Lệnh

```
agent-bridge                 wizard: setup → xử lý yêu cầu đang chờ → kết nối người mới
agent-bridge connect [ip]    kết nối (nhập IP Tailscale nếu quét không thấy)
agent-bridge requests        chấp nhận / từ chối yêu cầu đang chờ
agent-bridge peers           ai đã kết nối, mỗi bên đọc được gì
agent-bridge note <tên>      in lại đoạn hướng dẫn cho Claude Code
agent-bridge folders <tên>   đổi folder người đó được đọc
agent-bridge remove <tên>    ngắt kết nối
agent-bridge status          daemon + từng kết nối online/offline
agent-bridge uninstall       tắt daemon, gỡ MCP
```

## Gỡ rối

| Triệu chứng | Kiểm tra |
|---|---|
| `connect` không thấy ai | Đã share Tailscale **hai chiều** chưa (`tailscale status`)? Bên kia đã chạy `agent-bridge` lần đầu chưa? |
| Thấy máy nhưng không gửi/nhận được | Firewall macOS chặn `node` → System Settings → Network → Firewall → Options |
| Đồng nghiệp hỏi mà không ai trả lời | `agent-bridge status` trên máy họ; log ở `~/.agent-bridge/daemon.log` |

Dữ liệu nằm trong `~/.agent-bridge/`, gồm `config.json`, `bridge.db` (kết nối, lịch sử tin, hàng đợi) và `daemon.log`. Peer đang offline thì tin xếp hàng và tự gửi lại khi họ online. Chi phí trả lời tính vào account Claude của **bên trả lời**.

## Phát triển

```bash
npm install && npm test && npm run typecheck
npm run build   # dist/ được commit để `npm i -g github:…` không cần build — build trước khi commit
```
