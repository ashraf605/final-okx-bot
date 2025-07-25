// =================================================================
// OKX Advanced Analytics Bot - v22 (Positions Management UI)
// =================================================================
// هذا الإصدار يضيف واجهة متكاملة لإدارة متوسطات الشراء من قائمة الإعدادات.
// =================================================================

const express = require("express");
const { Bot, Keyboard, InlineKeyboard, webhookCallback } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto");
const fs = require("fs");
require("dotenv").config();

// --- إعدادات البوت الأساسية ---
const app = express();
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const PORT = process.env.PORT || 3000;
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID);
const API_BASE_URL = "https://www.okx.com";

// --- ملفات تخزين البيانات ---
const DATA_DIR = "./data";
const CAPITAL_FILE = `${DATA_DIR}/data_capital.json`;
const ALERTS_FILE = `${DATA_DIR}/data_alerts.json`;
const HISTORY_FILE = `${DATA_DIR}/data_history.json`;
const SETTINGS_FILE = `${DATA_DIR}/data_settings.json`;
const BALANCE_STATE_FILE = `${DATA_DIR}/data_balance_state.json`;
const POSITIONS_FILE = `${DATA_DIR}/data_positions.json`;

// --- متغيرات الحالة والمؤشرات ---
let waitingState = null;
let balanceMonitoringInterval = null;
let previousBalanceState = {};
let alertsCheckInterval = null;
let dailyJobsInterval = null;

// === دوال مساعدة وإدارة الملفات ===
function readJsonFile(filePath, defaultValue) {
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
        if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return defaultValue;
    } catch (error) { console.error(`Error reading ${filePath}:`, error); return defaultValue; }
}
function writeJsonFile(filePath, data) {
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (error) { console.error(`Error writing to ${filePath}:`, error); }
}
const loadCapital = () => readJsonFile(CAPITAL_FILE, 0);
const saveCapital = (amount) => writeJsonFile(CAPITAL_FILE, amount);
const loadAlerts = () => readJsonFile(ALERTS_FILE, []);
const saveAlerts = (alerts) => writeJsonFile(ALERTS_FILE, alerts);
const loadHistory = () => readJsonFile(HISTORY_FILE, []);
const saveHistory = (history) => writeJsonFile(HISTORY_FILE, history);
const loadSettings = () => readJsonFile(SETTINGS_FILE, { dailySummary: false, autoPostToChannel: false });
const saveSettings = (settings) => writeJsonFile(SETTINGS_FILE, settings);
const loadBalanceState = () => readJsonFile(BALANCE_STATE_FILE, {});
const saveBalanceState = (state) => writeJsonFile(BALANCE_STATE_FILE, state);
const loadPositions = () => readJsonFile(POSITIONS_FILE, {});
const savePositions = (positions) => writeJsonFile(POSITIONS_FILE, positions);

// === دوال API ===
function getHeaders(method, path, body = "") {
    const timestamp = new Date().toISOString();
    const prehash = timestamp + method.toUpperCase() + path + (typeof body === 'object' ? JSON.stringify(body) : body);
    const sign = crypto.createHmac("sha256", process.env.OKX_API_SECRET_KEY).update(prehash).digest("base64");
    return {
        "OK-ACCESS-KEY": process.env.OKX_API_KEY, "OK-ACCESS-SIGN": sign,
        "OK-ACCESS-TIMESTAMP": timestamp, "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE,
        "Content-Type": "application/json",
    };
}

// === دوال العرض والمساعدة ===
// استبدل الدالة القديمة بالكامل بهذه النسخة
function formatPortfolioMsg(assets, total, capital) {
    const positions = loadPositions();
    let pnl = capital > 0 ? total - capital : 0;
    let pnlPercent = capital > 0 ? (pnl / capital) * 100 : 0;
    let msg = `📊 *ملخص المحفظة* 📊\n\n`;
    msg += `💰 *القيمة الحالية:* \`$${total.toFixed(2)}\`\n`;
    msg += `💼 *رأس المال الأساسي:* \`$${capital.toFixed(2)}\`\n`;
    msg += `📈 *الربح/الخسارة (PnL):* ${pnl >= 0 ? '🟢' : '🔴'} \`$${pnl.toFixed(2)}\` (\`${pnlPercent.toFixed(2)}%\`)\n`;
    msg += `━━━━━━━━━━━━━━━━━━\n`;

    assets.forEach(a => {
        let percent = total > 0 ? ((a.value / total) * 100).toFixed(2) : 0;
        
        if (a.asset === "USDT") {
            msg += `\n╭─💎 *${a.asset}* (\`${percent}%\`)\n`;
            msg += `╰─💰 القيمة: \`$${a.value.toFixed(2)}\`\n`;
        } else {
            msg += `\n╭─💎 *${a.asset}* (\`${percent}%\`)\n`;
            msg += `├─💰 القيمة: \`$${a.value.toFixed(2)}\`\n`;
            msg += `├─📈 السعر الحالي: \`$${a.price.toFixed(4)}\`\n`;

            if (positions[a.asset] && positions[a.asset].avgBuyPrice > 0) {
                const avgBuyPrice = positions[a.asset].avgBuyPrice;
                msg += `├─🛒 متوسط الشراء: \`$${avgBuyPrice.toFixed(4)}\`\n`;
                const totalCost = avgBuyPrice * a.amount;
                const assetPnl = a.value - totalCost;
                const assetPnlPercent = (totalCost > 0) ? (assetPnl / totalCost) * 100 : 0;
                const pnlEmoji = assetPnl >= 0 ? '🟢' : '🔴';
                msg += `╰─📉 الربح/الخسارة: ${pnlEmoji} \`$${assetPnl.toFixed(2)}\` (\`${assetPnlPercent.toFixed(2)}%\`)\n`;
            } else {
                msg += `╰─🛒 متوسط الشراء: لم يتم تسجيله\n`;
            }
        }
    });
    msg += `\n🕒 *آخر تحديث:* ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}`;
    return msg;
}

function createChartUrl(history) {
    if (history.length < 2) return null;
    const last7Days = history.slice(-7);
    const labels = last7Days.map(h => h.date.slice(5));
    const data = last7Days.map(h => h.total.toFixed(2));
    const chartConfig = {
        type: 'line', data: { labels: labels, datasets: [{ label: 'قيمة المحفظة ($)', data: data, fill: true, backgroundColor: 'rgba(75, 192, 192, 0.2)', borderColor: 'rgb(75, 192, 192)', tension: 0.1 }] },
        options: { title: { display: true, text: 'أداء المحفظة آخر 7 أيام' } }
    };
    return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&backgroundColor=white`;
}

// === دوال منطق البوت والمهام المجدولة ===
// ... (getMarketPrices, getPortfolio, getBalanceForComparison, monitorBalanceChanges, etc. remain unchanged)
async function getMarketPrices() { try { const tickersRes = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`); const tickersJson = await tickersRes.json(); if (tickersJson.code !== '0') { console.error("Failed to fetch market prices:", tickersJson.msg); return null; } const prices = {}; tickersJson.data.forEach(t => prices[t.instId] = parseFloat(t.last)); return prices; } catch (error) { console.error("Exception in getMarketPrices:", error); return null; } }
async function getPortfolio(prices) { try { const path = "/api/v5/account/balance"; const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) }); const json = await res.json(); if (json.code !== '0') return { error: `فشل جلب المحفظة: ${json.msg}` }; let assets = [], total = 0; json.data[0]?.details?.forEach(asset => { const amount = parseFloat(asset.eq); if (amount > 0) { const instId = `${asset.ccy}-USDT`; const price = prices[instId] || (asset.ccy === "USDT" ? 1 : 0); const value = amount * price; if (value >= 1) { assets.push({ asset: asset.ccy, price, value, amount }); } total += value; } }); const filteredAssets = assets.filter(a => a.value >= 1); filteredAssets.sort((a, b) => b.value - a.value); return { assets: filteredAssets, total }; } catch (e) { console.error(e); return { error: "خطأ في الاتصال بالمنصة." }; } }
async function getBalanceForComparison() { try { const path = "/api/v5/account/balance"; const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) }); const json = await res.json(); if (json.code !== '0') { console.error("Error fetching balance for comparison:", json.msg); return null; } const balanceMap = {}; json.data[0]?.details?.forEach(asset => { const totalBalance = parseFloat(asset.eq); if (totalBalance > 1e-9) { balanceMap[asset.ccy] = totalBalance; } }); return balanceMap; } catch (error) { console.error("Exception in getBalanceForComparison:", error); return null; } }
async function monitorBalanceChanges() { const currentBalance = await getBalanceForComparison(); if (!currentBalance) { console.error("Could not fetch current balance. Skipping monitoring cycle."); return; } if (Object.keys(previousBalanceState).length === 0) { previousBalanceState = currentBalance; saveBalanceState(previousBalanceState); console.log("Initial balance state captured and saved. Monitoring will start on the next cycle."); return; } const prices = await getMarketPrices(); if (!prices) { console.error("Could not fetch market prices. Skipping monitoring cycle."); return; } const { total: newTotalPortfolioValue } = await getPortfolio(prices); if (newTotalPortfolioValue === undefined) {  console.error("Could not calculate new total portfolio value. Skipping monitoring cycle."); return;  } const allAssets = new Set([...Object.keys(previousBalanceState), ...Object.keys(currentBalance)]); const settings = loadSettings(); for (const asset of allAssets) { if (asset === 'USDT') continue; const prevAmount = previousBalanceState[asset] || 0; const currAmount = currentBalance[asset] || 0; const difference = currAmount - prevAmount; if (Math.abs(difference) < 1e-9) continue; const price = prices[`${asset}-USDT`]; if (!price) continue; const tradeValue = Math.abs(difference) * price; const avgPrice = tradeValue / Math.abs(difference); const type = difference > 0 ? 'شراء' : 'بيع'; const typeEmoji = difference > 0 ? '🟢' : '🔴'; const newAssetValue = currAmount * price; const portfolioPercentage = newTotalPortfolioValue > 0 ? (newAssetValue / newTotalPortfolioValue) * 100 : 0; const publicRecommendationText = `🔔 *توصية جديدة: ${type}* ${typeEmoji}\n\n` + `*العملة:* \`${asset}/USDT\`\n` + `*متوسط سعر الدخول:* ~ $${avgPrice.toFixed(4)}\n` + `*تمثل الآن:* \`${portfolioPercentage.toFixed(2)}%\` *من المحفظة*`; if (settings.autoPostToChannel) { await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, publicRecommendationText, { parse_mode: "Markdown" }); } else { const remainingCash = currentBalance['USDT'] || 0; const privateInfoText = `*تفاصيل خاصة بك:*\n- الكاش المتبقي: $${remainingCash.toFixed(2)}`; const confirmationText = `*صفقة جديدة مكتشفة*\n\n*سيتم نشر التالي في القناة:*\n--------------------\n${publicRecommendationText}\n--------------------\n\n${privateInfoText}\n\n*هل تريد المتابعة والنشر؟*`; const callbackData = `publish_${asset}_${avgPrice.toFixed(4)}_${portfolioPercentage.toFixed(2)}_${type}`; const confirmationKeyboard = new InlineKeyboard() .text("✅ نعم، انشر", callbackData) .text("❌ تجاهل", "ignore_trade"); await bot.api.sendMessage(AUTHORIZED_USER_ID, confirmationText, { parse_mode: "Markdown", reply_markup: confirmationKeyboard }); } } previousBalanceState = currentBalance; saveBalanceState(previousBalanceState); }
async function getInstrumentDetails(instId) { try { const res = await fetch(`${API_BASE_URL}/api/v5/market/ticker?instId=${instId.toUpperCase()}`); const json = await res.json(); if (json.code !== '0' || !json.data[0]) return { error: `لم يتم العثور على العملة.` }; const data = json.data[0]; return { price: parseFloat(data.last), high24h: parseFloat(data.high24h), low24h: parseFloat(data.low24h), vol24h: parseFloat(data.volCcy24h), }; } catch (e) { console.error(e); return { error: "خطأ في الاتصال بالمنصة." }; } }
async function checkPriceAlerts() { const alerts = loadAlerts(); if (alerts.length === 0) return; try { const prices = await getMarketPrices(); if (!prices) return; const remainingAlerts = []; let alertsTriggered = false; for (const alert of alerts) { const currentPrice = prices[alert.instId]; if (currentPrice === undefined) { remainingAlerts.push(alert); continue; } let triggered = false; if (alert.condition === '>' && currentPrice > alert.price) triggered = true; else if (alert.condition === '<' && currentPrice < alert.price) triggered = true; if (triggered) { const message = `🚨 *تنبيه سعر!* 🚨\n\n- العملة: *${alert.instId}*\n- الشرط: تحقق (${alert.condition} ${alert.price})\n- السعر الحالي: *${currentPrice}*`; await bot.api.sendMessage(AUTHORIZED_USER_ID, message, { parse_mode: "Markdown" }); alertsTriggered = true; } else { remainingAlerts.push(alert); } } if (alertsTriggered) { saveAlerts(remainingAlerts); } } catch (error) { console.error("Error in checkPriceAlerts:", error); } }
async function runDailyJobs() { const settings = loadSettings(); if (!settings.dailySummary) return; const prices = await getMarketPrices(); if (!prices) return; const { total, error } = await getPortfolio(prices); if (error) return console.error("Daily Summary Error:", error); const history = loadHistory(); const date = new Date().toISOString().slice(0, 10); if (history.length > 0 && history[history.length - 1].date === date) { history[history.length - 1].total = total; } else { history.push({ date, total }); } if (history.length > 30) history.shift(); saveHistory(history); console.log(`[✅ Daily Summary]: ${date} - $${total.toFixed(2)}`); }

// --- لوحات المفاتيح والقوائم ---
const mainKeyboard = new Keyboard()
    .text("📊 عرض المحفظة").text("📈 أداء المحفظة").row()
    .text("ℹ️ معلومات عملة").text("🔔 ضبط تنبيه").row()
    .text("🧮 حاسبة الربح والخسارة").row()
    .text("👁️ مراقبة الصفقات").text("⚙️ الإعدادات").resized();

async function sendSettingsMenu(ctx) {
    const settings = loadSettings();
    const settingsKeyboard = new InlineKeyboard()
        .text("💰 تعيين رأس المال", "set_capital").text("💼 إدارة المراكز", "manage_positions").row()
        .text("🗑️ حذف تنبيه", "delete_alert").text(`📰 الملخص اليومي: ${settings.dailySummary ? '✅' : '❌'}`, "toggle_summary").row()
        .text(`🚀 النشر التلقائي للقناة: ${settings.autoPostToChannel ? '✅' : '❌'}`, "toggle_autopost").row()
        .text("🔥 حذف كل البيانات 🔥", "delete_all_data");

    const text = "⚙️ *لوحة التحكم والإعدادات الرئيسية*";
    try {
        await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: settingsKeyboard });
    } catch {
        await ctx.reply(text, { parse_mode: "Markdown", reply_markup: settingsKeyboard });
    }
}

async function sendPositionsMenu(ctx) {
    const positionsKeyboard = new InlineKeyboard()
        .text("➕ إضافة أو تعديل مركز", "add_position").row()
        .text("📄 عرض كل المراكز", "view_positions").row()
        .text("🗑️ حذف مركز", "delete_position").row()
        .text("🔙 العودة للإعدادات الرئيسية", "back_to_settings");

    await ctx.editMessageText("💼 *إدارة مراكز التداول (متوسطات الشراء)*\n\n- من هنا يمكنك التحكم في متوسطات الشراء المسجلة لحساب الربح والخسارة لكل عملة.", {
        parse_mode: "Markdown",
        reply_markup: positionsKeyboard
    });
}

// --- معالجات الأوامر والرسائل ---
bot.use(async (ctx, next) => {
    if (ctx.from?.id === AUTHORIZED_USER_ID) { await next(); }
    else { console.log(`Unauthorized access attempt by user ID: ${ctx.from?.id}`); }
});
bot.command("start", async (ctx) => { await ctx.reply("🤖 *بوت OKX التحليلي المتكامل*\n\n- أهلاً بك! الواجهة الرئيسية للوصول السريع، والإدارة الكاملة من قائمة /settings.", { parse_mode: "Markdown", reply_markup: mainKeyboard }); });
bot.command("settings", async (ctx) => await sendSettingsMenu(ctx));
bot.command("pnl", async (ctx) => { const args = ctx.match.trim().split(/\s+/); if (args.length !== 3 || args[0] === '') { return await ctx.reply("❌ *صيغة غير صحيحة.*\n\n" + "يرجى استخدام الصيغة التالية:\n" + "`/pnl <سعر الشراء> <سعر البيع> <الكمية>`\n\n" + "*مثال:*\n`/pnl 100 120 0.5`", { parse_mode: "Markdown" }); } const [buyPrice, sellPrice, quantity] = args.map(parseFloat); if (isNaN(buyPrice) || isNaN(sellPrice) || isNaN(quantity) || buyPrice <= 0 || sellPrice <= 0 || quantity <= 0) { return await ctx.reply("❌ *خطأ:* تأكد من أن جميع القيم التي أدخلتها هي أرقام موجبة وصالحة."); } const totalInvestment = buyPrice * quantity; const totalSaleValue = sellPrice * quantity; const profitOrLoss = totalSaleValue - totalInvestment; const pnlPercentage = (profitOrLoss / totalInvestment) * 100; const resultStatus = profitOrLoss >= 0 ? "ربح ✅" : "خسارة 🔻"; const responseMessage = `*📊 نتيجة الحساب:*\n\n- *إجمالي تكلفة الشراء:* \`$${totalInvestment.toLocaleString()}\`\n- *إجمالي قيمة البيع:* \`$${totalSaleValue.toLocaleString()}\`\n\n- *قيمة الربح/الخسارة:* \`$${profitOrLoss.toLocaleString()}\`\n- *نسبة الربح/الخسارة:* \`${pnlPercentage.toFixed(2)}%\`\n\n*النتيجة النهائية: ${resultStatus}*`; await ctx.reply(responseMessage, { parse_mode: "Markdown" }); });
bot.command("avg", async (ctx) => { const args = ctx.match.trim().split(/\s+/); if (args.length !== 2 || args[0] === '') { return await ctx.reply("❌ *صيغة غير صحيحة.*\n\n" + "يرجى استخدام الصيغة التالية:\n" + "`/avg <SYMBOL> <PRICE>`\n\n" + "*مثال:*\n`/avg OP 1.50`", { parse_mode: "Markdown" }); } const [symbol, priceStr] = args; const price = parseFloat(priceStr); if (isNaN(price) || price <= 0) { return await ctx.reply("❌ *خطأ:* السعر يجب أن يكون رقمًا موجبًا وصالحًا."); } const positions = loadPositions(); positions[symbol.toUpperCase()] = { avgBuyPrice: price }; savePositions(positions); await ctx.reply(`✅ تم تحديث متوسط سعر شراء *${symbol.toUpperCase()}* إلى \`$${price.toFixed(4)}\`.`, { parse_mode: "Markdown" }); });

bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    await ctx.answerCallbackQuery();

    if (data.startsWith("publish_")) {
        const [, asset, priceStr, percentageStr, type] = data.split('_');
        const typeEmoji = type === 'شراء' ? '🟢' : '🔴';
        const finalRecommendation = `🔔 *توصية جديدة: ${type}* ${typeEmoji}\n\n` + `*العملة:* \`${asset}/USDT\`\n` + `*متوسط سعر الدخول:* ~ $${priceStr}\n` + `*تمثل الآن:* \`${percentageStr}%\` *من المحفظة*`;
        try { await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, finalRecommendation, { parse_mode: "Markdown" }); await ctx.editMessageText("✅ تم نشر التوصية بنجاح في القناة."); } catch (e) { console.error("Failed to post to channel:", e); await ctx.editMessageText("❌ فشل إرسال التوصية. تأكد من أن البوت مشرف في القناة وأن الـ ID صحيح."); }
        return;
    }
    if (data === "ignore_trade") { await ctx.editMessageText("👍 تم تجاهل الصفقة."); return; }

    switch (data) {
        // --- حالات القائمة الجديدة ---
        case "manage_positions":
            await sendPositionsMenu(ctx);
            break;
        case "add_position":
            waitingState = 'add_position_state';
            await ctx.reply("✍️ أرسل رمز العملة ومتوسط سعر الشراء.\n\n*مثال:*\n`OP 1.50`");
            break;
        case "view_positions":
            const positions = loadPositions();
            if (Object.keys(positions).length === 0) {
                await ctx.reply("ℹ️ لم تقم بإضافة أي متوسطات شراء بعد.");
            } else {
                let msg = "📄 *متوسطات الشراء المسجلة:*\n\n";
                for (const symbol in positions) {
                    msg += `*${symbol}*: \`$${positions[symbol].avgBuyPrice.toFixed(4)}\`\n`;
                }
                await ctx.reply(msg, { parse_mode: "Markdown" });
            }
            break;
        case "delete_position":
            waitingState = 'delete_position_state';
            await ctx.reply("🗑️ أرسل رمز العملة التي تريد حذف متوسط شرائها.\n\n*مثال:*\n`OP`");
            break;
        case "back_to_settings":
            await sendSettingsMenu(ctx);
            break;
        // --- الحالات القديمة ---
        case "set_capital":
            waitingState = 'set_capital';
            await ctx.reply("💰 أرسل المبلغ الجديد لرأس المال.");
            break;
        case "delete_alert":
            waitingState = 'delete_alert';
            await ctx.reply("🗑️ أرسل ID التنبيه الذي تريد حذفه.");
            break;
        case "toggle_summary":
        case "toggle_autopost":
            {
                const settings = loadSettings();
                if (data === 'toggle_summary') settings.dailySummary = !settings.dailySummary;
                else if (data === 'toggle_autopost') settings.autoPostToChannel = !settings.autoPostToChannel;
                saveSettings(settings);
                const updatedKeyboard = new InlineKeyboard()
                    .text("💰 تعيين رأس المال", "set_capital").text("💼 إدارة المراكز", "manage_positions").row()
                    .text("🗑️ حذف تنبيه", "delete_alert").text(`📰 الملخص اليومي: ${settings.dailySummary ? '✅' : '❌'}`, "toggle_summary").row()
                    .text(`🚀 النشر التلقائي للقناة: ${settings.autoPostToChannel ? '✅' : '❌'}`, "toggle_autopost").row()
                    .text("🔥 حذف كل البيانات 🔥", "delete_all_data");
                await ctx.editMessageReplyMarkup({ reply_markup: updatedKeyboard });
            }
            break;
        case "delete_all_data":
            waitingState = 'confirm_delete_all';
            await ctx.reply("⚠️ هل أنت متأكد من حذف كل البيانات؟ هذا الإجراء لا يمكن التراجع عنه.\n\nأرسل كلمة `تأكيد` خلال 30 ثانية.", { parse_mode: "Markdown" });
            setTimeout(() => { if (waitingState === 'confirm_delete_all') waitingState = null; }, 30000);
            break;
    }
});

bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (waitingState) {
        const state = waitingState;
        waitingState = null;
        switch (state) {
            // --- حالات جديدة لإدارة المراكز ---
            case 'add_position_state':
                const parts_add = text.split(/\s+/);
                if (parts_add.length !== 2) {
                    await ctx.reply("❌ صيغة غير صحيحة. يرجى إرسال رمز العملة ثم السعر.");
                    return;
                }
                const [symbol_add, priceStr_add] = parts_add;
                const price_add = parseFloat(priceStr_add);
                if (isNaN(price_add) || price_add <= 0) {
                    await ctx.reply("❌ السعر غير صالح.");
                    return;
                }
                const positions_add = loadPositions();
                positions_add[symbol_add.toUpperCase()] = { avgBuyPrice: price_add };
                savePositions(positions_add);
                await ctx.reply(`✅ تم تحديث متوسط شراء *${symbol_add.toUpperCase()}* إلى \`$${price_add.toFixed(4)}\`.`, { parse_mode: "Markdown" });
                return;
            case 'delete_position_state':
                const symbol_delete = text.toUpperCase();
                const positions_delete = loadPositions();
                if (positions_delete[symbol_delete]) {
                    delete positions_delete[symbol_delete];
                    savePositions(positions_delete);
                    await ctx.reply(`✅ تم حذف متوسط شراء *${symbol_delete}* بنجاح.`);
                } else {
                    await ctx.reply(`❌ لم يتم العثور على مركز مسجل للعملة *${symbol_delete}*.`);
                }
                return;
            // --- الحالات القديمة ---
            case 'set_capital': const amount = parseFloat(text); if (!isNaN(amount) && amount >= 0) { saveCapital(amount); await ctx.reply(`✅ تم تحديث رأس المال إلى: $${amount.toFixed(2)}`); } else { await ctx.reply("❌ مبلغ غير صالح."); } return;
            case 'coin_info': const { error, ...details } = await getInstrumentDetails(text); if (error) { await ctx.reply(`❌ ${error}`); } else { let msg = `*ℹ️ معلومات ${text.toUpperCase()}*\n\n- *السعر الحالي:* \`$${details.price}\`\n- *أعلى سعر (24س):* \`$${details.high24h}\`\n- *أدنى سعر (24س):* \`$${details.low24h}\`\n- *حجم التداول (24س):* \`${details.vol24h.toFixed(2)} ${text.split('-')[0]}\``; await ctx.reply(msg, { parse_mode: "Markdown" }); } return;
            case 'set_alert': const parts = text.trim().split(/\s+/); if (parts.length !== 3) return await ctx.reply("❌ صيغة غير صحيحة. استخدم: `SYMBOL > PRICE`"); const [instId, condition, priceStr] = parts; const price = parseFloat(priceStr); if (!['>', '<'].includes(condition) || isNaN(price)) return await ctx.reply("❌ صيغة غير صحيحة. الشرط يجب أن يكون `>` أو `<` والسعر يجب أن يكون رقماً."); const alerts = loadAlerts(); const newAlert = { id: crypto.randomBytes(4).toString('hex'), instId: instId.toUpperCase(), condition, price }; alerts.push(newAlert); saveAlerts(alerts); await ctx.reply(`✅ تم ضبط التنبيه بنجاح!\nID: \`${newAlert.id}\`\nسيتم إعلامك عندما يصبح سعر ${newAlert.instId} ${newAlert.condition === '>' ? 'أعلى من' : 'أقل من'} ${newAlert.price}`); return;
            case 'delete_alert': const currentAlerts = loadAlerts(); const filteredAlerts = currentAlerts.filter(a => a.id !== text); if (currentAlerts.length === filteredAlerts.length) { await ctx.reply(`❌ لم يتم العثور على تنبيه بالـ ID: \`${text}\``); } else { saveAlerts(filteredAlerts); await ctx.reply(`✅ تم حذف التنبيه بالـ ID: \`${text}\` بنجاح.`); } return;
            case 'confirm_delete_all':
                if (text.toLowerCase() === 'تأكيد') {
                    if (fs.existsSync(CAPITAL_FILE)) fs.unlinkSync(CAPITAL_FILE);
                    if (fs.existsSync(ALERTS_FILE)) fs.unlinkSync(ALERTS_FILE);
                    if (fs.existsSync(HISTORY_FILE)) fs.unlinkSync(HISTORY_FILE);
                    if (fs.existsSync(SETTINGS_FILE)) fs.unlinkSync(SETTINGS_FILE);
                    if (fs.existsSync(POSITIONS_FILE)) fs.unlinkSync(POSITIONS_FILE); // حذف ملف المراكز
                    if (fs.existsSync(BALANCE_STATE_FILE)) fs.unlinkSync(BALANCE_STATE_FILE); // حذف ملف حالة الرصيد
                    await ctx.reply("🔥 تم حذف جميع البيانات والإعدادات بنجاح.");
                } else {
                    await ctx.reply("🛑 تم إلغاء عملية الحذف.");
                }
                return;
        }
    }

    switch (text) {
        case "📊 عرض المحفظة": await ctx.reply('⏳ لحظات...'); const prices = await getMarketPrices(); if (!prices) return await ctx.reply("❌ فشل في جلب أسعار السوق."); const { assets, total, error } = await getPortfolio(prices); if (error) { await ctx.reply(`❌ ${error}`); } else { const capital = loadCapital(); const msg = formatPortfolioMsg(assets, total, capital); await ctx.reply(msg, { parse_mode: "Markdown" }); } break;
        case "📈 أداء المحفظة": const history = loadHistory(); if (history.length < 2) { await ctx.reply("ℹ️ لا توجد بيانات كافية."); } else { const chartUrl = createChartUrl(history); await ctx.replyWithPhoto(chartUrl, { caption: "📊 *أداء المحفظة آخر 7 أيام*", parse_mode: "Markdown" }); } break;
        case "ℹ️ معلومات عملة": waitingState = 'coin_info'; await ctx.reply("✍️ أرسل رمز العملة (مثال: `BTC-USDT`)."); break;
        case "🔔 ضبط تنبيه": waitingState = 'set_alert'; await ctx.reply("✍️ أرسل التنبيه بالصيغة: `SYMBOL > PRICE`"); break;
        case "🧮 حاسبة الربح والخسارة": await ctx.reply("استخدم الأمر مباشرة: `/pnl <شراء> <بيع> <كمية>`"); break;
        case "👁️ مراقبة الصفقات": await ctx.reply("ℹ️ *مراقبة الصفقات تعمل تلقائيًا في الخلفية.*", { parse_mode: "Markdown" }); break;
        case "⚙️ الإعدادات": await sendSettingsMenu(ctx); break;
        default: await ctx.reply("لم أتعرف على هذا الأمر.", { reply_markup: mainKeyboard });
    }
});

// --- بدء تشغيل البوت ---
async function startBot() {
    console.log("Starting bot...");
    previousBalanceState = loadBalanceState();
    if (Object.keys(previousBalanceState).length > 0) {
        console.log("Initial balance state loaded from file.");
    } else {
        console.log("No previous balance state found. Will capture on the first run.");
    }
    
    balanceMonitoringInterval = setInterval(monitorBalanceChanges, 1 * 60 * 1000);
    alertsCheckInterval = setInterval(checkPriceAlerts, 5 * 60 * 1000);
    dailyJobsInterval = setInterval(runDailyJobs, 60 * 60 * 1000);

    app.use(express.json());
    app.use(`/${bot.token}`, webhookCallback(bot, "express"));

    app.listen(PORT, () => {
        console.log(`Bot server listening on port ${PORT}`);
    });
}

startBot().catch(err => console.error("Failed to start bot:", err));
