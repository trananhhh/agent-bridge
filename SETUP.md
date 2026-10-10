# SETUP — hướng dẫn cho Claude Code

> **Người dùng:** mở Claude Code (terminal hoặc desktop) và nói:
> *"Setup agent-bridge cho tôi theo SETUP.md ở <REPO_URL>"* (hoặc đường dẫn file nếu đã clone).
> Nếu được người khác mời, dán luôn lệnh `agent-bridge add-peer …` mà họ gửi vào cùng tin nhắn.

---

**Claude: làm lần lượt từng bước dưới đây trên máy người dùng.** Dừng lại hỏi khi bước nào ghi "HỎI". Không tự bịa tên, URL, token. Cuối cùng báo cáo theo mẫu ở bước 8.

## 0. Kiểm tra điều kiện

```bash
node -v                 # cần >= 22.18
claude --version        # cần >= 2.1.80
tailscale ip -4 || /Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4
```

- Node cũ hơn → đề xuất `nvm install 24` (hoặc `brew install node`), hỏi trước khi cài.
- Không có Tailscale / không ra IP → **dừng**, nhờ người dùng cài app Tailscale (https://tailscale.com/download), đăng nhập, rồi chạy lại bước 0. Bạn không tự đăng nhập hộ.

## 1. HỎI người dùng (một lần, gom các câu)

1. **Tên** hiển thị với đồng nghiệp: chữ thường, không dấu, không khoảng trắng (vd `cu`, `minh`).
2. **Thư mục project** mà bot của đồng nghiệp được phép tra cứu (vd `~/Coding/trananhpremium`). Giải thích: bot bên kia hỏi gì thì câu trả lời chỉ được lấy từ trong các thư mục này, kể cả file `.env` nằm trong đó.
3. **Ghép cặp:** họ **đã nhận** lệnh `agent-bridge add-peer <tên> <url> --token <t>` từ ai đó chưa, hay họ là **người mời** (khi đó cần tên của đồng nghiệp)?

## 2. Cài code

```bash
git clone <REPO_URL> ~/Coding/agent-bridge   # bỏ qua nếu đã có; nếu có rồi thì git pull
cd ~/Coding/agent-bridge && npm install && npm link
agent-bridge help
```

`npm link` lỗi quyền (Node cài bằng hệ thống) → bỏ qua `npm link`, dùng `~/Coding/agent-bridge/bin/agent-bridge` thay cho `agent-bridge` và `~/Coding/agent-bridge/bin/claude-bridge` thay cho `claude-bridge` trong mọi bước sau.

## 3. Tạo config

```bash
agent-bridge init --name <tên> --workdir <thư mục 1> [--workdir <thư mục 2>]
```

Kiểm tra output:
- `listen` phải là IP `100.x.y.z` (tailscale). Nếu báo WARNING tailscale → quay lại bước 0.
- `claude` phải là đường dẫn tuyệt đối. Nếu WARNING → tìm `command -v claude` và sửa `claudeBin` trong `~/.agent-bridge/config.json`.

Ghi lại dòng `Your peer URL` để báo cho người dùng.

## 4. Ghép cặp với đồng nghiệp

**Trường hợp A — đã nhận lệnh từ người mời:** chạy đúng lệnh đó, thêm `--workdir` nếu người dùng muốn giới hạn riêng cho người này:

```bash
agent-bridge add-peer <tên-người-mời> http://100.x.y.z:8790 --token <token>
```

**Trường hợp B — người dùng là người mời:** cần URL của đồng nghiệp (`http://<tailscale-ip-của-họ>:8790`). Chưa có thì **HỎI**; nếu đồng nghiệp chưa setup, dùng tạm rồi sửa sau (`add-peer` lại với cùng tên là ghi đè).

```bash
agent-bridge add-peer <tên-đồng-nghiệp> http://<ip-của-họ>:8790
```

Lệnh in ra một dòng `agent-bridge add-peer <tên-mình> … --token …`. **Đưa nguyên dòng đó cho người dùng** để họ gửi riêng (DM) cho đồng nghiệp. Không đăng vào kênh chung.

**Khác tailnet** (hai người dùng hai tài khoản Tailscale khác nhau, thường gặp): **mỗi bên** phải share máy mình cho bên kia. Hướng dẫn người dùng:
admin console https://login.tailscale.com/admin/machines → máy của mình → `…` → **Share** → gửi link cho đồng nghiệp → đồng nghiệp bấm Accept.
Cùng một tailnet (vd tailnet công ty) thì bỏ qua bước này.

## 5. Chạy daemon nền

macOS:
```bash
agent-bridge install-service
```
Linux: không có launchd → chạy `agent-bridge daemon` dưới systemd user service / tmux, hỏi người dùng chọn cách nào.

Lần đầu macOS có thể hiện hộp thoại *"Allow node to accept incoming network connections"*. Nhắc người dùng bấm **Allow**. Nếu không thấy mà peer vẫn không vào được: System Settings → Network → Firewall → Options → cho phép `node`.

## 6. Đăng ký MCP cho Claude Code

```bash
agent-bridge register-mcp
claude mcp list | grep agent-bridge
```

## 7. Kiểm tra

```bash
agent-bridge status
```

Kỳ vọng: `daemon: running` và mỗi peer `reachable`. Peer `unreachable`:
- Đồng nghiệp chưa setup xong / daemon bên đó chưa chạy → bình thường, tin sẽ tự gửi lại khi họ online.
- Khác tailnet chưa share (bước 4), hoặc firewall (bước 5).
- `ping <ip-của-họ>` qua tailscale: `tailscale ping <ip>`.

Khi peer `reachable`, gửi thử một câu (dùng tool `ask_peer` nếu session này đã có MCP, còn không thì curl):

```bash
curl -s -X POST 127.0.0.1:8791/local/send -H 'content-type: application/json' \
  -d '{"kind":"ask","to":"<tên-peer>","text":"Ping từ agent-bridge: bạn đang setup ở thư mục nào? Trả lời 1 dòng."}'
sleep 60; curl -s 127.0.0.1:8791/local/inbox
```

## 8. Báo cáo cho người dùng

Trả lời ngắn, gồm:
- Tên của họ và **peer URL** (`http://100.x.y.z:8790`) để đưa cho đồng nghiệp.
- Các thư mục đang mở cho peer, peer nào đã ghép, trạng thái reachable.
- Lệnh cần gửi cho đồng nghiệp (nếu là người mời, từ bước 4B).
- Việc người dùng còn phải tự làm: share Tailscale, bấm Allow firewall, gửi token.
- Cách dùng:
  - **Nhận tin tự động trong conversation:** mở session bằng `claude-bridge` (thay cho `claude`) trong terminal, bấm xác nhận cảnh báo dev channel.
  - **Session thường / desktop app:** nói "hỏi bot của <tên> xem …"; bot dùng `ask_peer` rồi `peer_inbox` để lấy trả lời.
  - Khi đồng nghiệp hỏi lúc không có session nào mở, daemon tự mở session chỉ-đọc để trả lời. Lịch sử: `~/.agent-bridge/daemon.log`.

## Gỡ / sửa

```bash
agent-bridge remove-peer <tên>          # ngừng nói chuyện với 1 người
agent-bridge uninstall-service          # tắt daemon
claude mcp remove -s user agent-bridge
rm -rf ~/.agent-bridge                  # xoá config + lịch sử
```
