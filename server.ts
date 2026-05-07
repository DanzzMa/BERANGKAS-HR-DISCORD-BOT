import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from "discord.js";
import dotenv from "dotenv";
import Database from "better-sqlite3";

dotenv.config();

// --- CONFIG LOADING ---
let config = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID,
  DISCORD_STOCK_CHANNEL_ID: process.env.DISCORD_STOCK_CHANNEL_ID as string || "",
  DISCORD_STOCK_MESSAGE_ID: process.env.DISCORD_STOCK_MESSAGE_ID as string || ""
};

const configPath = path.join(process.cwd(), "config.json");
const saveConfig = () => {
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  } catch (err) {
    console.error("❌ Gagal menyimpan config.json:", err);
  }
};

if (fs.existsSync(configPath)) {
  try {
    const fileConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (fileConfig.DISCORD_TOKEN) config.DISCORD_TOKEN = fileConfig.DISCORD_TOKEN;
    if (fileConfig.DISCORD_CLIENT_ID) config.DISCORD_CLIENT_ID = fileConfig.DISCORD_CLIENT_ID;
    if (fileConfig.DISCORD_STOCK_CHANNEL_ID) config.DISCORD_STOCK_CHANNEL_ID = fileConfig.DISCORD_STOCK_CHANNEL_ID;
    if (fileConfig.DISCORD_STOCK_MESSAGE_ID) config.DISCORD_STOCK_MESSAGE_ID = fileConfig.DISCORD_STOCK_MESSAGE_ID;
    console.log("📂 Loaded Discord config from config.json");
  } catch (err) {
    console.warn("⚠️ Gagal membaca config.json, menggunakan environment variables.");
  }
}

const PORT = Number(process.env.PORT) || 3001;

// --- DATABASE SETUP (SQLite) ---
const db = new Database("inventory.db");

// Data Migration: Normalize existing names to lowercase to fix duplication
try {
  db.prepare("UPDATE transactions SET barang = lower(barang), kategori = lower(kategori)").run();
  console.log("🛠️ Data casing normalized successfully.");
} catch (err) {
  console.error("❌ Failed to normalize data casing:", err);
}

// --- BACKUP LOGIC ---
function performBackup() {
  const backupDir = path.join(process.cwd(), "backups");
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupFile = path.join(backupDir, `inventory_${timestamp}.db`);

  try {
    if (fs.existsSync("inventory.db")) {
      db.backup(backupFile)
        .then(() => {
          console.log(`✅ Database backed up to: ${backupFile}`);
          // Manage rotation: keep only last 24 backups
          const files = fs.readdirSync(backupDir)
            .filter(file => file.startsWith("inventory_") && file.endsWith(".db"))
            .map(file => ({ 
              name: file, 
              time: fs.statSync(path.join(backupDir, file)).mtime.getTime() 
            }))
            .sort((a, b) => b.time - a.time);

          if (files.length > 24) {
            files.slice(24).forEach(file => {
              fs.unlinkSync(path.join(backupDir, file.name));
              console.log(`🗑️ Deleted old backup: ${file.name}`);
            });
          }
        })
        .catch(err => {
          console.error("❌ Backup failed:", err);
        });
    }
  } catch (err) {
    console.error("❌ Backup operation error:", err);
  }
}

// Initial backup on startup
performBackup();
// Hourly backup (every 1 hour)
setInterval(performBackup, 60 * 60 * 1000);

// Create table if not exists
db.exec(`
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tanggal DATETIME DEFAULT CURRENT_TIMESTAMP,
    barang TEXT NOT NULL,
    jumlah INTEGER NOT NULL,
    tipe TEXT CHECK (tipe IN ('IN', 'OUT')) NOT NULL,
    keterangan TEXT,
    oleh TEXT NOT NULL,
    kategori TEXT DEFAULT 'Umum',
    image_url TEXT,
    icon TEXT
  )
`);
console.log("✅ SQLite initialized successfully.");

// --- DISCORD STOCK DISPLAY AUTO-UPDATE ---
async function updateDiscordStockDisplay() {
  if (!config.DISCORD_STOCK_CHANNEL_ID) return;
  if (!client.isReady()) return;

  try {
    const channel = await client.channels.fetch(config.DISCORD_STOCK_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) return;

    const textChannel = channel as any; // Cast for simplicity with diverse text channel types

    const data = await getTransactionsFromDB();
    const stock: Record<string, { qty: number; kategori: string }> = {};
    
    (data as any[]).forEach((row: any) => {
      const amt = Number(row.jumlah) || 0;
      const change = row.tipe === "IN" ? amt : -amt;
      if (!stock[row.barang]) {
        stock[row.barang] = { qty: 0, kategori: row.kategori || "Umum" };
      }
      stock[row.barang].qty += change;
      stock[row.barang].kategori = row.kategori || "Umum";
    });

    const categories: Record<string, string[]> = {};
    Object.entries(stock)
      .sort(([nameA], [nameB]) => nameA.localeCompare(nameB))
      .forEach(([name, detail]) => {
        const catName = detail.kategori.charAt(0).toUpperCase() + detail.kategori.slice(1);
        const displayName = name.charAt(0).toUpperCase() + name.slice(1);
        
        if (!categories[catName]) categories[catName] = [];
        const status = detail.qty <= 5 ? "⚠️" : (detail.qty === 0 ? "❌" : "✅");
        categories[catName].push(`${status} **${displayName}**: \`${detail.qty}\``);
      });

    const embed = new EmbedBuilder()
      .setTitle("🏢 Ringkasan Stok Gudang (Update Otomatis)")
      .setColor(0x10b981)
      .setDescription(`Terakhir diperbarui: <t:${Math.floor(Date.now() / 1000)}:R>\n_Pesan ini diperbarui otomatis setiap kali ada transaksi atau per 5 menit._`)
      .setTimestamp()
      .setFooter({ text: "Inventory Auto-Update System" });

    if (Object.keys(categories).length === 0) {
      embed.addFields({ name: "Info", value: "_Gudang kosong._" });
    } else {
      Object.entries(categories).forEach(([cat, items]) => {
        embed.addFields({ name: `📁 ${cat}`, value: items.join("\n").substring(0, 1024) });
      });
    }

    if (config.DISCORD_STOCK_MESSAGE_ID) {
      try {
        const message = await textChannel.messages.fetch(config.DISCORD_STOCK_MESSAGE_ID);
        if (message) {
          await message.edit({ embeds: [embed] });
          // console.log("🔄 Discord Stock Display updated (Edited).");
          return;
        }
      } catch (err) {
        console.warn("⚠️ Pesan stok tidak ditemukan, mengirim pesan baru...");
      }
    }

    // Jika belum ada ID atau pesan lama terhapus, kirim pesan baru
    const sent = await textChannel.send({ embeds: [embed] });
    config.DISCORD_STOCK_MESSAGE_ID = sent.id;
    saveConfig();
    console.log("🆕 Discord Stock Display initialized (New Message).");
  } catch (err) {
    console.error("❌ Gagal update Discord stock display:", err);
  }
}

// Update berkala setiap 5 menit
setInterval(updateDiscordStockDisplay, 5 * 60 * 1000);

// --- AUTO-CORRECT LOGIC (Levenshtein Distance) ---
function getSimilarity(s1: string, s2: string) {
  let longer = s1;
  let shorter = s2;
  if (s1.length < s2.length) {
    longer = s2;
    shorter = s1;
  }
  const longerLength = longer.length;
  if (longerLength === 0) return 1.0;
  return (longerLength - editDistance(longer, shorter)) / longerLength;
}

function editDistance(s1: string, s2: string) {
  s1 = s1.toLowerCase();
  s2 = s2.toLowerCase();
  const costs = new Array();
  for (let i = 0; i <= s1.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= s2.length; j++) {
      if (i === 0) costs[j] = j;
      else {
        if (j > 0) {
          let newValue = costs[j - 1];
          if (s1.charAt(i - 1) !== s2.charAt(j - 1))
            newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
          costs[j - 1] = lastValue;
          lastValue = newValue;
        }
      }
    }
    if (i > 0) costs[s2.length] = lastValue;
  }
  return costs[s2.length];
}

async function addTransactionToDB(data: any) {
  // Normalize item name for consistency
  let barangNormalized = data.barang.trim().toLowerCase();
  
  // Membersihkan karakter sampah yang sering terbawa dari sistem bulk (seperti | atau :)
  if (barangNormalized.includes('|')) barangNormalized = barangNormalized.split('|')[0].trim();
  if (barangNormalized.includes(':')) barangNormalized = barangNormalized.split(':').slice(0, -1).join(':').trim();
  
  let finalKategori = (data.kategori || "umum").trim().toLowerCase();

  // --- AUTO-CORRECT SYSTEM ---
  try {
    const existingItems = db.prepare("SELECT DISTINCT barang, kategori FROM transactions").all() as { barang: string, kategori: string }[];
    let bestMatch = "";
    let highestSimilarity = 0;
    let matchKategori = "";

    for (const item of existingItems) {
      const sim = getSimilarity(barangNormalized, item.barang);
      if (sim > highestSimilarity) {
        highestSimilarity = sim;
        bestMatch = item.barang;
        matchKategori = item.kategori;
      }
    }

    // Threshold: Jika kemiripan > 80% dan jarak edit maksimal 3 karakter
    const dist = editDistance(barangNormalized, bestMatch);
    if (highestSimilarity >= 0.8 && dist <= 3) {
      if (highestSimilarity < 1.0) {
        console.log(`✨ Auto-Correct: Detected typo "${barangNormalized}", corrected to "${bestMatch}" (Sim: ${Math.round(highestSimilarity * 100)}%)`);
      }
      barangNormalized = bestMatch;
      // Jika kita mengoreksi typo, kita juga harus mengikuti kategori barang aslinya
      if (matchKategori && (finalKategori === "umum" || finalKategori === "bulk")) {
        finalKategori = matchKategori;
      }
    }
  } catch (err) {
    console.error("❌ Auto-Correct Error:", err);
  }

  // Hapus akhiran kategori jika ada di nama barang (misal: "medkit medis" -> "medkit")
  const categoryNames = ["makanan", "medis", "tools", "minuman", "senjata", "item", "umum"];
  for (const cat of categoryNames) {
    if (barangNormalized.endsWith(" " + cat) && barangNormalized.length > cat.length + 2) {
      console.log(`✂️ Stripping category suffix: "${barangNormalized}" -> "${barangNormalized.substring(0, barangNormalized.length - cat.length).trim()}"`);
      barangNormalized = barangNormalized.substring(0, barangNormalized.length - cat.length).trim();
    }
  }

  // 1. Database Lookup (Priority): Cari kategori terakhir dari barang yang sama
  if (finalKategori === "umum" || finalKategori === "bulk") {
    try {
      const lastEntry = db.prepare(
        "SELECT kategori FROM transactions WHERE barang = ? AND kategori NOT IN ('umum', 'bulk') ORDER BY tanggal DESC LIMIT 1"
      ).get(barangNormalized) as { kategori: string } | undefined;

      if (lastEntry && lastEntry.kategori) {
        finalKategori = lastEntry.kategori;
        console.log(`🧠 Smart Categorization (DB): Auto-detected ${barangNormalized} as [${finalKategori}]`);
      } else {
        // 2. Keyword Lookup (Fallback): Jika tidak ada di DB, gunakan kata kunci
        const name = barangNormalized;
        
        const categories = {
          "minuman": ["water", "drink", "susu", "kopi", "teh", "juice", "air"],
          "medis": ["bandage", "kit", "antibiotics", "napkins", "obat", "vitamin", "p3k", "suntik", "alcohol"],
          "tools": ["axe", "pickaxe", "hammer", "wrench", "nail gun", "palu", "kapak", "bor", "gergaji"],
          "makanan": ["raw", "cooked", "deer", "boar", "pork", "coyote", "rabbit", "beef", "chicken", "fish", "flour", "sugar", "nuts", "rice", "fingers", "makan", "nasi", "burger", "daging", "snack", "buah", "indomie"],
          "umum": ["leather", "fabric", "plastic", "kit", "clothes", "shoes", "wallet", "armor", "rebar", "log", "cork", "besi", "scrap", "umum"],
          "item": ["rope", "rubber", "plank", "pipe", "shard", "bolt", "besi", "batu", "kayu", "part", "komponen", "item"]
        };

        let foundMatch = false;
        
        // Prioritas pertama untuk material dasar
        if (name.includes("besi") || name.includes("batu") || name.includes("kayu") || name.includes("bolt") || name.includes("shard")) {
          finalKategori = "item";
          foundMatch = true;
        } else {
          // Cek berdasarkan keyword kategori
          for (const [catName, keywords] of Object.entries(categories)) {
            if (keywords.some(kw => name.includes(kw))) {
              finalKategori = catName;
              foundMatch = true;
              console.log(`🧠 Smart Categorization: Auto-detected ${barangNormalized} as [${finalKategori}]`);
              break;
            }
          }
        }

        // 3. Final Fallback: Jika benar-benar tidak tahu, gunakan "item"
        if (!foundMatch) {
          finalKategori = "item";
        }
      }
    } catch (err) {
      console.error("🔍 Smart Categorization Error:", err);
    }
  }

  const stmt = db.prepare(
    "INSERT INTO transactions (barang, jumlah, tipe, keterangan, oleh, kategori, image_url, icon) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  // Simpan jumlah sebagai angka positif, logika sign ditangani saat kalkulasi
  const jumlahAbs = Math.abs(Number(data.jumlah));
  stmt.run(barangNormalized, jumlahAbs, data.tipe, data.keterangan, data.oleh, finalKategori, data.image_url || null, data.icon || null);
  
  // Update Discord display after transaction (background)
  updateDiscordStockDisplay();

  return { ...data, barang: barangNormalized, kategori: finalKategori };
}

async function getTransactionsFromDB() {
  const rows = db.prepare("SELECT * FROM transactions ORDER BY tanggal ASC").all();
  return rows.map((row: any) => ({
    ...row,
    // Pastikan jumlah selalu Number
    jumlah: Number(row.jumlah),
    tanggal: row.tanggal
  }));
}

// --- DISCORD BOT SETUP ---
const client = new Client({ 
  intents: [
    GatewayIntentBits.Guilds, 
    GatewayIntentBits.GuildMessages, 
    GatewayIntentBits.MessageContent
  ] 
});

const PREFIX = "!";

const commands = [
  new SlashCommandBuilder()
    .setName("masuk")
    .setDescription("Catat barang masuk")
    .addStringOption(opt => opt.setName("nama").setDescription("Nama barang").setRequired(true).setAutocomplete(true))
    .addIntegerOption(opt => opt.setName("jumlah").setDescription("Jumlah barang").setRequired(true))
    .addStringOption(opt => 
      opt.setName("kategori")
        .setDescription("Kategori barang")
        .addChoices(
          { name: "Makanan", value: "Makanan" },
          { name: "Senjata", value: "Senjata" },
          { name: "Medis", value: "Medis" },
          { name: "Tools", value: "Tools" },
          { name: "Lain-lain", value: "Lain-lain" }
        ))
    .addStringOption(opt => opt.setName("keterangan").setDescription("Keterangan tambahan")),
  new SlashCommandBuilder()
    .setName("keluar")
    .setDescription("Catat barang keluar")
    .addStringOption(opt => opt.setName("nama").setDescription("Nama barang").setRequired(true).setAutocomplete(true))
    .addIntegerOption(opt => opt.setName("jumlah").setDescription("Jumlah barang").setRequired(true))
    .addStringOption(opt => 
      opt.setName("kategori")
        .setDescription("Kategori barang")
        .addChoices(
          { name: "Makanan", value: "Makanan" },
          { name: "Senjata", value: "Senjata" },
          { name: "Medis", value: "Medis" },
          { name: "Tools", value: "Tools" },
          { name: "Lain-lain", value: "Lain-lain" }
        ))
    .addStringOption(opt => opt.setName("keterangan").setDescription("Keterangan tambahan")),
  new SlashCommandBuilder()
    .setName("form")
    .setDescription("Buka formulir input barang"),
  new SlashCommandBuilder()
    .setName("stok")
    .setDescription("Cek stok barang"),
  new SlashCommandBuilder()
    .setName("log")
    .setDescription("Lihat riwayat transaksi terakhir"),
  new SlashCommandBuilder()
    .setName("allstock")
    .setDescription("Lihat semua stok barang lengkap dengan kategori"),
  new SlashCommandBuilder()
    .setName("bulk")
    .setDescription("Masukkkan/keluar barang dalam jumlah banyak sekaligus"),
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Cek latensi bot"),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Cek status server dan database"),
].map(cmd => cmd.toJSON());

async function registerCommands() {
  const { DISCORD_TOKEN, DISCORD_CLIENT_ID } = config;
  if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) return;

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  try {
    console.log("Mulai mendaftarkan perintah slash (/) ke Discord...");
    await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commands });
    console.log(`✅ Berhasil mendaftarkan ${commands.length} perintah slash.`);
  } catch (error: any) {
    console.error("❌ Gagal mendaftarkan perintah:");
    if (error.code === 10002) {
      console.error(`👉 Masalah: DISCORD_CLIENT_ID (${DISCORD_CLIENT_ID}) tidak dikenal oleh Discord.`);
      console.error("   Pastikan 'Application ID' di Discord Developer Portal sama dengan yang ada di Settings > Secrets.");
    } else {
      console.error(error);
    }
  }
}

client.on("interactionCreate", async (interaction) => {
  if (interaction.isAutocomplete()) {
    const focusedValue = interaction.options.getFocused();
    try {
      const items = db.prepare("SELECT DISTINCT barang FROM transactions").all() as { barang: string }[];
      const filtered = items
        .filter(item => item.barang.toLowerCase().includes(focusedValue.toLowerCase()))
        .slice(0, 25);
      await interaction.respond(
        filtered.map(item => ({ name: item.barang, value: item.barang }))
      );
    } catch (err) {
      console.error("Autocomplete error:", err);
    }
    return;
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId === "inventory_form") {
      const nama = interaction.fields.getTextInputValue("item_name").trim();
      const jumlahStr = interaction.fields.getTextInputValue("item_qty").trim();
      const tipeRaw = interaction.fields.getTextInputValue("item_type").trim().toUpperCase();
      const kategori = interaction.fields.getTextInputValue("item_cat").trim() || "Umum";
      const ket = interaction.fields.getTextInputValue("item_note").trim() || "-";
      
      const jumlah = parseInt(jumlahStr);
      // Logika tipe: Jika ada kata 'MASUK' atau 'IN', maka IN. Selain itu OUT.
      const tipe = (tipeRaw.includes("MASUK") || tipeRaw === "IN" || tipeRaw.includes("ADD")) ? "IN" : "OUT";

      if (isNaN(jumlah)) {
        await interaction.reply({ content: "❌ Jumlah harus berupa angka!", ephemeral: true });
        return;
      }

      try {
        console.log(`📝 Discord Modal: Menambah ${tipe} - ${nama} (${jumlah}) oleh ${interaction.user.tag}`);
        const saved = await addTransactionToDB({
          barang: nama,
          jumlah: jumlah,
          tipe: tipe,
          keterangan: ket,
          oleh: interaction.user.tag,
          kategori: kategori,
        });

        const embed = new EmbedBuilder()
          .setTitle(`📦 Transaksi Dicatat: ${tipe === "IN" ? "Masuk" : "Keluar"}`)
          .setColor(tipe === "IN" ? 0x10b981 : 0xf43f5e)
          .setThumbnail(tipe === "IN" ? "https://cdn-icons-png.flaticon.com/512/3221/3221803.png" : "https://cdn-icons-png.flaticon.com/512/3221/3221845.png")
          .addFields(
            { name: "🏷️ Nama Barang", value: `**${nama}**`, inline: true },
            { name: "🔢 Jumlah", value: `\`${jumlah}\``, inline: true },
            { name: "📁 Kategori", value: `\`${saved.kategori}\``, inline: true },
            { name: "📝 Keterangan", value: ket }
          )
          .addFields({ name: "👤 Oleh", value: `${interaction.user.tag}` })
          .setFooter({ text: "Silakan refresh halaman web untuk melihat data terbaru.", iconURL: interaction.user.displayAvatarURL() })
          .setTimestamp();

        await interaction.reply({ embeds: [embed] });
      } catch (err) {
        console.error("Database error (Discord Modal):", err);
        await interaction.reply({ content: "❌ Gagal mencatat data ke database.", ephemeral: true });
      }
    } else if (interaction.customId === "bulk_inventory_form") {
      const bulkData = interaction.fields.getTextInputValue("bulk_data");
      const lines = bulkData.split("\n");
      const results: { name: string; qty: number; type: "IN" | "OUT"; category: string; success: boolean }[] = [];

      await interaction.deferReply({ ephemeral: false });

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        
        // Format: [+/-][jumlah] [nama] | [kategori]
        const [dataPart, categoryPart] = trimmed.split("|");
        const match = dataPart.trim().match(/^([+-])\s*(\d+)\s+(.+)$/);
        
        if (match) {
          const sign = match[1];
          const qty = parseInt(match[2]);
          const name = match[3].trim();
          const type = sign === "+" ? "IN" : "OUT";
          const category = categoryPart?.trim() || "Bulk";

          try {
            const saved = await addTransactionToDB({
              barang: name,
              jumlah: qty,
              tipe: type,
              keterangan: "Pencatatan Massal (Slash Bulk)",
              oleh: interaction.user.tag,
              kategori: category,
            });
            results.push({ name, qty, type, category: saved.kategori, success: true });
          } catch (e) {
            results.push({ name, qty, type, category, success: false });
          }
        }
      }

      if (results.length === 0) {
        await interaction.editReply("❌ Tidak ada data yang sesuai format. Gunakan `+100 Nama | Kategori` atau `-10 Nama` per baris.");
        return;
      }

      const successItems = results.filter(r => r.success);
      const failedItems = results.filter(r => !r.success);

      const embed = new EmbedBuilder()
        .setTitle("🏢 Laporan Bulk: Log Aktivitas Publik")
        .setDescription(`**${interaction.user.tag}** memasukkan data massal (**${successItems.length}** item).`)
        .setColor(0x8b5cf6) // Purple for public bulk log
        .setThumbnail(interaction.user.displayAvatarURL())
        .addFields({
          name: "📦 Daftar Barang Berhasil",
          value: successItems.map(r => `• \`${r.type === "IN" ? "+" : "-"}${r.qty}\` **${r.name}** \`[${r.category}]\``).join("\n").substring(0, 1024) || "_Tidak ada_"
        });

      if (failedItems.length > 0) {
        embed.addFields({
          name: "⚠️ Gagal Diproses",
          value: failedItems.map(r => `• \`${r.type === "IN" ? "+" : "-"}${r.qty}\` **${r.name}**`).join("\n").substring(0, 1024)
        });
      }

      embed.setTimestamp()
           .setFooter({ text: "Inventory Public Logging", iconURL: interaction.client.user?.displayAvatarURL() });

      await interaction.editReply({ embeds: [embed] });
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName, options, user } = interaction;

  try {
    // Segera defer reply untuk memberikan waktu proses lebih lama (3s -> 15m)
    if (commandName !== "form" && commandName !== "bulk") {
      await interaction.deferReply();
    }

    if (commandName === "form") {
      const modal = new ModalBuilder()
        .setCustomId("inventory_form")
        .setTitle("Input Transaksi Barang");

      const nameInput = new TextInputBuilder()
        .setCustomId("item_name")
        .setLabel("Nama Barang")
        .setPlaceholder("Contoh: Makanan Kaleng")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const qtyInput = new TextInputBuilder()
        .setCustomId("item_qty")
        .setLabel("Jumlah")
        .setPlaceholder("Masukkan angka (Contoh: 10)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const typeInput = new TextInputBuilder()
        .setCustomId("item_type")
        .setLabel("Tipe (Masuk / Keluar)")
        .setPlaceholder("Ketik 'Masuk' atau 'Keluar'")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const catInput = new TextInputBuilder()
        .setCustomId("item_cat")
        .setLabel("Kategori")
        .setPlaceholder("Makanan / Senjata / Medis / Tools")
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

      const noteInput = new TextInputBuilder()
        .setCustomId("item_note")
        .setLabel("Keterangan")
        .setPlaceholder("Opsional...")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false);

      const rows = [
        new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(qtyInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(typeInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(catInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(noteInput),
      ];

      modal.addComponents(...rows);
      await interaction.showModal(modal);
      return;
    }

    if (commandName === "masuk" || commandName === "keluar") {
      const nama = options.getString("nama", true);
      const jumlah = options.getInteger("jumlah", true);
      const kategori = options.getString("kategori") || "Umum";
      const ket = options.getString("keterangan") || "-";
      const tipe = commandName === "masuk" ? "IN" : "OUT";

      console.log(`Processing command: ${commandName}, item: ${nama}, qty: ${jumlah}, category: ${kategori}`);

      const saved = await addTransactionToDB({
        barang: nama,
        jumlah: jumlah,
        tipe: tipe,
        keterangan: ket,
        oleh: user.tag,
        kategori: kategori,
      });

      const embed = new EmbedBuilder()
        .setTitle(`📦 Transaksi Barang: ${tipe === "IN" ? "Masuk" : "Keluar"}`)
        .setColor(tipe === "IN" ? 0x10b981 : 0xf43f5e) 
        .setThumbnail(tipe === "IN" ? "https://cdn-icons-png.flaticon.com/512/3221/3221803.png" : "https://cdn-icons-png.flaticon.com/512/3221/3221845.png")
        .addFields(
          { name: "🏷️ Nama Barang", value: `**${nama}**`, inline: true },
          { name: "🔢 Jumlah", value: `\`${jumlah}\``, inline: true },
          { name: "📁 Kategori", value: `\`${saved.kategori}\``, inline: true },
          { name: "📝 Keterangan", value: ket },
          { name: "👤 Oleh", value: `<@${user.id}>`, inline: true }
        )
        .setTimestamp()
        .setFooter({ text: "Inventory System Bot", iconURL: user.displayAvatarURL() });

      await interaction.editReply({ embeds: [embed] });
      return;
    } else if (commandName === "stok") {
      console.log("Processing command: stok");
      const data = await getTransactionsFromDB();
      const inventory: Record<string, number> = {};
      
      (data as any[]).forEach((row: any) => {
        const amt = Number(row.jumlah) || 0;
        const change = row.tipe === "IN" ? amt : -amt;
        inventory[row.barang] = (inventory[row.barang] || 0) + change;
      });

      const list = Object.entries(inventory)
        .map(([name, qty]) => {
          const status = qty <= 5 ? "⚠️" : (qty === 0 ? "❌" : "✅");
          return `${status} **${name}**: \`${qty}\``;
        })
        .join("\n") || "_Gudang kosong._";

      const embed = new EmbedBuilder()
        .setTitle("📊 Ringkasan Stok Gudang")
        .setColor(0x6366f1) 
        .setDescription(list)
        .addFields({ name: "💡 Tips", value: "Stok dengan simbol ⚠️ menandakan jumlah kritis (≤ 5)." })
        .setTimestamp()
        .setFooter({ text: "Inventory System Bot" });

      await interaction.editReply({ embeds: [embed] });
      return;
    } else if (commandName === "log") {
      console.log("Processing command: log");
      const data = await getTransactionsFromDB();
      const last10 = (data as any[]).slice(-10).reverse();

      const logList = last10.map((item: any) => {
        const typeIcon = item.tipe === "IN" ? "🟢" : "🔴";
        const date = new Date(item.tanggal).toLocaleTimeString("id-ID", { hour: '2-digit', minute: '2-digit' });
        return `\`${date}\` ${typeIcon} **${item.barang}** (\`${item.jumlah}\`) - *${item.oleh}*`;
      }).join("\n") || "_Belum ada riwayat transaksi._";

      const embed = new EmbedBuilder()
        .setTitle("📜 Riwayat Aktivitas Gudang")
        .setColor(0xfacc15) 
        .setDescription(logList)
        .setTimestamp()
        .setFooter({ text: "Hanya menampilkan 10 transaksi terakhir." });

      await interaction.editReply({ embeds: [embed] });
      return;
    } else if (commandName === "allstock") {
      console.log("Processing command: allstock");
      const data = await getTransactionsFromDB();
      const stock: Record<string, { qty: number; kategori: string }> = {};
      
      (data as any[]).forEach((row: any) => {
        const amt = Number(row.jumlah) || 0;
        const change = row.tipe === "IN" ? amt : -amt;
        if (!stock[row.barang]) {
          stock[row.barang] = { qty: 0, kategori: row.kategori || "Umum" };
        }
        stock[row.barang].qty += change;
        stock[row.barang].kategori = row.kategori || "Umum";
      });

      const categories: Record<string, string[]> = {};
      Object.entries(stock).forEach(([name, detail]) => {
        if (!categories[detail.kategori]) categories[detail.kategori] = [];
        categories[detail.kategori].push(`• **${name}**: ${detail.qty}`);
      });

      const embed = new EmbedBuilder()
        .setTitle("🏢 Inventaris Lengkap")
        .setColor(0x8b5cf6)
        .setTimestamp()
        .setFooter({ text: "Inventory System Bot" });

      if (Object.keys(categories).length === 0) {
        embed.setDescription("Belum ada data barang.");
      } else {
        Object.entries(categories).forEach(([cat, items]) => {
          embed.addFields({ name: `📁 ${cat}`, value: items.join("\n").substring(0, 1024) });
        });
      }

      await interaction.editReply({ embeds: [embed] });
      return;
    } else if (commandName === "bulk") {
      const modal = new ModalBuilder()
        .setCustomId("bulk_inventory_form")
        .setTitle("Input Bulk Transaksi");

      const bulkInput = new TextInputBuilder()
        .setCustomId("bulk_data")
        .setLabel("Format: [+/-][jumlah] [nama] | [kategori]")
        .setPlaceholder("Contoh:\n+100 Air Mineral | Makanan\n-5 Roti Ganda | Makanan\n+1 Glock 17 | Senjata\n+10 Bandage")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);

      const row = new ActionRowBuilder<TextInputBuilder>().addComponents(bulkInput);
      modal.addComponents(row);

      await interaction.showModal(modal);
      return;
    }

    if (commandName === "ping") {
      const ping = client.ws.ping;
      const responseTime = Date.now() - interaction.createdTimestamp;

      const embed = new EmbedBuilder()
        .setTitle("🏓 Pong!")
        .setColor(0x34d399)
        .addFields(
          { name: "📡 Bot Latency", value: `\`${responseTime}ms\``, inline: true },
          { name: "🌐 API Latency", value: `\`${ping}ms\``, inline: true }
        )
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (commandName === "status") {
      const uptime = process.uptime();
      const hours = Math.floor(uptime / 3600);
      const minutes = Math.floor((uptime % 3600) / 60);
      const seconds = Math.floor(uptime % 60);

      const memUsage = process.memoryUsage();
      const rss = Math.round(memUsage.rss / 1024 / 1024 * 100) / 100;

      let dbStatus = "✅ Berjalan";
      try {
        db.prepare("SELECT 1").get();
      } catch (err) {
        dbStatus = "❌ Error";
      }

      const embed = new EmbedBuilder()
        .setTitle("🖥️ Status Server Inventory")
        .setColor(0x60a5fa)
        .addFields(
          { name: "⏱️ Uptime", value: `\`${hours}j ${minutes}m ${seconds}d\``, inline: true },
          { name: "🧠 Memori", value: `\`${rss} MB\``, inline: true },
          { name: "🗄️ Database", value: dbStatus, inline: true },
          { name: "🛡️ Bot Tag", value: `\`${client.user?.tag}\``, inline: true },
          { name: "📈 Gateway", value: `\`${client.ws.ping}ms\``, inline: true }
        )
        .setFooter({ text: "Inventory Server Health Monitor" })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
      return;
    }
  } catch (err) {
    console.error("Interaction Error:", err);
    const msg = "❌ Terjadi kesalahan pada bot atau database.";
    
    try {
      // Pastikan kita hanya membalas jika interaksi belum berakhir
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(msg);
      } else {
        await interaction.reply({ content: msg, ephemeral: true });
      }
    } catch (sendErr) {
      // Abaikan jika interaksi sudah hilang/expired
    }
  }
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift()?.toLowerCase();

  try {
    if (command === "masuk" || command === "keluar") {
      // Usage: !masuk [nama] [jumlah] [kategori?] [keterangan?]
      if (args.length < 2) {
        return message.reply(`❌ Format salah! Gunakan: \`${PREFIX}${command} [nama] [jumlah] [kategori?] [ket?]\``);
      }

      const nama = args[0].trim();
      const jumlah = parseInt(args[1].trim());
      if (isNaN(jumlah)) return message.reply("❌ Jumlah harus berupa angka!");

      const kategori = args[2]?.trim() || "Umum";
      const ket = args.slice(3).join(" ").trim() || "-";
      const tipe = command === "masuk" ? "IN" : "OUT";

      const saved = await addTransactionToDB({
        barang: nama,
        jumlah: jumlah,
        tipe: tipe,
        keterangan: ket,
        oleh: message.author.tag,
        kategori: kategori,
      });

      const statusLabel = tipe === "IN" ? "Masuk" : "Keluar";
      const embed = new EmbedBuilder()
        .setTitle(`📦 Transaksi Barang ${statusLabel}`)
        .setColor(tipe === "IN" ? 0x10b981 : 0xf43f5e)
        .addFields(
          { name: "🏷️ Nama Barang", value: `**${nama}**`, inline: true },
          { name: "🔢 Jumlah", value: `\`${jumlah}\``, inline: true },
          { name: "📁 Kategori", value: `\`${saved.kategori}\``, inline: true },
          { name: "📝 Keterangan", value: ket },
          { name: "👤 Oleh", value: `<@${message.author.id}>`, inline: true }
        )
        .setTimestamp()
        .setFooter({ text: "Inventory System Bot (Prefix)" });

      await message.reply({ embeds: [embed] });
    } else if (command === "stok") {
      const data = await getTransactionsFromDB();
      const inventory: Record<string, number> = {};
      
      (data as any[]).forEach((row: any) => {
        const amt = Number(row.jumlah) || 0;
        const change = row.tipe === "IN" ? amt : -amt;
        inventory[row.barang] = (inventory[row.barang] || 0) + change;
      });

      const list = Object.entries(inventory)
        .map(([name, qty]) => `• **${name}**: ${qty}`)
        .join("\n") || "Belum ada data stok.";

      const embed = new EmbedBuilder()
        .setTitle("📊 Status Stok Saat Ini")
        .setColor(0x6366f1)
        .setDescription(list)
        .setTimestamp()
        .setFooter({ text: "Inventory System Bot (Prefix)" });

      await message.reply({ embeds: [embed] });
    } else if (command === "log") {
      const data = await getTransactionsFromDB();
      const last10 = (data as any[]).slice(-10).reverse();

      const logList = last10.map((item: any) => {
        const typeIcon = item.tipe === "IN" ? "🟢" : "🔴";
        const date = new Date(item.tanggal).toLocaleTimeString("id-ID", { hour: '2-digit', minute: '2-digit' });
        return `\`${date}\` ${typeIcon} **${item.barang}** (\`${item.jumlah}\`) - *${item.oleh}*`;
      }).join("\n") || "_Belum ada riwayat transaksi._";

      const embedForPrefix = new EmbedBuilder()
        .setTitle("📜 Riwayat Aktivitas Gudang")
        .setColor(0xfacc15)
        .setDescription(logList)
        .setTimestamp()
        .setFooter({ text: "Hanya menampilkan 10 transaksi terakhir." });

      await message.reply({ embeds: [embedForPrefix] });
    } else if (command === "allstock") {
      const data = await getTransactionsFromDB();
      const stock: Record<string, { qty: number; kategori: string }> = {};
      
      (data as any[]).forEach((row: any) => {
        const amt = Number(row.jumlah) || 0;
        const change = row.tipe === "IN" ? amt : -amt;
        if (!stock[row.barang]) {
          stock[row.barang] = { qty: 0, kategori: row.kategori || "Umum" };
        }
        stock[row.barang].qty += change;
        stock[row.barang].kategori = row.kategori || "Umum";
      });

      const categories: Record<string, string[]> = {};
      Object.entries(stock).forEach(([name, detail]) => {
        if (!categories[detail.kategori]) categories[detail.kategori] = [];
        categories[detail.kategori].push(`• **${name}**: ${detail.qty}`);
      });

      const embed = new EmbedBuilder()
        .setTitle("🏢 Inventaris Lengkap")
        .setColor(0x8b5cf6)
        .setTimestamp()
        .setFooter({ text: "Inventory System Bot (Prefix)" });

      if (Object.keys(categories).length === 0) {
        embed.setDescription("Belum ada data barang.");
      } else {
        Object.entries(categories).forEach(([cat, items]) => {
          embed.addFields({ name: `📁 ${cat}`, value: items.join("\n").substring(0, 1024) });
        });
      }

      await message.reply({ embeds: [embed] });
    } else if (command === "bulk") {
      // Ambil teks setelah !bulk, split per baris
      const rawLines = message.content.slice(PREFIX.length + command.length).trim().split("\n");
      const results: { name: string; qty: number; type: "IN" | "OUT"; category: string; success: boolean }[] = [];

      for (const line of rawLines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue;

        // Format: [+/-][jumlah] [nama] | [kategori]
        const [dataPart, categoryPart] = trimmedLine.split("|");
        const match = dataPart.trim().match(/^([+-])\s*(\d+)\s+(.+)$/);
        
        if (match) {
          const sign = match[1];
          const qty = parseInt(match[2]);
          const name = match[3].trim();
          const type = sign === "+" ? "IN" : "OUT";
          const category = categoryPart?.trim() || "Bulk";

          try {
            const saved = await addTransactionToDB({
              barang: name,
              jumlah: qty,
              tipe: type,
              keterangan: "Pencatatan Massal (Bulk Prefix)",
              oleh: message.author.tag,
              kategori: category,
            });
            results.push({ name, qty, type, category: saved.kategori, success: true });
          } catch (e) {
            results.push({ name, qty, type, category, success: false });
          }
        }
      }

      if (results.length === 0) {
        return message.reply("❌ Format salah! Gunakan format per baris:\n`+100 Nama | Kategori` (satu per baris)");
      }

      const successItems = results.filter(r => r.success);
      const failedItems = results.filter(r => !r.success);

      const embed = new EmbedBuilder()
        .setTitle("🏢 Laporan Bulk: Log Aktivitas Publik")
        .setDescription(`**${message.author.tag}** memasukkan data massal (**${successItems.length}** item).`)
        .setColor(0x8b5cf6) // Purple for public bulk log
        .setThumbnail(message.author.displayAvatarURL())
        .addFields({
          name: "📦 Daftar Barang Berhasil",
          value: successItems.map(r => `• \`${r.type === "IN" ? "+" : "-"}${r.qty}\` **${r.name}** \`[${r.category}]\``).join("\n").substring(0, 1024) || "_Tidak ada_"
        });

      if (failedItems.length > 0) {
        embed.addFields({
          name: "⚠️ Gagal Diproses",
          value: failedItems.map(r => `• \`${r.type === "IN" ? "+" : "-"}${r.qty}\` **${r.name}**`).join("\n").substring(0, 1024)
        });
      }

      embed.setTimestamp()
           .setFooter({ text: "Inventory Public Logging", iconURL: message.client.user?.displayAvatarURL() });

      await message.reply({ embeds: [embed] });
    } else if (command === "register") {
      await registerCommands();
      await message.reply("📡 Mencoba mendaftarkan ulang perintah slash (/) ke Discord. Silakan cek daftar perintah di Discord dalam beberapa detik.");
    } else if (command === "ping") {
      const pingStatus = client.ws.ping;
      const responseTime = Date.now() - message.createdTimestamp;
      await message.reply(`🏓 Pong!\nLatensi Bot: \`${responseTime}ms\`\nAPI Gateway: \`${pingStatus}ms\``);
    } else if (command === "status") {
      const uptimeSec = process.uptime();
      const h = Math.floor(uptimeSec / 3600);
      const m = Math.floor((uptimeSec % 3600) / 60);
      const s = Math.floor(uptimeSec % 60);
      let dbStat = "✅ Berjalan";
      try { db.prepare("SELECT 1").get(); } catch (err) { dbStat = "❌ Error"; }
      const statEmbed = new EmbedBuilder()
        .setTitle("🖥️ Status Server Inventory")
        .setColor(0x60a5fa)
        .addFields(
          { name: "⏱️ Uptime", value: `\`${h}j ${m}m ${s}d\``, inline: true },
          { name: "🗄️ Database", value: dbStat, inline: true },
          { name: "📈 Gateway", value: `\`${client.ws.ping}ms\``, inline: true }
        )
        .setTimestamp();
      await message.reply({ embeds: [statEmbed] });
    } else if (command === "help") {
      const hEmbed = new EmbedBuilder()
        .setTitle("📖 Bantuan Perintah Bot (Prefix: !)")
        .setColor(0x34d399)
        .setDescription("Daftar perintah yang tersedia:")
        .addFields(
          { name: "!masuk [nama] [jumlah] [ket?]", value: "Catat barang masuk" },
          { name: "!keluar [nama] [jumlah] [ket?]", value: "Catat barang keluar" },
          { name: "!stok", value: "Cek ringkasan stok" },
          { name: "!allstock", value: "Cek stok lengkap per kategori" },
          { name: "!log", value: "Lihat ringkasan aktivitas" },
          { name: "!bulk [data]", value: "Input massal (satu data per baris)" },
          { name: "!ping", value: "Cek latensi bot" },
          { name: "!status", value: "Cek status server" },
          { name: "!register", value: "Daftarkan ulang slash command (/)" }
        );
      await message.reply({ embeds: [hEmbed] });
    }
  } catch (err) {
    console.error("Prefix Command Error:", err);
    await message.reply("❌ Terjadi kesalahan saat memproses perintah.");
  }
});

import dns from "dns";

// --- VALIDASI KONEKSI INTERNET ---
function checkInternetAndConnect() {
  console.log("🌐 Mengecek koneksi internet server...");
  dns.lookup("google.com", (err) => {
    if (err) {
      console.error("🚨 SERVER TIDAK PUNYA KONEKSI INTERNET ATAU DNS RUSAK!");
      console.error("Detail Error:", err.code);
      console.log("🔄 Mencoba cek ulang internet dalam 30 detik...");
      setTimeout(checkInternetAndConnect, 30000);
    } else {
      console.log("✅ Internet server terverifikasi. Melanjutkan ke Discord...");
      connectToDiscord();
    }
  });
}

async function connectToDiscord() {
  if (!config.DISCORD_TOKEN) {
    console.warn("⚠️ PERINGATAN: DISCORD_TOKEN tidak ditemukan di config.json atau environment variables.");
    return;
  }

  try {
    console.log("📡 Mencoba login ke Discord...");
    await client.login(config.DISCORD_TOKEN);
    console.log(`✅ Bot berhasil login sebagai ${client.user?.tag}`);
    await registerCommands();
    await updateDiscordStockDisplay();
  } catch (err: any) {
    console.error("❌ Kesalahan Login Discord:", err.message);
    
    // Jika gagal karena DNS atau Jaringan
    if (err.message.includes("EAI_AGAIN") || err.message.includes("ENOTFOUND") || err.message.includes("ECONNRESET") || err.message.includes("ETIMEDOUT")) {
      console.log("🔄 Masalah jaringan terdeteksi. Mencoba hubungkan kembali dalam 45 detik...");
      setTimeout(connectToDiscord, 45000);
    } else if (err.message.includes("TOKEN_INVALID")) {
      console.error("👉 Token Discord salah! Mohon periksa config.json.");
    } else {
      console.log("🔄 Mencoba ulang dalam 60 detik...");
      setTimeout(connectToDiscord, 60000);
    }
  }
}

// Ganti pemanggilan langsung sebelumnya dengan pengecekan koneksi
checkInternetAndConnect();

if (!config.DISCORD_CLIENT_ID) {
  console.warn("⚠️ WARNING: DISCORD_CLIENT_ID is missing in config.json or environment variables.");
}

// --- START SERVER ---
async function startServer() {
  const app = express();
  app.use(express.json());

  app.get("/api/bot-status", (req, res) => {
    res.json({
      online: client.isReady(),
      tag: client.user?.tag || "Offline",
      latency: client.ws.ping,
      guilds: client.guilds.cache.size,
      uptime: client.uptime || 0
    });
  });

  app.get("/api/stock", async (req, res) => {
    try {
      const data = await getTransactionsFromDB();
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: "Could not fetch data from database" });
    }
  });

  app.get("/api/backups", (req, res) => {
    try {
      const backupDir = path.join(process.cwd(), "backups");
      if (!fs.existsSync(backupDir)) return res.json([]);
      
      const files = fs.readdirSync(backupDir)
        .filter(file => file.startsWith("inventory_") && file.endsWith(".db"))
        .map(file => {
          const stats = fs.statSync(path.join(backupDir, file));
          return {
            name: file,
            size: stats.size,
            time: stats.mtime.toISOString()
          };
        })
        .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
      
      res.json(files);
    } catch (err) {
      res.status(500).json({ error: "Could not fetch backups" });
    }
  });

  // Rename an item across all transactions
  app.post("/api/rename-item", (req, res) => {
    const { oldName, newName } = req.body;
    if (!oldName || !newName) return res.status(400).json({ error: "Missing names" });

    const oldNormalized = oldName.trim().toLowerCase();
    const newNormalized = newName.trim().toLowerCase();

    try {
      const stmt = db.prepare("UPDATE transactions SET barang = ? WHERE barang = ?");
      const info = stmt.run(newNormalized, oldNormalized);
      updateDiscordStockDisplay();
      res.json({ success: true, affected: info.changes });
    } catch (err) {
      res.status(500).json({ error: "Database error" });
    }
  });

  // Update category for an item
  app.post("/api/update-category", (req, res) => {
    const { name, category } = req.body;
    if (!name || !category) return res.status(400).json({ error: "Missing data" });

    const nameNormalized = name.trim().toLowerCase();
    const catNormalized = category.trim().toLowerCase();

    try {
      const stmt = db.prepare("UPDATE transactions SET kategori = ? WHERE barang = ?");
      const info = stmt.run(catNormalized, nameNormalized);
      updateDiscordStockDisplay();
      res.json({ success: true, affected: info.changes });
    } catch (err) {
      res.status(500).json({ error: "Database error" });
    }
  });

  // Add a direct transaction
  app.post("/api/add-transaction", async (req, res) => {
    const { name, qty, type, note, category } = req.body;
    if (!name || !qty || !type) return res.status(400).json({ error: "Missing data" });

    try {
      const saved = await addTransactionToDB({
        barang: name,
        jumlah: qty,
        tipe: type,
        keterangan: note || "Logged via Web UI",
        oleh: "System (Web)",
        kategori: category || "Umum",
      });
      res.json({ success: true, kategori: saved.kategori });
    } catch (err) {
      res.status(500).json({ error: "Database error" });
    }
  });

  // Add an adjustment transaction to match target quantity
  app.post("/api/adjust-item", (req, res) => {
    const { name, targetQty, note, category, image_url, icon } = req.body;
    if (!name || targetQty === undefined) return res.status(400).json({ error: "Missing data" });

    const normalizedName = name.trim().toLowerCase();
    const normalizedCat = category ? category.trim().toLowerCase() : null;

    try {
      const data = db.prepare("SELECT * FROM transactions WHERE barang = ?").all();
      let currentQty = 0;
      data.forEach((row: any) => {
        const amt = Number(row.jumlah);
        currentQty += (row.tipe === "IN" ? amt : -amt);
      });

      // Update metadata for all transactions of this item if provided
      if (normalizedCat || image_url || icon) {
        db.prepare("UPDATE transactions SET kategori = COALESCE(?, kategori), image_url = COALESCE(?, image_url), icon = COALESCE(?, icon) WHERE barang = ?")
          .run(normalizedCat || null, image_url || null, icon || null, normalizedName);
      }

      const diff = targetQty - currentQty;
      
      // If qty is already correct, we are done (metadata already updated above)
      if (diff === 0) {
        return res.json({ success: true, message: "Metadata updated or no change needed" });
      }

      const tipe = diff > 0 ? "IN" : "OUT";
      const stmt = db.prepare(
        "INSERT INTO transactions (barang, jumlah, tipe, keterangan, oleh, kategori, image_url, icon) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      );
      stmt.run(normalizedName, Math.abs(diff), tipe, note || "Penyesuaian Stok", "System (Web)", normalizedCat || "umum", image_url || null, icon || null);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Database error" });
    }
  });

  // Delete everything for an item
  app.delete("/api/item/:name", (req, res) => {
    try {
      const normalizedName = req.params.name.trim().toLowerCase();
      const stmt = db.prepare("DELETE FROM transactions WHERE barang = ?");
      stmt.run(normalizedName);
      updateDiscordStockDisplay();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Database error" });
    }
  });

  // Delete a single transaction
  app.delete("/api/transaction/:id", (req, res) => {
    try {
      const stmt = db.prepare("DELETE FROM transactions WHERE id = ?");
      stmt.run(req.params.id);
      updateDiscordStockDisplay();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Database error" });
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    const indexPath = path.join(distPath, "index.html");
    
    // Check if dist folder exists
    app.use(express.static(distPath));
    
    app.get("*", (req, res) => {
      // Check if index.html exists before sending
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(404).send("Frontend build files (dist/index.html) not found. Please run 'npm run build' first.");
      }
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
