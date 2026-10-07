'use strict';

// Render serverlari UTC vaqtida ishlaydi — Toshkent vaqtiga o'tkazamiz
process.env.TZ = process.env.TZ || 'Asia/Tashkent';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { Telegraf, Markup } = require('telegraf');

// ======================= SOZLAMALAR =======================
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error(
    "BOT_TOKEN environment o'zgaruvchisi berilmagan. " +
      "Render'da Environment bo'limiga BOT_TOKEN ni qo'shing."
  );
  process.exit(1);
}

const ADMIN_IDS = new Set(
  (process.env.ADMIN_IDS || '7830914938')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s))
    .map(Number)
);
const OPEN_HOUR = 8;
const CLOSE_HOUR = 24; // 08:00 dan 24:00 gacha
const DAYS_AHEAD = 7; // necha kun oldindan band qilish mumkin
const PRICE = 150000; // 1 soat narxi (so'm)
const FIELD_NAME = 'Mini stadion';
const DB_PATH = process.env.DB_PATH || 'bookings.db';
const BLOCK_UID = 0; // yopilgan vaqtlar uchun maxsus user_id
const PORT = Number(process.env.PORT) || 10000;
// Render o'zi RENDER_EXTERNAL_URL ni beradi (masalan https://futbol-bot.onrender.com)
const BASE_URL = (process.env.WEBHOOK_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
// ==========================================================

// ======================= YORDAMCHI FUNKSIYALAR =======================
const pad = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const today = () => new Date();
const money = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const escapeHtml = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hh = (h) => `${pad(h)}:00`;

// ======================= BAZA =======================
fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT,
    phone TEXT,
    day TEXT NOT NULL,
    hour INTEGER NOT NULL,
    UNIQUE(day, hour)
  );
  CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    name TEXT,
    joined TEXT
  );
`);

const q = {
  saveUser: db.prepare('INSERT OR IGNORE INTO users(user_id,name,joined) VALUES(?,?,?)'),
  allUsers: db.prepare('SELECT user_id FROM users'),
  dayRows: db.prepare('SELECT * FROM bookings WHERE day=?'),
  addBooking: db.prepare('INSERT INTO bookings(user_id,name,phone,day,hour) VALUES(?,?,?,?,?)'),
  userBookings: db.prepare('SELECT * FROM bookings WHERE user_id=? AND day>=? ORDER BY day,hour'),
  byId: db.prepare('SELECT * FROM bookings WHERE id=?'),
  byIdUser: db.prepare('SELECT * FROM bookings WHERE id=? AND user_id=?'),
  del: db.prepare('DELETE FROM bookings WHERE id=?'),
};

function saveUser(user) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
  q.saveUser.run(user.id, name, new Date().toISOString().slice(0, 19));
}

const allUserIds = () => q.allUsers.all().map((r) => r.user_id);

/** {soat: qator} — shu kundagi barcha bronlar va yopilgan vaqtlar */
function dayRows(day) {
  const map = new Map();
  for (const r of q.dayRows.all(day)) map.set(r.hour, r);
  return map;
}

function addBooking(userId, name, phone, day, hour) {
  try {
    q.addBooking.run(userId, name, phone, day, hour);
    return true;
  } catch (e) {
    if (String(e.code).startsWith('SQLITE_CONSTRAINT')) return false; // shu vaqt allaqachon band
    throw e;
  }
}

const userBookings = (userId) => q.userBookings.all(userId, isoDate(today()));

function cancelOwn(bookingId, userId) {
  const row = q.byIdUser.get(bookingId, userId);
  if (row) q.del.run(bookingId);
  return row;
}

function cancelAny(bookingId) {
  const row = q.byId.get(bookingId);
  if (row) q.del.run(bookingId);
  return row;
}

function getStats() {
  const t = today();
  const todayIso = isoDate(t);
  const weekEnd = isoDate(addDays(t, 6));
  const monthPrefix = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-%`;
  const one = (sql, ...a) => db.prepare(sql).pluck().get(...a);
  const real = `user_id != ${BLOCK_UID}`;
  return {
    total: one(`SELECT COUNT(*) FROM bookings WHERE ${real}`),
    today: one(`SELECT COUNT(*) FROM bookings WHERE ${real} AND day=?`, todayIso),
    week: one(`SELECT COUNT(*) FROM bookings WHERE ${real} AND day BETWEEN ? AND ?`, todayIso, weekEnd),
    month: one(`SELECT COUNT(*) FROM bookings WHERE ${real} AND day LIKE ?`, monthPrefix),
    blocked: one(`SELECT COUNT(*) FROM bookings WHERE user_id=${BLOCK_UID} AND day>=?`, todayIso),
    users: one('SELECT COUNT(*) FROM users'),
    top: db
      .prepare(
        `SELECT hour, COUNT(*) n FROM bookings WHERE ${real} GROUP BY hour ORDER BY n DESC LIMIT 1`
      )
      .get(),
  };
}

// ======================= KLAVIATURALAR =======================
const btn = (text, data) => Markup.button.callback(text, data);

function grid(buttons, cols) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += cols) rows.push(buttons.slice(i, i + cols));
  return rows;
}

function mainMenu(userId) {
  const rows = [['⚽ Band qilish'], ['📋 Mening bronlarim']];
  if (ADMIN_IDS.has(userId)) rows.push(['🛠 Admin panel']);
  return Markup.keyboard(rows).resize();
}

function datesKb(prefix, backCb) {
  const buttons = [];
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const d = addDays(today(), i);
    const label = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}` + (i === 0 ? ' (bugun)' : '');
    buttons.push(btn(label, `${prefix}:${isoDate(d)}`));
  }
  const rows = grid(buttons, 2);
  if (backCb) rows.push([btn('⬅️ Orqaga', backCb)]);
  return Markup.inlineKeyboard(rows);
}

/** mode='user' -> bron qilish, mode='block' -> admin vaqtni yopish/ochish */
function hoursKb(day, mode = 'user') {
  const rows = dayRows(day);
  const now = new Date();
  const buttons = [];
  for (let h = OPEN_HOUR; h < CLOSE_HOUR; h++) {
    if (day === isoDate(now) && h <= now.getHours()) continue; // o'tib ketgan vaqtlar
    const r = rows.get(h);
    if (mode === 'user') {
      buttons.push(r ? btn(`❌ ${hh(h)}`, 'busy') : btn(`✅ ${hh(h)}`, `h:${day}:${h}`));
    } else if (!r) {
      buttons.push(btn(`✅ ${hh(h)}`, `abh:${day}:${h}`));
    } else if (r.user_id === BLOCK_UID) {
      buttons.push(btn(`⛔ ${hh(h)}`, `abh:${day}:${h}`));
    } else {
      buttons.push(btn(`❌ ${hh(h)}`, 'abusy'));
    }
  }
  const kbRows = grid(buttons, 3);
  kbRows.push([btn('⬅️ Orqaga', mode === 'user' ? 'back' : 'a:block')]);
  return Markup.inlineKeyboard(kbRows);
}

const phoneKb = () =>
  Markup.keyboard([[Markup.button.contactRequest('📱 Raqamni yuborish')]])
    .resize()
    .oneTime();

function adminMenuKb() {
  return Markup.inlineKeyboard([
    [btn('📅 Bugungi bronlar', `ad:${isoDate(today())}`)],
    [btn("📆 Kun bo'yicha", 'a:days'), btn('⛔ Vaqtni yopish/ochish', 'a:block')],
    [btn('📊 Statistika', 'a:stats'), btn('📣 Xabar yuborish', 'a:bc')],
  ]);
}

const toAdminMenuKb = () => Markup.inlineKeyboard([[btn('⬅️ Admin menyu', 'a:menu')]]);

// ======================= YORDAMCHI (Telegram) =======================
async function safeEdit(ctx, text, kb, html = false) {
  try {
    await ctx.editMessageText(text, { ...(kb || {}), ...(html ? { parse_mode: 'HTML' } : {}) });
  } catch (e) {
    // "message is not modified" va shu kabilar
    if (!(e.response && e.response.error_code === 400)) console.warn('safeEdit:', e.message);
  }
}

async function notifyAdmins(telegram, text) {
  for (const aid of ADMIN_IDS) {
    try {
      await telegram.sendMessage(aid, text);
    } catch (e) {
      console.warn('Adminga xabar yuborilmadi:', aid);
    }
  }
}

// Oddiy xotiradagi holatlar (FSM o'rniga): userId -> {name, ...data}
const states = new Map();

// ======================= BOT =======================
const bot = new Telegraf(BOT_TOKEN);

const adminOnly = (fn) => (ctx, next) => (ADMIN_IDS.has(ctx.from.id) ? fn(ctx, next) : next());

bot.catch((err, ctx) => {
  console.error(`Xatolik (${ctx.updateType}):`, err);
});

// ---- Admin buyruqlari (birinchi tekshiriladi) ----
const showAdminPanel = adminOnly(async (ctx) => {
  states.delete(ctx.from.id);
  await ctx.reply('🛠 <b>Admin panel</b>', { parse_mode: 'HTML', ...adminMenuKb() });
});
bot.command('admin', showAdminPanel);
bot.hears('🛠 Admin panel', showAdminPanel);

// ---- Mijoz: start va menyu ----
bot.start(async (ctx) => {
  states.delete(ctx.from.id);
  saveUser(ctx.from);
  await ctx.reply(
    `Assalomu alaykum, ${escapeHtml(ctx.from.first_name)}! 👋\n` +
      `<b>${FIELD_NAME}</b> maydonini band qilish botiga xush kelibsiz.\n` +
      `Narxi: ${money(PRICE)} so'm / soat`,
    { parse_mode: 'HTML', ...mainMenu(ctx.from.id) }
  );
});

bot.hears('⚽ Band qilish', async (ctx) => {
  states.delete(ctx.from.id);
  saveUser(ctx.from);
  await ctx.reply('📅 Kunni tanlang:', datesKb('d'));
});

bot.hears('📋 Mening bronlarim', async (ctx) => {
  const rows = userBookings(ctx.from.id);
  if (!rows.length) return ctx.reply("Sizda faol bronlar yo'q.");
  for (const r of rows) {
    await ctx.reply(
      `📅 ${r.day}  🕒 ${hh(r.hour)}`,
      Markup.inlineKeyboard([[btn('🗑 Bekor qilish', `c:${r.id}`)]])
    );
  }
});

bot.action('back', async (ctx) => {
  await safeEdit(ctx, '📅 Kunni tanlang:', datesKb('d'));
  await ctx.answerCbQuery();
});

bot.action(/^d:(.+)$/, async (ctx) => {
  const day = ctx.match[1];
  await safeEdit(ctx, `🕒 ${day} uchun vaqtni tanlang:\n✅ bo'sh   ❌ band`, hoursKb(day));
  await ctx.answerCbQuery();
});

bot.action('busy', (ctx) => ctx.answerCbQuery('Bu vaqt band ❌', { show_alert: true }));

bot.action(/^h:([^:]+):(\d+)$/, async (ctx) => {
  const day = ctx.match[1];
  const hour = Number(ctx.match[2]);
  if (dayRows(day).has(hour)) {
    await ctx.answerCbQuery("Afsus, bu vaqt band bo'lib qoldi ❌", { show_alert: true });
    await safeEdit(ctx, `🕒 ${day} uchun vaqtni tanlang:`, hoursKb(day));
    return;
  }
  states.set(ctx.from.id, { name: 'phone', day, hour });
  await safeEdit(ctx, `Tanlandi: <b>${day}, ${hh(hour)}</b>`, null, true);
  await ctx.reply(
    "Telefon raqamingizni yuboring (tugma orqali yoki qo'lda yozing):",
    phoneKb()
  );
  await ctx.answerCbQuery();
});

bot.action(/^c:(\d+)$/, async (ctx) => {
  const row = cancelOwn(Number(ctx.match[1]), ctx.from.id);
  if (!row) return ctx.answerCbQuery('Bron topilmadi', { show_alert: true });
  await safeEdit(ctx, '🗑 Bron bekor qilindi.');
  await notifyAdmins(
    ctx.telegram,
    `⚠️ Bron bekor qilindi\n👤 ${ctx.from.first_name}\n📅 ${row.day} ${hh(row.hour)}`
  );
  await ctx.answerCbQuery();
});

// ======================= ADMIN PANEL =======================
bot.action('a:menu', adminOnly(async (ctx) => {
  states.delete(ctx.from.id);
  await safeEdit(ctx, '🛠 <b>Admin panel</b>', adminMenuKb(), true);
  await ctx.answerCbQuery();
}));

// ---- Kun bo'yicha bronlar ----
function dayView(day) {
  const rows = dayRows(day);
  const free = CLOSE_HOUR - OPEN_HOUR - rows.size;
  const lines = [`📅 <b>${day}</b>   (bo'sh soatlar: ${free})\n`];
  const buttons = [];
  if (!rows.size) lines.push("Hozircha bronlar yo'q.");
  for (const h of [...rows.keys()].sort((a, b) => a - b)) {
    const r = rows.get(h);
    if (r.user_id === BLOCK_UID) lines.push(`${hh(h)} — ⛔ yopilgan`);
    else lines.push(`${hh(h)} — ${escapeHtml(r.name)}, ${escapeHtml(r.phone)}`);
    buttons.push(btn(`🗑 ${hh(h)}`, `ax:${r.id}:${day}`));
  }
  const kbRows = grid(buttons, 3);
  kbRows.push([btn('📆 Boshqa kun', 'a:days'), btn('⬅️ Menyu', 'a:menu')]);
  return { text: lines.join('\n'), kb: Markup.inlineKeyboard(kbRows) };
}

bot.action('a:days', adminOnly(async (ctx) => {
  await safeEdit(ctx, '📆 Kunni tanlang:', datesKb('ad', 'a:menu'));
  await ctx.answerCbQuery();
}));

bot.action(/^ad:(.+)$/, adminOnly(async (ctx) => {
  const { text, kb } = dayView(ctx.match[1]);
  await safeEdit(ctx, text, kb, true);
  await ctx.answerCbQuery();
}));

bot.action(/^ax:(\d+):(.+)$/, adminOnly(async (ctx) => {
  const row = cancelAny(Number(ctx.match[1]));
  const day = ctx.match[2];
  if (row && row.user_id !== BLOCK_UID) {
    try {
      await ctx.telegram.sendMessage(
        row.user_id,
        `⚠️ Kechirasiz, ${row.day} ${hh(row.hour)} dagi broningiz administrator tomonidan bekor qilindi.`
      );
    } catch (e) {
      /* foydalanuvchi botni bloklagan bo'lishi mumkin */
    }
  }
  await ctx.answerCbQuery(row ? 'Bekor qilindi 🗑' : 'Topilmadi');
  const { text, kb } = dayView(day);
  await safeEdit(ctx, text, kb, true);
}));

// ---- Vaqtni yopish / ochish ----
bot.action('a:block', adminOnly(async (ctx) => {
  await safeEdit(ctx, '⛔ Qaysi kun uchun vaqtni yopmoqchisiz?', datesKb('abd', 'a:menu'));
  await ctx.answerCbQuery();
}));

bot.action(/^abd:(.+)$/, adminOnly(async (ctx) => {
  const day = ctx.match[1];
  await safeEdit(
    ctx,
    `⛔ ${day}\nBo'sh vaqtni bosing — yopiladi, ⛔ ni bosing — qayta ochiladi.\n` +
      `✅ bo'sh  ⛔ yopiq  ❌ mijoz broni`,
    hoursKb(day, 'block')
  );
  await ctx.answerCbQuery();
}));

bot.action('abusy', adminOnly((ctx) =>
  ctx.answerCbQuery("Bu vaqtda mijoz broni bor. Uni kun ro'yxatidan bekor qiling.", {
    show_alert: true,
  })
));

bot.action(/^abh:([^:]+):(\d+)$/, adminOnly(async (ctx) => {
  const day = ctx.match[1];
  const hour = Number(ctx.match[2]);
  const r = dayRows(day).get(hour);
  if (!r) {
    addBooking(BLOCK_UID, '⛔ Yopilgan', '', day, hour);
    await ctx.answerCbQuery('Vaqt yopildi ⛔');
  } else if (r.user_id === BLOCK_UID) {
    cancelAny(r.id);
    await ctx.answerCbQuery('Vaqt ochildi ✅');
  } else {
    await ctx.answerCbQuery('Bu vaqtda mijoz broni bor', { show_alert: true });
  }
  try {
    await ctx.editMessageReplyMarkup(hoursKb(day, 'block').reply_markup);
  } catch (e) {
    /* o'zgarmagan */
  }
}));

// ---- Statistika ----
bot.action('a:stats', adminOnly(async (ctx) => {
  const s = getStats();
  const top = s.top ? `${hh(s.top.hour)} (${s.top.n} marta)` : '—';
  const text =
    '📊 <b>Statistika</b>\n\n' +
    `Bugun: <b>${s.today}</b> ta bron\n` +
    `Keyingi 7 kun: <b>${s.week}</b> ta\n` +
    `Shu oy: <b>${s.month}</b> ta  ≈ ${money(s.month * PRICE)} so'm\n` +
    `Jami: <b>${s.total}</b> ta  ≈ ${money(s.total * PRICE)} so'm\n\n` +
    `👥 Foydalanuvchilar: <b>${s.users}</b>\n` +
    `⛔ Yopilgan vaqtlar: <b>${s.blocked}</b>\n` +
    `🔥 Eng ommabop soat: <b>${top}</b>`;
  await safeEdit(ctx, text, toAdminMenuKb(), true);
  await ctx.answerCbQuery();
}));

// ---- Xabar yuborish (broadcast) ----
bot.action('a:bc', adminOnly(async (ctx) => {
  states.set(ctx.from.id, { name: 'broadcast' });
  await safeEdit(
    ctx,
    `📣 Barcha foydalanuvchilarga (${allUserIds().length} ta) yuboriladigan ` +
      `xabarni yozing (matn yoki rasm).\nBekor qilish uchun tugmani bosing.`,
    toAdminMenuKb()
  );
  await ctx.answerCbQuery();
}));

// ======================= HOLATGA BOG'LIQ XABARLAR =======================
bot.on('message', async (ctx) => {
  const st = states.get(ctx.from.id);
  if (!st) return;

  // --- Broadcast (faqat admin) ---
  if (st.name === 'broadcast' && ADMIN_IDS.has(ctx.from.id)) {
    states.delete(ctx.from.id);
    const chatId = ctx.chat.id;
    const messageId = ctx.message.message_id;
    const telegram = ctx.telegram;
    // Fonda yuboramiz — webhook so'rovi uzoq kutib qolmasligi uchun
    (async () => {
      let ok = 0;
      let fail = 0;
      for (const uid of allUserIds()) {
        try {
          await telegram.copyMessage(uid, chatId, messageId);
          ok++;
        } catch (e) {
          fail++;
        }
        await sleep(50); // Telegram limitlariga tushmaslik uchun
      }
      await telegram
        .sendMessage(chatId, `✅ Yuborildi: ${ok}\n❌ Xatolik: ${fail}`, adminMenuKb())
        .catch(() => {});
    })();
    return;
  }

  // --- Telefon raqami ---
  if (st.name === 'phone') {
    const phone = ctx.message.contact
      ? ctx.message.contact.phone_number
      : (ctx.message.text || '').trim();
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 9) {
      return ctx.reply("Raqam noto'g'ri. Qaytadan yuboring (masalan: +998901234567).");
    }

    const { day, hour } = st;
    const fullName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ');
    const ok = addBooking(ctx.from.id, fullName, phone, day, hour);
    states.delete(ctx.from.id);

    if (!ok) {
      return ctx.reply('Afsus, bu vaqt boshqa mijoz tomonidan band qilindi ❌', mainMenu(ctx.from.id));
    }

    await ctx.reply(
      `✅ Band qilindi!\n\n📍 ${FIELD_NAME}\n📅 ${day}\n🕒 ${hh(hour)} – ${hh(hour + 1)}\n` +
        `💰 ${money(PRICE)} so'm`,
      mainMenu(ctx.from.id)
    );
    await notifyAdmins(
      ctx.telegram,
      `🔔 Yangi bron\n👤 ${fullName}\n📞 ${phone}\n📅 ${day} ${hh(hour)}`
    );
  }
});

// ======================= ISHGA TUSHIRISH =======================
async function main() {
  if (!ADMIN_IDS.size) console.warn("ADMIN_IDS berilmagan — admin panel hech kimga ochiq emas!");

  // Render (Web Service) port ochilishini kutadi, shuning uchun HTTP server doim ishlaydi
  const secretToken = crypto.createHash('sha256').update(BOT_TOKEN).digest('hex');
  const hookPath = `/webhook/${secretToken.slice(0, 32)}`;
  const hook = BASE_URL ? bot.webhookCallback(hookPath, { secretToken }) : null;

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/healthz')) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('OK');
    }
    if (hook && req.method === 'POST' && req.url === hookPath) {
      return hook(req, res).catch((e) => {
        console.error('Webhook xatosi:', e);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(PORT, '0.0.0.0', resolve));
  console.log(`HTTP server ${PORT}-portda ishga tushdi`);

  if (BASE_URL) {
    await bot.telegram.setWebhook(`${BASE_URL}${hookPath}`, {
      secret_token: secretToken,
      allowed_updates: ['message', 'callback_query'],
    });
    console.log('Webhook rejimi:', `${BASE_URL}/webhook/***`);
  } else {
    bot.launch().catch((e) => {
      console.error('Polling xatosi:', e);
      process.exit(1);
    });
    console.log('Polling rejimi (lokal ishlatish uchun)');
  }

  const stop = (signal) => {
    console.log(`${signal} — to'xtatilmoqda`);
    if (!BASE_URL) bot.stop(signal);
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
