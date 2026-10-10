# SETUP — nếu muốn Claude Code cài hộ

Người dùng tự cài theo [README](README.md) là đủ. File này dành cho Claude Code khi người dùng nói *"cài agent-bridge cho tôi theo https://github.com/trananhhh/agent-bridge/blob/main/SETUP.md"*.

**Claude:** làm lần lượt các bước. Gặp "HỎI" thì phải hỏi người dùng; không tự chọn tên hay folder thay họ.

1. **Tailscale:** chạy `tailscale ip -4 || /Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4`. Nếu không ra IP `100.x.y.z` → dừng lại, nhờ người dùng cài https://tailscale.com/download và đăng nhập.
2. **Cài:** `node -v` (cần ≥ 22.13), sau đó chạy `npm install -g github:trananhhh/agent-bridge`.
3. **HỎI tên** (chữ thường, không dấu), rồi chạy `agent-bridge setup --name <tên>`.
4. **Share Tailscale hai chiều:** hướng dẫn người dùng theo mục "Share máy cho nhau" trong README. Bạn không làm hộ được bước này.
5. **Kết nối:** CLI có câu hỏi tương tác nhưng nhận được input qua pipe.
   - Mời người khác: `agent-bridge connect` để xem danh sách. HỎI người dùng chọn ai và folder người đó được đọc (nhắc rằng `.env` cũng đọc được), rồi chạy:
     `printf '<số>\n<folder1>,<folder2>\ny\n' | agent-bridge connect`
     Lệnh sẽ chờ bên kia chấp nhận, tối đa 15 phút.
   - Có người đang mời: `agent-bridge requests` để xem. HỎI người dùng có chấp nhận không và chọn folder, rồi chạy:
     `printf 'y\n<folder1>,<folder2>\n' | agent-bridge requests`
6. **Lưu memory:** lấy đoạn hướng dẫn CLI in ra (hoặc chạy `agent-bridge note <tên>`) và lưu vào memory của bạn đúng như nội dung đó.
7. **Báo cho người dùng:** đã kết nối với ai, mỗi bên đọc được folder nào (`agent-bridge peers`). Muốn tin của đồng nghiệp tự hiện trong conversation thì mở Claude bằng `claude-bridge`.
