// Бот-администратор пространства: встречает новых участников, добавляет их в группы
// и выполняет команды владельца бота. Без сторонних библиотек, Node.js 20.6+.

const token = process.env.VVELCOM_BOT_TOKEN?.trim();
const spaceId = process.env.SPACE_ID?.trim();
if (!token) throw new Error('Укажите VVELCOM_BOT_TOKEN в файле .env');
if (!spaceId) throw new Error('Укажите SPACE_ID в файле .env');
// Группы, куда добавлять каждого нового участника (через запятую, необязательно).
const welcomeGroups = (process.env.WELCOME_GROUP_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean);

const api = `https://apibots.vvelcom.online/bot${token}`;

async function call(method, payload = {}) {
  const response = await fetch(`${api}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    const error = new Error(data.description ?? `HTTP ${response.status}`);
    error.code = data.code;
    throw error;
  }
  return data.result;
}

const me = await call('getMe');
const space = await call('getSpace', { space_id: spaceId });
console.log(`Бот @${me.username} запущен. Пространство «${space.name ?? space.id}», права: ${space.bot_rights.join(', ') || 'нет'}`);

const HELP = [
  'Команды (только для владельца бота):',
  '/groups — группы пространства',
  '/newgroup Название — новая группа с разделами',
  '/rename <chat_id> Название — переименовать группу',
  '/kick <user_id> — удалить участника из пространства',
].join('\n');

// Новый участник пространства: приветствие в личку и группы по умолчанию.
async function onSpaceMember(update) {
  const joined = update.new_space_member.status !== 'left' && update.old_space_member.status === 'left';
  if (!joined) return;
  const user = update.new_space_member.user;
  for (const chatId of welcomeGroups) {
    try {
      await call('addChatMember', { chat_id: chatId, user_id: user.id });
    } catch (error) {
      console.error(`Не добавил ${user.first_name} в ${chatId}: ${error.message}`);
    }
  }
  try {
    // chat_id = user_id: личный чат. Если человек сам не запускал бота, нужно право «Писать участникам».
    await call('sendMessage', { chat_id: user.id, text: `Добро пожаловать в «${space.name ?? 'пространство'}», ${user.first_name}!` });
  } catch (error) {
    console.error(`Не написал ${user.first_name}: ${error.message}`);
  }
}

async function onCommand(message) {
  const [command, ...rest] = message.text.trim().split(/\s+/);
  const reply = (text) => call('sendMessage', { chat_id: message.chat.id, text });
  if (message.from?.id !== me.owner_id) return reply('Командовать ботом может только его владелец.');

  if (command === '/groups') {
    const chats = await call('getSpaceChats', { space_id: spaceId });
    return reply(chats.map((chat) => `${chat.title ?? 'Без названия'} — ${chat.id}`).join('\n') || 'Групп нет');
  }
  if (command === '/newgroup' && rest.length) {
    const chat = await call('createChat', { space_id: spaceId, title: rest.join(' '), topics_enabled: true, topics_layout: 'list' });
    await call('createForumTopic', { chat_id: chat.id, name: 'Объявления' });
    await call('sendMessage', { chat_id: chat.id, text: 'Группа создана ботом. Пишите в разделы!' });
    return reply(`Готово: ${chat.title} (${chat.id})`);
  }
  if (command === '/rename' && rest.length > 1) {
    await call('setChatTitle', { chat_id: rest[0], title: rest.slice(1).join(' ') });
    return reply('Переименовал.');
  }
  if (command === '/kick' && rest.length === 1) {
    await call('removeSpaceMember', { space_id: spaceId, user_id: rest[0] });
    return reply('Удалил из пространства.');
  }
  return reply(HELP);
}

let offset = 0;
while (true) {
  try {
    // chat_member и space_member приходят, только если их явно перечислить в allowed_updates.
    const updates = await call('getUpdates', {
      offset,
      timeout: 30,
      allowed_updates: ['message', 'chat_member', 'space_member'],
    });
    for (const update of updates) {
      offset = update.update_id + 1;
      try {
        if (update.space_member?.space_id === spaceId) await onSpaceMember(update.space_member);
        else if (update.chat_member) {
          const { chat, new_chat_member: next } = update.chat_member;
          console.log(`${chat.title}: ${next.user.first_name} → ${next.status}`);
        } else if (update.message?.text && update.message.chat.type === 'private') await onCommand(update.message);
      } catch (error) {
        console.error(`Ошибка обработки: ${error.message}${error.code ? ` (${error.code})` : ''}`);
      }
    }
  } catch (error) {
    console.error(`Ошибка: ${error.message}. Повтор через 3 секунды.`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}
