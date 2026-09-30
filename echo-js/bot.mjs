const token = process.env.VVELCOM_BOT_TOKEN?.trim();
if (!token) throw new Error('Укажите VVELCOM_BOT_TOKEN в файле .env');

const api = `https://apibots.vvelcom.online/bot${token}`;

async function call(method, payload = {}) {
  const response = await fetch(`${api}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.description ?? `HTTP ${response.status}`);
  return data.result;
}

const me = await call('getMe');
console.log(`Бот @${me.username ?? me.id} запущен`);

let offset = 0;
while (true) {
  try {
    const updates = await call('getUpdates', { offset, timeout: 30 });
    for (const update of updates) {
      const message = update.message;
      if (message?.text) {
        const text = message.text === '/start'
          ? 'Привет! Я эхо-бот. Напишите мне что-нибудь.'
          : `Вы написали: ${message.text}`;
        await call('sendMessage', { chat_id: message.chat.id, text });
      }
      offset = update.update_id + 1;
    }
  } catch (error) {
    console.error(`Ошибка: ${error.message}. Повтор через 3 секунды.`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

