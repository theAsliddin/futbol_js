# Futbol maydoni band qilish boti (Node.js)

## Render'ga joylash
1. Bu papkani GitHub'ga yuklang (`git init`, `git add .`, `git commit`, `git push`).
2. Render → **New → Web Service** → repozitoriyni tanlang.
3. Sozlamalar: Runtime **Node**, Build `npm install`, Start `npm start`.
4. **Environment** bo'limida qo'shing:
   - `BOT_TOKEN` — BotFather bergan token
   - `ADMIN_IDS` — admin Telegram ID'lari (vergul bilan)
   - `TZ` = `Asia/Tashkent`
   - `NODE_VERSION` = `22`
5. Deploy qiling. Bot webhook orqali avtomatik ulanadi.

## Lokal ishga tushirish
    npm install
    BOT_TOKEN=... node index.js
