const { Client, GatewayIntentBits, SlashCommandBuilder, Routes, EmbedBuilder, PermissionsBitField } = require("discord.js");
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
        // console.log('Oturumlar dosyaya kaydedildi.'); // Logları temiz tutmak için kapatıldı
    } catch (error) {
        console.error("Oturumlar kaydedilirken hata oluştu:", error);
    }
}

function loadSessions() {
    try {
        if (fs.existsSync(SESSIONS_FILE)) {
            const data = fs.readFileSync(SESSIONS_FILE, 'utf-8');
            const parsedData = JSON.parse(data);
            if (parsedData.length > 0) {
                activeSessions = new Map(parsedData);
                console.log(`${activeSessions.size} aktif oturum dosyadan yüklendi.`);
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
    
    if (lastChar !== 'k' && lastChar !== 'm') {
        return null; 
    }

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
    new SlashCommandBuilder()
        .setName("contentbaslat")
        .setDescription("Yeni bir ganimet takibi oturumu başlatır.")
        .addStringOption(option => option.setName("oyuncular").setDescription("Katılan oyuncuları etiketle (Örn: @oyuncu1 @oyuncu2)").setRequired(true))
        .addIntegerOption(option => option.setName("vergi").setDescription("Lonca vergi yüzdesi (Örn: 10 yaz -> %10)")),
    
    new SlashCommandBuilder()
        .setName("silver-ekle")
        .setDescription("Bir oyuncunun topladığı nakit silver'ı ekler.")
        .addUserOption(option => option.setName("oyuncu").setDescription("Para kesesini alan oyuncu.").setRequired(true))
        .addStringOption(option => option.setName("miktar").setDescription("Keseden gelen nakit (Örn: 50k, 1.25m)").setRequired(true)),

    new SlashCommandBuilder()
        .setName("item-ekle")
        .setDescription("Ortak havuza eklenen item'lerin toplam değerini ekler.")
        .addStringOption(option => option.setName("tutar").setDescription("Itemlerin toplam değeri (Örn: 500k, 2.5m)").setRequired(true)),
    
    new SlashCommandBuilder()
        .setName("toplam")
        .setDescription("Mevcut ganimet oturumunun anlık özetini gösterir."),

    new SlashCommandBuilder()
        .setName("loot-split")
        .setDescription("Oturumu sonlandırır ve nihai ganimet paylaşım raporunu oluşturur."),

    new SlashCommandBuilder()
        .setName("contentbitir")
        .setDescription("Mevcut ganimet oturumunu veri kaydetmeden iptal eder."),

].map(cmd => cmd.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.BOT_TOKEN);

// ----- Bot Hazır Olduğunda Çalışacak Kod -----
client.once("ready", async () => {
    console.log(`Bot hazır ✅ ${client.user.tag}`);
    loadSessions();
    try {
        console.log("Slash komutlar GLOBAL olarak güncelleniyor...");
        // DEĞİŞİKLİK BURADA: Komutları sunucuya özel (guild) değil, global olarak kaydediyoruz.
        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID),
            { body: commands }
        );
        console.log("Slash komutlar GLOBAL olarak güncellendi ✅");
    } catch (err) {
        console.error("Slash komutları güncellenirken hata:", err);
    }
});

// ----- Slash Command Handler -----
client.on("interactionCreate", async interaction => {
    // ... (Bu kısım bir önceki kodla aynı, o yüzden tekrar eklemiyorum. 
    // Kendi dosyanızdaki client.on("interactionCreate",...) bloğunu burada tutabilirsiniz.)
    // Eğer tam halini isterseniz, onu da ekleyebilirim.
});


// ----- BU KISMI KENDİ KODUNUZDAKİ İLE DEĞİŞTİRİN -----
client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, options, channelId, user, member } = interaction;
    const yöneticiRolü = "Subay"; // BU ROL ADINI KENDİ SUNUCUNUZA GÖRE DEĞİŞTİRİN

    if (commandName === "contentbaslat") {
        if (!member.roles.cache.some(role => role.name === yöneticiRolü)) {
            return interaction.reply({ content: "Bu komutu kullanmak için yetkin yok.", ephemeral: true });
        }
        await interaction.deferReply();

        const playersString = options.getString("oyuncular");
        const tax = options.getInteger("vergi") || 0;
        
        const playerMentions = playersString.match(/<@!?(\d+)>/g);
        if (!playerMentions) {
            return interaction.editReply("Lütfen geçerli oyuncuları etiketle.");
        }

        const session = {
            totalItemValue: 0,
            players: new Map(),
            tax: tax,
            leader: user.id
        };

        const playerList = [];
        const playerPromises = playerMentions.map(mention => {
            const id = mention.replace(/<@!?/, '').replace('>', '');
            return interaction.guild.members.fetch(id).then(member => {
                session.players.set(id, { user: { id: member.user.id, username: member.user.username }, cash: 0 });
                playerList.push(`<@${id}>`);
            }).catch(() => console.log(`Üye bulunamadı: ${id}`));
        });
        
        await Promise.all(playerPromises);

        activeSessions.set(channelId, session);
        saveSessions();

        const embed = new EmbedBuilder()
            .setColor("#57F287")
            .setTitle("✨ Ganimet Oturumu Başlatıldı!")
            .addFields(
                { name: "Katılımcılar 👥", value: playerList.join("\n") || "Oyuncu bulunamadı." },
                { name: "Lonca Vergisi 📜", value: `Bu oturum için vergi oranı **%${tax}** olarak belirlendi.` }
            )
            .setFooter({ text: "`/item-ekle` ve `/silver-ekle` komutlarıyla ganimetleri ekleyebilirsiniz." });

        await interaction.editReply({ embeds: [embed] });
        return;
    }

    const session = activeSessions.get(channelId);
    if (["silver-ekle", "item-ekle", "toplam", "loot-split", "contentbitir"].includes(commandName) && !session) {
        return interaction.reply({ content: "Bu kanalda aktif bir ganimet oturumu yok! Lütfen önce `/contentbaslat` komutunu kullanın.", ephemeral: true });
    }
    
    // Diğer komutlar için deferReply'i kendi blokları içinde yapalım
    switch (commandName) {
        case "silver-ekle":
            await interaction.deferReply({ ephemeral: true });
            const player = options.getUser("oyuncu");
            const amountStringSilver = options.getString("miktar");
            const amountSilver = parseSilver(amountStringSilver);

            if (amountSilver === null) {
                return interaction.editReply("Geçersiz silver miktarı girdin! Lütfen `50k`, `1.25m` gibi bir format kullan.");
            }
            if (!session.players.has(player.id)) {
                return interaction.editReply(`Hata: ${player.username} mevcut oturumda kayıtlı değil.`);
            }

            const playerData = session.players.get(player.id);
            playerData.cash += amountSilver;
            saveSessions();
            await interaction.editReply(`✅ Nakit eklendi! <@${player.id}> adlı oyuncunun hanesine **+${amountSilver.toLocaleString('tr-TR')}** Silver yazıldı.`);
            break;

        case "item-ekle":
            await interaction.deferReply({ ephemeral: true });
            const amountStringItem = options.getString("tutar");
            const amountItem = parseSilver(amountStringItem);
            
            if (amountItem === null) {
                return interaction.editReply("Geçersiz silver miktarı girdin! Lütfen `50k`, `1.25m` gibi bir format kullan.");
            }

            session.totalItemValue += amountItem;
            if (amountItem >= 0) {
                await interaction.editReply(`✅ Ganimet eklendi! Ortak kasaya **+${amountItem.toLocaleString('tr-TR')}** Silver değerinde item eklendi.`);
            } else {
                await interaction.editReply(`✅ Düzeltme yapıldı! Ortak kasadan **${amountItem.toLocaleString('tr-TR')}** Silver değerinde item düşüldü.`);
            }
            saveSessions();
            break;
        
        case "toplam":
            await interaction.deferReply();
            let totalCash = 0;
            let cashBreakdown = "";
            for (const [id, data] of session.players.entries()) {
                totalCash += data.cash;
                cashBreakdown += `<@${id}>: **${data.cash.toLocaleString('tr-TR')}**\n`;
            }
            const embedToplam = new EmbedBuilder()
                .setColor("#3498DB")
                .setTitle("📊 Anlık Ganimet Durumu")
                .setDescription(`Oturumdaki mevcut birikim ve dağılım:`)
                .addFields(
                    { name: "📦 Toplam İtem Değeri", value: `**${session.totalItemValue.toLocaleString('tr-TR')}** Silver` },
                    { name: "💵 Toplam Nakit Değeri", value: `**${totalCash.toLocaleString('tr-TR')}** Silver` },
                    { name: "🧑‍🤝‍🧑 Oyuncuların Topladığı Nakitler", value: cashBreakdown || "Henüz nakit toplanmadı." }
                );
            await interaction.editReply({ embeds: [embedToplam] });
            break;

        case "contentbitir":
            if (!member.roles.cache.some(role => role.name === yöneticiRolü)) {
                return interaction.reply({ content: "Bu komutu kullanmak için yetkin yok.", ephemeral: true });
            }
            activeSessions.delete(channelId);
            saveSessions();
            await interaction.reply("Bu kanaldaki mevcut ganimet oturumu iptal edildi.");
            break;

        case "loot-split":
            if (!member.roles.cache.some(role => role.name === yöneticiRolü)) {
                return interaction.reply({ content: "Bu komutu kullanmak için yetkin yok.", ephemeral: true });
            }
            await interaction.deferReply();
            const playerCount = session.players.size;
            if (playerCount === 0) return interaction.editReply("Oturumda hiç oyuncu yok!");

            // Hesaplamalar...
            const itemTaxAmount = session.totalItemValue * (session.tax / 100);
            const distributableItemValue = session.totalItemValue - itemTaxAmount;
            const itemSharePerPlayer = distributableItemValue / playerCount;
            let totalCashSplit = 0;
            session.players.forEach(p => totalCashSplit += p.cash);
            const cashTaxAmount = totalCashSplit * (session.tax / 100);
            const distributableCash = totalCashSplit - cashTaxAmount;
            const cashSharePerPlayer = distributableCash / playerCount;
            
            const leaderId = user.id;
            let paymentPlan = "";
            let leaderOwes = 0;
            let leaderReceives = 0;

            session.players.forEach((data, id) => {
                const balance = cashSharePerPlayer - data.cash;
                if (id === leaderId) {
                    if (balance < 0) leaderOwes = Math.abs(balance);
                    else leaderReceives = balance;
                    return;
                }
                if (balance < 0) {
                    paymentPlan += `• <@${id}> ➡️ <@${leaderId}>: **${Math.abs(balance).toLocaleString('tr-TR')}** Silver ödeyecek.\n`;
                } else if (balance > 0) {
                    paymentPlan += `• <@${leaderId}> ➡️ <@${id}>: **${balance.toLocaleString('tr-TR')}** Silver ödeyecek.\n`;
                }
            });

            if (leaderReceives > 0) {
                 paymentPlan += `• Lider (<@${leaderId}>) kendi payı olan **${leaderReceives.toLocaleString('tr-TR')}** Silver'ı alacak.\n`;
            } else if (leaderOwes > 0) {
                 paymentPlan += `• Lider (<@${leaderId}>) payından fazla topladığı **${leaderOwes.toLocaleString('tr-TR')}** Silver'ı dağıtımda kullanacak.\n`;
            }

            if (paymentPlan === "") paymentPlan = "Tüm oyuncular kendi payını toplamış, denkleştirmeye gerek yok.";

            const embedSplit = new EmbedBuilder()
                .setColor("#F1C40F")
                .setTitle("🏆 Ganimet Paylaşım Raporu!")
                .setAuthor({ name: `Paylaşımı Yapan Lider: ${user.username}`, iconURL: user.displayAvatarURL() })
                .addFields(
                    { name: "Genel Özet", value: `Toplam İtem: **${session.totalItemValue.toLocaleString('tr-TR')}**\nToplam Nakit: **${totalCashSplit.toLocaleString('tr-TR')}**\nVergi: **%${session.tax}**` },
                    { name: "📦 ITEM PAYLAŞIMI", value: `Kişi Başı Düşen İtem Değeri: **${Math.round(itemSharePerPlayer).toLocaleString('tr-TR')}** Silver`},
                    { name: "💵 NAKİT DENKLEŞTİRME", value: `Kişi Başı Düşen Nakit Payı: **${Math.round(cashSharePerPlayer).toLocaleString('tr-TR')}** Silver` },
                    { name: "💸 ÖDEME PLANI", value: paymentPlan }
                )
                .setFooter({ text: "Oturum Sona Erdi" })
                .setTimestamp();
            await interaction.editReply({ embeds: [embedSplit] });
            
            activeSessions.delete(channelId);
            saveSessions();
            break;
    }
});
// ----- BU SATIRIN ÜSTÜNDEKİ KODU KULLANIN -----


client.login(process.env.BOT_TOKEN);
