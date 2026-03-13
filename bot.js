const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.use(express.json());

// Root route for connection testing
app.get('/', (req, res) => {
    res.status(200).json({
        status: 'online',
        message: 'WhatsApp Blog Bot API is running.',
        endpoint: '/send-blog (POST)'
    });
});

const PORT = process.env.PORT || 3000;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const ADMIN_NUMBER = process.env.WHATSAPP_NUMBER; // Format: 919XXXXXXXXX

if (!ADMIN_NUMBER) {
    console.error('❌ Error: WHATSAPP_NUMBER is not defined in .env');
    process.exit(1);
}

// Global state to store the pending blog details
let pendingBlog = null;

// Initialize WhatsApp Client
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: './.wwebjs_auth'
    }),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        executablePath: process.env.CHROME_PATH || null // Useful for Docker
    }
});

client.on('qr', (qr) => {
    console.log('--- SCAN THE QR CODE BELOW ---');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ WhatsApp Bot is ready and authenticated!');
});

client.on('auth_failure', (msg) => {
    console.error('❌ Authentication failure:', msg);
});

// Helper function to send message with retry
async function sendMessageWithRetry(chatId, content, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            return await client.sendMessage(chatId, content);
        } catch (error) {
            console.error(`⚠️ Attempt ${i + 1} failed sending to ${chatId}:`, error.message);
            if (i === retries - 1) throw error;
            await new Promise(res => setTimeout(res, 2000)); // Wait 2s before retry
        }
    }
}

// Endpoint to receive blog from n8n
app.post('/send-blog', async (req, res) => {
    const blogDetails = req.body;

    if (!blogDetails || !blogDetails.title) {
        return res.status(400).json({ error: 'Invalid blog details provided. Title is required.' });
    }

    try {
        console.log(`📩 Received blog review request: "${blogDetails.title}"`);
        pendingBlog = blogDetails;

        const chatId = `${ADMIN_NUMBER}@c.us`;

        // 1. Send cover image first if available
        if (blogDetails.coverImage) {
            try {
                console.log(`🖼️ Fetching cover image from: ${blogDetails.coverImage}`);
                const media = await MessageMedia.fromUrl(blogDetails.coverImage);
                await sendMessageWithRetry(chatId, media);
            } catch (imgError) {
                console.error('❌ Failed to send cover image:', imgError.message);
                await sendMessageWithRetry(chatId, '⚠️ *Could not load cover image*, but here are the details:');
            }
        }

        // 2. Send formatted text message exactly as requested
        const tagsStr = Array.isArray(blogDetails.tags) ? blogDetails.tags.join(', ') : blogDetails.tags;

        const message = `📝 *Blog Review Request*

*Title:* ${blogDetails.title}

*Excerpt:*
${blogDetails.excerpt}

*Category:* ${blogDetails.category}

*Tags:*
${tagsStr}

Reply with:

*Y* = Publish
*N* = Reject`;

        await sendMessageWithRetry(chatId, message);

        res.status(200).json({
            success: true,
            message: 'Review request sent to WhatsApp admin.'
        });
    } catch (error) {
        console.error('❌ Error in /send-blog:', error);
        res.status(500).json({ error: 'Failed to process blog review request.' });
    }
});

// Listen for WhatsApp messages (using message_create to catch self-sent messages)
client.on('message_create', async (msg) => {
    // Ignore messages from groups or status updates
    if (msg.from.includes('@g.us') || msg.isStatus) return;

    const sender = (msg.from || '').split('@')[0];
    const receiver = (msg.to || '').split('@')[0];
    const body = msg.body.trim().toUpperCase();

    // The message is relevant if:
    // 1. It was sent BY the admin to the bot
    // 2. OR it was sent BY the bot (on the phone) to itself/admin (if using same number)
    const isFromAdmin = sender === ADMIN_NUMBER;
    const isSentToAdmin = receiver === ADMIN_NUMBER;

    // We only care about Y/N replies
    if (body !== 'Y' && body !== 'N') return;

    // Logic: If I (Admin) send 'Y' to the bot, or if I (Bot/Admin) send 'Y' in our shared chat
    if (isFromAdmin || (msg.fromMe && isSentToAdmin)) {
        if (body === 'Y') {
            if (!pendingBlog) {
                // Only reply if it was specifically an incoming message to avoid loops
                if (!msg.fromMe) await msg.reply('⚠️ No blog is currently pending review.');
                return;
            }

            try {
                console.log(`🚀 Admin approved: "${pendingBlog.title}"`);
                await axios.post(N8N_WEBHOOK_URL, pendingBlog);
                await client.sendMessage(msg.from, '✅ *Blog approved and published successfully!*');
                pendingBlog = null;
            } catch (error) {
                console.error('❌ Webhook Error:', error.message);
                await client.sendMessage(msg.from, '❌ *Error:* Failed to notify n8n.');
            }
        } else if (body === 'N') {
            if (!pendingBlog) return;
            console.log(`❌ Admin rejected: "${pendingBlog.title}"`);
            await client.sendMessage(msg.from, '❌ *Blog rejected.*');
            pendingBlog = null;
        }
    }
});

client.initialize();

app.listen(PORT, () => {
    console.log(`🚀 API Server running on port ${PORT}`);
});
