require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// ให้บริการไฟล์ Static บนโฟลเดอร์โปรเจกต์
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index-tablet.html'));
});

// WebSocket Proxy: รับสัญญาณจากแท็บเล็ต แล้วแปะ API Key ยิงหา Google แบบปลอดภัย
wss.on('connection', (clientWs) => {
    console.log('📱 แท็บเล็ตเชื่อมต่อเข้ามาที่หลังบ้านสำเร็จ!');

    if (!GEMINI_API_KEY) {
        console.error('❌ Error: ยังไม่ได้กำหนด GEMINI_API_KEY ในไฟล์ .env');
        clientWs.close();
        return;
    }

    const targetUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
    const googleWs = new WebSocket(targetUrl);

    googleWs.on('open', () => {
        console.log('🚀 เชื่อมต่อกับ Google Gemini Live API สำเร็จ (ซ่อน Key เรียบร้อย)');
    });

    // ส่งต่อข้อความจาก แท็บเล็ต -> Google
    clientWs.on('message', (message) => {
        if (googleWs.readyState === WebSocket.OPEN) {
            googleWs.send(message);
        }
    });

    // ส่งต่อข้อความจาก Google -> แท็บเล็ต
    googleWs.on('message', (data) => {
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(data);
        }
    });

    clientWs.on('close', () => {
        if (googleWs.readyState === WebSocket.OPEN) googleWs.close();
        console.log('📱 แท็บเล็ตตัดการเชื่อมต่อ');
    });

    googleWs.on('close', () => {
        if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
    });

    googleWs.on('error', (err) => {
        console.error('❌ Google WebSocket Error:', err.message);
    });
});

server.listen(PORT, () => {
    console.log(`=================================================`);
    console.log(`🚀 Genesis Master Backend Proxy Running!`);
    console.log(`📱 เปิดเว็บบนแท็บเล็ตได้ที่: http://localhost:${PORT}`);
    console.log(`=================================================`);
});