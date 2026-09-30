# Эхо-бот на Python

Отвечает на `/start` приветствием, а на остальные текстовые сообщения повторяет полученный текст.

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env             # Windows: copy .env.example .env
python bot.py
```

Заполните `VVELCOM_BOT_TOKEN` в `.env`, затем откройте бота в VVelcom и нажмите «Начать».

