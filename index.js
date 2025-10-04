const { Client, GatewayIntentBits, SlashCommandBuilder, Routes, EmbedBuilder, MessageFlags } = require("discord.js");
const { REST } = require("@discordjs/rest");
const express = require("express");
const dotenv = require("dotenv");
const fs = require('fs');

dotenv.config();

// ----- Uptime Server -----
const app = express();
app.get("/", (req, res) => res.send("FameHunters LootAsistan çalışıyor ✅"));
app.listen(process.env.PORT || 3000, () => console.log("Uptime server'ı çalışıyor."));

// ----- Veri Kalıcılığı (Persistence) -----
const SESSIONS_FILE = './sessions.json';
let activeSessions = new Map();

function saveSessions() {
    try {
        const dataToSave = JSON.stringify(Array.from(activeSessions.entries()));
        fs.writeFileSync(SESSIONS_FILE, dataToSave, 'utf-8');
    } catch (error) {
        console.error("Oturumlar kaydedilirken hata oluştu:", error);
    }
}
function loadSessions() {
    try {
        if (fs.existsSync(SESSIONS_FILE)) {
            const data = fs.readFileSync(SESSIONS_FILE, 'utf-8');
            if (data) {
                const parsedData = JSON.parse(data);
                if (Array.isArray(parsedData) && parsedData.length > 0) {
                    activeSessions = new Map(parsedData);
                    console.log(`${activeSessions.size} aktif oturum dosyadan yüklendi.`);
                }
            }
        }
    } catch (error) {
        console.error("Oturumlar yüklenirken hata oluştu:", error);
    }
}

// ----- Discord Client -----
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

// ----- Helper Functions -----
function parseSilver(silverString) {
    if (!silverString || typeof silverString !== 'string') return null;
    const cleanedString = silverString.trim().toLowerCase().replace(',', '.');
    const lastChar = cleanedString.slice(-1);
    if (lastChar !== 'k' && lastChar !== 'm') { return null; }
    let numericPart = cleanedString.slice(0, -1);
    let multiplier = 1;
    if (lastChar === 'k') multiplier = 1000;
    if (lastChar === 'm') multiplier = 1000000;
    const number = parseFloat(numericPart);
    if (isNaN(number)) return null;
    return Math.round(number * multiplier);
}

// ----- Slash Command Register -----
const commands = [
    new SlashCommandBuilder().setName("contentbaslat").setDescription("Yeni bir ganimet takibi oturumu başlatır.").addStringOption(option => option.setName("oyuncular").setDescription("Katılan oyuncuları etiketle (Örn: @oyuncu1 @oyuncu2)").setRequired(true)).addIntegerOption(option => option.setName("vergi").setDescription("Lonca vergi yüzdesi (Örn: 10 yaz -> %10)")),
    new SlashCommandBuilder().setName("silver-ekle").setDescription("Bir oyuncunun topladığı nakit silver'ı ekler.").addUserOption(option => option.setName("oyuncu").setDescription("Para kesesini alan oyuncu.").setRequired(true)).addStringOption(option => option.setName("miktar").setDescription("Keseden gelen nakit (Örn: 50k, 1.25m)").setRequired(true)),
    new SlashCommandBuilder().setName("item-ekle").setDescription("Ortak havuza eklenen item'lerin toplam değerini ekler.").addStringOption(option => option.setName("tutar").setDescription("Itemlerin toplam değeri (Örn: 500k, 2.5m)").setRequired(true)),
    new SlashCommandBuilder().setName("toplam").setDescription("Mevcut ganimet oturumunun anlık özetini gösterir."),
    new SlashCommandBuilder().setName("loot-split").setDescription("Oturumu sonlandırır ve nihai ganimet paylaşım raporunu oluşturur."),
    new SlashCommandBuilder().setName("contentbitir").setDescription("Mevcut ganimet oturumunu veri kaydetmeden iptal eder."),
].map(cmd => cmd.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.BOT_TOKEN);

// ----- Bot Hazır Olduğunda Çalışacak Kod -----
client.once("ready", async () => {
    console.log(`Bot hazır ✅ ${client.user.tag}`);
    loadSessions();
    try {
        console.log("Slash komutlar sunucuya özel olarak güncelleniyor...");
        await rest.put(
            Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
            { body: commands }
        );
        console.log("Slash komutlar sunucuya özel olarak güncellendi ✅");
    } catch (err) {
        console.error("Slash komutları güncellenirken hata:", err);
    }
});

// ----- Slash Command Handler -----
client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName, options, channelId, user, member } = interaction;
    const adminRoleId = process.env.ADMIN_ROLE_ID;
    const adminCommands = ["contentbaslat", "loot-split", "contentbitir"];

    if (adminCommands.includes(commandName)) {
        if (!adminRoleId || !member.roles.cache.has(adminRoleId)) {
            return interaction.reply({ content: "Bu komutu kullanmak için gerekli role sahip değilsin.", flags: [MessageFlags.Ephemeral] });
        }
    }

    const session = activeSessions.get(channelId);
    const sessionCommands = ["silver-ekle", "item-ekle", "toplam", "loot-split", "contentbitir"];
    if (sessionCommands.includes(commandName) && !session) {
        return interaction.reply({ content: "Bu kanalda aktif bir ganimet oturumu yok! Lütfen önce `/contentbaslat` komutunu kullanın.", flags: [MessageFlags.Ephemeral] });
    }

    try {
        switch (commandName) {
            case "contentbaslat":
                await interaction.deferReply();
                const playersString = options.getString("oyuncular");
                const tax = options.getInteger("vergi") || 0;
                const playerMentions = playersString.match(/<@!?(\d+)>/g);
                if (!playerMentions) {
                    return interaction.editReply("Lütfen geçerli oyuncuları etiketle.");
                }
                const newSession = { totalItemValue: 0, players: {}, tax: tax }; // players'ı obje olarak başlatalım
                const playerList = [];
                const playerPromises = playerMentions.map(mention => {
                    const id = mention.replace(/<@!?/, '').replace('>', '');
                    return interaction.guild.members.fetch(id).then(member => {
                        newSession.players[id] = { username: member.user.username, cash: 0 };
                        playerList.push(`<@${id}>`);
                    }).catch(() => console.log(`Üye bulunamadı: ${id}`));
                });
                await Promise.all(playerPromises);
                activeSessions.set(channelId, newSession);
                saveSessions();
                const embed = new EmbedBuilder().setColor("#57F287").setTitle("✨ Ganimet Oturumu Başlatıldı!").addFields({ name: "Katılımcılar 👥", value: playerList.join("\n") || "Oyuncu bulunamadı." }, { name: "Lonca Vergisi 📜", value: `Bu oturum için vergi oranı **%${tax}** olarak belirlendi.` }).setFooter({ text: "`/item-ekle` ve `/silver-ekle` komutlarıyla ganimetleri ekleyebilirsiniz." });
                await interaction.editReply({ embeds: [embed] });
                break;

            case "silver-ekle":
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                const player = options.getUser("oyuncu");
                const amountStringSilver = options.getString("miktar");
                const amountSilver = parseSilver(amountStringSilver);
                if (amountSilver === null) { return interaction.editReply("Geçersiz silver miktarı girdin! Lütfen `50k`, `1.25m` gibi bir format kullan."); }
                if (!session.players[player.id]) { return interaction.editReply(`Hata: ${player.username} mevcut oturumda kayıtlı değil.`); }
                session.players[player.id].cash += amountSilver;
                saveSessions();
                await interaction.editReply(`✅ Nakit eklendi! <@${player.id}> adlı oyuncunun hanesine **+${amountSilver.toLocaleString('tr-TR')}** Silver yazıldı.`);
                break;

            case "item-ekle":
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                const amountStringItem = options.getString("tutar");
                const amountItem = parseSilver(amountStringItem);
                if (amountItem === null) { return interaction.editReply("Geçersiz silver miktarı girdin! Lütfen `50k`, `1.25m` gibi bir format kullan."); }
                session.totalItemValue += amountItem;
                if (amountItem >= 0) { await interaction.editReply(`✅ Ganimet eklendi! Ortak kasaya **+${amountItem.toLocaleString('tr-TR')}** Silver değerinde item eklendi.`); }
                else { await interaction.editReply(`✅ Düzeltme yapıldı! Ortak kasadan **${amountItem.toLocaleString('tr-TR')}** Silver değerinde item düşüldü.`); }
                saveSessions();
                break;
            
            case "toplam":
                await interaction.deferReply();
                let totalCash = 0;
                let cashBreakdown = "";
                for (const id in session.players) { totalCash += session.players[id].cash; cashBreakdown += `<@${id}>: **${session.players[id].cash.toLocaleString('tr-TR')}**\n`; }
                const embedToplam = new EmbedBuilder().setColor("#3498DB").setTitle("📊 Anlık Ganimet Durumu").setDescription(`Oturumdaki mevcut birikim ve dağılım:`).addFields({ name: "📦 Toplam İtem Değeri", value: `**${session.totalItemValue.toLocaleString('tr-TR')}** Silver` }, { name: "💵 Toplam Nakit Değeri", value: `**${totalCash.toLocaleString('tr-TR')}** Silver` }, { name: "🧑‍🤝‍🧑 Oyuncuların Topladığı Nakitler", value: cashBreakdown || "Henüz nakit toplanmadı." });
                await interaction.editReply({ embeds: [embedToplam] });
                break;

            case "contentbitir":
                activeSessions.delete(channelId);
                saveSessions();
                await interaction.reply("Bu kanaldaki mevcut ganimet oturumu iptal edildi.");
                break;

            case "loot-split":
                await interaction.deferReply();
                const playerCount = Object.keys(session.players).length;
                if (playerCount === 0) return interaction.editReply("Oturumda hiç oyuncu yok!");
                const itemTaxAmount = session.totalItemValue * (session.tax / 100);
                const distributableItemValue = session.totalItemValue - itemTaxAmount;
                const itemSharePerPlayer = distributableItemValue / playerCount;
                let totalCashSplit = 0;
                for (const id in session.players) { totalCashSplit += session.players[id].cash; }
                const cashTaxAmount = totalCashSplit * (session.tax / 100);
                const distributableCash = totalCashSplit - cashTaxAmount;
                const cashSharePerPlayer = distributableCash / playerCount;
                const leaderId = user.id;
                let paymentPlan = "";
                for (const id in session.players) {
                    const balance = cashSharePerPlayer - session.players[id].cash;
                    if (id === leaderId) continue;
                    if (balance < 0) { paymentPlan += `• <@${id}> ➡️ <@${leaderId}>: **${Math.abs(balance).toLocaleString('tr-TR')}** Silver ödeyecek.\n`; }
                    else if (balance > 0) { paymentPlan += `• <@${leaderId}> ➡️ <@${id}>: **${balance.toLocaleString('tr-TR')}** Silver ödeyecek.\n`; }
                }
                const leaderBalance = cashSharePerPlayer - (session.players[leaderId]?.cash || 0);
                if (leaderBalance > 0) { paymentPlan += `• Lider (<@${leaderId}>) kendi payı olan **${leaderBalance.toLocaleString('tr-TR')}** Silver'ı alacak.\n`; }
                else if (leaderBalance < 0) { paymentPlan += `• Lider (<@${leaderId}>) payından fazla topladığı **${Math.abs(leaderBalance).toLocaleString('tr-TR')}** Silver'ı dağıtımda kullanacak.\n`; }
                if (paymentPlan.trim() === "") paymentPlan = "Tüm oyuncular kendi payını toplamış, denkleştirmeye gerek yok.";
                
                const embedSplit = new EmbedBuilder().setColor("#F1C40F").setTitle("🏆 Ganimet Paylaşım Raporu!").setAuthor({ name: `Paylaşımı Yapan Lider: ${user.username}`, iconURL: user.displayAvatarURL() }).addFields({ name: "Genel Özet", value: `Toplam İtem: **${session.totalItemValue.toLocaleString('tr-TR')}**\nToplam Nakit: **${totalCashSplit.toLocaleString('tr-TR')}**\nVergi: **%${session.tax}**` }, { name: "📦 ITEM PAYLAŞIMI", value: `Kişi Başı Düşen İtem Değeri: **${Math.round(itemSharePerPlayer).toLocaleString('tr-TR')}** Silver`}, { name: "💵 NAKİT DENKLEŞTİRME", value: `Kişi Başı Düşen Nakit Payı: **${Math.round(cashSharePerPlayer).toLocaleString('tr-TR')}** Silver` }, { name: "💸 ÖDEME PLANI", value: paymentPlan }).setFooter({ text: "Oturum Sona Erdi" }).setTimestamp();
                await interaction.editReply({ embeds: [embedSplit] });
                activeSessions.delete(channelId);
                saveSessions();
                break;
        }
    } catch (err) {
        console.error("Ana işlem bloğunda hata oluştu:", err);
        try {
            const errorMessage = { content: "Bir hata oluştu, komut işlenemedi.", flags: [MessageFlags.Ephemeral], embeds: [], files: [] };
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(errorMessage);
            } else {
                await interaction.reply(errorMessage);
            }
        } catch (err2) {
            console.error("Hata mesajı bile gönderilemedi:", err2);
        }
    }
});

client.login(process.env.BOT_TOKEN);
