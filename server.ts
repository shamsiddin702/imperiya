import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

import {
  getDbBookings,
  insertDbBooking,
  updateDbBookingStatus,
  updateDbBookingReminders,
  updateDbBookingChatId,
  deleteDbBooking,
  clearAllDbBookings,
  getDbSubscribers,
  upsertDbSubscriber,
  ensureSubscribersSchema,
  BookingRecord,
} from './src/db/queries.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'dist')));

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const STORAGE_FILE = path.join(__dirname, 'server_storage.json');
const ADMIN_CHAT_ID = 7737656048;

// ---- Bot Time Slots (30-min intervals 09:00-21:30) ----
const BOT_TIME_SLOTS: string[] = [];
for (let h = 9; h <= 21; h++) {
  BOT_TIME_SLOTS.push(`${String(h).padStart(2, '0')}:00`);
  if (h < 22) BOT_TIME_SLOTS.push(`${String(h).padStart(2, '0')}:30`);
}
BOT_TIME_SLOTS.push('22:00');

// ---- Local Storage ----
interface LocalStorageData {
  bookings: any[];
  subscribers: {
    chat_id: number;
    username: string;
    first_name: string;
    phone?: string;
    role: string;
    created_at: string;
  }[];
}

let localStore: LocalStorageData = {
  bookings: [],
  subscribers: [
    {
      chat_id: 7737656048,
      username: 'temurbek_xaliyarov',
      first_name: '__KHOLYAROV__',
      phone: '+998997070024',
      role: 'admin',
      created_at: new Date().toISOString(),
    }
  ]
};

function loadLocalStorage() {
  try {
    if (fs.existsSync(STORAGE_FILE)) {
      const raw = fs.readFileSync(STORAGE_FILE, 'utf-8').trim();
      if (!raw) { saveLocalStorage(); return; }
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.bookings)) localStore.bookings = parsed.bookings;
      if (Array.isArray(parsed.subscribers)) localStore.subscribers = parsed.subscribers;
      console.log(`📦 Loaded ${localStore.bookings.length} bookings and ${localStore.subscribers.length} subscribers from local storage.`);
    } else {
      saveLocalStorage();
    }
  } catch (err) {
    console.warn('⚠️ Error reading local storage file:', err);
    saveLocalStorage();
  }
}

function saveLocalStorage() {
  try {
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(localStore, null, 2), 'utf-8');
  } catch (err) {
    console.warn('⚠️ Error saving local storage file:', err);
  }
}

// ---- DB ----
let dbConnected = false;

async function initDb() {
  try {
    const { db } = await import('./src/db/index.ts');
    if (!db) return;
    await ensureSubscribersSchema();
    const dbBookings = await getDbBookings();
    const dbSubs = await getDbSubscribers();
    if (dbBookings.length > 0) {
      localStore.bookings = dbBookings;
      console.log(`🗄️ Loaded ${dbBookings.length} bookings from PostgreSQL.`);
    } else if (localStore.bookings.length > 0) {
      for (const b of localStore.bookings) {
        try { await insertDbBooking(b as BookingRecord); } catch {}
      }
      console.log(`🗄️ Synced ${localStore.bookings.length} local bookings to PostgreSQL.`);
    }
    if (dbSubs.length > 0) {
      localStore.subscribers = dbSubs;
    } else {
      for (const s of localStore.subscribers) {
        try { await upsertDbSubscriber(s); } catch {}
      }
    }
    dbConnected = true;
    console.log('✅ PostgreSQL connected.');
  } catch (err) {
    console.warn('⚠️ PostgreSQL not connected, using local storage only:', (err as any).message);
  }
}

// ---- Telegram API Helpers ----
async function sendTelegramMessage(chatId: number | string, text: string, replyMarkup?: any) {
  if (!BOT_TOKEN) return;
  try {
    const body: any = { chat_id: chatId, text, parse_mode: 'HTML' };
    if (replyMarkup) {
      if (replyMarkup.inline_keyboard) {
        body.reply_markup = { inline_keyboard: replyMarkup.inline_keyboard };
      } else if (replyMarkup.keyboard) {
        body.reply_markup = {
          keyboard: replyMarkup.keyboard,
          resize_keyboard: true,
          one_time_keyboard: false,
        };
      }
    }
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      console.warn(`⚠️ Telegram sendMessage error: ${err}`);
    }
  } catch (err) {
    console.warn('⚠️ Telegram API error:', err);
  }
}

async function editTelegramMessage(chatId: number | string, messageId: number, text: string, replyMarkup?: any) {
  if (!BOT_TOKEN) return;
  try {
    const body: any = { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' };
    if (replyMarkup?.inline_keyboard) {
      body.reply_markup = { inline_keyboard: replyMarkup.inline_keyboard };
    }
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {}
}

async function answerCallbackQuery(callbackQueryId: string, text?: string) {
  if (!BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text: text || '' }),
    });
  } catch {}
}

// ---- Keyboards ----
const CLIENT_KEYBOARD = {
  keyboard: [
    [{ text: '✂️ Navbatga Yozilish' }, { text: '📅 Mening Navbatim' }],
    [{ text: '🕒 Bo\'sh Vaqtlar' }, { text: '💰 Narxlar & Xizmatlar' }],
    [{ text: '📍 Manzil & Joylashuv' }, { text: '👤 Profilim' }],
    [{ text: '📞 Usta bilan aloqa' }],
  ],
};

const ADMIN_KEYBOARD = {
  keyboard: [
    [{ text: '📊 Admin Panel' }, { text: '📅 Bugungi Navbatlar' }],
    [{ text: '📋 Barcha Buyurtmalar' }, { text: '📊 Statistika & Kassa' }],
    [{ text: '👥 Mijozlar Ro\'yxati' }, { text: '📢 Xabar Yuborish' }],
    [{ text: '👤 Mijoz Rejimi' }, { text: '🗑 Barchasini Tozalash' }],
  ],
};

// ---- Admin Sessions ----
const adminSessions = new Map<number, { action: string; data?: any }>();

// ---- Bot Booking Sessions ----
interface BotSession {
  step: 'service' | 'day' | 'time' | 'phone' | 'confirm';
  serviceId?: string;
  serviceName?: string;
  servicePrice?: number;
  date?: string;
  dayName?: string;
  fullDateTitle?: string;
  time?: string;
  clientPhone?: string;
}
const botBookingSessions = new Map<number, BotSession>();

// ---- Services ----
const SERVICES = [
  { id: 'haircut', name: 'Soch olish', price: 25000 },
  { id: 'beard', name: 'Soqol olish', price: 15000 },
  { id: 'haircut_beard', name: 'Soch + Soqol', price: 35000 },
  { id: 'kids', name: 'Bolalar soch olish', price: 20000 },
  { id: 'shaving', name: 'To\'liq ustara', price: 20000 },
  { id: 'styling', name: 'Soch turmagʻi', price: 15000 },
];

function formatPrice(p: number) {
  return p.toLocaleString('uz-UZ') + ' so\'m';
}

function isUserAdmin(chatId: number | string, username?: string, phone?: string): boolean {
  const id = Number(chatId);
  if (id === ADMIN_CHAT_ID) return true;
  if (username && (username.toLowerCase() === 'erkinov5633' || username.toLowerCase() === 'temurbek_xaliyarov')) return true;
  if (phone) {
    const clean = phone.replace(/\D/g, '');
    if (clean.endsWith('930565633') || clean.endsWith('997070024')) return true;
  }
  const sub = localStore.subscribers.find(s => Number(s.chat_id) === id);
  if (sub?.role === 'admin') return true;
  return false;
}

async function getAdminChatIds(): Promise<number[]> {
  const ids = new Set<number>();
  ids.add(ADMIN_CHAT_ID);
  for (const s of localStore.subscribers) {
    if (isUserAdmin(s.chat_id, s.username, s.phone)) {
      ids.add(Number(s.chat_id));
    }
  }
  return Array.from(ids);
}

// ---- Helper: isBookingScheduledForToday ----
function isBookingScheduledForToday(b: any, todayDateStr: string): boolean {
  if (b.date === todayDateStr) return true;
  if (b.dayName && b.dayName.toLowerCase().includes('bugun')) return true;
  return false;
}

// ---- Notify Admins: New Booking ----
async function notifyAdminsNewBooking(booking: any) {
  const adminIds = await getAdminChatIds();
  const text =
    `💈 <b>YANGI NAVBAT!</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👤 <b>Mijoz:</b> <b>${booking.clientName}</b>\n` +
    `📞 <b>Tel:</b> <a href="tel:${booking.clientPhone}">${booking.clientPhone}</a>\n` +
    `${booking.clientTelegram ? `📱 <b>Telegram:</b> @${booking.clientTelegram.replace('@','')}\n` : ''}` +
    `✂️ <b>Xizmat:</b> ${booking.serviceName}\n` +
    `💰 <b>Narx:</b> ${formatPrice(booking.servicePrice)}\n` +
    `📅 <b>Sana:</b> ${booking.dayName || ''} (${booking.date})\n` +
    `⏰ <b>Vaqt:</b> <b>${booking.time}</b>\n` +
    `${booking.notes ? `📝 <b>Izoh:</b> ${booking.notes}\n` : ''}` +
    `🆔 <b>ID:</b> #${booking.id}`;

  for (const aId of adminIds) {
    await sendTelegramMessage(aId, text, {
      inline_keyboard: [
        [
          { text: '✅ Tasdiqlash', callback_data: `status:${booking.id}:confirmed` },
          { text: '❌ Rad etish', callback_data: `status:${booking.id}:cancelled` },
        ],
      ],
    });
  }
}

// ---- Notify Next Inline Client ----
async function notifyNextInlineClient(booking: any) {
  const todayStr = new Date().toISOString().split('T')[0];
  const pending = localStore.bookings
    .filter(b => (b.date === todayStr || isBookingScheduledForToday(b, todayStr)) && b.status === 'pending')
    .sort((a, b) => a.time.localeCompare(b.time));
  if (!pending.length) return;
  const next = pending[0];
  const cid = next.clientChatId || next.client_chat_id;
  if (!cid) return;
  await sendTelegramMessage(
    cid,
    `💈 <b>Sizning navbatingiz yaqinlashmoqda!</b>\n\n` +
    `⏰ <b>Vaqt:</b> ${next.time}\n` +
    `✂️ <b>Xizmat:</b> ${next.serviceName || next.service_name}\n` +
    `📍 <b>Manzil:</b> Qorasuv massiv, 87-uy\n\n` +
    `<i>Oldingi mijoz navbatini tugatdi. Siz navbatdasiz!</i>`
  );
}

// ---- Register Subscriber ----
async function registerSubscriber(chatId: number, username?: string, firstName?: string, lastName?: string, phone?: string) {
  const existing = localStore.subscribers.find(s => Number(s.chat_id) === Number(chatId));
  const role = isUserAdmin(chatId, username, phone) ? 'admin' : 'client';

  if (existing) {
    if (username) existing.username = username;
    if (firstName) existing.first_name = firstName;
    if (phone) existing.phone = phone;
    existing.role = role;
  } else {
    localStore.subscribers.push({
      chat_id: chatId,
      username: username || '',
      first_name: firstName || '',
      phone: phone || '',
      role,
      created_at: new Date().toISOString(),
    });
  }

  // Auto-link phone to existing bookings
  if (phone) {
    const cleanPhone = phone.replace(/\D/g, '');
    for (const b of localStore.bookings) {
      if (b.clientChatId) continue;
      const bPhone = (b.clientPhone || b.client_phone || '').replace(/\D/g, '');
      if (bPhone.length >= 7 && (bPhone.endsWith(cleanPhone.slice(-7)) || cleanPhone.endsWith(bPhone.slice(-7)))) {
        b.clientChatId = chatId;
        if (dbConnected) updateDbBookingChatId(b.id, String(chatId)).catch(() => {});
      }
    }
  }

  saveLocalStorage();
  if (dbConnected) {
    upsertDbSubscriber({ chat_id: chatId, username, first_name: firstName, last_name: lastName, phone, role }).catch(() => {});
  }
}

// ---- Finalize Bot Booking ----
async function finalizeBotBooking(chatId: number, session: BotSession, username?: string, firstName?: string) {
  const randomId = 'EMP-' + Math.floor(1000 + Math.random() * 9000);
  const now = new Date();

  const booking: any = {
    id: randomId,
    clientName: firstName || username || `User_${chatId}`,
    clientPhone: session.clientPhone || '',
    clientTelegram: username ? `@${username}` : '',
    clientChatId: chatId,
    serviceId: session.serviceId || 'haircut',
    serviceName: session.serviceName || 'Soch olish',
    servicePrice: session.servicePrice || 25000,
    date: session.date || now.toISOString().split('T')[0],
    dayName: session.dayName || 'Bugun',
    time: session.time || '10:00',
    notes: '',
    status: 'pending',
    createdAt: now.toISOString(),
    remindersSent: [],
    telegramSent: true,
  };

  localStore.bookings.push(booking);
  saveLocalStorage();

  if (dbConnected) {
    insertDbBooking(booking as BookingRecord).catch(() => {});
  }

  botBookingSessions.delete(chatId);
  await notifyAdminsNewBooking(booking);

  return booking;
}

// ---- Render Bot Service Step ----
async function renderBotServiceStep(chatId: number) {
  const session = botBookingSessions.get(chatId) || { step: 'service' as const };
  session.step = 'service';
  botBookingSessions.set(chatId, session);

  const buttons: any[][] = [];
  let row: any[] = [];
  SERVICES.forEach((s, i) => {
    row.push({ text: `${s.name} — ${formatPrice(s.price)}`, callback_data: `book_service:${s.id}` });
    if (row.length === 1) { buttons.push(row); row = []; }
  });
  if (row.length) buttons.push(row);
  buttons.push([{ text: '❌ Bekor qilish', callback_data: 'book_cancel' }]);

  await sendTelegramMessage(
    chatId,
    `💈 <b>ONLINE NAVBATGA YOZILISH</b>\n━━━━━━━━━━━━━━━━━━━━\n\n<b>1-QADAM:</b> Kerakli xizmat turini tanlang:`,
    { inline_keyboard: buttons }
  );
}

// ---- Render Bot Day Step ----
async function renderBotDayStep(chatId: number) {
  const session = botBookingSessions.get(chatId);
  if (!session) return;
  session.step = 'day';

  const now = new Date();
  const days: { label: string; date: string; dayName: string }[] = [];
  const UZ_DAYS = ['Yakshanba', 'Dushanba', 'Seshanba', 'Chorshanba', 'Payshanba', 'Juma', 'Shanba'];
  const UZ_MONTHS = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun', 'Iyul', 'Avgust', 'Sentabr', 'Oktabr', 'Noyabr', 'Dekabr'];

  for (let i = 0; i < 7; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    const dayName = i === 0 ? 'Bugun' : i === 1 ? 'Ertaga' : UZ_DAYS[d.getDay()];
    const dateStr = d.toISOString().split('T')[0];
    const label = `${dayName}, ${d.getDate()} ${UZ_MONTHS[d.getMonth()]}`;
    days.push({ label, date: dateStr, dayName });
  }

  const buttons = days.map(d => [{ text: d.label, callback_data: `book_day:${d.date}:${encodeURIComponent(d.dayName)}:${encodeURIComponent(d.label)}` }]);
  buttons.push([{ text: '⬅️ Xizmatni o\'zgartirish', callback_data: 'book_step:service' }]);
  buttons.push([{ text: '❌ Bekor qilish', callback_data: 'book_cancel' }]);

  await sendTelegramMessage(
    chatId,
    `💈 <b>ONLINE NAVBATGA YOZILISH</b>\n━━━━━━━━━━━━━━━━━━━━\n` +
    `✂️ <b>Xizmat:</b> ${session.serviceName}\n\n` +
    `<b>2-QADAM:</b> Qulay sanani tanlang:`,
    { inline_keyboard: buttons }
  );
}

// ---- Render Bot Times Step ----
async function renderBotTimesStep(chatId: number, messageId?: number) {
  const session = botBookingSessions.get(chatId);
  if (!session || !session.date) return;

  session.step = 'time';

  const sessionBookings = localStore.bookings.filter(
    (b) => (b.date === session.date || (session.date === new Date().toISOString().split('T')[0] && b.dayName && b.dayName.toLowerCase().includes('bugun'))) && b.status !== 'cancelled'
  );

  // Helper: returns true if a given slot (HH:MM) overlaps any existing booking within 45 min
  const isSlotOverlap = (slot: string): boolean => {
    const [sH, sM] = slot.split(':').map(Number);
    const sTotal = sH * 60 + sM;
    return sessionBookings.some((b) => {
      const parts = (b.time || '').split(':');
      if (parts.length < 2) return false;
      const bTotal = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
      return Math.abs(sTotal - bTotal) < 45;
    });
  };

  const text =
    `💈 <b>ONLINE NAVBATGA YOZILISH</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `✂️ <b>Xizmat:</b> ${session.serviceName}\n` +
    `📅 <b>Sana:</b> ${session.fullDateTitle || session.dayName} (${session.date})\n\n` +
    `<b>3-QADAM:</b> O'zingizga qulay bo'sh vaqtni tanlang yoki chatga <b>istalgan aniq vaqtni yozing</b> (Masalan: <code>16:12</code>, <code>16:00</code>):\n` +
    `🟢 — <i>Bo'sh vaqt</i> | 🔴 — <i>Band qilingan</i>\n` +
    `<i>(Ish vaqti: 09:00 dan 22:00 gacha)</i>`;

  const slotButtons: any[] = [];
  let currentRow: any[] = [];

  BOT_TIME_SLOTS.forEach((slot, index) => {
    const isOccupied = isSlotOverlap(slot);
    if (isOccupied) {
      currentRow.push({ text: `🔴 ${slot}`, callback_data: `book_busy:${slot}` });
    } else {
      currentRow.push({ text: `🟢 ${slot}`, callback_data: `book_time:${slot}` });
    }
    if (currentRow.length === 2 || index === BOT_TIME_SLOTS.length - 1) {
      slotButtons.push(currentRow);
      currentRow = [];
    }
  });

  slotButtons.push([{ text: '✍️ Aniq vaqtni yozish (Masalan: 16:12)', callback_data: 'book_ask_custom_time' }]);
  slotButtons.push([{ text: '⬅️ Sanani o\'zgartirish', callback_data: 'book_step:day' }]);
  slotButtons.push([{ text: '❌ Bekor qilish', callback_data: 'book_cancel' }]);

  await sendTelegramMessage(chatId, text, { inline_keyboard: slotButtons });
}

// ---- Render Bot Confirmation Step ----
async function renderBotConfirmationStep(chatId: number) {
  const session = botBookingSessions.get(chatId);
  if (!session) return;
  session.step = 'confirm';

  const text =
    `💈 <b>NAVBAT MA'LUMOTLARI</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `✂️ <b>Xizmat:</b> ${session.serviceName}\n` +
    `💰 <b>Narx:</b> ${formatPrice(session.servicePrice || 0)}\n` +
    `📅 <b>Sana:</b> ${session.fullDateTitle || session.dayName}\n` +
    `⏰ <b>Vaqt:</b> <b>${session.time}</b>\n` +
    `📞 <b>Telefon:</b> ${session.clientPhone || 'Kiritilmagan'}\n\n` +
    `<b>Ma'lumotlar to'g'rimi? Tasdiqlaysizmi?</b>`;

  await sendTelegramMessage(chatId, text, {
    inline_keyboard: [
      [{ text: '✅ Ha, Tasdiqlash!', callback_data: 'book_confirm' }],
      [{ text: '📞 Telefon raqamni o\'zgartirish', callback_data: 'book_change_phone' }],
      [{ text: '⬅️ Vaqtni o\'zgartirish', callback_data: 'book_step:time' }],
      [{ text: '❌ Bekor qilish', callback_data: 'book_cancel' }],
    ],
  });
}

// ---- Admin Panel ----
async function renderAdminPanel(chatId: number) {
  const today = new Date().toISOString().split('T')[0];
  const todayBookings = localStore.bookings.filter(b =>
    isBookingScheduledForToday(b, today) && b.status !== 'cancelled'
  );
  const pending = todayBookings.filter(b => b.status === 'pending').length;
  const confirmed = todayBookings.filter(b => b.status === 'confirmed').length;
  const totalSubs = localStore.subscribers.length;

  const text =
    `🔐 <b>ADMIN PANEL — EMPERIYA BARBERSHOP</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📅 <b>Bugungi navbatlar:</b> ${todayBookings.length} ta\n` +
    `⏳ <b>Kutmoqda:</b> ${pending} ta\n` +
    `✅ <b>Tasdiqlangan:</b> ${confirmed} ta\n` +
    `👥 <b>Jami obunachi:</b> ${totalSubs} ta\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<i>Quyidagi menyudan kerakli amalni tanlang:</i>`;

  await sendTelegramMessage(chatId, text, {
    inline_keyboard: [
      [{ text: '📅 Bugungi Navbatlar', callback_data: 'admin:today' }],
      [{ text: '📋 Barcha Buyurtmalar', callback_data: 'admin:all_orders' }],
      [{ text: '📊 Statistika & Kassa', callback_data: 'admin:stats' }],
      [{ text: '👥 Mijozlar Ro\'yxati', callback_data: 'admin:clients' }],
      [{ text: '📢 Hammaga Xabar Yuborish', callback_data: 'admin:broadcast' }],
      [{ text: '🗑 Barchasini Tozalash', callback_data: 'admin:clear_confirm' }],
    ],
  });
}

// ---- Send Admin Today Schedule ----
async function sendAdminTodaySchedule(chatId: number) {
  const today = new Date().toISOString().split('T')[0];
  const todayBookings = localStore.bookings
    .filter(b => isBookingScheduledForToday(b, today))
    .sort((a, b) => a.time.localeCompare(b.time));

  if (!todayBookings.length) {
    await sendTelegramMessage(chatId, `📅 <b>Bugun hech qanday navbat yo'q.</b>`, ADMIN_KEYBOARD);
    return;
  }

  let text = `📅 <b>BUGUNGI NAVBATLAR (${todayBookings.length} ta):</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  const buttons: any[][] = [];

  for (const b of todayBookings) {
    const statusEmoji = b.status === 'confirmed' ? '✅' : b.status === 'cancelled' ? '❌' : b.status === 'completed' ? '💈' : '⏳';
    text += `${statusEmoji} <b>${b.time}</b> — <b>${b.clientName || b.client_name}</b>\n`;
    text += `   ✂️ ${b.serviceName || b.service_name} | 📞 ${b.clientPhone || b.client_phone}\n\n`;

    if (b.status === 'pending' || b.status === 'confirmed') {
      buttons.push([
        { text: `✅ ${b.time} tasdiqlash`, callback_data: `status:${b.id}:confirmed` },
        { text: `❌ Rad`, callback_data: `status:${b.id}:cancelled` },
      ]);
      if (b.status === 'confirmed') {
        buttons.push([{ text: `💈 ${b.time} Tugatdim`, callback_data: `status:${b.id}:completed` }]);
      }
    }
  }

  await sendTelegramMessage(chatId, text, { inline_keyboard: buttons });
}

// ---- Send Admin All Orders ----
async function sendAdminAllOrders(chatId: number) {
  const all = localStore.bookings.slice(-20).reverse();
  if (!all.length) {
    await sendTelegramMessage(chatId, `📋 <b>Hech qanday buyurtma yo'q.</b>`, ADMIN_KEYBOARD);
    return;
  }
  let text = `📋 <b>SO'NGGI BUYURTMALAR (${all.length} ta):</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  for (const b of all) {
    const statusEmoji = b.status === 'confirmed' ? '✅' : b.status === 'cancelled' ? '❌' : b.status === 'completed' ? '💈' : '⏳';
    text += `${statusEmoji} <b>#${b.id}</b> | ${b.date} ${b.time}\n`;
    text += `   👤 ${b.clientName || b.client_name} | ✂️ ${b.serviceName || b.service_name}\n\n`;
  }
  await sendTelegramMessage(chatId, text, ADMIN_KEYBOARD);
}

// ---- Send Admin Stats ----
async function sendAdminStats(chatId: number) {
  const all = localStore.bookings;
  const completed = all.filter(b => b.status === 'completed' || b.status === 'confirmed');
  const total = completed.reduce((sum, b) => sum + (Number(b.servicePrice || b.service_price) || 0), 0);
  const today = new Date().toISOString().split('T')[0];
  const todayDone = all.filter(b => isBookingScheduledForToday(b, today) && (b.status === 'completed' || b.status === 'confirmed'));
  const todayTotal = todayDone.reduce((sum, b) => sum + (Number(b.servicePrice || b.service_price) || 0), 0);

  const text =
    `📊 <b>STATISTIKA & KASSA</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📅 <b>Bugungi daromad:</b> ${formatPrice(todayTotal)}\n` +
    `📅 <b>Bugungi mijozlar:</b> ${todayDone.length} ta\n\n` +
    `💰 <b>Jami daromad (barcha vaqt):</b> ${formatPrice(total)}\n` +
    `👥 <b>Jami mijozlar:</b> ${completed.length} ta\n` +
    `📦 <b>Jami buyurtmalar:</b> ${all.length} ta\n` +
    `👥 <b>Bot obunachilari:</b> ${localStore.subscribers.length} ta`;

  await sendTelegramMessage(chatId, text, ADMIN_KEYBOARD);
}

// ---- Send Admin Clients List ----
async function sendAdminClientsList(chatId: number) {
  const subs = localStore.subscribers.filter(s => s.role !== 'admin');
  if (!subs.length) {
    await sendTelegramMessage(chatId, `👥 <b>Hech qanday mijoz yo'q.</b>`, ADMIN_KEYBOARD);
    return;
  }
  let text = `👥 <b>MIJOZLAR RO'YXATI (${subs.length} ta):</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  for (const s of subs.slice(0, 30)) {
    text += `👤 <b>${s.first_name || s.username || 'Ism yo\'q'}</b>`;
    if (s.username) text += ` (@${s.username})`;
    if (s.phone) text += `\n   📞 ${s.phone}`;
    text += `\n\n`;
  }
  await sendTelegramMessage(chatId, text, ADMIN_KEYBOARD);
}

// ---- Send Client Services List ----
async function sendClientServicesList(chatId: number) {
  let text = `💰 <b>EMPERIYA BARBERSHOP — XIZMATLAR & NARXLAR:</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  for (const s of SERVICES) {
    text += `✂️ <b>${s.name}</b> — ${formatPrice(s.price)}\n`;
  }
  text += `\n📍 <b>Manzil:</b> Qorasuv massiv, 87-uy\n🕒 <b>Ish vaqti:</b> 09:00 — 22:00`;
  await sendTelegramMessage(chatId, text, {
    inline_keyboard: [[{ text: '✂️ Navbatga Yozilish', callback_data: 'book_step:service' }]],
  });
}

// ---- Send Client My Booking ----
async function sendClientMyBooking(chatId: number, username?: string, firstName?: string) {
  const myBookings = localStore.bookings.filter(b => {
    if (Number(b.clientChatId || b.client_chat_id) === Number(chatId)) return true;
    if (username && b.clientTelegram && b.clientTelegram.replace('@', '').toLowerCase() === username.toLowerCase()) return true;
    return false;
  }).filter(b => b.status === 'pending' || b.status === 'confirmed').slice(-3);

  if (!myBookings.length) {
    await sendTelegramMessage(
      chatId,
      `📅 <b>Sizning faol navbatingiz yo'q.</b>\n\nNavbat olish uchun quyidagi tugmani bosing:`,
      { inline_keyboard: [[{ text: '✂️ Navbatga Yozilish', callback_data: 'book_step:service' }]] }
    );
    return;
  }

  let text = `📅 <b>SIZNING NAVBAT(LAR)INGIZ:</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  for (const b of myBookings) {
    const statusEmoji = b.status === 'confirmed' ? '✅ Tasdiqlangan' : '⏳ Kutmoqda';
    text +=
      `🆔 #${b.id}\n` +
      `📅 ${b.date} ⏰ <b>${b.time}</b>\n` +
      `✂️ ${b.serviceName || b.service_name}\n` +
      `📊 Holat: ${statusEmoji}\n\n`;
  }
  await sendTelegramMessage(chatId, text, CLIENT_KEYBOARD);
}

// ---- Send Client Profile ----
async function sendClientProfile(chatId: number) {
  const sub = localStore.subscribers.find(s => Number(s.chat_id) === Number(chatId));
  const myBookingsCount = localStore.bookings.filter(b =>
    Number(b.clientChatId || b.client_chat_id) === Number(chatId)
  ).length;

  const text =
    `👤 <b>SIZNING PROFILINGIZ:</b>\n━━━━━━━━━━━━━━━━━━━━\n\n` +
    `👤 <b>Ism:</b> ${sub?.first_name || 'Noma\'lum'}\n` +
    `${sub?.username ? `📱 <b>Telegram:</b> @${sub.username}\n` : ''}` +
    `${sub?.phone ? `📞 <b>Telefon:</b> ${sub.phone}\n` : ''}` +
    `🎫 <b>Jami navbatlar:</b> ${myBookingsCount} ta\n` +
    `🔔 <b>Eslatmalar:</b> Yoqilgan ✅`;

  await sendTelegramMessage(chatId, text, CLIENT_KEYBOARD);
}

// ---- Start Bot Booking ----
async function startBotBooking(chatId: number, firstName?: string, username?: string) {
  await registerSubscriber(chatId, username, firstName);
  botBookingSessions.set(chatId, { step: 'service' });
  await renderBotServiceStep(chatId);
}

// ---- getTelegramBotDeepLink (exported for client) ----
function getTelegramBotDeepLink(bookingId: string): string {
  return `https://t.me/imperiiyabarbershop_bot?start=b_${bookingId}`;
}

// ---- Check Booking Reminders ----
// Reminder schedule: 60 min, 10 min, 5 min, 1 min before appointment
async function checkBookingReminders() {
  try {
    const now = new Date();
    const uzParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tashkent',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);

    const year = uzParts.find((p) => p.type === 'year')?.value;
    const month = uzParts.find((p) => p.type === 'month')?.value;
    const day = uzParts.find((p) => p.type === 'day')?.value;
    const hour = parseInt(uzParts.find((p) => p.type === 'hour')?.value || '0', 10);
    const minute = parseInt(uzParts.find((p) => p.type === 'minute')?.value || '0', 10);

    const todayDateStr = `${year}-${month}-${day}`;
    const currentTotalMinutes = hour * 60 + minute;

    for (const b of localStore.bookings) {
      if (!b.time) continue;
      if (b.status !== 'pending' && b.status !== 'confirmed') continue;

      // Only process bookings scheduled for today
      if (!isBookingScheduledForToday(b, todayDateStr)) continue;

      // Auto-resolve clientChatId if missing from subscribers
      let clientChatId = b.clientChatId || b.client_chat_id;
      if (!clientChatId && (b.clientTelegram || b.client_telegram)) {
        const cleanTg = (b.clientTelegram || b.client_telegram).replace('@', '').trim().toLowerCase();
        const foundSub = localStore.subscribers.find((s) => s.username && s.username.toLowerCase() === cleanTg);
        if (foundSub) {
          clientChatId = foundSub.chat_id;
          b.clientChatId = foundSub.chat_id;
          saveLocalStorage();
        }
      }
      if (!clientChatId && (b.clientPhone || b.client_phone)) {
        const cleanP = (b.clientPhone || b.client_phone).replace(/\D/g, '');
        if (cleanP.length >= 7) {
          const foundSub = localStore.subscribers.find((s) => {
            if (!s.phone) return false;
            const subP = s.phone.replace(/\D/g, '');
            return subP.length >= 7 && (subP.endsWith(cleanP.slice(-7)) || cleanP.endsWith(subP.slice(-7)));
          });
          if (foundSub) {
            clientChatId = foundSub.chat_id;
            b.clientChatId = foundSub.chat_id;
            saveLocalStorage();
          }
        }
      }

      const timeParts = b.time.split(':');
      if (timeParts.length < 2) continue;
      const bHour = parseInt(timeParts[0], 10);
      const bMin = parseInt(timeParts[1], 10);
      if (isNaN(bHour) || isNaN(bMin)) continue;

      const bookingTotalMinutes = bHour * 60 + bMin;
      const diffMinutes = bookingTotalMinutes - currentTotalMinutes;

      let reminders: string[] = Array.isArray(b.remindersSent || b.reminders_sent)
        ? (b.remindersSent || b.reminders_sent)
        : [];

      let reminderKey: string | null = null;
      let messageText: string | null = null;

      // 60 min reminder (51m - 70m window)
      if (diffMinutes <= 70 && diffMinutes > 50 && !reminders.includes('60')) {
        reminderKey = '60';
        messageText =
          `⏰ <b>NAVBAT ESLATMASI — 1 SOAT QOLDI!</b>\n\n` +
          `Hurmatli <b>${b.clientName || b.client_name}</b>, sizning <b>Emperiya Barbershop</b>dagi navbatingizga <b>1 soat</b> (60 daqiqa) qoldi!\n\n` +
          `⏰ Belgilangan vaqt: <b>${b.time}</b>\n` +
          `✂️ Xizmat: <b>${b.serviceName || b.service_name}</b>\n` +
          `📍 Manzil: Qorasuv massiv, 87-uy\n` +
          `📞 Usta Asadbek: +998 99 707 00 24\n\n` +
          `<i>Tayyorgarlik ko'rishni boshlashingiz mumkin!</i>`;
      }
      // 10 min reminder (6m - 14m window)
      else if (diffMinutes <= 14 && diffMinutes > 5 && !reminders.includes('10')) {
        reminderKey = '10';
        messageText =
          `⚠️ <b>MUHIM ESLATMA — 10 DAQIQA QOLDI!</b>\n\n` +
          `Hurmatli <b>${b.clientName || b.client_name}</b>, navbatingizga atigi <b>10 daqiqa</b> qoldi!\n\n` +
          `⏰ Belgilangan vaqt: <b>${b.time}</b>\n` +
          `✂️ Xizmat: <b>${b.serviceName || b.service_name}</b>\n` +
          `📍 Manzil: Qorasuv massiv, 87-uy\n` +
          `📞 Usta Asadbek: +998 99 707 00 24\n\n` +
          `🚗 <i>Yo'lga chiqqan bo'lsangiz, yetib borasiz. Usta sizni kutmoqda!</i>`;
      }
      // 5 min reminder (2m - 5m window)
      else if (diffMinutes <= 5 && diffMinutes > 1 && !reminders.includes('5')) {
        reminderKey = '5';
        messageText =
          `🚨 <b>SHOSHILING — 5 DAQIQA QOLDI!</b>\n\n` +
          `Hurmatli <b>${b.clientName || b.client_name}</b>, navbatingizga atigi <b>5 daqiqa</b> qoldi!\n\n` +
          `⏰ Belgilangan vaqt: <b>${b.time}</b>\n` +
          `✂️ Xizmat: <b>${b.serviceName || b.service_name}</b>\n` +
          `📍 Manzil: Qorasuv massiv, 87-uy\n\n` +
          `💨 <b>Iltimos tezroq keling, usta sizni kutmoqda!</b>`;
      }
      // 1 min reminder (0m - 1m or now)
      else if (diffMinutes <= 1 && diffMinutes >= -5 && !reminders.includes('1')) {
        reminderKey = '1';
        messageText =
          `🚨 <b>DIQQAT — NAVBATINGIZ BOSHLANMOQDA!</b>\n\n` +
          `Hurmatli <b>${b.clientName || b.client_name}</b>, sizning navbatingiz boshlanishiga <b>1 daqiqa yoki hozir</b>!\n\n` +
          `⏰ Belgilangan vaqt: <b>${b.time}</b>\n` +
          `✂️ Xizmat: <b>${b.serviceName || b.service_name}</b>\n` +
          `📍 Manzil: Qorasuv massiv, 87-uy (Emperiya Barbershop)\n` +
          `📞 Usta Asadbek: +998 99 707 00 24\n\n` +
          `💈 <b>Usta kresloda sizni kutmoqda, marhamat kiring!</b>`;
      }

      // If client has connected bot, send reminder directly to their chat
      if (reminderKey && messageText && clientChatId) {
        reminders.push(reminderKey);
        b.remindersSent = reminders;
        saveLocalStorage();
        if (dbConnected) {
          updateDbBookingReminders(b.id, reminders).catch(() => {});
        }

        await sendTelegramMessage(clientChatId, messageText, {
          inline_keyboard: [
            [{ text: '📍 Manzil & Lokatsiya', callback_data: `info:location` }],
            [{ text: '📞 Usta bilan aloqa', url: 'tel:+998997070024' }],
          ]
        });

        console.log(`⏰ Sent ${reminderKey}m reminder to client ${b.clientName || b.client_name} (#${b.id}) on chat ${clientChatId}`);

        // ---- AUTO-CONFIRM: 1 daqiqa qolganida, pending navbat avtomatik tasdiqlanadi ----
        if (reminderKey === '1' && b.status === 'pending') {
          b.status = 'confirmed';
          saveLocalStorage();
          if (dbConnected) {
            updateDbBookingStatus(b.id, 'confirmed').catch(() => {});
          }

          console.log(`✅ Auto-confirmed booking #${b.id} for ${b.clientName || b.client_name} at ${b.time}`);

          // Mijozga tasdiqlash xabari
          await sendTelegramMessage(
            clientChatId,
            `✅ <b>Navbatingiz avtomatik tasdiqlandi!</b>\n\n` +
            `⏰ Vaqt: <b>${b.time}</b>\n` +
            `✂️ Xizmat: <b>${b.serviceName || b.service_name}</b>\n` +
            `📍 Manzil: Qorasuv massiv, 87-uy\n\n` +
            `💈 <b>Usta Asadbek sizni kutmoqda!</b>`,
            CLIENT_KEYBOARD
          );

          // Adminlarga xabarnoma
          const adminIds = await getAdminChatIds();
          const autoConfirmAdminText =
            `✅ <b>NAVBAT AVTOMATIK TASDIQLANDI!</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `👤 <b>Mijoz:</b> ${b.clientName || b.client_name}\n` +
            `⏰ <b>Vaqt:</b> <b>${b.time}</b>\n` +
            `📞 <b>Tel:</b> <a href="tel:${b.clientPhone || b.client_phone}">${b.clientPhone || b.client_phone}</a>\n` +
            `✂️ <b>Xizmat:</b> ${b.serviceName || b.service_name}\n` +
            `🆔 <b>ID:</b> #${b.id}\n\n` +
            `<i>Navbat boshlanishiga 1 daqiqa qoldi — avtomatik tasdiqlandi.</i>`;

          for (const aId of adminIds) {
            await sendTelegramMessage(aId, autoConfirmAdminText, {
              inline_keyboard: [
                [{ text: '💈 Tugatdim', callback_data: `status:${b.id}:completed` }],
                [{ text: '❌ Rad etish', callback_data: `status:${b.id}:cancelled` }],
              ],
            });
          }
        }
      }

      // If client has NO bot chat connected, send barber alert when 10 min left
      if (!clientChatId && diffMinutes <= 15 && diffMinutes > 0 && !reminders.includes('admin_alert_10')) {
        reminders.push('admin_alert_10');
        b.remindersSent = reminders;
        saveLocalStorage();
        if (dbConnected) {
          updateDbBookingReminders(b.id, reminders).catch(() => {});
        }

        const adminIds = await getAdminChatIds();
        const alertAdminText =
          `⏰ <b>ESLATMA (10 DAQIQA QOLDI!):</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `👤 <b>Mijoz:</b> <b>${b.clientName || b.client_name}</b>\n` +
          `⏰ <b>Vaqti:</b> <b>${b.time}</b>\n` +
          `📞 <b>Telefon:</b> <a href="tel:${b.clientPhone || b.client_phone}">${b.clientPhone || b.client_phone}</a>\n` +
          `✂️ <b>Xizmat:</b> ${b.serviceName || b.service_name}\n` +
          `⚠️ <i>Mijoz botga ulanmagan. Iltimos, telefon qilib ogohlantiring!</i>`;

        for (const aId of adminIds) {
          await sendTelegramMessage(aId, alertAdminText, {
            inline_keyboard: [
              [{ text: '📞 Qo\'ng\'iroq qilish', url: `tel:${b.clientPhone || b.client_phone}` }],
              [{ text: '✅ Qabul qilish', callback_data: `status:${b.id}:confirmed` }],
            ],
          });
        }
      }

      // ---- AUTO-CONFIRM (bot yo'q): 1 daqiqa qolganida pending navbatni avtomatik tasdiqlash ----
      if (diffMinutes <= 1 && diffMinutes >= -5 && b.status === 'pending' && !reminders.includes('auto_confirmed')) {
        b.status = 'confirmed';
        reminders.push('auto_confirmed');
        b.remindersSent = reminders;
        saveLocalStorage();
        if (dbConnected) {
          updateDbBookingStatus(b.id, 'confirmed').catch(() => {});
          updateDbBookingReminders(b.id, reminders).catch(() => {});
        }

        console.log(`✅ Auto-confirmed (no-bot) booking #${b.id} for ${b.clientName || b.client_name} at ${b.time}`);

        // Adminlarga xabarnoma
        const adminIds2 = await getAdminChatIds();
        const autoConfirmText =
          `✅ <b>NAVBAT AVTOMATIK TASDIQLANDI!</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `👤 <b>Mijoz:</b> ${b.clientName || b.client_name}\n` +
          `⏰ <b>Vaqt:</b> <b>${b.time}</b>\n` +
          `📞 <b>Tel:</b> <a href="tel:${b.clientPhone || b.client_phone}">${b.clientPhone || b.client_phone}</a>\n` +
          `✂️ <b>Xizmat:</b> ${b.serviceName || b.service_name}\n` +
          `🆔 <b>ID:</b> #${b.id}\n\n` +
          `<i>Navbat boshlanishiga 1 daqiqa qoldi — avtomatik tasdiqlandi.</i>`;

        for (const aId of adminIds2) {
          await sendTelegramMessage(aId, autoConfirmText, {
            inline_keyboard: [
              [{ text: '💈 Tugatdim', callback_data: `status:${b.id}:completed` }],
              [{ text: '❌ Rad etish', callback_data: `status:${b.id}:cancelled` }],
            ],
          });
        }
      }
    }
  } catch (err) {
    console.error('Error in checkBookingReminders:', err);
  }
}

// ---- Start Reminder Interval ----
function startReminderInterval() {
  checkBookingReminders();
  setInterval(checkBookingReminders, 20000); // every 20 seconds
}

// ---- Handle Telegram Message ----
async function handleTelegramMessage(msg: any) {
  const chatId: number = msg.chat?.id;
  const text: string = msg.text || '';
  const username: string = msg.from?.username || '';
  const firstName: string = msg.from?.first_name || '';

  if (!chatId) return;

  // 1. /start command
  if (text.startsWith('/start')) {
    const param = text.split(' ')[1] || '';

    // Deep link: /start b_EMP-1234
    if (param.startsWith('b_')) {
      const bookingId = param.slice(2);
      await registerSubscriber(chatId, username, firstName);

      let booking = localStore.bookings.find(b => b.id === bookingId);
      if (!booking && dbConnected) {
        try {
          const dbBookings = await getDbBookings();
          booking = dbBookings.find(b => b.id === bookingId);
          if (booking && !localStore.bookings.find(b => b.id === bookingId)) {
            localStore.bookings.push(booking);
            saveLocalStorage();
          }
        } catch {}
      }

      if (booking) {
        booking.clientChatId = chatId;
        saveLocalStorage();
        if (dbConnected) updateDbBookingChatId(bookingId, String(chatId)).catch(() => {});

        await sendTelegramMessage(
          chatId,
          `✅ <b>Siz navbat eslatma tizimiga ulandingiz!</b>\n\n` +
          `🆔 Navbat: <b>#${booking.id}</b>\n` +
          `📅 Sana: <b>${booking.date}</b>\n` +
          `⏰ Vaqt: <b>${booking.time}</b>\n` +
          `✂️ Xizmat: <b>${booking.serviceName || booking.service_name}</b>\n\n` +
          `🔔 Navbatingizga <b>1 soat, 10 daqiqa, 5 daqiqa va 1 daqiqa</b> qolganda eslatma olasiz!\n\n` +
          `<i>Sartaroshxonaga xush kelibsiz!</i>`,
          CLIENT_KEYBOARD
        );
      } else {
        await sendTelegramMessage(
          chatId,
          `⚠️ <b>Navbat topilmadi.</b> (#${bookingId})\n\nYangi navbat olish uchun quyidagi tugmani bosing:`,
          { inline_keyboard: [[{ text: '✂️ Navbatga Yozilish', callback_data: 'book_step:service' }]] }
        );
      }
      return;
    }

    // Normal /start
    await registerSubscriber(chatId, username, firstName);
    const isAdmin = isUserAdmin(chatId, username);

    const welcomeText =
      `💈 <b>EMPERIYA BARBERSHOP BOTIGA XUSH KELIBSIZ!</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Assalomu alaykum, <b>${firstName || username || 'Hurmatli mijoz'}</b>! 👋\n\n` +
      `🏆 <b>Erkinov Asadbek</b> — professional sartarosh\n` +
      `📍 <b>Manzil:</b> Qorasuv massiv, 87-uy\n` +
      `🕒 <b>Ish vaqti:</b> 09:00 — 22:00 (har kuni)\n\n` +
      `Quyidagi menyudan kerakli bo'limni tanlang:`;

    await sendTelegramMessage(chatId, welcomeText, isAdmin ? ADMIN_KEYBOARD : CLIENT_KEYBOARD);
    return;
  }

  // 2. /admin command
  if (text === '/admin' || text === '/panel') {
    if (!isUserAdmin(chatId, username)) {
      await sendTelegramMessage(chatId, `🔒 <b>Ruxsat yo'q.</b> Parolni kiriting:`, CLIENT_KEYBOARD);
      adminSessions.set(chatId, { action: 'await_admin_password' });
      return;
    }
    await renderAdminPanel(chatId);
    return;
  }

  // 3. ADMIN SESSIONS: Password & Broadcast
  const adminSession = adminSessions.get(chatId);

  if (adminSession?.action === 'await_admin_password') {
    if (text === 'admin123' || text === 'erkinov' || text === 'asadbek') {
      adminSessions.delete(chatId);
      await renderAdminPanel(chatId);
      return;
    } else {
      adminSessions.delete(chatId);
      await sendTelegramMessage(chatId, `❌ <b>Noto'g'ri parol.</b>`, CLIENT_KEYBOARD);
      return;
    }
  }

  if (adminSession?.action === 'broadcast') {
    if (text === '/cancel' || text === '❌ Bekor qilish') {
      adminSessions.delete(chatId);
      await sendTelegramMessage(chatId, 'E\'lon tarqatish bekor qilindi.', ADMIN_KEYBOARD);
      await renderAdminPanel(chatId);
      return;
    }

    adminSessions.delete(chatId);
    const broadcastMsg =
      `📢 <b>EMPERIYA BARBERSHOP — RASMIY E'LON:</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `${text}\n\n` +
      `💈 <b>Sartarosh:</b> Erkinov Asadbek\n` +
      `📞 <b>Aloqa:</b> +998 99 707 00 24`;

    let sentCount = 0;
    for (const sub of localStore.subscribers) {
      if (Number(sub.chat_id) !== Number(chatId)) {
        try {
          await sendTelegramMessage(sub.chat_id, broadcastMsg, CLIENT_KEYBOARD);
          sentCount++;
        } catch {}
      }
    }

    await sendTelegramMessage(
      chatId,
      `✅ <b>Xabarnoma muvaffaqiyatli tarqatildi!</b>\n\nJami: <b>${sentCount} ta</b> foydalanuvchiga yuborildi.`,
      ADMIN_KEYBOARD
    );
    return;
  }

  // 4. ACTIVE BOOKING SESSION INPUTS
  const activeSession = botBookingSessions.get(chatId);
  if (activeSession) {
    // A. Custom time input (e.g. 16:12, 16 12, 16.12, 16:00)
    const timeMatch = text.match(/^(\d{1,2})[:.\ -](\d{2})$/);
    if (activeSession.step === 'time' || (timeMatch && !activeSession.time)) {
      if (timeMatch) {
        const hour = parseInt(timeMatch[1], 10);
        const min = parseInt(timeMatch[2], 10);
        if (hour >= 9 && hour <= 22 && (hour < 22 || min === 0) && min >= 0 && min <= 59) {
          const formattedTime = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
          const isOccupied = localStore.bookings.some((b) => {
            if (b.date !== activeSession.date) return false;
            if (b.status === 'cancelled') return false;
            const parts = (b.time || '').split(':');
            if (parts.length < 2) return false;
            const bTotal = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
            const newTotal = hour * 60 + min;
            return Math.abs(newTotal - bTotal) < 45;
          });
          if (isOccupied) {
            await sendTelegramMessage(
              chatId,
              `⚠️ <b>Kechirasiz!</b> ${formattedTime} vaqti (±45 daqiqa) allaqachon band qilingan.\nIltimos, boshqa vaqtni tanlang yoki yozing:`
            );
            return;
          }

          activeSession.time = formattedTime;
          await sendTelegramMessage(chatId, `⏰ Tanlangan vaqtingiz: <b>${formattedTime}</b> qabul qilindi!`);
          await renderBotConfirmationStep(chatId);
          return;
        } else {
          await sendTelegramMessage(
            chatId,
            `⚠️ <b>Noto'g'ri vaqt!</b>\nSartaroshxona ish vaqti: <b>09:00 dan 22:00 gacha</b>.\nIltimos, ushbu oraliqdagi vaqtni yozing (Masalan: <code>16:12</code>):`
          );
          return;
        }
      } else if (activeSession.step === 'time') {
        await sendTelegramMessage(
          chatId,
          `⚠️ Iltimos, vaqtni to'g'ri formatda yozing (Masalan: <code>16:12</code> yoki <code>16:00</code>):`
        );
        return;
      }
    }

    // B. Phone input
    let inputPhone = '';
    if (text && (/^(\+?998|8)?\s*[\d\s-]{7,14}$/.test(text) || activeSession.step === 'phone')) {
      inputPhone = text.replace(/[\s-]/g, '');
    }

    if (inputPhone) {
      activeSession.clientPhone = inputPhone.startsWith('+') ? inputPhone : (inputPhone.startsWith('998') ? `+${inputPhone}` : `+998${inputPhone}`);
      await registerSubscriber(chatId, username, firstName, undefined, activeSession.clientPhone);
      await sendTelegramMessage(chatId, `📞 Telefon raqamingiz qabul qilindi: <b>${activeSession.clientPhone}</b>`);
      await renderBotConfirmationStep(chatId);
      return;
    }
  }

  // 5. /cancel command
  if (text === '/cancel' || text === '❌ Bekor qilish') {
    botBookingSessions.delete(chatId);
    adminSessions.delete(chatId);
    await sendTelegramMessage(chatId, `❌ <b>Bekor qilindi.</b>`, isUserAdmin(chatId, username) ? ADMIN_KEYBOARD : CLIENT_KEYBOARD);
    return;
  }

  // 6. Admin Panel button
  if (text === '📊 Admin Panel' || text === '/admin_panel') {
    if (!isUserAdmin(chatId, username)) {
      await sendTelegramMessage(chatId, `🔒 Ruxsat yo'q.`, CLIENT_KEYBOARD);
      return;
    }
    await renderAdminPanel(chatId);
    return;
  }

  // 7. Book button
  if (text === '✂️ Navbatga Yozilish' || text === '/book' || text === '/navbat') {
    await startBotBooking(chatId, firstName, username);
    return;
  }

  // 8. My Booking
  if (text === '📅 Mening Navbatim' || text === '/mybooking' || text === '/status') {
    await sendClientMyBooking(chatId, username, firstName);
    return;
  }

  // 9. Services
  if (text === '💰 Narxlar & Xizmatlar' || text === '/services' || text === '/narxlar') {
    await sendClientServicesList(chatId);
    return;
  }

  // 10. Profile
  if (text === '👤 Profilim' || text === '/profile') {
    await sendClientProfile(chatId);
    return;
  }

  // 11. Free time slots
  if (text === '🕒 Bo\'sh Vaqtlar' || text === '/free' || text === '/bosh') {
    const todayStr = new Date().toISOString().split('T')[0];
    const todayBookings2 = localStore.bookings
      .filter((b) => (b.date === todayStr || (b.dayName && b.dayName.toLowerCase().includes('bugun'))) && b.status !== 'cancelled');

    const isStdSlotBlocked = (slot: string): boolean => {
      const [sH2, sM2] = slot.split(':').map(Number);
      const sTotal2 = sH2 * 60 + sM2;
      return todayBookings2.some((b) => {
        const parts = (b.time || '').split(':');
        if (parts.length < 2) return false;
        const bTotal2 = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
        return Math.abs(sTotal2 - bTotal2) < 45;
      });
    };

    const allSlots = BOT_TIME_SLOTS;
    let slotText = `🕒 <b>BUGUNGI VAQTLAR HOLATI (YARIM SOATLIK INTERVALLAR):</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
    allSlots.forEach((slot) => {
      if (isStdSlotBlocked(slot)) {
        slotText += `🔴 <b>${slot}</b> — Band\n`;
      } else {
        slotText += `🟢 <b>${slot}</b> — <b>Bo'sh (Ochiq)</b>\n`;
      }
    });

    const customTimeBookings = todayBookings2.filter((b) => b.time && !BOT_TIME_SLOTS.includes(b.time));
    if (customTimeBookings.length > 0) {
      slotText += `\n📌 <b>Aniq vaqtdagi navbatlar:</b>\n`;
      customTimeBookings.forEach((b) => {
        slotText += `🔴 <b>${b.time}</b> — ${b.clientName || 'Mijoz'} (Aniq vaqt)\n`;
      });
    }

    slotText += `\n<i>Eslatma: Sartarosh navbatni "Tugatdim" deb belgilasa, o'sha soatdagi joy avtomatik bo'shaydi.</i>`;

    await sendTelegramMessage(chatId, slotText, {
      inline_keyboard: [
        [{ text: '✂️ Navbatga Yozilish', callback_data: 'book_step:service' }],
      ]
    });
    return;
  }

  // 12. Location
  if (text === '📍 Manzil & Joylashuv' || text === '/location' || text === '/manzil' || text.includes('Manzil')) {
    await sendTelegramMessage(chatId,
      `📍 <b>EMPERIYA BARBERSHOP MANZILI:</b>\n\n` +
      `🏢 <b>Mo'ljal:</b> Qorasuv massiv markaziy yo'li, 87-uy (Samarqand)\n` +
      `🕒 <b>Ish vaqti:</b> Har kuni 09:00 — 22:00\n` +
      `💈 <b>Sartarosh:</b> Erkinov Asadbek\n` +
      `📞 <b>Aloqa:</b> +998 99 707 00 24 / +998 93 056 56 33`,
      { inline_keyboard: [[{ text: '📞 Qo\'ng\'iroq qilish', url: 'tel:+998997070024' }]] }
    );
    return;
  }

  // 13. Contact
  if (text === '📞 Usta bilan aloqa' || text === '/contact' || text === '/aloqa') {
    await sendTelegramMessage(chatId,
      `📞 <b>EMPERIYA BARBERSHOP ALOQA:</b>\n\n` +
      `👤 <b>Sartarosh:</b> Erkinov Asadbek\n` +
      `📱 <b>Telefon 1:</b> +998 99 707 00 24\n` +
      `📱 <b>Telefon 2:</b> +998 93 056 56 33\n` +
      `📱 <b>Telegram:</b> @Erkinov5633`,
      { inline_keyboard: [[{ text: '📞 Qo\'ng\'iroq qilish', url: 'tel:+998997070024' }]] }
    );
    return;
  }

  // 14. Admin-only: Today's schedule
  if (text === '📅 Bugungi Navbatlar' || text === '/today' || text === '/bugun') {
    if (isUserAdmin(chatId, username)) {
      await sendAdminTodaySchedule(chatId);
    } else {
      await sendClientMyBooking(chatId, username, firstName);
    }
    return;
  }

  // 15. Admin-only: All orders
  if (text === '📋 Barcha Buyurtmalar' || text === '/orders' || text === '/buyurtmalar') {
    if (!isUserAdmin(chatId, username)) {
      await sendTelegramMessage(chatId, `🔒 Ushbu bo'lim faqat administratorlar uchun.`, CLIENT_KEYBOARD);
      return;
    }
    await sendAdminAllOrders(chatId);
    return;
  }

  // 16. Admin-only: Stats
  if (text === '📊 Statistika & Kassa' || text === '/stats') {
    if (!isUserAdmin(chatId, username)) {
      await sendTelegramMessage(chatId, `🔒 Ushbu bo'lim faqat administratorlar uchun.`, CLIENT_KEYBOARD);
      return;
    }
    await sendAdminStats(chatId);
    return;
  }

  // 17. Admin-only: Broadcast
  if (text === '📢 Xabar Yuborish') {
    if (!isUserAdmin(chatId, username)) {
      await sendTelegramMessage(chatId, `🔒 Ushbu bo'lim faqat administratorlar uchun.`, CLIENT_KEYBOARD);
      return;
    }
    adminSessions.set(chatId, { action: 'broadcast' });
    await sendTelegramMessage(
      chatId,
      `✍️ <b>Barcha ro'yxatdan o'tgan mijozlarga yubormoqchi bo'lgan xabarni chatga yozing:</b>\n\n<i>(Bekor qilish uchun /cancel deb yozing)</i>`
    );
    return;
  }

  // 18. Admin-only: Clients list
  if (text === '👥 Mijozlar Ro\'yxati') {
    if (!isUserAdmin(chatId, username)) {
      await sendTelegramMessage(chatId, `🔒 Ushbu bo'lim faqat administratorlar uchun.`, CLIENT_KEYBOARD);
      return;
    }
    await sendAdminClientsList(chatId);
    return;
  }

  // 19. Admin-only: Clear all
  if (text === '🗑 Barchasini Tozalash' || text === '/clear' || text === '/reset') {
    if (!isUserAdmin(chatId, username)) {
      await sendTelegramMessage(chatId, `🔒 Ushbu bo'lim faqat administratorlar uchun.`, CLIENT_KEYBOARD);
      return;
    }
    await sendTelegramMessage(chatId,
      `⚠️ <b>DIQQAT:</b> Barcha mavjud online navbatlarni tozalab, o'chirib tashlamoqchimisiz?`,
      {
        inline_keyboard: [
          [{ text: '🗑 Ha, Barchasini O\'chir!', callback_data: 'admin:clear_all' }],
          [{ text: '❌ Yo\'q, Bekor qilish', callback_data: 'admin:cancel' }],
        ]
      }
    );
    return;
  }

  // 20. Admin-only: Mijoz Rejimi
  if (text === '👤 Mijoz Rejimi') {
    if (isUserAdmin(chatId, username)) {
      await sendTelegramMessage(chatId, `👤 <b>Siz mijoz ko'rinishiga o'tdingiz.</b>\nQayta admin panelga o'tish uchun <b>/admin</b> deb yozing.`, CLIENT_KEYBOARD);
      return;
    }
  }

  // Default: show menu
  await sendTelegramMessage(
    chatId,
    `💈 Botdan foydalanish uchun quyidagi menyudan tanlang:`,
    isUserAdmin(chatId, username) ? ADMIN_KEYBOARD : CLIENT_KEYBOARD
  );
}

// ---- Handle Telegram Callback ----
async function handleTelegramCallback(cb: any) {
  const chatId: number = cb.message?.chat?.id;
  const data: string = cb.data || '';
  const callbackQueryId: string = cb.id;
  const username: string = cb.from?.username || '';
  const firstName: string = cb.from?.first_name || '';

  if (!chatId) return;
  await answerCallbackQuery(callbackQueryId);

  // ---- Booking Flow Callbacks ----

  // book_step:service / book_step:day / book_step:time
  if (data.startsWith('book_step:')) {
    const step = data.split(':')[1];
    if (step === 'service') {
      await renderBotServiceStep(chatId);
    } else if (step === 'day') {
      await renderBotDayStep(chatId);
    } else if (step === 'time') {
      await renderBotTimesStep(chatId);
    }
    return;
  }

  // book_cancel
  if (data === 'book_cancel') {
    botBookingSessions.delete(chatId);
    await sendTelegramMessage(chatId, `❌ <b>Navbat olish bekor qilindi.</b>`, isUserAdmin(chatId, username) ? ADMIN_KEYBOARD : CLIENT_KEYBOARD);
    return;
  }

  // book_service:id
  if (data.startsWith('book_service:')) {
    const serviceId = data.split(':')[1];
    const service = SERVICES.find(s => s.id === serviceId);
    if (!service) return;

    const session = botBookingSessions.get(chatId) || { step: 'service' as const };
    session.serviceId = service.id;
    session.serviceName = service.name;
    session.servicePrice = service.price;
    botBookingSessions.set(chatId, session);

    await renderBotDayStep(chatId);
    return;
  }

  // book_day:date:dayName:fullDateTitle
  if (data.startsWith('book_day:')) {
    const parts = data.split(':');
    const date = parts[1];
    const dayName = decodeURIComponent(parts[2] || '');
    const fullDateTitle = decodeURIComponent(parts.slice(3).join(':') || '');

    const session = botBookingSessions.get(chatId);
    if (!session) return;
    session.date = date;
    session.dayName = dayName;
    session.fullDateTitle = fullDateTitle;
    botBookingSessions.set(chatId, session);

    await renderBotTimesStep(chatId);
    return;
  }

  // book_time:HH:MM
  if (data.startsWith('book_time:')) {
    const timeParts = data.split(':');
    const time = `${timeParts[1]}:${timeParts[2]}`;
    const session = botBookingSessions.get(chatId);
    if (!session) return;
    session.time = time;
    botBookingSessions.set(chatId, session);

    // Check if user has phone
    if (!session.clientPhone) {
      const sub = localStore.subscribers.find(s => Number(s.chat_id) === Number(chatId));
      if (sub?.phone) {
        session.clientPhone = sub.phone;
      } else {
        session.step = 'phone';
        await sendTelegramMessage(chatId,
          `📞 <b>Telefon raqamingizni kiriting:</b>\n<i>Masalan: +998 90 123 45 67</i>`
        );
        return;
      }
    }

    await renderBotConfirmationStep(chatId);
    return;
  }

  // book_busy:HH:MM
  if (data.startsWith('book_busy:')) {
    await answerCallbackQuery(callbackQueryId, '🔴 Bu vaqt band qilingan!');
    return;
  }

  // book_ask_custom_time
  if (data === 'book_ask_custom_time') {
    const session = botBookingSessions.get(chatId);
    if (!session) return;
    session.step = 'time';
    botBookingSessions.set(chatId, session);
    await sendTelegramMessage(chatId,
      `✍️ <b>Istalgan vaqtni yozing:</b>\n\n` +
      `Masalan: <code>16:12</code> yoki <code>13:37</code> yoki <code>9:00</code>\n\n` +
      `<i>Ish vaqti: 09:00 dan 22:00 gacha</i>`
    );
    return;
  }

  // book_change_phone
  if (data === 'book_change_phone') {
    const session = botBookingSessions.get(chatId);
    if (!session) return;
    session.step = 'phone';
    botBookingSessions.set(chatId, session);
    await sendTelegramMessage(chatId, `📞 Yangi telefon raqamingizni kiriting:\n<i>Masalan: +998 90 123 45 67</i>`);
    return;
  }

  // book_confirm
  if (data === 'book_confirm') {
    const session = botBookingSessions.get(chatId);
    if (!session || !session.time || !session.date) {
      await sendTelegramMessage(chatId, `⚠️ Navbat ma'lumotlari to'liq emas. Qaytadan boshlang.`, CLIENT_KEYBOARD);
      return;
    }

    const booking = await finalizeBotBooking(chatId, session, username, firstName);

    await sendTelegramMessage(chatId,
      `✅ <b>NAVBAT MUVAFFAQIYATLI QABUL QILINDI!</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🆔 <b>Navbat ID:</b> #${booking.id}\n` +
      `✂️ <b>Xizmat:</b> ${booking.serviceName}\n` +
      `💰 <b>Narx:</b> ${formatPrice(booking.servicePrice)}\n` +
      `📅 <b>Sana:</b> ${booking.date}\n` +
      `⏰ <b>Vaqt:</b> <b>${booking.time}</b>\n\n` +
      `🔔 Navbatingizga <b>1 soat, 10 daqiqa, 5 daqiqa va 1 daqiqa</b> qolganda eslatma olasiz!\n\n` +
      `📍 <b>Manzil:</b> Qorasuv massiv, 87-uy\n` +
      `📞 <b>Usta Asadbek:</b> +998 99 707 00 24`,
      CLIENT_KEYBOARD
    );
    return;
  }

  // ---- Status Change Callbacks ----
  if (data.startsWith('status:')) {
    if (!isUserAdmin(chatId, username)) {
      await sendTelegramMessage(chatId, `🔒 Ruxsat yo'q.`, CLIENT_KEYBOARD);
      return;
    }
    const parts = data.split(':');
    const bookingId = parts[1];
    const newStatus = parts[2];

    const booking = localStore.bookings.find(b => b.id === bookingId);
    if (!booking) {
      await sendTelegramMessage(chatId, `⚠️ Navbat topilmadi: #${bookingId}`);
      return;
    }

    booking.status = newStatus;
    saveLocalStorage();
    if (dbConnected) updateDbBookingStatus(bookingId, newStatus).catch(() => {});

    const statusText = newStatus === 'confirmed' ? '✅ Tasdiqlandi' : newStatus === 'cancelled' ? '❌ Rad etildi' : newStatus === 'completed' ? '💈 Tugatildi' : newStatus;
    await sendTelegramMessage(chatId, `${statusText}: <b>#${bookingId}</b> — ${booking.clientName || booking.client_name}`);

    // Notify client about status change
    const clientChatId = booking.clientChatId || booking.client_chat_id;
    if (clientChatId) {
      let clientMsg = '';
      if (newStatus === 'confirmed') {
        clientMsg = `✅ <b>Navbatingiz tasdiqlandi!</b>\n\n⏰ Vaqt: <b>${booking.time}</b>\n✂️ ${booking.serviceName || booking.service_name}\n📍 Qorasuv massiv, 87-uy\n\n<i>Usta Asadbek sizni kutmoqda!</i>`;
      } else if (newStatus === 'cancelled') {
        clientMsg = `❌ <b>Navbatingiz bekor qilindi.</b>\n\nUsta Asadbek bilan bog'laning: +998 99 707 00 24\n\nYangi navbat olish uchun /book`;
      } else if (newStatus === 'completed') {
        clientMsg = `💈 <b>Navbatingiz tugadi!</b>\n\nEmpériya Barbershopga tashrif buyurganingiz uchun rahmat!\n\nQayta navbat olish uchun /book`;
      }
      if (clientMsg) await sendTelegramMessage(clientChatId, clientMsg, CLIENT_KEYBOARD);
    }

    // If completed, notify next client
    if (newStatus === 'completed') {
      await notifyNextInlineClient(booking);
    }
    return;
  }

  // ---- Info Callbacks ----
  if (data === 'info:location') {
    await sendTelegramMessage(chatId,
      `📍 <b>Manzil:</b> Qorasuv massiv, 87-uy (Samarqand)\n🕒 <b>Ish vaqti:</b> 09:00 — 22:00\n📞 <b>Tel:</b> +998 99 707 00 24`
    );
    return;
  }

  // ---- Admin Callbacks ----
  if (data === 'admin:today') {
    if (!isUserAdmin(chatId, username)) return;
    await sendAdminTodaySchedule(chatId);
    return;
  }

  if (data === 'admin:all_orders') {
    if (!isUserAdmin(chatId, username)) return;
    await sendAdminAllOrders(chatId);
    return;
  }

  if (data === 'admin:stats') {
    if (!isUserAdmin(chatId, username)) return;
    await sendAdminStats(chatId);
    return;
  }

  if (data === 'admin:clients') {
    if (!isUserAdmin(chatId, username)) return;
    await sendAdminClientsList(chatId);
    return;
  }

  if (data === 'admin:broadcast') {
    if (!isUserAdmin(chatId, username)) return;
    adminSessions.set(chatId, { action: 'broadcast' });
    await sendTelegramMessage(chatId,
      `✍️ <b>Barcha ro'yxatdan o'tgan mijozlarga yubormoqchi bo'lgan xabarni chatga yozing:</b>\n\n<i>(Bekor qilish uchun /cancel)</i>`
    );
    return;
  }

  if (data === 'admin:clear_confirm') {
    if (!isUserAdmin(chatId, username)) return;
    await sendTelegramMessage(chatId,
      `⚠️ <b>DIQQAT:</b> Barcha navbatlarni o'chirishni tasdiqlaysizmi?`,
      {
        inline_keyboard: [
          [{ text: '🗑 Ha, O\'chir!', callback_data: 'admin:clear_all' }],
          [{ text: '❌ Bekor', callback_data: 'admin:cancel' }],
        ]
      }
    );
    return;
  }

  if (data === 'admin:clear_all') {
    if (!isUserAdmin(chatId, username)) return;
    const count = localStore.bookings.length;
    localStore.bookings = [];
    saveLocalStorage();
    if (dbConnected) clearAllDbBookings().catch(() => {});
    await sendTelegramMessage(chatId, `🗑 <b>Jami ${count} ta navbat o'chirildi.</b>`, ADMIN_KEYBOARD);
    return;
  }

  if (data === 'admin:cancel') {
    await sendTelegramMessage(chatId, `✅ Bekor qilindi.`, ADMIN_KEYBOARD);
    return;
  }
}

// ---- Telegram Long Polling ----
let pollingOffset = 0;
let isPolling = false;
let pollingActive = false;

async function startTelegramPolling() {
  if (!BOT_TOKEN) {
    console.warn('⚠️ TELEGRAM_BOT_TOKEN not set. Bot will not run.');
    return;
  }
  pollingActive = true;
  isPolling = true;
  console.log('🤖 Telegram bot polling started...');

  const poll = async () => {
    if (!pollingActive) return;
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${pollingOffset}&timeout=25&allowed_updates=["message","callback_query"]`,
        { signal: AbortSignal.timeout(30000) }
      );
      if (!res.ok) {
        await new Promise(r => setTimeout(r, 3000));
        poll();
        return;
      }
      const data = await res.json();
      if (data.ok && data.result?.length) {
        for (const update of data.result) {
          pollingOffset = update.update_id + 1;
          try {
            if (update.message) {
              await handleTelegramMessage(update.message);
            } else if (update.callback_query) {
              await handleTelegramCallback(update.callback_query);
            }
          } catch (e) {
            console.error('⚠️ Error handling update:', e);
          }
        }
      }
    } catch (e: any) {
      if (e.name !== 'AbortError' && e.name !== 'TimeoutError') {
        console.warn('⚠️ Polling error:', e.message);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
    if (pollingActive) setTimeout(poll, 100);
  };

  poll();
}

// ---- Express API Routes ----

// GET /api/bookings
app.get('/api/bookings', async (req, res) => {
  try {
    if (dbConnected) {
      const bookings = await getDbBookings();
      return res.json(bookings);
    }
    res.json(localStore.bookings);
  } catch {
    res.json(localStore.bookings);
  }
});

// POST /api/bookings
app.post('/api/bookings', async (req, res) => {
  try {
    const booking = req.body;
    if (!booking.id) booking.id = 'EMP-' + Math.floor(1000 + Math.random() * 9000);
    booking.status = booking.status || 'pending';
    booking.remindersSent = booking.remindersSent || [];
    booking.createdAt = booking.createdAt || new Date().toISOString();

    // Auto-link clientChatId from phone
    if (!booking.clientChatId && booking.clientPhone) {
      const cleanP = booking.clientPhone.replace(/\D/g, '');
      const foundSub = localStore.subscribers.find(s => {
        if (!s.phone) return false;
        const subP = s.phone.replace(/\D/g, '');
        return subP.length >= 7 && (subP.endsWith(cleanP.slice(-7)) || cleanP.endsWith(subP.slice(-7)));
      });
      if (foundSub) booking.clientChatId = foundSub.chat_id;
    }

    localStore.bookings.push(booking);
    saveLocalStorage();

    if (dbConnected) {
      try { await insertDbBooking(booking as BookingRecord); } catch {}
    }

    await notifyAdminsNewBooking(booking);
    res.json(booking);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/bookings/:id/status
app.patch('/api/bookings/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const booking = localStore.bookings.find(b => b.id === id);
    if (!booking) return res.status(404).json({ error: 'Not found' });

    booking.status = status;
    saveLocalStorage();
    if (dbConnected) updateDbBookingStatus(id, status).catch(() => {});

    // Notify client
    const clientChatId = booking.clientChatId || booking.client_chat_id;
    if (clientChatId) {
      let clientMsg = '';
      if (status === 'confirmed') {
        clientMsg = `✅ <b>Navbatingiz tasdiqlandi!</b>\n\n⏰ Vaqt: <b>${booking.time}</b>\n✂️ ${booking.serviceName || booking.service_name}\n📍 Qorasuv massiv, 87-uy\n\n<i>Usta Asadbek sizni kutmoqda!</i>`;
      } else if (status === 'cancelled') {
        clientMsg = `❌ <b>Navbatingiz bekor qilindi.</b>\n\nUsta bilan bog'laning: +998 99 707 00 24`;
      } else if (status === 'completed') {
        clientMsg = `💈 <b>Navbatingiz tugadi!</b>\n\nEmpériya Barbershopga tashrif buyurganingiz uchun rahmat!`;
      }
      if (clientMsg) await sendTelegramMessage(clientChatId, clientMsg, CLIENT_KEYBOARD);
    }

    if (status === 'completed') {
      await notifyNextInlineClient(booking);
    }

    // Find next pending booking to return
    const today = new Date().toISOString().split('T')[0];
    const nextClient = localStore.bookings.find(b =>
      isBookingScheduledForToday(b, today) && b.status === 'pending'
    );

    res.json({ ok: true, nextClient });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/bookings/:id
app.delete('/api/bookings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    localStore.bookings = localStore.bookings.filter(b => b.id !== id);
    saveLocalStorage();
    if (dbConnected) deleteDbBooking(id).catch(() => {});
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/bookings/clear-all
app.post('/api/bookings/clear-all', async (req, res) => {
  try {
    localStore.bookings = [];
    saveLocalStorage();
    if (dbConnected) clearAllDbBookings().catch(() => {});
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/db-status
app.get('/api/db-status', async (req, res) => {
  try {
    if (dbConnected) {
      const bookings = await getDbBookings();
      res.json({
        status: 'connected',
        database: 'PostgreSQL',
        totalBookings: bookings.length,
        currentTime: new Date().toISOString(),
      });
    } else {
      res.json({ status: 'error', database: 'PostgreSQL', message: 'Not connected' });
    }
  } catch (e: any) {
    res.json({ status: 'error', database: 'PostgreSQL', message: e.message });
  }
});

// GET /api/telegram/status
app.get('/api/telegram/status', (req, res) => {
  res.json({
    configured: !!BOT_TOKEN,
    botUsername: 'imperiiyabarbershop_bot',
    botUrl: 'https://t.me/imperiiyabarbershop_bot',
    isPolling,
    subscribersCount: localStore.subscribers.length,
  });
});

// GET /api/telegram/subscribers
app.get('/api/telegram/subscribers', (req, res) => {
  res.json(localStore.subscribers.map(s => ({
    chat_id: String(s.chat_id),
    username: s.username,
    first_name: s.first_name,
    role: s.role,
    created_at: s.created_at,
  })));
});

// POST /api/telegram/test
app.post('/api/telegram/test', async (req, res) => {
  try {
    const adminIds = await getAdminChatIds();
    for (const id of adminIds) {
      await sendTelegramMessage(id, `🧪 <b>Test xabar!</b>\n\nEmpériya Barbershop bot ishlayapti. ✅`);
    }
    res.json({ success: true, message: `Test xabar ${adminIds.length} ta adminga yuborildi.` });
  } catch (e: any) {
    res.json({ success: false, message: e.message });
  }
});

// POST /api/telegram/trigger-reminders
app.post('/api/telegram/trigger-reminders', async (req, res) => {
  try {
    await checkBookingReminders();
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/telegram/add-admin
app.post('/api/telegram/add-admin', async (req, res) => {
  try {
    const { chatId } = req.body;
    const sub = localStore.subscribers.find(s => Number(s.chat_id) === Number(chatId));
    if (sub) {
      sub.role = 'admin';
      saveLocalStorage();
      if (dbConnected) upsertDbSubscriber({ ...sub, role: 'admin' }).catch(() => {});
    }
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/telegram/subscribers/:chatId
app.delete('/api/telegram/subscribers/:chatId', async (req, res) => {
  try {
    const { chatId } = req.params;
    localStore.subscribers = localStore.subscribers.filter(s => String(s.chat_id) !== String(chatId));
    saveLocalStorage();
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Catch-all: serve React app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// ---- Start Server ----
async function main() {
  loadLocalStorage();
  await initDb();
  startTelegramPolling();
  startReminderInterval();

  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🤖 Telegram bot: @imperiiyabarbershop_bot`);
    console.log(`🗄️ DB connected: ${dbConnected}`);
  });
}

main().catch(console.error);
