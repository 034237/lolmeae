require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

let bot = null;

if (token && chatId) {
    bot = new TelegramBot(token, { polling: false });
    console.log(' Telegram Bot initialized.');
} else {
    console.warn(' Telegram Bot Token hoặc Chat ID chưa được cấu hình trong .env');
}

/**
 * Gửi thông báo tới Telegram
 * @param {string} message - Nội dung tin nhắn
 */
async function sendTelegramMessage(message) {
    if (!bot || !chatId) return null;
    try {
        const res = await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
        return res?.message_id;
    } catch (error) {
        console.error(' Lỗi gửi tin nhắn Telegram:', error.message);
        return null;
    }
}

async function editTelegramMessage(messageId, message) {
    if (!bot || !chatId || !messageId) return;
    try {
        await bot.editMessageText(message, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' });
    } catch (error) {
        console.error(' Lỗi cập nhật tin Telegram:', error.message);
    }
}

module.exports = { sendTelegramMessage, editTelegramMessage };
