# SETUP — hướng dẫn cho Claude Code

> **Người dùng:** nói với Claude Code: *"Setup agent-bridge theo https://github.com/trananhhh/agent-bridge/blob/main/SETUP.md"*.
> Nếu đã nhận được mã `ab1_…` từ ai đó, dán kèm luôn.

---

**Claude: làm lần lượt các bước dưới đây trên máy người dùng.** Gặp bước "HỎI" thì phải hỏi người dùng. Không tự đặt tên thay họ, không tự chọn folder thay họ.

## 1. Kiểm tra

```bash
node -v            # cần >= 22.18
claude --version   # cần >= 2.1.80
tailscale ip -4 2>/dev/null || /Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4
```

- Node cũ → hỏi người dùng rồi cài `nvm install 24` (hoặc `brew install node`).
- Không ra IP `100.x.y.z` → **dừng lại**, nhờ người dùng cài app Tailscale (https://tailscale.com/download), đăng nhập, rồi chạy lại bước 1. Bạn không đăng nhập hộ được.

## 2. Cài

```bash
git clone https://github.com/trananhhh/agent-bridge.git ~/Coding/agent-bridge 2>/dev/null || git -C ~/Coding/agent-bridge pull
cd ~/Coding/agent-bridge && npm install
```

## 3. HỎI tên, rồi setup

HỎI: tên hiển thị với đồng nghiệp (chữ thường, không dấu, không khoảng trắng, vd `cu`, `minh`).

```bash
~/Coding/agent-bridge/bin/agent-bridge setup --name <tên>
~/Coding/agent-bridge/bin/agent-bridge status
```

`setup` làm 3 việc: ghi `~/.agent-bridge/config.json`, chạy daemon nền lúc đăng nhập (macOS launchd), đăng ký MCP server `agent-bridge` cho Claude Code. `status` phải báo `daemon: running`.

Nếu macOS hỏi *"Allow node to accept incoming network connections"* → nhắc người dùng bấm **Allow**.

## 4. Kết nối

Session hiện tại chưa có tool MCP mới. Có hai cách:
- **Nói người dùng mở session Claude Code mới** rồi nói "kết nối với <tên>" hoặc dán mã `ab1_…`. Session mới tự biết làm (tool `create_invite` / `accept_invite`).
- Hoặc làm luôn bằng CLI trong session này:
  - **Người dùng có mã `ab1_…`:** HỎI họ chọn folder người gửi mã được **đọc** (chỉ đọc; nhắc rằng `.env` trong folder đó cũng đọc được), rồi chạy:
    `~/Coding/agent-bridge/bin/agent-bridge accept '<ab1_…>' --folder <dir> [--folder <dir>]`
  - **Người dùng muốn mời ai đó:** HỎI folder người kia được đọc, rồi chạy:
    `~/Coding/agent-bridge/bin/agent-bridge invite --folder <dir> [--folder <dir>]`
    Đưa mã cho người dùng gửi riêng (DM) cho người kia. Mã dùng 1 lần, hết hạn 24h.

`accept` báo không kết nối được → hai máy chưa thấy nhau trên Tailscale:
- Cùng tailnet: kiểm tra bằng `tailscale ping <ip trong mã>`.
- Khác tailnet: người mời vào https://login.tailscale.com/admin/machines → máy mình → `…` → **Share** → gửi link, người kia bấm **Accept**.
- Hoặc daemon bên mời đang tắt: bảo họ chạy `agent-bridge status`.

## 5. Báo cáo cho người dùng (ngắn)

- Đã cài xong, tên `<tên>`, daemon chạy nền.
- Đã kết nối với ai, mỗi người đọc được folder nào (`bin/agent-bridge peers`).
- Cách dùng:
  - *"hỏi bot của <tên> …"*: Claude hỏi qua bridge.
  - Muốn tin của đồng nghiệp **tự hiện trong conversation**: mở Claude bằng `~/Coding/agent-bridge/bin/claude-bridge` (thay cho `claude`) và xác nhận cảnh báo development channels. Gợi ý thêm alias: `alias claude-bridge=~/Coding/agent-bridge/bin/claude-bridge`.
  - Khi đồng nghiệp hỏi lúc không có ai ngồi máy, bot tự trả lời ở chế độ chỉ đọc trong đúng các folder đã chọn. Việc cần ghi sẽ được báo là phải chủ máy duyệt.
- Đổi folder hoặc ngắt kết nối: nói với Claude "đổi folder của <tên>" / "ngắt kết nối <tên>".

## Gỡ

```bash
~/Coding/agent-bridge/bin/agent-bridge uninstall   # tắt daemon + gỡ MCP
rm -rf ~/.agent-bridge                              # quên hết kết nối
```
