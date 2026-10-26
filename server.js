// server_on_demand_guardian_with_voice.js - Project-J Smart Guardian Server (On-Demand & Voice Registration)
const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const axios = require('axios');
const sharp = require('sharp');
const FormData = require('form-data');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// ตั้งค่าการเชื่อมต่อ Supabase Cloud Storage (ดึงค่าจาก Environment Variables บน Render)
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
let supabase = null;

if (SUPABASE_URL && SUPABASE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    console.log('[Cloud Storage] เชื่อมต่อกับ Supabase สำเร็จ 🟢');
} else {
    console.log('[Cloud Storage Warning] ไม่พบค่า SUPABASE_URL หรือ SUPABASE_KEY ระบบจะบันทึกแบบ Local ชั่วคราว');
}

// โฟลเดอร์สำรองบนเครื่อง (Local Fallback Directories)
const DIR_PC = path.join(__dirname, 'snapshots_pc');
const DIR_TABLET = path.join(__dirname, 'snapshots_tablet');
const DIR_MOTION_PC = path.join(__dirname, 'motion_events_pc');
const DIR_MOTION_TABLET = path.join(__dirname, 'motion_events_tablet');
const DIR_FAMILY_PC = path.join(__dirname, 'family_events_pc');
const DIR_FAMILY_TABLET = path.join(__dirname, 'family_events_tablet');
const DIR_VISITOR_PC = path.join(__dirname, 'visitor_events_pc');
const DIR_VISITOR_TABLET = path.join(__dirname, 'visitor_events_tablet');
const DIR_UPLOADS = path.join(__dirname, 'uploads');
const DIR_VOICE_PROFILES = path.join(__dirname, 'voice_profiles'); // โฟลเดอร์เก็บเสียงตัวอย่างรายบุคคล

const OWNER_CONFIG_PATH = path.join(__dirname, 'owner_config.json');

[
    DIR_PC, DIR_TABLET, 
    DIR_MOTION_PC, DIR_MOTION_TABLET, 
    DIR_FAMILY_PC, DIR_FAMILY_TABLET, 
    DIR_VISITOR_PC, DIR_VISITOR_TABLET,
    DIR_UPLOADS, DIR_VOICE_PROFILES
].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

const lastFrames = { pc: null, tablet: null };
const lastTelegramAlertTime = { pc: 0, tablet: 0 };
const TELEGRAM_ALERT_COOLDOWN = 5 * 60 * 1000; // 5 นาที

// ตัวแปรเก็บสถานะคำขอภาพด่วนจากแท็บเล็ต (On-Demand Signaling State)
let cameraRequestState = { requested: false };

let pendingAudioVerifications = {};

app.use(cors());
app.use(express.json({ limit: '15mb' })); // ขยายรองรับภาพและเสียง Base64 ขนาดใหญ่
app.use(express.static(__dirname));

const FAMILY_WHITELIST = ["เพื่อนเอก", "คุณแม่", "Ake", "Mother"];
const VISITOR_WHITELIST = ["คุณน้า", "ช่างไฟ", "เพื่อนบ้าน", "Guest"];

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

// 👤 API บันทึกเจ้าของเครื่องตัวจริงครั้งแรก (First-Time Owner Registration)
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

// 🖥️ แยกเส้นทางหน้าจอหลัก (PC / Desktop) และหน้าจอแท็บเล็ตชัดเจน
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/tablet', (req, res) => {
    res.sendFile(path.join(__dirname, 'index-tablet.html'));
});

// 📸 API 1: สำหรับรับภาพล่าสุดจากกล้อง PC และบันทึกทับเป็น realtime_home.jpg ทันที
app.post('/api/camera/upload-latest', (req, res) => {
    try {
        const { imageBase64 } = req.body;
        if (!imageBase64) {
            return res.status(400).json({ success: false, message: 'Missing imageBase64' });
        }

        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
        const filePath = path.join(DIR_UPLOADS, 'realtime_home.jpg');

        fs.writeFileSync(filePath, base64Data, 'base64');
        console.log(`[${new Date().toLocaleTimeString('th-TH')}] 📸 อัปเดตภาพสด [realtime_home.jpg] จากกล้อง PC บ้านเรียบร้อยแล้ว`);

        return res.json({ success: true, url: '/uploads/realtime_home.jpg', timestamp: Date.now() });
    } catch (err) {
        console.error('Save image error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// 📸 API 2: สำหรับให้แท็บเล็ตดึงภาพสดล่าสุด (realtime_home.jpg) จากกล้อง PC บ้านไปให้เจดู
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

// 📡 API 3: ระบบส่งสัญญาณ On-Demand (Signaling) ระหว่างแท็บเล็ตและคอมพิวเตอร์
app.get('/api/camera/check-request', (req, res) => {
    return res.json(cameraRequestState);
});

app.post('/api/camera/request-capture', (req, res) => {
    cameraRequestState.requested = true;
    console.log(`[${new Date().toLocaleTimeString('th-TH')}] 📥 แท็บเล็ตส่งสัญญาณขอภาพสดจากกล้อง PC แล้ว!`);
    return res.json({ success: true, message: 'Request sent to PC' });
});

app.post('/api/camera/clear-request', (req, res) => {
    cameraRequestState.requested = false;
    return res.json({ success: true });
});

// 🎙️ [NEW] API สำหรับบันทึกเสียงตัวอย่างรายบุคคล (Voice Profile Registration)
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
        const filePath = path.join(personDir, filename);

        fs.writeFileSync(filePath, audioBuffer);
        console.log(`🎙️ [Voice Registration]: บันทึกเสียงตัวอย่างของสมาชิก [${personName}] สำเร็จแล้ว`);

        if (!FAMILY_WHITELIST.includes(personName) && !VISITOR_WHITELIST.includes(personName)) {
            FAMILY_WHITELIST.push(personName);
        }

        return res.json({ success: true, message: `บันทึกเสียงของ ${personName} เรียบร้อยครับ` });
    } catch (err) {
        console.error('Voice register error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// 🎙️ [NEW] API ดึงรายชื่อโปรไฟล์เสียงทั้งหมดที่มีการบันทึกไว้
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

// เปิด Static Routes สำหรับเรียกดูไฟล์ผ่าน URL
app.use('/uploads', express.static(DIR_UPLOADS));
app.use('/snapshots_pc', express.static(DIR_PC));
app.use('/snapshots_tablet', express.static(DIR_TABLET));
app.use('/motion_events_pc', express.static(DIR_MOTION_PC));
app.use('/motion_events_tablet', express.static(DIR_MOTION_TABLET));
app.use('/family_events_pc', express.static(DIR_FAMILY_PC));
app.use('/family_events_tablet', express.static(DIR_FAMILY_TABLET));
app.use('/visitor_events_pc', express.static(DIR_VISITOR_PC));
app.use('/visitor_events_tablet', express.static(DIR_VISITOR_TABLET));
app.use('/voice_profiles', express.static(DIR_VOICE_PROFILES));

// ☁️ ฟังก์ชันอัปโหลดภาพขึ้น Supabase Cloud Storage
async function uploadToCloudStorage(buffer, filename, folderType) {
    if (!supabase) return null;
    try {
        const filePath = `${folderType}/${filename}`;
        const { error } = await supabase.storage
            .from('project-j-events')
            .upload(filePath, buffer, {
                contentType: 'image/jpeg',
                upsert: true
            });

        if (error) throw error;

        const { data: publicUrlData } = supabase.storage
            .from('project-j-events')
            .getPublicUrl(filePath);

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

app.post('/api/snapshot/upload', async (req, res) => {
    try {
        const { imageBase64, device, recognizedName, isFamily } = req.body;
        if (!imageBase64) {
            return res.status(400).json({ success: false, message: 'No image data provided' });
        }

        const isTablet = device === 'tablet';
        const deviceKey = isTablet ? 'tablet' : 'pc';

        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');

        // หากมาจาก PC ให้บันทึกทับเป็นภาพล่าสุดสำหรับให้แท็บเล็ตดึงไปใช้ได้ทันที
        if (!isTablet) {
            const latestPath = path.join(DIR_UPLOADS, 'realtime_home.jpg');
            fs.writeFileSync(latestPath, buffer);
        }

        const now = new Date();
        const dateStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
        const timeStr = now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Bangkok' }).replace(/:/g, '-');
        const timestamp = Date.now();

        const snapshotDir = isTablet ? DIR_TABLET : DIR_PC;
        const snapshotPrefix = isTablet ? 'tablet_' : 'pc_';
        const snapshotFilename = `${snapshotPrefix}${dateStr}_${timeStr}_${timestamp}.jpg`;
        const snapshotFilePath = path.join(snapshotDir, snapshotFilename);

        fs.writeFileSync(snapshotFilePath, buffer);

        const previousBuffer = lastFrames[deviceKey];
        lastFrames[deviceKey] = buffer;

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

        let eventFolderType = 'snapshots_24h';
        let personCategory = 'none'; 

        let isConfirmedFamily = isFamily;
        let isConfirmedVisitor = false;

        if (recognizedName) {
            if (FAMILY_WHITELIST.some(fam => recognizedName.includes(fam))) {
                isConfirmedFamily = true;
            } else if (VISITOR_WHITELIST.some(vis => recognizedName.includes(vis))) {
                isConfirmedVisitor = true;
            }
        }

        if (hasImportantMotion || recognizedName) {
            let targetEventDir;
            let eventPrefix;
            let bucketFolder = 'motion_events';

            if (isConfirmedFamily) {
                personCategory = 'family';
                targetEventDir = isTablet ? DIR_FAMILY_TABLET : DIR_FAMILY_PC;
                eventPrefix = isTablet ? 'family_tablet_' : 'family_pc_';
                eventFolderType = 'family_events';
                bucketFolder = 'family_events';
            } else if (isConfirmedVisitor) {
                personCategory = 'visitor';
                targetEventDir = isTablet ? DIR_VISITOR_TABLET : DIR_VISITOR_PC;
                eventPrefix = isTablet ? 'visitor_tablet_' : 'visitor_pc_';
                eventFolderType = 'visitor_events';
                bucketFolder = 'visitor_events';
            } else {
                personCategory = 'stranger';
                targetEventDir = isTablet ? DIR_MOTION_TABLET : DIR_MOTION_PC;
                eventPrefix = isTablet ? 'tablet_motion_' : 'pc_motion_';
                eventFolderType = 'motion_events';
                bucketFolder = 'motion_events';
            }

            const eventFilename = `${eventPrefix}${dateStr}_${timeStr}_${timestamp}.jpg`;
            const eventFilePath = path.join(targetEventDir, eventFilename);
            fs.writeFileSync(eventFilePath, buffer);

            const cloudUrl = await uploadToCloudStorage(buffer, eventFilename, bucketFolder);
            const alertImageSource = cloudUrl || eventFilePath;

            if (personCategory === 'stranger') {
                const sessionId = `verify_${deviceKey}_${timestamp}`;
                pendingAudioVerifications[sessionId] = {
                    imagePath: alertImageSource,
                    deviceKey: deviceKey,
                    status: 'waiting_for_voice'
                };

                setTimeout(async () => {
                    if (pendingAudioVerifications[sessionId] && pendingAudioVerifications[sessionId].status === 'waiting_for_voice') {
                        delete pendingAudioVerifications[sessionId];
                        const nowTime = Date.now();
                        if (nowTime - lastTelegramAlertTime[deviceKey] > TELEGRAM_ALERT_COOLDOWN) {
                            lastTelegramAlertTime[deviceKey] = nowTime;
                            await sendTelegramAlertWithPhoto(
                                alertImageSource, 
                                `🚨 *แจ้งเตือนด่วน! พบผู้บุกรุก (ไม่ตอบชื่อยืนยันตัวตน)*\nตรวจสอบพบที่อุปกรณ์: *${deviceKey.toUpperCase()}* ❌`
                            );
                        }
                    }
                }, 12000);
            } else {
                const nowTime = Date.now();
                if (nowTime - lastTelegramAlertTime[deviceKey] > TELEGRAM_ALERT_COOLDOWN) {
                    lastTelegramAlertTime[deviceKey] = nowTime;
                    let alertCaption = personCategory === 'family' 
                        ? `🏠 *แจ้งเตือนครอบครัว Project-J*\nพบบุคคลในครอบครัว: *คุณ ${recognizedName || 'สมาชิก'}* 🟢`
                        : `🎴 *แจ้งเตือนคนรู้จัก / แขก*\nพบคุณ *${recognizedName}* 🔵`;
                    await sendTelegramAlertWithPhoto(alertImageSource, alertCaption);
                }
            }
        }

        return res.status(200).json({
            success: true,
            filename: snapshotFilename,
            filteredAsMotion: hasImportantMotion,
            recognizedPerson: recognizedName || null,
            category: personCategory,
            folder: eventFolderType
        });

    } catch (error) {
        console.error('Server error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/verify/response', (req, res) => {
    const { sessionId, spokenName } = req.body;
    if (pendingAudioVerifications[sessionId]) {
        if (spokenName && spokenName.trim() !== "") {
            VISITOR_WHITELIST.push(spokenName.trim());
            pendingAudioVerifications[sessionId].status = 'verified';
            delete pendingAudioVerifications[sessionId];
            return res.json({ success: true, message: `บันทึกชื่อ ${spokenName} สำเร็จ` });
        }
    }
    return res.json({ success: false, message: "Session expired or invalid name" });
});

app.listen(PORT, () => {
    console.log(`[Project-J Guardian Server] Running on http://localhost:${PORT}`);
    console.log(`[Architecture] On-Demand Realtime & Voice Registration Active 🟢🎙️`);
});
