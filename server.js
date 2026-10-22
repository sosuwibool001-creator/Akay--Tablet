// server.js - Backend Server สำหรับ PC ในบ้าน
const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// สร้างโฟลเดอร์ uploads สำหรับเก็บภาพถ้ายังไม่มี
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

// 📌 API สำหรับให้กล้อง PC อัปเดตภาพล่าสุดเข้ามาเก็บไว้
app.post('/api/camera/upload-latest', (req, res) => {
    try {
        const { imageBase64 } = req.body;
        if (!imageBase64) {
            return res.status(400).json({ success: false, message: 'Missing imageBase64' });
        }

        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
        const filePath = path.join(uploadDir, 'latest_home.jpg');

        fs.writeFileSync(filePath, base64Data, 'base64');
        console.log(`[${new Date().toLocaleTimeString()}] 📸 อัปเดตภาพล่าสุดจากกล้องบ้านเรียบร้อยแล้ว`);

        res.json({ success: true, url: '/uploads/latest_home.jpg', timestamp: Date.now() });
    } catch (err) {
        console.error('Save image error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 📌 API สำหรับให้แท็บเล็ตดึงภาพล่าสุดไปให้เจดู
app.get('/api/camera/latest-image', (req, res) => {
    const filePath = path.join(uploadDir, 'latest_home.jpg');
    if (fs.existsSync(filePath)) {
        const imageBuffer = fs.readFileSync(filePath);
        const base64Image = imageBuffer.toString('base64');
        res.json({ success: true, imageBase64: base64Image });
    } else {
        res.status(404).json({ success: false, message: 'ยังไม่มีภาพบันทึกในระบบ' });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Project-J Home Guardian Server Running on http://localhost:${PORT}`);
});
