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

// ✨ แก้ไขตรงนี้ให้ชี้มาที่ไฟล์ index-tablet.html โดยตรงแบบชัดเจน
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index-tablet.html'));
});

// WebSocket Proxy: รับสัญญาณจากแท็บเล็ต แล้วแปะ API Key ยิงหา Google
wss.on('connection', (clientWs) => {
    console.log('📱 แท็บเล็ตเชื่อมต่อเข้ามาที่หลังบ้านสำเร็จ!');

    if (!GEMINI_API_KEY) {
        console.error('❌ Error: ยังไม่ได้กำหนด GEMINI_API_KEY');
        clientWs.close();
        return;
    }

    const targetUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
    const googleWs = new WebSocket(targetUrl);

    googleWs.on('open', () => {
        console.log('🚀 เชื่อมต่อกับ Google Gemini Live API สำเร็จ');
    });

    clientWs.on('message', (message) => {
        if (googleWs.readyState === WebSocket.OPEN) {
            googleWs.send(message);
        }
    });

    googleWs.on('message', (data) => {
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(data);
        }
    });

    clientWs.on('close', () => {
        if (googleWs.readyState === WebSocket.OPEN) googleWs.close();
    });

    googleWs.on('close', () => {
        if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
    });

    googleWs.on('error', (err) => {
        console.error('❌ Google WebSocket Error:', err.message);
    });
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
