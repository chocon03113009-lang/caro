# Cờ Caro Online (Node.js + Socket.IO)

Trò chơi cờ caro 15×15, 2–10 người mỗi phòng (2 người chơi, còn lại là khán giả), chơi qua Internet bằng đường dẫn web. Người chơi chỉ cần mở link, không cài đặt gì.

## Cấu trúc

```
caro-online/
├── public/            Phần chạy trong trình duyệt (ai cũng tải được)
│   ├── index.html     Khung trang
│   ├── style.css      Giao diện
│   └── script.js      Giao diện + kết nối Socket.IO
├── server.js          Máy chủ: phục vụ public/ + quản lý phòng + kiểm tra luật
├── package.json       Khai báo thư viện (socket.io) và lệnh npm start
├── .gitignore         Danh sách tệp không đưa lên GitHub
└── README.md          Tệp này
```

Vì sao có thư mục `public/`: tách rõ "tệp công khai" (trình duyệt tải về) và "mã máy chủ" (`server.js`, chỉ chạy trên máy chủ). Máy chủ chỉ phục vụ 3 tệp trong `public/`, nên không ai đọc trộm được `server.js`.

## Chạy thử trên máy

1. Cài Node.js bản LTS (nodejs.org).
2. Mở Terminal trong thư mục dự án, chạy: `npm install` rồi `npm start`.
3. Mở `http://localhost:3000` trên hai tab trình duyệt: một tab tạo phòng, tab kia nhập mã để vào.

## Biến môi trường

| Tên | Ý nghĩa | Mặc định |
|---|---|---|
| `PORT` | Cổng máy chủ. Render/Railway tự đặt, **không cần tự đặt khi triển khai**. | 3000 |
| `CORS_ORIGIN` | Chỉ cần khi trang web đặt ở tên miền khác máy chủ. Nhiều địa chỉ ngăn cách bằng dấu phẩy. | để trống (cùng nguồn) |

Dự án **không có khóa bí mật nào**. Nếu sau này bạn thêm (ví dụ chuỗi kết nối cơ sở dữ liệu), hãy để trong biến môi trường của dịch vụ hosting hoặc tệp `.env` (đã nằm trong `.gitignore`), tuyệt đối không viết vào `public/`.

## Triển khai lên Render (tóm tắt)

1. Đưa thư mục lên GitHub (không có `node_modules`).
2. Render → **New → Web Service** → chọn kho GitHub.
3. Runtime: **Node**. Build Command: `npm install`. Start Command: `npm start`. Instance Type: Free.
4. Mục Health Check Path, điền `/healthz`.
5. Bấm Create. Khi xong, bạn nhận đường dẫn `https://ten-cua-ban.onrender.com`.

Lưu ý: chỉ chạy **một** bản (instance) của máy chủ, vì phòng chơi nằm trong bộ nhớ của từng bản.
