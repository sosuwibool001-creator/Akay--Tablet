// server.js - Project-J Smart Guardian Server (Full Multi-Camera + Security Mode & RAM Buffering & Burst Capture + Greeting Templates + go2rtc Auto-Sync)
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
const GREETINGS_CONFIG_PATH = path.join(__dirname, 'greetings_config.json');
const GO2RTC_CONFIG_PATH = path.join(__dirname, 'go2rtc.yaml'); // 📹 เส้นทางไฟล์ตั้งค่า go2rtc

[
    DIR_CAMERAS, DIR_UPLOADS, DIR_VOICE_PROFILES
].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// 🧠 ระบบจัดการสถานะของบ้าน (State Machine) - เริ่มต้นที่ CARE Mode
let currentSystemMode = 'CARE'; // ค่าที่เป็นไปได้: 'CARE' หรือ 'SECURITY'

// โหลดค่าตั้งค่ากล้องจากไฟล์ Local JSON โดยตรง
let camerasConfig = {};
let greetingsConfig = {};

// 📹 ฟังก์ชันพิเศษ: อัปเดตไฟล์ go2rtc.yaml อัตโนมัติทุกครั้งที่มีการเปลี่ยนแปลงกล้อง
function updateGo2RtcYaml(camerasObj) {
    try {
        let streamsConfig = "streams:\n";
        let count = 0;

        for (const [camId, cam] of Object.entries(camerasObj)) {
            if (cam.ip && cam.ip !== '127.0.0.1' && cam.ip !== 'DHCP/Unknown') {
                const channel = cam.channel || '102';
                streamsConfig += `  ${camId}: rtsp://admin_inglobe:Inglobe2026@${cam.ip}:554/Streaming/Channels/${channel}\n`;
                count++;
            }
        }

        fs.writeFileSync(GO2RTC_CONFIG_PATH, streamsConfig, 'utf8');
        console.log(`[go2rtc Auto-Sync] ซิงค์สตรีมกล้อง ${count} ตัวลงใน go2rtc.yaml สำเร็จ 🟢`);
    } catch (err) {
        console.error('[go2rtc Auto-Sync Error]:', err.message);
    }
}

async function initSystemConfigs() {
    // 1. โหลดค่ากล้อง
    if (fs.existsSync(CAMERAS_CONFIG_PATH)) {
        try {
            camerasConfig = JSON.parse(fs.readFileSync(CAMERAS_CONFIG_PATH, 'utf8'));
            console.log('[Local DB] โหลดรายชื่อกล้องจาก cameras_config.json สำเร็จ 🟢');
        } catch (e) {
            camerasConfig = {};
        }
    } else {
        camerasConfig = {
            "camera001": { name: "กล้องหน้าคอม", ip: "127.0.0.1", channel: "", careMode: true, securityMode: true, active: true },
            "camera002": { name: "กล้องหน้าบ้าน", ip: "192.168.1.170", channel: "602", careMode: true, securityMode: true, active: true }
        };
        fs.writeFileSync(CAMERAS_CONFIG_PATH, JSON.stringify(camerasConfig, null, 2));
        console.log('[Local DB] สร้างไฟล์ cameras_config.json เริ่มต้นสำเร็จ 🟢');
    }

    // ซิงค์สตรีมไปที่ go2rtc.yaml ทันทีตอนสตาร์ตระบบ
    updateGo2RtcYaml(camerasConfig);

    // 2. โหลดหรือสร้างเทมเพลตคำทักทายหน้าบ้าน (0 Token Local Templates)
    if (fs.existsSync(GREETINGS_CONFIG_PATH)) {
        try {
            greetingsConfig = JSON.parse(fs.readFileSync(GREETINGS_CONFIG_PATH, 'utf8'));
            console.log('[Local DB] โหลดเทมเพลตคำทักทายสำเร็จ 🟢');
        } catch (e) {
            greetingsConfig = {};
        }
    } else {
        greetingsConfig = {
            "care_mode_greeting": "สวัสดีครับ ไม่ทราบว่ามาติดต่อใคร หรือมีธุระอะไรหรือเปล่าครับ บอกเจได้เลยนะครับ",
            "security_mode_warning": "แจ้งเตือน: ขณะนี้บ้านอยู่ในโหมดรักษาความปลอดภัย กรุณาแสดงตัวตนหรือถอยออกไปครับ",
            "delivery_indoor_announcement": "เรียนคนในบ้านครับ ตอนนี้มีผู้มาติดต่อหรือมีพัสดุมาส่งที่หน้าบ้านครับ รบกวนออกมาพบผู้มาติดต่อด้วยครับ"
        };
        fs.writeFileSync(GREETINGS_CONFIG_PATH, JSON.stringify(greetingsConfig, null, 2));
        console.log('[Local DB] สร้างไฟล์ greetings_config.json เริ่มต้นสำเร็จ 🟢');
    }
}

// สร้างโฟลเดอร์ย่อยสำหรับเก็บภาพของแต่ละกล้องอัตโนมัติ
Object.keys(camerasConfig).forEach(camId => {
    const camDir = path.join(DIR_CAMERAS, camId);
    const securityEventDir = path.join(camDir, 'security_events');
    if (!fs.existsSync(camDir)) fs.mkdirSync(camDir, { recursive: true });
    if (!fs.existsSync(securityEventDir)) fs.mkdirSync(securityEventDir, { recursive: true });
});

const lastFrames = {};
const inMemoryRAMStore = {};
const rollingBuffers = {};
const lastTelegramAlertTime = {};
const TELEGRAM_ALERT_COOLDOWN = 5 * 60 * 1000;

let cameraRequestState = { requested: false };
let pendingAudioVerifications = {};

app.use(cors());
app.use(express.json({ limit: '15mb' })); 
app.use(express.static(__dirname));

const FAMILY_WHITELIST = ["เพื่อนเอก", "คุณแม่", "Ake", "Mother"];
const VISITOR_WHITELIST = ["คุณน้า", "ช่างไฟ", "เพื่อนบ้าน", "Guest"];

// 🎙️📷 API ตรวจสอบอุปกรณ์
app.get('/api/media/permissions-check', (req, res) => {
    return res.json({
        success: true,
        message: "ระบบพร้อมรองรับการเปิดใช้งานไมโครโฟนและกล้องสองทาง 🎙️📷",
        supportedCodecs: ["audio/pcm", "audio/wav", "image/jpeg"],
        sampleRate: 24000
    });
});

// 🎛️ API ควบคุมและตรวจสอบสถานะโหมดระบบ
app.get('/api/system/mode', (req, res) => {
    return res.json({ success: true, mode: currentSystemMode });
});

app.post('/api/system/set-mode', (req, res) => {
    const { mode } = req.body;
    if (mode === "SECURITY" || mode === "CARE") {
        currentSystemMode = mode;
        console.log(`🛡️ ระบบเปลี่ยนโหมดเป็น: ${currentSystemMode}`);
        res.json({ success: true, mode: currentSystemMode });
    } else {
        res.status(400).json({ success: false, message: "Invalid mode" });
    }
});

// 📷 API จัดการกล้อง: ดึงรายการกล้อง
app.get('/api/cameras/list', async (req, res) => {
    return res.json({ success: true, cameras: camerasConfig });
});

// 📷 API จัดการกล้อง: เพิ่ม/แก้ไขข้อมูลกล้อง (พร้อมบันทึกโหมด Care/Security และ Auto-Sync go2rtc)
app.post('/api/cameras/save', async (req, res) => {
    try {
        const { cameraId, name, ip, channel, careMode, securityMode } = req.body;
        if (!cameraId || !name) {
            return res.status(400).json({ success: false, message: 'Camera ID and Name are required' });
        }

        const updatedAt = new Date().toISOString();
        camerasConfig[cameraId] = {
            name: name,
            ip: ip || 'DHCP/Unknown',
            channel: channel || '',
            careMode: careMode !== undefined ? careMode : true,
            securityMode: securityMode !== undefined ? securityMode : true,
            active: true,
            updatedAt: updatedAt
        };

        fs.writeFileSync(CAMERAS_CONFIG_PATH, JSON.stringify(camerasConfig, null, 2));

        // 🟢 อัปเดตสตรีมลง go2rtc.yaml อัตโนมัติ
        updateGo2RtcYaml(camerasConfig);

        const camDir = path.join(DIR_CAMERAS, cameraId);
        const secDir = path.join(camDir, 'security_events');
        if (!fs.existsSync(camDir)) fs.mkdirSync(camDir, { recursive: true });
        if (!fs.existsSync(secDir)) fs.mkdirSync(secDir, { recursive: true });

        console.log(`[Multi-Camera] บันทึก/อัปเดตกล้องสำเร็จ -> [${cameraId}] ${name} (${ip}) Channel: ${channel || 'N/A'}`);
        return res.json({ success: true, message: `บันทึกกล้อง ${cameraId} (${name}) เรียบร้อยครับ`, cameras: camerasConfig });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// 📷 API จัดการกล้อง: ลบกล้องออกจากระบบ (พร้อม Auto-Sync go2rtc)
app.delete('/api/cameras/delete/:cameraId', async (req, res) => {
    try {
        const { cameraId } = req.params;
        if (!camerasConfig[cameraId]) {
            return res.status(404).json({ success: false, message: 'ไม่พบกล้องนี้ในระบบ' });
        }

        const deletedName = camerasConfig[cameraId].name;
        delete camerasConfig[cameraId];

        fs.writeFileSync(CAMERAS_CONFIG_PATH, JSON.stringify(camerasConfig, null, 2));

        // 🟢 อัปเดตสตรีมลง go2rtc.yaml อัตโนมัติหลังลบ
        updateGo2RtcYaml(camerasConfig);

        console.log(`[Multi-Camera] ลบกล้องสำเร็จ -> [${cameraId}] ${deletedName}`);
        return res.json({ success: true, message: `ลบกล้อง ${deletedName} เรียบร้อยแล้วครับ`, cameras: camerasConfig });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// 🗣️ API คำสั่งเสียงสลับกล้อง / เปลี่ยนโหมด
app.post('/api/camera/voice-command', async (req, res) => {
    try {
        const { commandText } = req.body;
        if (!commandText) {
            return res.status(400).json({ success: false, message: 'ไม่พบคำสั่งเสียง' });
        }

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

// 🔍 API เช็กเจ้าของเครื่อง
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
        const { ownerName } = req.body;
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

// 🖥️ เส้นทางหน้าจอหลัก
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/cameras', (req, res) => {
    res.sendFile(path.join(__dirname, 'cameras-manager.html'));
});

app.get('/tablet', (req, res) => {
    res.sendFile(path.join(__dirname, 'index-tablet.html'));
});

// 📸 API อัปโหลดภาพสดลง RAM Buffer
app.post('/api/camera/upload/:cameraId', (req, res) => {
    try {
        const { cameraId } = req.params;
        const { imageBase64 } = req.body;

        if (!imageBase64) {
            return res.status(400).json({ success: false, message: 'Missing imageBase64' });
        }

        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
        const imageBuffer = Buffer.from(base64Data, 'base64');
        
        inMemoryRAMStore[cameraId] = imageBuffer;
        if (cameraId === 'camera001' || cameraId === 'camera002') {
            inMemoryRAMStore['home'] = imageBuffer;
        }

        const latestCamPath = path.join(DIR_UPLOADS, `realtime_${cameraId}.jpg`);
        fs.writeFileSync(latestCamPath, imageBuffer);

        if (cameraId === 'camera001' || cameraId === 'camera002') {
            fs.writeFileSync(path.join(DIR_UPLOADS, 'realtime_home.jpg'), imageBuffer);
        }

        return res.json({ success: true, url: `/uploads/realtime_${cameraId}.jpg`, timestamp: Date.now() });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// 📸 API ดึงภาพสดล่าสุด
app.get('/api/camera/latest/:cameraId', (req, res) => {
    try {
        const { cameraId } = req.params;
        
        if (inMemoryRAMStore[cameraId]) {
            return res.json({ 
                success: true, 
                imageBase64: inMemoryRAMStore[cameraId].toString('base64'),
                source: 'ram-buffer' 
            });
        }

        const filePath = path.join(DIR_UPLOADS, `realtime_${cameraId}.jpg`);
        if (fs.existsSync(filePath)) {
            const imageBuffer = fs.readFileSync(filePath);
            inMemoryRAMStore[cameraId] = imageBuffer;
            return res.json({ success: true, imageBase64: imageBuffer.toString('base64'), source: 'disk-fallback' });
        } else {
            return res.status(404).json({ success: false, message: `ยังไม่มีภาพสดจาก ${cameraId}` });
        }
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// 📡 API ส่งสัญญาณ On-Demand
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

// 🎙️ API บันทึกเสียงตัวอย่าง
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

// 🚨 ฟังก์ชันพิเศษ: บันทึกภาพชุด Burst Capture 5 ช็อต
async function triggerSecurityBurstCapture(cameraId, camMeta, initialBuffer) {
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
    const eventFolder = path.join(DIR_CAMERAS, cameraId, 'security_events');
    
    if (!fs.existsSync(eventFolder)) {
        fs.mkdirSync(eventFolder, { recursive: true });
    }

    console.log(`[Security Burst] 🚨 ตรวจพบการบุกรุกที่ [${camMeta.name}]! เริ่มบันทึกภาพชุดหลักฐาน 5 ช็อต...`);

    for (let i = 1; i <= 5; i++) {
        const timeStr = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Bangkok' }).replace(/:/g, '-');
        const filename = `sec_${cameraId}_${dateStr}_${timeStr}_shot${i}.jpg`;
        const savePath = path.join(eventFolder, filename);

        const frameToSave = (i === 1 && initialBuffer) ? initialBuffer : (inMemoryRAMStore[cameraId] || initialBuffer);
        if (frameToSave) {
            fs.writeFileSync(savePath, frameToSave);
        }

        if (i < 5) {
            await new Promise(resolve => setTimeout(resolve, 600));
        }
    }
    console.log(`[Security Burst] ✅ บันทึกชุดภาพหลักฐาน 5 ช็อตลงโฟลเดอร์สำเร็จ`);
}

// 📸 API รับ Snapshot คัดกรองตาม CARE Mode และ SECURITY Mode (รองรับ Template คำทักทาย 0 Token)
app.post('/api/snapshot/upload/:cameraId', async (req, res) => {
    try {
        const { cameraId } = req.params;
        const { imageBase64, recognizedName, isFamily, visitorResponse } = req.body;
        
        if (!imageBase64) {
            return res.status(400).json({ success: false, message: 'No image data provided' });
        }

        const camMeta = camerasConfig[cameraId] || { name: cameraId, careMode: true, securityMode: true };
        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');

        inMemoryRAMStore[cameraId] = buffer;

        // 🟢 [CARE Mode Logic]
        if (currentSystemMode === 'CARE') {
            if (cameraId === 'camera002' && camMeta.careMode !== false) {
                if (visitorResponse) {
                    console.log(`[CARE Mode] ผู้มาติดต่อตอบกลับมาว่า: "${visitorResponse}"`);
                    let indoorMsg = greetingsConfig.delivery_indoor_announcement || "เรียนคนในบ้านครับ มีผู้มาติดต่อหรือมีพัสดุมาส่งที่หน้าบ้านครับ";
                    
                    return res.status(200).json({
                        success: true,
                        mode: 'CARE',
                        action: 'announce_indoor',
                        announcementText: indoorMsg,
                        message: 'ส่งเสียงประกาศเตือนคนในบ้านเรียบร้อยครับ'
                    });
                }

                return res.status(200).json({ 
                    success: true, 
                    mode: 'CARE', 
                    action: 'greet_visitor',
                    greetingText: greetingsConfig.care_mode_greeting || "สวัสดีครับ ไม่ทราบว่ามาติดต่อใคร หรือมีธุระอะไรหรือเปล่าครับ บอกเจได้เลยนะครับ",
                    message: 'ส่งประโยคทักทาย CARE Mode สำเร็จ (0 Token)' 
                });
            }

            return res.status(200).json({ 
                success: true, 
                mode: 'CARE', 
                message: 'ระบบอยู่ในโหมดดูแล (CARE Mode) กล้องจุดอื่นปกติ' 
            });
        }

        // 🛡️ [SECURITY Mode Logic]
        const TARGET_SECURITY_CAMERA = 'camera002';
        if (cameraId !== TARGET_SECURITY_CAMERA || camMeta.securityMode === false) {
            return res.status(200).json({ success: true, message: `กล้องนอกขอบเขต Security` });
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

        // 🧠 จัดการ RAM Rolling Buffer (เก็บ 3 เฟรมล่าสุดเพื่อเทียบ Pixel Diff)
        if (!rollingBuffers[cameraId]) rollingBuffers[cameraId] = [];
        rollingBuffers[cameraId].push(buffer);
        if (rollingBuffers[cameraId].length > 3) {
            rollingBuffers[cameraId].shift();
        }

        let hasImportantMotion = false;
        const currentBuffer = rollingBuffers[cameraId][rollingBuffers[cameraId].length - 1];
        const previousBuffer = rollingBuffers[cameraId].length >= 2 ? rollingBuffers[cameraId][rollingBuffers[cameraId].length - 2] : null;

        if (previousBuffer) {
            let diffCount = 0;
            const sampleStep = 50;
            const checkLength = Math.min(currentBuffer.length, previousBuffer.length);
            let totalSamples = 0;

            for (let i = 0; i < checkLength; i += sampleStep) {
                totalSamples++;
                if (Math.abs(currentBuffer[i] - previousBuffer[i]) > 35) diffCount++;
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

        if (personCategory === 'family') {
            return res.status(200).json({ success: true, filtered: 'family-whitelist-passed', category: 'family' });
        }

        if (hasImportantMotion || recognizedName) {
            await triggerSecurityBurstCapture(cameraId, camMeta, currentBuffer);

            const cloudUrl = await uploadToCloudStorage(buffer, snapshotFilename, cameraId);
            const alertImageSource = cloudUrl || snapshotFilePath;

            const nowTime = Date.now();
            if (!lastTelegramAlertTime[cameraId]) lastTelegramAlertTime[cameraId] = 0;

            if (personCategory === 'stranger') {
                const sessionId = `verify_${cameraId}_${timestamp}`;
                pendingAudioVerifications[sessionId] = { imagePath: alertImageSource, cameraId, status: 'waiting' };

                console.log(`[Security Action] 🔔 ตรวจพบคนแปลกหน้าหน้ากล้อง [${camMeta.name}] เริ่มนับถอยหลัง 15 วินาที...`);

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
                }, 15000);
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

// 🔄 ฟังก์ชันดึงภาพ Snapshot จากกล้อง RTSP อัตโนมัติ
function captureRtspSnapshot(cameraId, rtspUrl) {
    const realtimeOutputPath = path.join(DIR_UPLOADS, `realtime_${cameraId}.jpg`);
    
    const camDir = path.join(DIR_CAMERAS, cameraId);
    const secDir = path.join(camDir, 'security_events');
    if (!fs.existsSync(camDir)) fs.mkdirSync(camDir, { recursive: true });
    if (!fs.existsSync(secDir)) fs.mkdirSync(secDir, { recursive: true });
    
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
        })
        .on('error', (err) => {})
        .run();
}

// ⏰ ลูปตรวจสอบความถี่ดึงภาพ
let lastLoopTime = Date.now();
setInterval(() => {
    const intervalTime = currentSystemMode === 'SECURITY' ? 1000 : 3000;
    const now = Date.now();
    
    if (now - lastLoopTime >= intervalTime) {
        lastLoopTime = now;
        for (const [cameraId, cam] of Object.entries(camerasConfig)) {
            if (cameraId === 'camera001' || cam.ip === '127.0.0.1') continue;        
            if (cam && cam.ip && cam.ip !== 'DHCP/Unknown') {
                const ip = cam.ip;
                const channel = cam.channel || '102'; 
                const rtspUrl = `rtsp://admin_inglobe:Inglobe2026@${ip}:554/Streaming/Channels/${channel}`;
                
                captureRtspSnapshot(cameraId, rtspUrl);
            }
        }
    }
}, 500);

// เริ่มรันเซิร์ฟเวอร์
initSystemConfigs().then(() => {
    app.listen(PORT, () => {
        console.log(`[Project-J Guardian Server] Running on http://localhost:${PORT}`);
        console.log(`[Multi-Camera System (Local-First + RAM Buffering + Burst Capture + Templates + go2rtc Auto-Sync)] Ready 🟢📹⚡`);
        console.log(`[Initial System Mode]: ${currentSystemMode}`);
    });
});
