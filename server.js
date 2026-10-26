// server_on_demand_guardian_with_voice.js - Project-J Smart Guardian Server (Multi-Camera Support)
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

// โหลดหรือสร้างค่าตั้งค่ากล้องเริ่มต้น (Default Cameras)
let camerasConfig = {};
if (fs.existsSync(CAMERAS_CONFIG_PATH)) {
    try {
        camerasConfig = JSON.parse(fs.readFileSync(CAMERAS_CONFIG_PATH, 'utf8'));
    } catch (e) {
        camerasConfig = {};
    }
} else {
    // กำหนดกล้องเริ่มต้นตามที่เพื่อนเอกต้องการ
    camerasConfig = {
        "camera001": { name: "กล้องหน้าคอม", ip: "127.0.0.1", active: true },
        "camera002": { name: "กล้องหน้าบ้าน", ip: "192.168.188.140", active: true }
    };
    fs.writeFileSync(CAMERAS_CONFIG_PATH, JSON.stringify(camerasConfig, null, 2));
}

// สร้างโฟลเดอร์ย่อยสำหรับเก็บภาพของแต่ละกล้องอัตโนมัติ
Object.keys(camerasConfig).forEach(camId => {
    const camDir = path.join(DIR_CAMERAS, camId);
    if (!fs.existsSync(camDir)) {
        fs.mkdirSync(camDir, { recursive: true });
    }
});

const lastFrames = {};
const lastTelegramAlertTime = {};
const TELEGRAM_ALERT_COOLDOWN = 5 * 60 * 1000; // 5 นาที

let cameraRequestState = { requested: false };
let pendingAudioVerifications = {};

app.use(cors());
app.use(express.json({ limit: '15mb' })); 
app.use(express.static(__dirname));

const FAMILY_WHITELIST = ["เพื่อนเอก", "คุณแม่", "Ake", "Mother"];
const VISITOR_WHITELIST = ["คุณน้า", "ช่างไฟ", "เพื่อนบ้าน", "Guest"];

// 📷 API จัดการกล้อง: ดึงรายชื่อกล้องทั้งหมด
app.get('/api/cameras/list', (req, res) => {
    return res.json({ success: true, cameras: camerasConfig });
});

// 📷 API จัดการกล้อง: เพิ่มหรือแก้ไขข้อมูลกล้องตัวใหม่ (เช่น camera003, camera004...)
app.post('/api/cameras/save', (req, res) => {
    try {
        const { cameraId, name, ip } = req.body;
        if (!cameraId || !name) {
            return res.status(400).json({ success: false, message: 'Camera ID and Name are required' });
        }

        camerasConfig[cameraId] = {
            name: name,
            ip: ip || 'DHCP/Unknown',
            active: true,
            updatedAt: new Date().toISOString()
        };

        fs.writeFileSync(CAMERAS_CONFIG_PATH, JSON.stringify(camerasConfig, null, 2));

        // สร้างโฟลเดอร์รองรับภาพของกล้องใหม่ทันที
        const camDir = path.join(DIR_CAMERAS, cameraId);
        if (!fs.existsSync(camDir)) {
            fs.mkdirSync(camDir, { recursive: true });
        }

        console.log(`[Multi-Camera] บันทึก/อัปเดตกล้องสำเร็จ -> [${cameraId}] ${name} (${ip})`);
        return res.json({ success: true, message: `บันทึกกล้อง ${cameraId} (${name}) เรียบร้อยครับ`, cameras: camerasConfig });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// 📷 API จัดการกล้อง: ลบกล้องออกจากระบบ
app.delete('/api/cameras/delete/:cameraId', (req, res) => {
    try {
        const { cameraId } = req.params;
        if (!camerasConfig[cameraId]) {
            return res.status(404).json({ success: false, message: 'ไม่พบกล้องนี้ในระบบ' });
        }

        const deletedName = camerasConfig[cameraId].name;
        delete camerasConfig[cameraId];

        // บันทึกการเปลี่ยนแปลงลงไฟล์ config
        fs.writeFileSync(CAMERAS_CONFIG_PATH, JSON.stringify(camerasConfig, null, 2));

        console.log(`[Multi-Camera] ลบกล้องสำเร็จ -> [${cameraId}] ${deletedName}`);
        return res.json({ success: true, message: `ลบกล้อง ${deletedName} เรียบร้อยแล้วครับ`, cameras: camerasConfig });
    } catch (err) {
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

// 📸 API 4: รองรับการรับภาพสดแยกตามรหัสกล้อง (เช่น /api/camera/upload/camera001)
app.post('/api/camera/upload/:cameraId', (req, res) => {
    try {
        const { cameraId } = req.params;
        const { imageBase64 } = req.body;

        if (!imageBase64) {
            return res.status(400).json({ success: false, message: 'Missing imageBase64' });
        }

        const camMeta = camerasConfig[cameraId] || { name: cameraId };
        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
        
        // บันทึกภาพล่าสุดของกล้องนั้นๆ
        const latestCamPath = path.join(DIR_UPLOADS, `realtime_${cameraId}.jpg`);
        fs.writeFileSync(latestCamPath, base64Data, 'base64');

        // ถ้ารู้จักว่าเป็นกล้องหลักตัวแรก ให้อัปเดตเป็น realtime_home.jpg เผื่อหน้าเว็บเดิมเรียกใช้
        if (cameraId === 'camera001' || cameraId === 'camera002') {
            fs.writeFileSync(path.join(DIR_UPLOADS, 'realtime_home.jpg'), base64Data, 'base64');
        }

        console.log(`[${new Date().toLocaleTimeString('th-TH')}] 📸 อัปเดตภาพสดจาก [${cameraId}: ${camMeta.name}] สำเร็จ`);
        return res.json({ success: true, url: `/uploads/realtime_${cameraId}.jpg`, timestamp: Date.now() });
    } catch (err) {
        console.error('Save camera image error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// 📸 API ดึงภาพล่าสุดของกล้องแต่ละตัวไปแสดงผล
app.get('/api/camera/latest/:cameraId', (req, res) => {
    const { cameraId } = req.params;
    const filePath = path.join(DIR_UPLOADS, `realtime_${cameraId}.jpg`);
    if (fs.existsSync(filePath)) {
        const imageBuffer = fs.readFileSync(filePath);
        return res.json({ success: true, imageBase64: imageBuffer.toString('base64') });
    } else {
        return res.status(404).json({ success: false, message: `ยังไม่มีภาพสดจาก ${cameraId}` });
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

// 📸 API หลักสำหรับรับ Snapshot และแยกแยะตามกล้อง (cameraId)
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

        if (hasImportantMotion || recognizedName) {
            const cloudUrl = await uploadToCloudStorage(buffer, snapshotFilename, cameraId);
            const alertImageSource = cloudUrl || snapshotFilePath;

            const nowTime = Date.now();
            if (!lastTelegramAlertTime[cameraId]) lastTelegramAlertTime[cameraId] = 0;

            if (personCategory === 'stranger') {
                const sessionId = `verify_${cameraId}_${timestamp}`;
                pendingAudioVerifications[sessionId] = { imagePath: alertImageSource, cameraId, status: 'waiting' };

                setTimeout(async () => {
                    if (pendingAudioVerifications[sessionId]) {
                        delete pendingAudioVerifications[sessionId];
                        if (nowTime - lastTelegramAlertTime[cameraId] > TELEGRAM_ALERT_COOLDOWN) {
                            lastTelegramAlertTime[cameraId] = nowTime;
                            await sendTelegramAlertWithPhoto(
                                alertImageSource, 
                                `🚨 *แจ้งเตือนด่วน! พบผู้บุกรุก*\nกล้อง: *[${cameraId}] ${camMeta.name}* (IP: ${camMeta.ip}) ❌`
                            );
                        }
                    }
                }, 12000);
            } else {
                if (nowTime - lastTelegramAlertTime[cameraId] > TELEGRAM_ALERT_COOLDOWN) {
                    lastTelegramAlertTime[cameraId] = nowTime;
                    let alertCaption = personCategory === 'family' 
                        ? `🏠 *แจ้งเตือนครอบครัว Project-J*\nกล้อง: *[${cameraId}] ${camMeta.name}*\nพบบุคคล: *คุณ ${recognizedName}* 🟢`
                        : `🎴 *แจ้งเตือนแขก / คนรู้จัก*\nกล้อง: *[${cameraId}] ${camMeta.name}*\nพบคุณ *${recognizedName}* 🔵`;
                    await sendTelegramAlertWithPhoto(alertImageSource, alertCaption);
                }
            }
        }

        return res.status(200).json({
            success: true,
            filename: snapshotFilename,
            camera: camMeta.name,
            filteredAsMotion: hasImportantMotion,
            category: personCategory
        });

    } catch (error) {
        console.error('Snapshot upload error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`[Project-J Guardian Server] Running on http://localhost:${PORT}`);
    console.log(`[Multi-Camera System] Ready to support camera001, camera002, and beyond 🟢📹`);
});
