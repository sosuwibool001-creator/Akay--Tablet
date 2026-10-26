// server_realtime_optimized.js - Project-J Smart Guardian (Realtime On-Demand Optimized)
const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const axios = require('axios');
const FormData = require('form-data');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// ตั้งค่าการเชื่อมต่อ Supabase Cloud Storage (ถ้ามี)
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
let supabase = null;

if (SUPABASE_URL && SUPABASE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    console.log('[Cloud Storage] เชื่อมต่อกับ Supabase สำเร็จ 🟢');
} else {
    console.log('[Cloud Storage Warning] ไม่พบค่า SUPABASE_URL หรือ SUPABASE_KEY ระบบจะบันทึกแบบ Local ชั่วคราว');
}

// โฟลเดอร์สำหรับเก็บไฟล์อัปโหลด (Local Uploads)
const DIR_UPLOADS = path.join(__dirname, 'uploads');
const OWNER_CONFIG_PATH = path.join(__dirname, 'owner_config.json');

if (!fs.existsSync(DIR_UPLOADS)) {
    fs.mkdirSync(DIR_UPLOADS, { recursive: true });
}

app.use(cors());
app.use(express.json({ limit: '15mb' })); // รองรับภาพ Base64 ความละเอียดสูง
app.use(express.static(__dirname));

// 🔍 API ตรวจสอบการลงทะเบียนเจ้าของเครื่อง
app.get('/api/owner/check', (req, res) => {
    if (fs.existsSync(OWNER_CONFIG_PATH)) {
        try {
            const ownerData = JSON.parse(fs.readFileSync(OWNER_CONFIG_PATH, 'utf8'));
            return res.json({ registered: true, owner: ownerData });
        } catch (e) {
            return res.json({ registered: false });
        }
    }
    return res.json({ registered: false });
});

// 👤 API บันทึกเจ้าของเครื่อง
app.post('/api/owner/register', (req, res) => {
    try {
        const { ownerName, imageBase64 } = req.body;
        if (!ownerName) {
            return res.status(400).json({ success: false, message: 'Owner name required' });
        }

        const ownerData = {
            name: ownerName,
            registeredAt: new Date().toISOString(),
            role: "Admin / เจ้าของเครื่องตัวจริง"
        };

        fs.writeFileSync(OWNER_CONFIG_PATH, JSON.stringify(ownerData, null, 2));
        console.log(`✅ [Owner Registered]: บันทึกเจ้าของเครื่องสำเร็จ -> ${ownerName}`);
        return res.json({ success: true, message: `บันทึกเจ้าของเครื่อง ${ownerName} เรียบร้อยแล้ว` });
    } catch (error) {
        console.error('Owner register error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// ดึง API Key สำหรับฝั่ง Client (ถ้าจำเป็นต้องใช้เรียก Gemini จาก Client)
app.get('/api/config/apikey', (req, res) => {
   const apiKey = process.env.BACKEND_API_KEY; 
    if (!apiKey) {
        return res.status(500).json({ error: "API Key not configured on server" });
    }
    res.json({ apiKey: apiKey });
});

// เส้นทางหน้าเว็บหลัก
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/tablet', (req, res) => {
    res.sendFile(path.join(__dirname, 'index-tablet.html'));
});

// 📸 API 1: อัปเดตภาพสดเฉพาะกิจ (On-Demand) บันทึกทับเป็น realtime_home.jpg ตามที่เพื่อนเอกต้องการ
app.post('/api/camera/upload-latest', (req, res) => {
    try {
        const { imageBase64 } = req.body;
        if (!imageBase64) {
            return res.status(400).json({ success: false, message: 'Missing imageBase64' });
        }

        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
        const filePath = path.join(DIR_UPLOADS, 'realtime_home.jpg');

        fs.writeFileSync(filePath, base64Data, 'base64');
        console.log(`[${new Date().toLocaleTimeString('th-TH')}] 📸 อัปเดตภาพสด [realtime_home.jpg] เรียบร้อยแล้ว`);

        return res.json({ success: true, url: '/uploads/realtime_home.jpg', timestamp: Date.now() });
    } catch (err) {
        console.error('Save image error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// 📸 API 2: สำหรับดึงภาพสดล่าสุด (realtime_home.jpg) ไปใช้งานหรือให้เจวิเคราะห์ต่อ
app.get('/api/camera/latest-image', (req, res) => {
    const filePath = path.join(DIR_UPLOADS, 'realtime_home.jpg');
    if (fs.existsSync(filePath)) {
        const imageBuffer = fs.readFileSync(filePath);
        const base64Image = imageBuffer.toString('base64');
        return res.json({ success: true, imageBase64: base64Image });
    } else {
        return res.status(404).json({ success: false, message: 'ยังไม่มีภาพสดบันทึกในระบบ' });
    }
});

// เปิด Static Routes สำหรับโฟลเดอร์ uploads
app.use('/uploads', express.static(DIR_UPLOADS));

app.listen(PORT, () => {
    console.log(`[Project-J Realtime Guardian Server] Running on http://localhost:${PORT}`);
    console.log(`[Architecture] On-Demand Realtime Mode Active 🟢 (File: realtime_home.jpg)`);
});
