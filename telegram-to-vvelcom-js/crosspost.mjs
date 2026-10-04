const required = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_SOURCE_CHANNEL',
  'VVELCOM_BOT_TOKEN',
  'VVELCOM_CHANNEL',
];
const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length) throw new Error(`Заполните переменные в .env: ${missing.join(', ')}`);

const telegramApi = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN.trim()}`;
const vvelcomApi = `https://apibots.vvelcom.online/bot${process.env.VVELCOM_BOT_TOKEN.trim()}`;
const sourceChannel = process.env.TELEGRAM_SOURCE_CHANNEL.trim().toLowerCase();
// Канал VVelcom — по нику (`@my_channel` или `my_channel`); подойдёт и UUID.
const channelValue = process.env.VVELCOM_CHANNEL.trim();
const targetChannel = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(channelValue)
  ? channelValue
  : `@${channelValue.replace(/^@/, '')}`;
const addSourceLink = process.env.ADD_SOURCE_LINK !== 'false';

async function apiCall(base, method, payload = {}) {
  const response = await fetch(`${base}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.description ?? `HTTP ${response.status}`);
  return data.result;
}

function isSourceChannel(chat) {
  const candidates = [String(chat.id), chat.username ? `@${chat.username}` : '']
    .map((value) => value.toLowerCase());
  return candidates.includes(sourceChannel);
}

function buildPost(post) {
  const sourceLink = post.chat.username
    ? `https://t.me/${post.chat.username}/${post.message_id}`
    : null;
  let text = post.text || post.caption || '';
  if (!text && sourceLink) text = 'Новая публикация в Telegram';
  if (addSourceLink && sourceLink) text += `${text ? '\n\n' : ''}Источник: ${sourceLink}`;
  return text.trim().slice(0, 4096);
}

await apiCall(vvelcomApi, 'getChat', { chat_id: targetChannel });
console.log('Кросспостинг запущен. Ожидаю новые публикации Telegram.');

let offset = 0;
while (true) {
  try {
    const updates = await apiCall(telegramApi, 'getUpdates', {
      offset,
      timeout: 30,
      allowed_updates: ['channel_post'],
    });
    for (const update of updates) {
      const post = update.channel_post;
      if (post && isSourceChannel(post.chat)) {
        const text = buildPost(post);
        if (text) await apiCall(vvelcomApi, 'sendMessage', { chat_id: targetChannel, text });
      }
      offset = update.update_id + 1;
    }
  } catch (error) {
    console.error(`Ошибка: ${error.message}. Повтор через 3 секунды.`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

