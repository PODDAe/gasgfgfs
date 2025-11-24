import express from 'express';
import bodyParser from 'body-parser';
import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import pino from 'pino';
import qrcode from 'qrcode';
import { 
    makeWASocket, 
    useMultiFileAuthState, 
    delay,
    makeCacheableSignalKeyStore,
    DisconnectReason
} from '@whiskeysockets/baileys';

dotenv.config();

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 10000;

// Store active sessions
const activeSessions = new Map();

// Middleware
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '1mb' }));

// Session cleanup function
async function cleanupSession(sessionDir) {
    try {
        await fs.rm(sessionDir, { recursive: true, force: true });
        activeSessions.delete(sessionDir);
        console.log(`🧹 Cleaned up session: ${sessionDir}`);
    } catch (error) {
        console.log('Cleanup warning:', error.message);
    }
}

// QR Code pairing endpoint
app.get('/api/code/qr', async (req, res) => {
    console.log('📡 QR code endpoint hit');
    
    const sessionId = 'session_' + Date.now();
    const sessionDir = `./${sessionId}`;

    console.log('🔐 Starting QR pairing session');
    
    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        
        const socketConfig = {
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
            },
            printQRInTerminal: true,
            logger: pino({ level: "silent" }),
            browser: ["DTZ-NOVA-X-MD", "Chrome", "2.2.0"],
            markOnlineOnConnect: false,
            generateHighQualityLinkPreview: false,
        };

        const bot = makeWASocket(socketConfig);

        let qrGenerated = false;
        let isConnected = false;

        bot.ev.on('creds.update', saveCreds);

        // Handle incoming messages
        bot.ev.on('messages.upsert', async (m) => {
            const message = m.messages[0];
            if (message.key && message.key.fromMe) return;
            
            if (message.message) {
                console.log('📨 Received message:', message.message);
                
                // Auto-reply to messages
                const userJid = message.key.remoteJid;
                const messageText = message.message.conversation || 
                                  message.message.extendedTextMessage?.text || 
                                  'Message received';
                
                try {
                    await bot.sendMessage(userJid, { 
                        text: `🤖 *DTZ NOVA X MD*\n\nThank you for your message: "${messageText}"\n\nI am an automated WhatsApp bot.\n\n📢 Channel: https://chat.whatsapp.com/KJnHbIYysdrJhCLH8C1HFe\n👤 Owner: wa.me/94752978237` 
                    });
                    console.log('✅ Auto-reply sent');
                } catch (error) {
                    console.log('❌ Failed to send auto-reply:', error.message);
                }
            }
        });

        bot.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            console.log(`🔗 Connection state: ${connection}`);

            if (qr && !qrGenerated) {
                console.log('📱 QR Code received');
                qrGenerated = true;
                
                try {
                    // Generate QR code as data URL
                    const qrImage = await qrcode.toDataURL(qr);
                    
                    // Store session info
                    activeSessions.set(sessionId, {
                        bot,
                        sessionDir,
                        connected: false
                    });

                    console.log('✅ QR code generated and sent to client');
                    res.json({
                        success: true,
                        qrCode: qrImage,
                        sessionId: sessionId,
                        message: 'Scan this QR code with WhatsApp'
                    });

                } catch (qrError) {
                    console.error('QR generation error:', qrError);
                    if (!res.headersSent) {
                        res.status(500).json({ 
                            success: false,
                            error: 'Failed to generate QR code',
                            message: 'Please try again'
                        });
                    }
                }
            }

            if (connection === "open") {
                console.log('✅ WhatsApp connected successfully!');
                isConnected = true;
                
                const session = activeSessions.get(sessionId);
                if (session) {
                    session.connected = true;
                    
                    // Send welcome message to the bot's own number
                    try {
                        const botInfo = bot.user;
                        if (botInfo && botInfo.id) {
                            await bot.sendMessage(botInfo.id, { 
                                text: `✅ *DTZ NOVA X MD CONNECTED SUCCESSFULLY!*\n\n🤖 Your WhatsApp is now connected to DTZ NOVA X MD\n\n📢 Join our channel: https://chat.whatsapp.com/KJnHbIYysdrJhCLH8C1HFe\n\n👤 Contact owner: wa.me/94752978237\n\n💬 You can now send and receive messages!\n\n⚠️ *DO NOT SHARE YOUR SESSION DATA*` 
                            });
                            console.log('📨 Welcome message sent to bot');
                        }
                    } catch (msgError) {
                        console.log('Welcome message warning:', msgError.message);
                    }

                    // Keep session alive
                    setTimeout(async () => {
                        if (isConnected) {
                            console.log('🔄 Session kept alive for messaging');
                        }
                    }, 30000);
                }
            }

            if (connection === "close") {
                console.log('❌ Connection closed');
                isConnected = false;
                await cleanupSession(sessionDir);
            }
        });

        // Timeout if no QR code in 30 seconds
        setTimeout(() => {
            if (!qrGenerated && !res.headersSent) {
                console.log('⏰ QR generation timeout');
                res.status(408).json({ 
                    success: false,
                    error: 'QR code timeout',
                    message: 'Please try generating a new QR code'
                });
                cleanupSession(sessionDir);
            }
        }, 30000);

    } catch (error) {
        console.error('💥 QR Session error:', error);
        await cleanupSession(sessionDir);
        
        if (!res.headersSent) {
            res.status(500).json({ 
                success: false,
                error: 'Session failed',
                message: 'Please try again'
            });
        }
    }
});

// Phone number pairing endpoint
app.get('/api/code/phone', async (req, res) => {
    console.log('📡 Phone pairing endpoint hit');
    
    const { number } = req.query;
    
    if (!number) {
        return res.status(400).json({ 
            success: false,
            error: 'Phone number required',
            message: 'Please provide a phone number parameter'
        });
    }

    const cleanNumber = number.replace(/\D/g, '');
    const sessionDir = `./session_${cleanNumber}_${Date.now()}`;

    console.log(`📞 Attempting phone pairing for: ${cleanNumber}`);

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        
        const socketConfig = {
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
            },
            printQRInTerminal: false,
            logger: pino({ level: "fatal" }),
            browser: ["DTZ-NOVA-X-MD", "Chrome", "2.2.0"],
            connectTimeoutMs: 30000,
        };

        const bot = makeWASocket(socketConfig);

        let isConnected = false;

        bot.ev.on('creds.update', saveCreds);

        // Handle incoming messages for phone pairing
        bot.ev.on('messages.upsert', async (m) => {
            const message = m.messages[0];
            if (message.key && message.key.fromMe) return;
            
            if (message.message) {
                console.log('📨 Received message (Phone pairing):', message.message);
                
                const userJid = message.key.remoteJid;
                const messageText = message.message.conversation || 
                                  message.message.extendedTextMessage?.text || 
                                  'Message received';
                
                try {
                    await bot.sendMessage(userJid, { 
                        text: `🤖 *DTZ NOVA X MD - Phone Pairing*\n\nThank you for your message: "${messageText}"\n\nYour phone pairing was successful!\n\n📢 Channel: https://chat.whatsapp.com/KJnHbIYysdrJhCLH8C1HFe\n👤 Owner: wa.me/94752978237` 
                    });
                    console.log('✅ Auto-reply sent for phone pairing');
                } catch (error) {
                    console.log('❌ Failed to send auto-reply:', error.message);
                }
            }
        });

        bot.ev.on("connection.update", async (update) => {
            const { connection } = update;
            
            if (connection === "open") {
                console.log('✅ WhatsApp connected via phone pairing!');
                isConnected = true;
                
                // Send welcome message
                try {
                    const userJid = cleanNumber + '@s.whatsapp.net';
                    await bot.sendMessage(userJid, { 
                        text: `✅ *DTZ NOVA X MD - PHONE PAIRING SUCCESSFUL!*\n\n🤖 Your WhatsApp is now connected via phone pairing\n\n📢 Join our channel: https://chat.whatsapp.com/KJnHbIYysdrJhCLH8C1HFe\n\n👤 Contact owner: wa.me/94752978237\n\n💬 You can now send and receive messages!\n\n⚠️ *DO NOT SHARE YOUR SESSION DATA*` 
                    });
                    console.log('📨 Welcome message sent via phone pairing');
                } catch (msgError) {
                    console.log('Welcome message warning:', msgError.message);
                }
            }
        });

        if (!bot.authState.creds.registered) {
            await delay(3000);
            
            try {
                const pairingCode = await bot.requestPairingCode(cleanNumber);
                console.log(`✅ Pairing code generated: ${pairingCode}`);
                
                res.json({
                    success: true,
                    code: pairingCode,
                    message: 'Use this code in WhatsApp: Linked Devices → Link a Device',
                    number: cleanNumber
                });

                // Store session for messaging
                activeSessions.set(sessionDir, {
                    bot,
                    sessionDir,
                    connected: true
                });

                // Set cleanup timeout (longer for phone pairing)
                setTimeout(async () => {
                    if (isConnected) {
                        console.log('🔄 Phone pairing session active');
                    } else {
                        await cleanupSession(sessionDir);
                    }
                }, 60000);

            } catch (pairError) {
                console.error('❌ Pairing error:', pairError.message);
                await cleanupSession(sessionDir);
                
                res.json({
                    success: false,
                    error: 'Phone pairing failed',
                    message: 'Please use QR code method instead',
                    alternative: '/api/code/qr'
                });
            }
        } else {
            await cleanupSession(sessionDir);
            res.json({
                success: false,
                error: 'Already registered',
                message: 'This number appears to be already registered'
            });
        }

    } catch (error) {
        console.error('💥 Phone pairing failed:', error);
        await cleanupSession(sessionDir);
        
        res.json({
            success: false,
            error: 'Phone pairing not available',
            message: 'Please use QR code method',
            qrEndpoint: '/api/code/qr'
        });
    }
});

// Check connection status endpoint
app.get('/api/code/status/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    console.log(`📡 Status check for session: ${sessionId}`);
    
    const session = activeSessions.get(sessionId);
    
    if (!session) {
        return res.json({ 
            success: false,
            connected: false, 
            error: 'Session not found or expired' 
        });
    }
    
    res.json({ 
        success: true,
        connected: session.connected,
        message: session.connected ? 'WhatsApp connected successfully!' : 'Waiting for QR scan...'
    });
});

// Get all active sessions
app.get('/api/sessions', (req, res) => {
    const sessions = Array.from(activeSessions.entries()).map(([id, session]) => ({
        sessionId: id,
        connected: session.connected,
        directory: session.sessionDir
    }));
    
    res.json({
        success: true,
        activeSessions: sessions.length,
        sessions: sessions
    });
});

// Health check endpoints
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        service: 'DTZ NOVA X MD',
        version: '2.2.0',
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime()),
        activeSessions: activeSessions.size
    });
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Test endpoint
app.get('/api/test', (req, res) => {
    res.json({ 
        success: true,
        message: 'DTZ NOVA X MD API is working!',
        endpoints: [
            'GET /api/code/qr',
            'GET /api/code/phone?number=PHONE',
            'GET /api/code/status/:sessionId',
            'GET /api/sessions',
            'GET /api/health'
        ],
        activeSessions: activeSessions.size
    });
});

// Serve the complete HTML page
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>DTZ NOVA X MD - Complete WhatsApp Bot</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --primary: #05e6ff;
            --dark: #000000;
            --light: #05e6ff;
            --accent: #05e6ff;
            --success: #00ff88;
            --error: #ff4444;
            --warning: #ffaa00;
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            font-family: 'Poppins', sans-serif;
        }

        body {
            background: var(--dark);
            color: white;
            min-height: 100vh;
            overflow-x: hidden;
        }

        .bg-animation {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            z-index: -1;
            background: linear-gradient(45deg, #000000, #001122, #000000);
        }

        .particle {
            position: absolute;
            background: var(--primary);
            border-radius: 50%;
            animation: float 15s linear infinite;
        }

        @keyframes float {
            0% { transform: translateY(100vh) scale(0); opacity: 0; }
            50% { opacity: 0.7; }
            100% { transform: translateY(-100vh) scale(1); opacity: 0; }
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
            position: relative;
            z-index: 1;
        }

        header {
            text-align: center;
            padding: 30px 0;
        }

        .logo {
            display: inline-flex;
            align-items: center;
            gap: 15px;
            background: rgba(0, 0, 0, 0.6);
            padding: 15px 25px;
            border-radius: 15px;
            border: 2px solid var(--primary);
            box-shadow: 0 0 20px var(--primary);
        }

        .logo-img {
            width: 60px;
            height: 60px;
            border-radius: 50%;
            object-fit: cover;
            border: 2px solid var(--primary);
        }

        .logo-text h1 {
            font-size: 1.8rem;
            background: linear-gradient(to right, var(--primary), var(--accent));
            -webkit-background-clip: text;
            background-clip: text;
            color: transparent;
        }

        .main-content {
            background: rgba(0, 0, 0, 0.7);
            border-radius: 15px;
            padding: 40px 20px;
            text-align: center;
            border: 2px solid var(--primary);
            box-shadow: 0 0 30px var(--primary);
            margin: 20px 0;
        }

        .feature-img {
            max-width: 100%;
            height: auto;
            max-height: 300px;
            border-radius: 10px;
            border: 2px solid var(--primary);
            margin-bottom: 20px;
        }

        /* Pairing Methods Tabs */
        .pairing-methods {
            margin: 30px 0;
        }

        .method-tabs {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
            justify-content: center;
        }

        .tab-btn {
            padding: 12px 25px;
            border: 2px solid var(--primary);
            background: transparent;
            color: var(--light);
            border-radius: 25px;
            cursor: pointer;
            transition: all 0.3s ease;
            font-weight: 500;
        }

        .tab-btn.active {
            background: var(--primary);
            color: black;
            font-weight: 600;
        }

        .tab-content {
            display: none;
            animation: fadeIn 0.5s ease;
        }

        .tab-content.active {
            display: block;
        }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }

        /* QR Code Section */
        .qr-container {
            text-align: center;
            margin: 20px 0;
        }

        .qr-code {
            max-width: 200px;
            border: 2px solid var(--primary);
            border-radius: 10px;
            padding: 10px;
            background: white;
            margin: 0 auto;
        }

        /* Phone Number Section */
        .phone-input-group {
            margin: 20px 0;
            text-align: left;
            max-width: 300px;
            margin: 20px auto;
        }

        .input-label {
            display: block;
            margin-bottom: 8px;
            color: var(--light);
            font-weight: 500;
            text-align: center;
        }

        .input-field {
            width: 100%;
            padding: 12px 15px;
            border-radius: 8px;
            border: 1px solid #333;
            background: rgba(255, 255, 255, 0.1);
            color: white;
            font-size: 16px;
            text-align: center;
        }

        .input-field:focus {
            outline: none;
            border-color: var(--primary);
            box-shadow: 0 0 10px var(--primary);
        }

        /* Steps */
        .steps {
            margin: 20px 0;
            text-align: left;
            max-width: 400px;
            margin: 20px auto;
        }

        .step {
            margin-bottom: 10px;
            font-size: 0.9rem;
            color: var(--light);
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .step-number {
            width: 24px;
            height: 24px;
            background: var(--primary);
            color: black;
            border-radius: 50%;
            text-align: center;
            line-height: 24px;
            font-size: 0.8rem;
            font-weight: bold;
            flex-shrink: 0;
        }

        /* Buttons */
        .btn {
            padding: 12px 25px;
            border-radius: 25px;
            text-decoration: none;
            color: white;
            font-weight: 600;
            display: inline-flex;
            align-items: center;
            gap: 8px;
            transition: all 0.3s ease;
            border: 2px solid var(--primary);
            background: rgba(0, 0, 0, 0.8);
            cursor: pointer;
            margin: 10px 5px;
        }

        .btn:hover {
            transform: translateY(-3px);
            box-shadow: 0 5px 15px var(--primary);
            background: var(--primary);
            color: black;
        }

        .btn:disabled {
            opacity: 0.6;
            cursor: not-allowed;
            transform: none;
        }

        /* Status Messages */
        .status-message {
            margin: 15px 0;
            padding: 12px;
            border-radius: 8px;
            font-weight: 500;
            text-align: center;
        }

        .status-loading {
            background: rgba(5, 230, 255, 0.1);
            color: var(--primary);
            border: 1px solid var(--primary);
        }

        .status-success {
            background: rgba(0, 255, 136, 0.1);
            color: var(--success);
            border: 1px solid var(--success);
        }

        .status-error {
            background: rgba(255, 68, 68, 0.1);
            color: var(--error);
            border: 1px solid var(--error);
        }

        /* Code Box */
        .code-box {
            background: rgba(255, 255, 255, 0.1);
            padding: 15px 20px;
            border-radius: 8px;
            border: 1px dashed var(--primary);
            font-family: monospace;
            font-size: 20px;
            font-weight: 700;
            cursor: pointer;
            transition: all 0.3s ease;
            letter-spacing: 2px;
            margin: 10px 0;
        }

        .code-box:hover {
            background: rgba(255, 255, 255, 0.2);
            transform: scale(1.05);
        }

        .code-box.copied {
            background: var(--success);
            color: black;
        }

        .hint {
            font-size: 0.8rem;
            color: var(--light);
            margin-top: 8px;
        }

        footer {
            text-align: center;
            padding: 20px;
            margin-top: 40px;
            color: var(--light);
        }

        @media (max-width: 768px) {
            .logo { flex-direction: column; text-align: center; }
            .method-tabs { flex-direction: column; align-items: center; }
            .tab-btn { width: 100%; max-width: 250px; }
        }

        /* Audio visualizer */
        .audio-visualizer {
            position: fixed;
            bottom: 0;
            left: 0;
            width: 100%;
            height: 4px;
            background: linear-gradient(90deg, var(--primary), var(--accent));
            opacity: 0.6;
            z-index: 100;
            animation: pulse 2s infinite;
        }

        @keyframes pulse {
            0%, 100% { opacity: 0.3; }
            50% { opacity: 0.8; }
        }
    </style>
</head>
<body>
    <div class="bg-animation" id="bg"></div>
    <div class="audio-visualizer"></div>
    
    <div class="container">
        <header>
            <div class="logo">
                <img src="https://files.catbox.moe/avflwa.jpg" alt="DTZ NOVA X MD" class="logo-img">
                <div class="logo-text">
                    <h1>DTZ NOVA X MD</h1>
                    <div>Complete WhatsApp Bot Solution</div>
                </div>
            </div>
        </header>

        <main class="main-content">
            <img src="https://files.catbox.moe/g1zze2.jpg" alt="Feature" class="feature-img">
            
            <h2>Advanced WhatsApp Bot with Messaging</h2>
            <p>Connect your WhatsApp instantly using QR code or phone number pairing with full messaging capabilities</p>

            <!-- Pairing Methods Section -->
            <div class="pairing-methods">
                <div class="method-tabs">
                    <button class="tab-btn active" data-tab="qr">
                        <i class="fas fa-qrcode"></i> QR Code
                    </button>
                    <button class="tab-btn" data-tab="phone">
                        <i class="fas fa-mobile-alt"></i> Phone Number
                    </button>
                </div>

                <!-- QR Code Tab -->
                <div class="tab-content active" id="qr-tab">
                    <div class="steps">
                        <div class="step">
                            <span class="step-number">1</span>
                            <span>Click "Generate QR Code" below</span>
                        </div>
                        <div class="step">
                            <span class="step-number">2</span>
                            <span>Open WhatsApp → Settings → Linked Devices</span>
                        </div>
                        <div class="step">
                            <span class="step-number">3</span>
                            <span>Tap "Link a Device" and scan QR code</span>
                        </div>
                        <div class="step">
                            <span class="step-number">4</span>
                            <span>Bot will auto-connect and receive messages</span>
                        </div>
                    </div>

                    <button class="btn" id="generateQrBtn">
                        <i class="fas fa-qrcode"></i> Generate QR Code
                    </button>

                    <div class="qr-container" id="qrContainer"></div>
                    <div id="qrStatus"></div>
                </div>

                <!-- Phone Number Tab -->
                <div class="tab-content" id="phone-tab">
                    <div class="steps">
                        <div class="step">
                            <span class="step-number">1</span>
                            <span>Enter your phone number below</span>
                        </div>
                        <div class="step">
                            <span class="step-number">2</span>
                            <span>Click "Get Pairing Code"</span>
                        </div>
                        <div class="step">
                            <span class="step-number">3</span>
                            <span>Use the code in WhatsApp Linked Devices</span>
                        </div>
                        <div class="step">
                            <span class="step-number">4</span>
                            <span>Bot will connect and receive messages</span>
                        </div>
                    </div>

                    <div class="phone-input-group">
                        <label class="input-label">Country Code</label>
                        <select class="input-field" id="countryCode">
                            <option value="94">Sri Lanka (+94)</option>
                            <option value="91">India (+91)</option>
                            <option value="1">USA/Canada (+1)</option>
                            <option value="44">UK (+44)</option>
                            <option value="61">Australia (+61)</option>
                        </select>
                    </div>

                    <div class="phone-input-group">
                        <label class="input-label">Phone Number (without country code)</label>
                        <input type="tel" class="input-field" id="phoneNumber" 
                               placeholder="77 123 4567" inputmode="numeric" maxlength="15">
                    </div>

                    <button class="btn" id="getCodeBtn">
                        <i class="fas fa-key"></i> Get Pairing Code
                    </button>

                    <div id="phoneResult"></div>
                </div>
            </div>

            <!-- Server Status -->
            <div style="margin-top: 30px; padding: 20px; background: rgba(0,0,0,0.5); border-radius: 10px;">
                <h3><i class="fas fa-server"></i> Server Status</h3>
                <div id="serverStatus" class="status-message status-loading">
                    <i class="fas fa-sync fa-spin"></i> Checking server status...
                </div>
                <button class="btn" onclick="checkServerStatus()">
                    <i class="fas fa-sync"></i> Refresh Status
                </button>
            </div>

            <!-- Additional Links -->
            <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid rgba(255,255,255,0.1);">
                <div class="buttons">
                    <a href="https://wa.me/94752978237" class="btn" target="_blank">
                        <i class="fas fa-headset"></i> Contact Support
                    </a>
                    <a href="https://chat.whatsapp.com/KJnHbIYysdrJhCLH8C1HFe" class="btn" target="_blank">
                        <i class="fas fa-users"></i> Join Group
                    </a>
                    <a href="/api/health" class="btn" target="_blank">
                        <i class="fas fa-heart-pulse"></i> API Health
                    </a>
                </div>
            </div>
        </main>

        <footer>
            <p>&copy; 2024 DTZ NOVA X MD. All rights reserved. | Version 2.2.0</p>
        </footer>
    </div>

    <!-- Background Audio -->
    <audio id="bgMusic" loop>
        <source src="https://files.catbox.moe/od0rav.mp3" type="audio/mpeg">
    </audio>

    <script>
        // Simple particles for background
        function createParticles() {
            const bg = document.getElementById('bg');
            for (let i = 0; i < 20; i++) {
                const particle = document.createElement('div');
                particle.className = 'particle';
                const size = Math.random() * 4 + 2;
                particle.style.width = \`\${size}px\`;
                particle.style.height = \`\${size}px\`;
                particle.style.left = \`\${Math.random() * 100}%\`;
                particle.style.animationDuration = \`\${Math.random() * 10 + 10}s\`;
                particle.style.animationDelay = \`\${Math.random() * 5}s\`;
                bg.appendChild(particle);
            }
        }

        // Tab switching functionality
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                // Update active tab button
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                
                // Show active tab content
                const tabName = btn.getAttribute('data-tab');
                document.querySelectorAll('.tab-content').forEach(content => {
                    content.classList.remove('active');
                });
                document.getElementById(\`\${tabName}-tab\`).classList.add('active');
                
                // Clear previous results
                document.getElementById('qrStatus').innerHTML = '';
                document.getElementById('phoneResult').innerHTML = '';
            });
        });

        // QR Code Generation
        document.getElementById('generateQrBtn').addEventListener('click', async function() {
            const btn = this;
            const qrContainer = document.getElementById('qrContainer');
            const qrStatus = document.getElementById('qrStatus');
            
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating...';
            qrStatus.innerHTML = '<div class="status-message status-loading"><i class="fas fa-sync fa-spin"></i> Creating WhatsApp session...</div>';
            qrContainer.innerHTML = '';

            try {
                const response = await fetch('/api/code/qr');
                const data = await response.json();

                if (data.success && data.qrCode) {
                    // Display QR Code
                    qrContainer.innerHTML = \`
                        <img src="\${data.qrCode}" alt="WhatsApp QR Code" class="qr-code">
                        <div class="hint">Scan this QR code with WhatsApp</div>
                    \`;
                    
                    qrStatus.innerHTML = '<div class="status-message status-success"><i class="fas fa-check-circle"></i> QR Code generated! Scan it with WhatsApp.</div>';
                    
                    // Check connection status periodically
                    if (data.sessionId) {
                        checkQrConnectionStatus(data.sessionId);
                    }

                    // Update button to allow regeneration
                    btn.disabled = false;
                    btn.innerHTML = '<i class="fas fa-sync"></i> Generate New QR';

                } else {
                    qrStatus.innerHTML = \`<div class="status-message status-error"><i class="fas fa-exclamation-triangle"></i> \${data.error || 'Failed to generate QR code'}</div>\`;
                    btn.disabled = false;
                    btn.innerHTML = '<i class="fas fa-qrcode"></i> Generate QR Code';
                }
            } catch (error) {
                qrStatus.innerHTML = '<div class="status-message status-error"><i class="fas fa-wifi"></i> Network error. Please try again.</div>';
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-qrcode"></i> Generate QR Code';
            }
        });

        // Phone Number Pairing
        document.getElementById('getCodeBtn').addEventListener('click', async function() {
            const rawNumber = document.getElementById('phoneNumber').value.replace(/\\s/g, '');
            const fullNumber = document.getElementById('countryCode').value + rawNumber;
            const result = document.getElementById('phoneResult');
            const btn = this;

            if (!rawNumber || rawNumber.length < 7) {
                result.innerHTML = '<div class="status-message status-error">Please enter a valid phone number (at least 7 digits)</div>';
                return;
            }

            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating...';
            result.innerHTML = '<div class="status-message status-loading"><i class="fas fa-sync fa-spin"></i> Connecting to WhatsApp...</div>';

            try {
                const response = await fetch(\`/api/code/phone?number=\${encodeURIComponent(fullNumber)}\`);
                const data = await response.json();

                if (data.success && data.code) {
                    showPhoneCode(data.code);
                } else {
                    result.innerHTML = \`<div class="status-message status-error"><i class="fas fa-exclamation-triangle"></i> \${data.error || data.message || 'Failed to generate code'}</div>\`;
                    if (data.qrEndpoint) {
                        result.innerHTML += \`<div class="status-message status-loading" style="margin-top: 10px;">Try the <a href="javascript:switchToQr()" style="color: var(--primary); font-weight: 600;">QR Code method</a> for better reliability.</div>\`;
                    }
                }
            } catch (error) {
                result.innerHTML = '<div class="status-message status-error"><i class="fas fa-wifi"></i> Network error. Please try again.</div>';
            } finally {
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-key"></i> Get Pairing Code';
            }
        });

        function switchToQr() {
            document.querySelector('[data-tab="qr"]').click();
            document.getElementById('generateQrBtn').click();
        }

        function showPhoneCode(code) {
            document.getElementById('phoneResult').innerHTML = \`
                <div style="text-align: center;">
                    <div class="status-message status-success">✅ Pairing Code Generated!</div>
                    <div class="code-box" onclick="copyCode('\${code}')" id="phoneCodeBox">
                        <i class="fas fa-key"></i> \${code}
                    </div>
                    <div class="hint">Click the code to copy it</div>
                    <div style="margin-top: 15px; font-size: 0.8rem; color: var(--light);">
                        <i class="fas fa-mobile-alt"></i> 
                        Go to WhatsApp → Linked Devices → Link a Device → Enter this code
                    </div>
                </div>
            \`;
        }

        function copyCode(code) {
            navigator.clipboard.writeText(code).then(() => {
                const codeBox = document.getElementById('phoneCodeBox');
                if (codeBox) {
                    codeBox.classList.add('copied');
                    codeBox.innerHTML = '<i class="fas fa-check"></i> Copied!';
                    setTimeout(() => {
                        codeBox.classList.remove('copied');
                        codeBox.innerHTML = \`<i class="fas fa-key"></i> \${code}\`;
                    }, 2000);
                }
            });
        }

        function checkQrConnectionStatus(sessionId) {
            const qrStatus = document.getElementById('qrStatus');
            let checks = 0;
            const maxChecks = 60; // 2 minutes max

            const interval = setInterval(async () => {
                checks++;
                
                if (checks >= maxChecks) {
                    clearInterval(interval);
                    qrStatus.innerHTML = '<div class="status-message status-error"><i class="fas fa-clock"></i> QR code expired. Generate a new one.</div>';
                    return;
                }

                try {
                    const response = await fetch(\`/api/code/status/\${sessionId}\`);
                    const data = await response.json();
                    
                    if (data.connected) {
                        qrStatus.innerHTML = '<div class="status-message status-success"><i class="fas fa-check-circle"></i> ✅ WhatsApp connected successfully! You can now receive messages.</div>';
                        clearInterval(interval);
                    }
                } catch (error) {
                    // Ignore status check errors
                }
            }, 2000);
        }

        // Server status check
        async function checkServerStatus() {
            const statusDiv = document.getElementById('serverStatus');
            statusDiv.innerHTML = '<i class="fas fa-sync fa-spin"></i> Checking server status...';
            statusDiv.className = 'status-message status-loading';

            try {
                const response = await fetch('/api/health');
                const data = await response.json();
                
                statusDiv.innerHTML = \`<i class="fas fa-check-circle"></i> Server is healthy | Version: \${data.version} | Uptime: \${data.uptime}s | Sessions: \${data.activeSessions}\`;
                statusDiv.className = 'status-message status-success';
            } catch (error) {
                statusDiv.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Server is not responding';
                statusDiv.className = 'status-message status-error';
            }
        }

        // Phone number formatting
        document.getElementById('phoneNumber').addEventListener('input', function(e) {
            let value = e.target.value.replace(/\\D/g, '');
            if (value.length > 2 && value.length <= 7) {
                value = value.slice(0, 2) + ' ' + value.slice(2);
            } else if (value.length > 7) {
                value = value.slice(0, 2) + ' ' + value.slice(2, 7) + ' ' + value.slice(7, 10);
            }
            e.target.value = value;
        });

        // Enter key support
        document.getElementById('phoneNumber').addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                document.getElementById('getCodeBtn').click();
            }
        });

        // Auto-play background music
        function playBackgroundMusic() {
            const audio = document.getElementById('bgMusic');
            audio.volume = 0.3;
            
            const playAudio = () => {
                audio.play().catch(e => console.log('Auto-play prevented'));
            };
            
            playAudio();
            document.addEventListener('click', playAudio, { once: true });
        }

        // Initialize
        createParticles();
        playBackgroundMusic();
        checkServerStatus();
        
        // Auto-focus on phone number when phone tab is active
        document.querySelector('[data-tab="phone"]').addEventListener('click', () => {
            setTimeout(() => {
                document.getElementById('phoneNumber').focus();
            }, 100);
        });
    </script>
</body>
</html>
    `);
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('💥 Server Error:', err);
    res.status(500).json({ 
        success: false,
        error: 'Internal server error',
        message: 'Something went wrong. Please try again later.'
    });
});

// 404 handler - must be last
app.use('*', (req, res) => {
    if (req.originalUrl.startsWith('/api/')) {
        res.status(404).json({ 
            success: false,
            error: 'Endpoint not found',
            message: `The route ${req.originalUrl} does not exist.`,
            availableEndpoints: [
                'GET /',
                'GET /api/code/qr',
                'GET /api/code/phone?number=PHONE',
                'GET /api/code/status/:sessionId',
                'GET /api/sessions',
                'GET /api/health',
                'GET /api/test'
            ]
        });
    } else {
        res.status(404).send(`
            <html>
                <head><title>404 - Page Not Found</title></head>
                <body style="background: #000; color: #05e6ff; font-family: Arial; text-align: center; padding: 50px;">
                    <h1>🤖 DTZ NOVA X MD</h1>
                    <h2>404 - Page Not Found</h2>
                    <p>The page you're looking for doesn't exist.</p>
                    <a href="/" style="color: #05e6ff;">Go to Home Page</a>
                </body>
            </html>
        `);
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`
🚀 DTZ NOVA X MD Complete Server Started
📍 Port: ${PORT}
🌐 Environment: ${process.env.NODE_ENV || 'development'}
📱 Version: 2.2.0
🕒 Started at: ${new Date().toLocaleString()}
    
📋 Single File Deployment:
   ✅ GET  /                     - Complete Web Interface
   ✅ GET  /api/code/qr          - QR code generation
   ✅ GET  /api/code/phone       - Phone pairing
   ✅ GET  /api/code/status/:id  - Connection status
   ✅ GET  /api/sessions         - Active sessions
   ✅ GET  /api/health           - Health check
    `);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('🛑 SIGTERM received - cleaning up sessions');
    for (const [sessionId, session] of activeSessions) {
        await cleanupSession(session.sessionDir);
    }
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('🛑 SIGINT received - cleaning up sessions');
    for (const [sessionId, session] of activeSessions) {
        await cleanupSession(session.sessionDir);
    }
    process.exit(0);
});

export default app;
