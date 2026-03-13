const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.use(express.json());

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

// Listen for WhatsApp replies
client.on('message', async (msg) => {
    const sender = msg.from.split('@')[0];

    // Only respond to the admin number
    if (sender !== ADMIN_NUMBER) return;

    const body = msg.body.trim().toUpperCase();

    if (body === 'Y') {
        if (!pendingBlog) {
            return msg.reply('⚠️ No blog is currently pending review.');
        }

        try {
            console.log(`🚀 Admin approved publishing: "${pendingBlog.title}"`);

            // Forward the full blogDetails JSON to n8n publish webhook
            await axios.post(N8N_WEBHOOK_URL, pendingBlog);

            await msg.reply('✅ *Blog approved and published successfully!*');
            pendingBlog = null; // Clear state after processing
        } catch (error) {
            console.error('❌ Error calling n8n publish webhook:', error.message);
            await msg.reply('❌ *Error:* Failed to notify n8n. Please check server logs.');
        }
    } else if (body === 'N') {
        if (!pendingBlog) {
            return msg.reply('⚠️ No blog is currently pending review.');
        }

        console.log(`❌ Admin rejected: "${pendingBlog.title}"`);
        await msg.reply('❌ *Blog rejected.*');
        pendingBlog = null; // Clear state
    }
});

client.initialize();

app.listen(PORT, () => {
    console.log(`🚀 API Server running on port ${PORT}`);
});
