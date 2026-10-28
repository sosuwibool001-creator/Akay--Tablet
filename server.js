const ffmpeg = require('fluent-ffmpeg');

// 🔄 ฟังก์ชันดึงภาพ Snapshot จากกล้อง RTSP อัตโนมัติทุกๆ 5 วินาที
function captureRtspSnapshot(cameraId, rtspUrl) {
    const outputFilePath = path.join(DIR_UPLOADS, `realtime_${cameraId}.jpg`);
    
    ffmpeg(rtspUrl)
        .inputOptions([
            '-rtsp_transport tcp', // บังคับใช้ TCP เพื่อความเสถียรไม่ให้ภาพลาย
            '-stimeout 3000000'    // ตั้งเวลา Timeout 3 วินาทีกันค้าง
        ])
        .outputOptions([
            '-vframes 1',          // ดึงมาแค่ 1 เฟรม (ภาพนิ่ง)
            '-q:v 2'               // คุณภาพความคมชัด
        ])
        .output(outputFilePath)
        .on('end', () => {
            // สำเนาไปไว้เป็นภาพรวมหน้าบ้านด้วย
            if (cameraId === 'camera002') {
                const homePath = path.join(DIR_UPLOADS, 'realtime_home.jpg');
                if (fs.existsSync(outputFilePath)) {
                    fs.copyFileSync(outputFilePath, homePath);
                }
            }
            console.log(`[RTSP Stream] ดึงภาพจากกล้อง [${cameraId}] สำเร็จ 🟢`);
        })
        .on('error', (err) => {
            // ซ่อน Log Error ถ่ายภาพถี่เกินไปเพื่อไม่ให้หน้าจอรก
            console.log(`[RTSP Warning] กล้อง [${cameraId}] กำลังเชื่อมต่อหรือสัญญาณสะดุด: ${err.message}`);
        })
        .run();
}

// ตั้งเวลาให้ดึงภาพจากกล้องหน้าบ้าน (camera002) ทุกๆ 5 วินาที
setInterval(() => {
    if (camerasConfig['camera002'] && camerasConfig['camera002'].ip) {
        const rtspUrl = `rtsp://${camerasConfig['camera002'].ip}:554/onvif1`;
        captureRtspSnapshot('camera002', rtspUrl);
    }
}, 5000);
