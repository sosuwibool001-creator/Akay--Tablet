// server.js - Project-J Smart Guardian Server (Full Multi-Camera + Security Mode & RAM Buffering)
const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const axios = require('axios');
const sharp = require('sharp');
const FormData = require('form-data');
const { createClient } = require('@supabase/supabase-js');
const ffmpeg = require('fluent-ffmpeg');

const app = express();
const PORT = process.env.PORT || 3000;

// ตั้งค่าการเชื่อมต่อ Supabase (เก็บบันทึกไฟล์ Event / Cloud Storage สำรองเท่านั้น ไม่ใช้ Database Table)
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
let supabase = null;

if (SUPABASE_URL && SUPABASE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    console.log('[Cloud Storage] เชื่อมต่อกับ Supabase สำเร็จ (ใช้สำหรับเก็บไฟล์ภาพ Event) 🟢');
} else {
    console.log('[Cloud Storage Warning] ไม่พบค่า SUPABASE_URL หรือ SUPABASE_KEY ระบบจะบันทึกแบบ Local 100%');
}

// โฟลเดอร์สำรองบนเครื่อง (Local Fallback Directories)
const DIR_CAMERAS = path.join(__dirname, 'cameras_storage');
const DIR_UPLOADS = path.join(__dirname, 'uploads');
const DIR_VOICE_PROFILES = path.join(__dirname, 'voice_profiles'); 

const OWNER_CONFIG_PATH = path.join(__dirname, 'owner_config.json');
const CAMERAS_CONFIG_PATH = path.join(__dirname, 'cameras_config.json');

[
    DIR_CAMERAS, DIR_UPLOADS, DIR_VOICE_PROFILES
].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// 🧠 ระบบจัดการสถานะของบ้าน (State Machine) - เริ่มต้นที่ CARE Mode (ป้องกันกล้องโรงงานทักทายมั่ว)
let currentSystemMode = 'CARE'; // ค่าที่เป็นไปได้: 'CARE' หรือ 'SECURITY'

// โหลดค่าตั้งค่ากล้องจากไฟล์ Local JSON โดยตรง (ไม่พึ่ง Supabase Table)
let camerasConfig = {};

async function initCamerasConfig() {
    if (fs.existsSync(CAMERAS_CONFIG_PATH)) {
        try {
            camerasConfig = JSON.parse(fs.readFileSync(CAMERAS_CONFIG_PATH, 'utf8'));
            console.log('[Local DB] โหลดรายชื่อกล้องจาก cameras_config.json สำเร็จ 🟢');
        } catch (e) {
            camerasConfig = {};
        }
    } else {
        camerasConfig = {
            "camera001": { name: "กล้องหน้าคอม", ip: "127.0.0.1", channel: "", active: true },
            "camera002": { name: "กล้องหน้าบ้าน", ip: "192.168.1.170", channel: "602", active: true }
        };
        fs.writeFileSync(CAMERAS_CONFIG_PATH, JSON.stringify(camerasConfig, null, 2));
        console.log('[Local DB] สร้างไฟล์ cameras_config.json เริ่มต้นสำเร็จ 🟢');
    }
}

// สร้างโฟลเดอร์ย่อยสำหรับเก็บภาพของแต่ละกล้องอัตโนมัติ
Object.keys(camerasConfig).forEach(camId => {
    const camDir = path.join(DIR_CAMERAS, camId);
    if (!fs.existsSync(camDir)) {
        fs.mkdirSync(camDir, { recursive: true });
    }
});

const lastFrames = {};
const inMemoryRAMStore = {}; // 🧠 In-Memory RAM Buffer สำหรับเก็บภาพสแนปชอตล่าสุดของแต่ละกล้อง
const lastTelegramAlertTime = {};
const TELEGRAM_ALERT_COOLDOWN = 5 * 60 * 1000; // 5 นาที

let cameraRequestState = { requested: false };
let pendingAudioVerifications = {};

app.use(cors());
app.use(express.json({ limit: '15mb' })); 
app.use(express.static(__dirname));

const FAMILY_WHITELIST = ["เพื่อนเอก", "คุณแม่", "Ake", "Mother"];
const VISITOR_WHITELIST = ["คุณน้า", "ช่างไฟ", "เพื่อนบ้าน", "Guest"];

// 🎙️📷 API สำหรับตรวจสอบความพร้อมของอุปกรณ์ไมค์และกล้องจากฝั่ง Client
app.get('/api/media/permissions-check', (req, res) => {
    return res.json({
        success: true,
        message: "ระบบพร้อมรองรับการเปิดใช้งานไมโครโฟนและกล้องสองทาง 🎙️📷",
        supportedCodecs: ["audio/pcm", "audio/wav", "image/jpeg"],
        sampleRate: 24000
    });
});

// 🎛️ API ควบคุมและตรวจสอบสถานะโหมดของระบบ (System Mode API)
app.get('/api/system/mode', (req, res) => {
    return res.json({ success: true, mode: currentSystemMode });
});

app.post('/api/system/mode', (req, res) => {
    const { mode } = req.body; // รับค่า 'SECURITY' หรือ 'CARE'
    if (mode === 'SECURITY' || mode === 'CARE') {
        currentSystemMode = mode;
        console.log(`[System Mode] เปลี่ยนสถานะระบบเรียบร้อย -> โหมด [${currentSystemMode}] 🟢`);
        return res.json({ success: true, mode: currentSystemMode, message: `เปลี่ยนเป็นโหมด ${currentSystemMode} เรียบร้อยครับ` });
    }
    return res.status(400).json({ success: false, message: 'Invalid mode specified. Use SECURITY or CARE.' });
});

// 📷 API จัดการกล้อง: ดึงรายชื่อกล้องทั้งหมดจาก Local JSON
app.get('/api/cameras/list', async (req, res) => {
    return res.json({ success: true, cameras: camerasConfig });
});

// 📷 API จัดการกล้อง: เพิ่มหรือแก้ไขข้อมูลกล้อง (บันทึกลง Local JSON ทันที)
app.post('/api/cameras/save', async (req, res) => {
    try {
        const { cameraId, name, ip, channel } = req.body;
        if (!cameraId || !name) {
            return res.status(400).json({ success: false, message: 'Camera ID and Name are required' });
        }

        const updatedAt = new Date().toISOString();
        camerasConfig[cameraId] = {
            name: name,
            ip: ip || 'DHCP/Unknown',
            channel: channel || '',
            active: true,
            updatedAt: updatedAt
        };

        // บันทึกลงไฟล์ Local JSON
        fs.writeFileSync(CAMERAS_CONFIG_PATH, JSON.stringify(camerasConfig, null, 2));

        const camDir = path.join(DIR_CAMERAS, cameraId);
        if (!fs.existsSync(camDir)) {
            fs.mkdirSync(camDir, { recursive: true });
        }

        console.log(`[Multi-Camera] บันทึก/อัปเดตกล้องสำเร็จ -> [${cameraId}] ${name} (${ip}) Channel: ${channel || 'N/A'}`);
        return res.json({ success: true, message: `บันทึกกล้อง ${cameraId} (${name}) เรียบร้อยครับ`, cameras: camerasConfig });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// 📷 API จัดการกล้อง: ลบกล้องออกจากระบบ Local JSON
app.delete('/api/cameras/delete/:cameraId', async (req, res) => {
    try {
        const { cameraId } = req.params;
        if (!camerasConfig[cameraId]) {
            return res.status(404).json({ success: false, message: 'ไม่พบกล้องนี้ในระบบ' });
        }

        const deletedName = camerasConfig[cameraId].name;
        delete camerasConfig[cameraId];

        // บันทึกไฟล์ Local JSON ใหม่
        fs.writeFileSync(CAMERAS_CONFIG_PATH, JSON.stringify(camerasConfig, null, 2));

        console.log(`[Multi-Camera] ลบกล้องสำเร็จ -> [${cameraId}] ${deletedName}`);
        return res.json({ success: true, message: `ลบกล้อง ${deletedName} เรียบร้อยแล้วครับ`, cameras: camerasConfig });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// 🗣️ API รับคำสั่งเสียงเพื่อสลับหรือเปิดกล้องตามชื่อที่สั่ง (รวมคำสั่งเปลี่ยนโหมด)
app.post('/api/camera/voice-command', async (req, res) => {
    try {
        const { commandText } = req.body;
        if (!commandText) {
            return res.status(400).json({ success: false, message: 'ไม่พบคำสั่งเสียง' });
        }

        // รองรับคำสั่งเสียงเปลี่ยนโหมด
        if (commandText.includes('โหมดรักษาความปลอดภัย') || commandText.includes('เปิดระบบกันขโมย')) {
            currentSystemMode = 'SECURITY';
            console.log(`[Voice Command] สั่งเปิด Security Mode ผ่านเสียงสำเร็จ 🛡️`);
            return res.json({ success: true, message: 'เปิดโหมดรักษาความปลอดภัยเรียบร้อยครับเพื่อนเอก', mode: currentSystemMode });
        } else if (commandText.includes('โหมดดูแล') || commandText.includes('โหมดปกติ')) {
            currentSystemMode = 'CARE';
            console.log(`[Voice Command] สั่งเปิด Care Mode ผ่านเสียงสำเร็จ 🟢`);
            return res.json({ success: true, message: 'สลับกลับสู่โหมดดูแลเรียบร้อยครับ', mode: currentSystemMode });
        }

        let targetCamId = null;
        let targetCamMeta = null;

        for (const [camId, cam] of Object.entries(camerasConfig)) {
            if (commandText.includes(camId) || commandText.includes(cam.name)) {
                targetCamId = camId;
                targetCamMeta = cam;
                break;
            }
        }

        if (!targetCamId) {
            return res.status(404).json({ 
                success: false, 
                message: `ไม่พบกล้องที่ตรงกับคำสั่ง "${commandText}" ครับเพื่อนเอก` 
            });
        }

        let imageBase64 = null;
        // 🧠 ดึงจาก RAM Buffer เป็นหลัก
        if (inMemoryRAMStore[targetCamId]) {
            imageBase64 = inMemoryRAMStore[targetCamId].toString('base64');
        } else {
            const filePath = path.join(DIR_UPLOADS, `realtime_${targetCamId}.jpg`);
            if (fs.existsSync(filePath)) {
                imageBase64 = fs.readFileSync(filePath).toString('base64');
            }
        }

        console.log(`[Voice Command] สลับมาที่กล้อง -> [${targetCamId}] ${targetCamMeta.name} สำเร็จ 🟢`);
        
        return res.json({
            success: true,
            message: `สลับภาพมาที่ ${targetCamMeta.name} (${targetCamId}) เรียบร้อยครับ`,
            cameraId: targetCamId,
            cameraName: targetCamMeta.name,
            ip: targetCamMeta.ip,
            channel: targetCamMeta.channel || '',
            imageBase64: imageBase64
        });

    } catch (err) {
        console.error('Voice command error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// 🔍 API ตรวจสอบว่าระบบมีเจ้าของเครื่องลงทะเบียนไว้หรือยัง
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

// 👤 API บันทึกเจ้าของเครื่องตัวจริงครั้งแรก
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
        if (!FAMILY_WHITELIST.includes(ownerName)) {
            FAMILY_WHITELIST.push(ownerName);
        }

        console.log(`✅ [Owner Registered]: บันทึกเจ้าของเครื่องสำเร็จ -> ${ownerName}`);
        return res.json({ success: true, message: `บันทึกเจ้าของเครื่อง ${ownerName} เรียบร้อยแล้ว` });
    } catch (error) {
        console.error('Owner register error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/config/apikey', (req, res) => {
   const apiKey = process.env.BACKEND_API_KEY; 
    if (!apiKey) {
        return res.status(500).json({ error: "API Key not configured on server" });
    }
    res.json({ apiKey: apiKey });
});

// 🖥️ เส้นทางหน้าจอหลัก (PC / Desktop) และหน้าจอแท็บเล็ต
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/cameras', (req, res) => {
    res.sendFile(path.join(__dirname, 'cameras-manager.html'));
});

app.get('/tablet', (req, res) => {
    res.sendFile(path.join(__dirname, 'index-tablet.html'));
});

// 📸 API รองรับการรับภาพสดแยกตามรหัสกล้อง (อัปเดตลง RAM Buffer)
app.post('/api/camera/upload/:cameraId', (req, res) => {
    try {
        const { cameraId } = req.params;
        const { imageBase64 } = req.body;

        if (!imageBase64) {
            return res.status(400).json({ success: false, message: 'Missing imageBase64' });
        }

        const camMeta = camerasConfig[cameraId] || { name: cameraId };
        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
        const imageBuffer = Buffer.from(base64Data, 'base64');
        
        // 🧠 1. บันทึกลง RAM Buffer ทันที (In-Memory Access)
        inMemoryRAMStore[cameraId] = imageBuffer;
        if (cameraId === 'camera001' || cameraId === 'camera002') {
            inMemoryRAMStore['home'] = imageBuffer;
        }

        // 💾 2. บันทึกลง Disk สำรอง
        const latestCamPath = path.join(DIR_UPLOADS, `realtime_${cameraId}.jpg`);
        fs.writeFileSync(latestCamPath, imageBuffer);

        if (cameraId === 'camera001' || cameraId === 'camera002') {
            fs.writeFileSync(path.join(DIR_UPLOADS, 'realtime_home.jpg'), imageBuffer);
        }

        console.log(`[${new Date().toLocaleTimeString('th-TH')}] 📸 อัปเดตภาพสดจาก [${cameraId}: ${camMeta.name}] ลง RAM & Local สำเร็จ ⚡`);
        return res.json({ success: true, url: `/uploads/realtime_${cameraId}.jpg`, timestamp: Date.now() });
    } catch (err) {
        console.error('Save camera image error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// 📸 API ดึงภาพล่าสุดของกล้องแต่ละตัวไปแสดงผล (ดึงจาก RAM Buffer เป็นหลัก)
app.get('/api/camera/latest/:cameraId', (req, res) => {
    try {
        const { cameraId } = req.params;
        
        // 🧠 ดึงตรงจาก RAM Buffer ทันที (เสี้ยววินาที ไม่เกิด File I/O Lock)
        if (inMemoryRAMStore[cameraId]) {
            return res.json({ 
                success: true, 
                imageBase64: inMemoryRAMStore[cameraId].toString('base64'),
                source: 'ram-buffer' 
            });
        }

        // 💾 Fallback: อ่านจากไฟล์ Disk หากยังไม่มีข้อมูลใน RAM
        const filePath = path.join(DIR_UPLOADS, `realtime_${cameraId}.jpg`);
        if (fs.existsSync(filePath)) {
            const imageBuffer = fs.readFileSync(filePath);
            inMemoryRAMStore[cameraId] = imageBuffer; // โหลดเข้า RAM
            return res.json({ success: true, imageBase64: imageBuffer.toString('base64'), source: 'disk-fallback' });
        } else {
            return res.status(404).json({ success: false, message: `ยังไม่มีภาพสดจาก ${cameraId} (ไฟล์ยังไม่ถูกสร้าง)` });
        }
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// 📡 API ส่งสัญญาณ On-Demand ระหว่างแท็บเล็ตและคอมพิวเตอร์
app.get('/api/camera/check-request', (req, res) => {
    return res.json(cameraRequestState);
});

app.post('/api/camera/request-capture', (req, res) => {
    cameraRequestState.requested = true;
    console.log(`[${new Date().toLocaleTimeString('th-TH')}] 📥 แท็บเล็ตส่งสัญญาณขอภาพสดจากกล้องบ้านแล้ว!`);
    return res.json({ success: true, message: 'Request sent' });
});

app.post('/api/camera/clear-request', (req, res) => {
    cameraRequestState.requested = false;
    return res.json({ success: true });
});

// 🎙️ API บันทึกเสียงตัวอย่างรายบุคคล
app.post('/api/voice/register-sample', (req, res) => {
    try {
        const { personName, audioBase64 } = req.body;
        if (!personName || !audioBase64) {
            return res.status(400).json({ success: false, message: 'Missing personName or audioBase64' });
        }

        const personDir = path.join(DIR_VOICE_PROFILES, personName);
        if (!fs.existsSync(personDir)) {
            fs.mkdirSync(personDir, { recursive: true });
        }

        const base64Data = audioBase64.replace(/^data:audio\/\w+;base64,/, '');
        const audioBuffer = Buffer.from(base64Data, 'base64');
        const filename = `sample_${Date.now()}.wav`;
        fs.writeFileSync(path.join(personDir, filename), audioBuffer);

        console.log(`🎙️ [Voice Registration]: บันทึกเสียงตัวอย่างของ [${personName}] สำเร็จ`);
        if (!FAMILY_WHITELIST.includes(personName) && !VISITOR_WHITELIST.includes(personName)) {
            FAMILY_WHITELIST.push(personName);
        }

        return res.json({ success: true, message: `บันทึกเสียงของ ${personName} เรียบร้อยครับ` });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/voice/profiles', (req, res) => {
    try {
        if (!fs.existsSync(DIR_VOICE_PROFILES)) {
            return res.json({ success: true, profiles: [] });
        }
        const profiles = fs.readdirSync(DIR_VOICE_PROFILES).filter(file => {
            return fs.statSync(path.join(DIR_VOICE_PROFILES, file)).isDirectory();
        });
        return res.json({ success: true, profiles: profiles });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// เปิด Static Routes
app.use('/uploads', express.static(DIR_UPLOADS));
app.use('/cameras_storage', express.static(DIR_CAMERAS));
app.use('/voice_profiles', express.static(DIR_VOICE_PROFILES));

async function uploadToCloudStorage(buffer, filename, folderType) {
    if (!supabase) return null;
    try {
        const filePath = `${folderType}/${filename}`;
        const { error } = await supabase.storage
            .from('project-j-events')
            .upload(filePath, buffer, { contentType: 'image/jpeg', upsert: true });

        if (error) throw error;
        const { data: publicUrlData } = supabase.storage.from('project-j-events').getPublicUrl(filePath);
        return publicUrlData.publicUrl;
    } catch (err) {
        console.error('[Cloud Storage Error]:', err.message);
        return null;
    }
}

async function sendTelegramAlertWithPhoto(imageInput, caption) {
    const TELEGRAM_BOT_TOKEN = '8643709223:AAF0nILPSKiEqO_Yky_zwkdzUQvXn_Sv408'; 
    const TELEGRAM_CHAT_ID = '7469060426';

    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`;
        const form = new FormData();
        form.append('chat_id', TELEGRAM_CHAT_ID);
        
        if (typeof imageInput === 'string' && imageInput.startsWith('http')) {
            form.append('photo', imageInput);
        } else {
            form.append('photo', fs.createReadStream(imageInput));
        }

        form.append('caption', caption);
        form.append('parse_mode', 'Markdown');

        await axios.post(url, form, { headers: form.getHeaders() });
    } catch (error) {
        console.error("[Telegram Photo Error]:", error.message);
    }
}

// 📸 API หลักสำหรับรับ Snapshot พร้อมระบบคัดกรองตาม Security Mode และบีบขอบเขตเฉพาะกล้องหน้าบ้าน (camera002)
app.post('/api/snapshot/upload/:cameraId', async (req, res) => {
    try {
        const { cameraId } = req.params;
        const { imageBase64, recognizedName, isFamily } = req.body;
        
        if (!imageBase64) {
            return res.status(400).json({ success: false, message: 'No image data provided' });
        }

        const camMeta = camerasConfig[cameraId] || { name: cameraId };
        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');

        // 🧠 เก็บภาพเหตุการณ์ใส่ RAM Buffer เสมอ
        inMemoryRAMStore[cameraId] = buffer;

        // 🛑 เงื่อนไขที่ 1: ถ้ายังไม่ได้เปิด Security Mode -> ปิดการดักจับและทักทายทุกกรณี (กันรบกวนคนในโรงงาน)
        if (currentSystemMode !== 'SECURITY') {
            return res.status(200).json({ 
                success: true, 
                mode: currentSystemMode, 
                message: 'ระบบอยู่ในโหมดปกติ (CARE Mode) ข้ามการทักทายและแจ้งเตือนผู้บุกรุก' 
            });
        }

        // 🛑 เงื่อนไขที่ 2: บีบขอบเขตเฉพาะ "กล้องหน้าบ้าน" (camera002) เท่านั้นที่จะรันฟังก์ชันทักทายและนับถอยหลัง 15 วินาที
        const TARGET_SECURITY_CAMERA = 'camera002';
        if (cameraId !== TARGET_SECURITY_CAMERA) {
            return res.status(200).json({ 
                success: true, 
                message: `กล้อง ${cameraId} ไม่ได้อยู่ในขอบเขตการทักทายผู้บุกรุก (เปิดเฉพาะ ${TARGET_SECURITY_CAMERA})` 
            });
        }

        const now = new Date();
        const dateStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
        const timeStr = now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Bangkok' }).replace(/:/g, '-');
        const timestamp = Date.now();

        const camDir = path.join(DIR_CAMERAS, cameraId);
        if (!fs.existsSync(camDir)) fs.mkdirSync(camDir, { recursive: true });

        const snapshotFilename = `${cameraId}_${dateStr}_${timeStr}_${timestamp}.jpg`;
        const snapshotFilePath = path.join(camDir, snapshotFilename);
        fs.writeFileSync(snapshotFilePath, buffer);

        const previousBuffer = lastFrames[cameraId];
        lastFrames[cameraId] = buffer;

        let hasImportantMotion = false;
        if (previousBuffer) {
            let diffCount = 0;
            const sampleStep = 50;
            const checkLength = Math.min(buffer.length, previousBuffer.length);
            let totalSamples = 0;

            for (let i = 0; i < checkLength; i += sampleStep) {
                totalSamples++;
                if (Math.abs(buffer[i] - previousBuffer[i]) > 35) diffCount++;
            }
            hasImportantMotion = (diffCount / totalSamples) > 0.35;
        }

        let personCategory = 'stranger';
        let isConfirmedFamily = isFamily;
        let isConfirmedVisitor = false;

        if (recognizedName) {
            if (FAMILY_WHITELIST.some(fam => recognizedName.includes(fam))) {
                isConfirmedFamily = true;
            } else if (VISITOR_WHITELIST.some(vis => recognizedName.includes(vis))) {
                isConfirmedVisitor = true;
            }
        }

        if (isConfirmedFamily) personCategory = 'family';
        else if (isConfirmedVisitor) personCategory = 'visitor';

        // 🛑 ด่านที่ 1: ถ้าเป็นคนในครอบครัว (Family Whitelist) -> ตัดจบ ไม่แจ้งเตือน
        if (personCategory === 'family') {
            return res.status(200).json({ success: true, filtered: 'family-whitelist-passed', category: 'family' });
        }

        if (hasImportantMotion || recognizedName) {
            const cloudUrl = await uploadToCloudStorage(buffer, snapshotFilename, cameraId);
            const alertImageSource = cloudUrl || snapshotFilePath;

            const nowTime = Date.now();
            if (!lastTelegramAlertTime[cameraId]) lastTelegramAlertTime[cameraId] = 0;

            if (personCategory === 'stranger') {
                const sessionId = `verify_${cameraId}_${timestamp}`;
                pendingAudioVerifications[sessionId] = { imagePath: alertImageSource, cameraId, status: 'waiting' };

                console.log(`[Security Action] 🔔 ตรวจพบคนแปลกหน้าหน้ากล้อง [${camMeta.name}] เริ่มส่งเสียงทักทายและจับเวลา 15 วินาที...`);

                // ⏱️ ชาเลนจ์ 15 วินาที: รอการยืนยันตัวตนก่อนยิง Telegram จริง
                setTimeout(async () => {
                    if (pendingAudioVerifications[sessionId]) {
                        delete pendingAudioVerifications[sessionId];
                        if (nowTime - lastTelegramAlertTime[cameraId] > TELEGRAM_ALERT_COOLDOWN) {
                            lastTelegramAlertTime[cameraId] = nowTime;
                            await sendTelegramAlertWithPhoto(
                                alertImageSource, 
                                `🚨 *แจ้งเตือน Security Mode (กล้องหน้าบ้าน)*\nพบผู้บุกรุกไม่แสดงตัวตนภายใน 15 วินาที!\nกล้อง: *[${cameraId}] ${camMeta.name}* (IP: ${camMeta.ip}) ❌`
                            );
                        }
                    }
                }, 15000); // 15 วินาทีทองตามที่ตกลงกัน
            } else {
                if (nowTime - lastTelegramAlertTime[cameraId] > TELEGRAM_ALERT_COOLDOWN) {
                    lastTelegramAlertTime[cameraId] = nowTime;
                    let alertCaption = `🎴 *แจ้งเตือนแขก / คนรู้จัก (กล้องหน้าบ้าน)*\nพบคุณ *${recognizedName}* 🔵`;
                    await sendTelegramAlertWithPhoto(alertImageSource, alertCaption);
                }
            }
        }

        return res.status(200).json({
            success: true,
            filename: snapshotFilename,
            camera: camMeta.name,
            mode: currentSystemMode,
            filteredAsMotion: hasImportantMotion,
            category: personCategory
        });

    } catch (error) {
        console.error('Snapshot upload error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// 🔄 ฟังก์ชันดึงภาพ Snapshot จากกล้อง RTSP อัตโนมัติและเซฟทับไฟล์หลักพร้อมเก็บลง RAM
function captureRtspSnapshot(cameraId, rtspUrl) {
    const realtimeOutputPath = path.join(DIR_UPLOADS, `realtime_${cameraId}.jpg`);
    
    const camDir = path.join(DIR_CAMERAS, cameraId);
    if (!fs.existsSync(camDir)) fs.mkdirSync(camDir, { recursive: true });
    
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
    const timeStr = now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Bangkok' }).replace(/:/g, '-');
    const archiveOutputPath = path.join(camDir, `${cameraId}_${dateStr}_${timeStr}.jpg`);

    ffmpeg(rtspUrl)
        .inputOptions([
            '-rtsp_transport tcp',
            '-timeout 3000000'
        ])
        .outputOptions([
            '-vframes 1',
            '-q:v 2',
            '-update 1',
            '-y'
        ])
        .output(realtimeOutputPath)
        .on('end', () => {
            try {
                // 🧠 อ่านภาพเข้า RAM Buffer ทันทีเพื่อเสิร์ฟฝั่ง Client เสี้ยววินาที
                if (fs.existsSync(realtimeOutputPath)) {
                    const imageBuffer = fs.readFileSync(realtimeOutputPath);
                    inMemoryRAMStore[cameraId] = imageBuffer;
                    
                    if (cameraId === 'camera002') {
                        inMemoryRAMStore['home'] = imageBuffer;
                        const homePath = path.join(DIR_UPLOADS, 'realtime_home.jpg');
                        fs.writeFileSync(homePath, imageBuffer);
                    }
                }

                fs.copyFileSync(realtimeOutputPath, archiveOutputPath);
            } catch (e) {}

            console.log(`[RTSP Stream] ดึงภาพจากกล้อง [${cameraId}] สำเร็จและอัปเดต RAM/Local แล้ว 🟢⚡`);
        })
        .on('error', (err) => {
            console.log(`[RTSP Warning] กล้อง [${cameraId}] กำลังเชื่อมต่อหรือสัญญาณสะดุด: ${err.message}`);
        })
        .run();
}

// ⏰ ตั้งเวลาดึงภาพจากกล้องทุกๆ 3 วินาที (ข้าม camera001 ที่เป็นกล้องหน้าคอม)
setInterval(() => {
    for (const [cameraId, cam] of Object.entries(camerasConfig)) {
        if (cameraId === 'camera001' || cam.ip === '127.0.0.1') {
            continue; 
        }        
        if (cam && cam.ip && cam.ip !== 'DHCP/Unknown') {
            const ip = cam.ip;
            const channel = cam.channel || '102'; 
            const rtspUrl = `rtsp://admin_inglobe:Inglobe2026@${ip}:554/Streaming/Channels/${channel}`;
            
            captureRtspSnapshot(cameraId, rtspUrl);
        }
    }
}, 3000);

// เริ่มรันเซิร์ฟเวอร์หลังจากโหลดค่ากล้องเสร็จ
initCamerasConfig().then(() => {
    app.listen(PORT, () => {
        console.log(`[Project-J Guardian Server] Running on http://localhost:${PORT}`);
        console.log(`[Multi-Camera System (Local-First + RAM Buffering)] Ready 🟢📹⚡`);
        console.log(`[Initial System Mode]: ${currentSystemMode} (Safe for factory testing)`);
    });
});
