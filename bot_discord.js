require('dotenv').config();

const webhookUrl = process.env.DISCORD_WEBHOOK_URL;

if (webhookUrl) {
    console.log(' Discord Webhook initialized.');
} else {
    console.warn(' Discord Webhook URL chưa được cấu hình trong .env');
}

/**
 * Gửi thông báo tới Discord Webhook (Embed đẹp)
 * @param {object} options
 * @param {string} options.title - Tiêu đề embed
 * @param {string} options.description - Nội dung chính
 * @param {number} [options.color] - Màu embed (decimal)
 * @param {Array} [options.fields] - Danh sách fields [{name, value, inline}]
 * @returns {Promise<string|null>} Message ID hoặc null
 */
async function sendDiscordWebhook({ title, description, color = 0x5865F2, fields = [] }) {
    if (!webhookUrl) return null;
    try {
        const payload = {
            embeds: [{
                title,
                description,
                color,
                fields,
                timestamp: new Date().toISOString(),
                footer: { text: 'Proxy-FB Tracker' }
            }]
        };

        const res = await fetch(webhookUrl + '?wait=true', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            console.error(' Discord Webhook lỗi:', res.status, await res.text());
            return null;
        }

        const data = await res.json();
        return data.id || null;
    } catch (error) {
        console.error(' Lỗi gửi Discord Webhook:', error.message);
        return null;
    }
}

/**
 * Chỉnh sửa tin nhắn Discord đã gửi
 * @param {string} messageId - ID tin nhắn cần sửa
 * @param {object} options - Giống sendDiscordWebhook
 */
async function editDiscordWebhook(messageId, { title, description, color = 0x57F287, fields = [] }) {
    if (!webhookUrl || !messageId) return;
    try {
        const payload = {
            embeds: [{
                title,
                description,
                color,
                fields,
                timestamp: new Date().toISOString(),
                footer: { text: 'Proxy-FB Tracker' }
            }]
        };

        const res = await fetch(`${webhookUrl}/messages/${messageId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            console.error(' Discord edit lỗi:', res.status, await res.text());
        }
    } catch (error) {
        console.error(' Lỗi cập nhật Discord:', error.message);
    }
}

module.exports = { sendDiscordWebhook, editDiscordWebhook };
