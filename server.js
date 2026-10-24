// server_stable_ondemand.js - Project-J Smart Guardian Server (Stable Snapshot & On-Demand)
const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const axios = require('axios');
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
const DIR_UPLOADS = path.join(__dirname, 'uploads'); // โฟลเดอร์เก็บภาพเฉพาะกิจสำหรับ On-Demand

const OWNER_CONFIG_PATH = path.join(__dirname, 'owner_config.json');

[
    DIR_PC, DIR_TABLET, 
    DIR_MOTION_PC, DIR_MOTION_TABLET, 
    DIR_FAMILY_PC, DIR_FAMILY_TABLET, 
    DIR_VISITOR_PC, DIR_VISITOR_TABLET,
    DIR_UPLOADS
].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

const lastFrames = { pc: null, tablet: null };
const lastTelegramAlertTime = { pc: 0, tablet: 0 };
const TELEGRAM_ALERT_COOLDOWN = 5 * 60 * 1000; // 5 นาที

let pendingAudioVerifications = {};

// ⚡ ตัวแปรจัดการธงคำขอภาพสด (Real-time On-Demand Request Flag)
let pendingCameraRequest = false;

app.use(cors());
app.use(express.json({ limit: '10mb' })); // ใช้ขนาด 10mb มาตรฐานเสถียรตาม server001
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

// ⚡ API สำหรับระบบ On-Demand (ขอภาพสดจากแท็บเล็ตไปหา PC)
app.post('/api/camera/request-live', (req, res) => {
    pendingCameraRequest = true;
    console.log('[Camera] แท็บเล็ตส่งคำขอภาพสด (Real-time) ไปยัง PC แล้ว ⚡');
    return res.json({ success: true, message: 'Requested live capture' });
});

app.get('/api/camera/check-request', (req, res) => {
    const requested = pendingCameraRequest;
    if (requested) {
        pendingCameraRequest = false; // รีเซ็ตธงทันทีเมื่อ PC รับทราบ
    }
    return res.json({ requested: requested });
});

app.post('/api/camera/clear', (req, res) => {
    try {
        const filePath = path.join(DIR_UPLOADS, 'latest_home.jpg');
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        lastFrames.pc = null;
        console.log('[Camera] เคลียร์ภาพล่าสุดออกจากระบบเรียบร้อยแล้ว 🧹');
        return res.json({ success: true });
    } catch (e) {
        return res.status(500).json({ success: false, message: e.message });
    }
});

// รับภาพสดเฉพาะกิจจาก PC มาเก็บไว้ที่ latest_home.jpg
app.post('/api/camera/upload-latest', (req, res) => {
    try {
        const { imageBase64 } = req.body;
        if (!imageBase64) {
            return res.status(400).json({ success: false, message: 'Missing imageBase64' });
        }

        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
        const filePath = path.join(DIR_UPLOADS, 'latest_home.jpg');

        fs.writeFileSync(filePath, base64Data, 'base64');
        console.log(`[${new Date().toLocaleTimeString('th-TH')}] 📸 บันทึกภาพสด (Real-time) ลง latest_home.jpg สำเร็จ`);

        return res.json({ success: true, url: '/uploads/latest_home.jpg', timestamp: Date.now() });
    } catch (err) {
        console.error('Save image error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ให้แท็บเล็ตดึงภาพจาก latest_home.jpg พร้อมเช็กอายุภาพ (25 วินาที)
app.get('/api/camera/latest-image', (req, res) => {
    const filePath = path.join(DIR_UPLOADS, 'latest_home.jpg');
    if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        const fileAgeMs = Date.now() - stats.mtimeMs;
        
        if (fileAgeMs > 25000) {
            try { fs.unlinkSync(filePath); } catch(e) {}
            return res.status(404).json({ success: false, message: 'กล้องฝั่งคอมปิดการทำงานหรือไม่ได้อัปเดตภาพ' });
        }

        const imageBuffer = fs.readFileSync(filePath);
        const base64Image = imageBuffer.toString('base64');
        return res.json({ success: true, imageBase64: base64Image });
    } else {
        return res.status(404).json({ success: false, message: 'ยังไม่มีภาพบันทึกในระบบ' });
    }
});

// เปิด Static Routes เผื่อเรียกดูไฟล์แบบ Local
app.use('/uploads', express.static(DIR_UPLOADS));
app.use('/snapshots_pc', express.static(DIR_PC));
app.use('/snapshots_tablet', express.static(DIR_TABLET));
app.use('/motion_events_pc', express.static(DIR_MOTION_PC));
app.use('/motion_events_tablet', express.static(DIR_MOTION_TABLET));
app.use('/family_events_pc', express.static(DIR_FAMILY_PC));
app.use('/family_events_tablet', express.static(DIR_FAMILY_TABLET));
app.use('/visitor_events_pc', express.static(DIR_VISITOR_PC));
app.use('/visitor_events_tablet', express.static(DIR_VISITOR_TABLET));

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

// 📦 API หลักสำหรับรับภาพสตรีมเบื้องหลังทุก 10 วิ ไปบันทึกเก็บสะสมลง Snapshot 24 ชม. อย่างเสถียร
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

        const now = new Date();
        const dateStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
        const timeStr = now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Bangkok' }).replace(/:/g, '-');
        const timestamp = Date.now();

        const snapshotDir = isTablet ? DIR_TABLET : DIR_PC;
        const snapshotPrefix = isTablet ? 'tablet_' : 'pc_';
        const snapshotFilename = `${snapshotPrefix}${dateStr}_${timeStr}_${timestamp}.jpg`;
        const snapshotFilePath = path.join(snapshotDir, snapshotFilename);

        // บันทึกลงฐานข้อมูล Snapshot 24 ชม. โดยตรง ไม่ไปกวนไฟล์ latest_home.jpg
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
    console.log(`[Architecture] Stable Snapshot DB & On-Demand Live Active 🟢📱💻`);
});
