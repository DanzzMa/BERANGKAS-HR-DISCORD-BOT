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
  DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID
};

const configPath = path.join(process.cwd(), "config.json");
if (fs.existsSync(configPath)) {
  try {
    const fileConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (fileConfig.DISCORD_TOKEN) config.DISCORD_TOKEN = fileConfig.DISCORD_TOKEN;
    if (fileConfig.DISCORD_CLIENT_ID) config.DISCORD_CLIENT_ID = fileConfig.DISCORD_CLIENT_ID;
    console.log("📂 Loaded Discord config from config.json");
  } catch (err) {
    console.warn("⚠️ Gagal membaca config.json, menggunakan environment variables.");
  }
}

const PORT = Number(process.env.PORT) || 3000;

// --- DATABASE SETUP (SQLite) ---
const db = new Database("inventory.db");

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

async function addTransactionToDB(data: any) {
  let finalKategori = data.kategori || "Umum";

  // 1. Database Lookup (Priority): Cari kategori terakhir dari barang yang sama
  if (finalKategori === "Umum" || finalKategori === "Bulk") {
    try {
      const lastEntry = db.prepare(
        "SELECT kategori FROM transactions WHERE lower(barang) = lower(?) AND kategori NOT IN ('Umum', 'Bulk') ORDER BY tanggal DESC LIMIT 1"
      ).get(data.barang) as { kategori: string } | undefined;

      if (lastEntry && lastEntry.kategori) {
        finalKategori = lastEntry.kategori;
        console.log(`🧠 Smart Categorization (DB): Auto-detected ${data.barang} as [${finalKategori}]`);
      } else {
        // 2. Keyword Lookup (Fallback): Jika tidak ada di DB, gunakan kata kunci
        const name = data.barang.toLowerCase();
        
        const categories = {
          "Makanan": ["roti", "air", "nasi", "burger", "daging", "ikan", "snack", "buah", "indomie", "kopi", "susu", "raw", "mentah"],
          "Senjata": ["glock", "ak47", "m4", "peluru", "ammo", "mag", "shotgun", "riffle", "pistol", "senjata", "knife"],
          "Medis": ["medkit", "bandage", "perban", "obat", "vitamin", "p3k", "suntik", "infus", "darah", "aspirin"],
          "Tools": ["palu", "kunci", "obeng", "tang", "bor", "kapak", "skop", "scrap", "part", "komponen", "mesin", "perkakas", "gergaji"]
        };

        let foundMatch = false;
        
        // Cek jika Besi (harus masuk Item)
        if (name.includes("besi") || name.includes("batu") || name.includes("kayu")) {
          finalKategori = "Item";
          foundMatch = true;
        } else {
          for (const [catName, keywords] of Object.entries(categories)) {
            if (keywords.some(kw => name.includes(kw))) {
              finalKategori = catName;
              foundMatch = true;
              console.log(`🧠 Smart Categorization (Keyword): Auto-detected ${data.barang} as [${finalKategori}]`);
              break;
            }
          }
        }

        // 3. Final Fallback: Jika benar-benar tidak tahu, gunakan "Item"
        if (!foundMatch) {
          finalKategori = "Item";
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
  stmt.run(data.barang, jumlahAbs, data.tipe, data.keterangan, data.oleh, finalKategori, data.image_url || null, data.icon || null);
  
  return { ...data, kategori: finalKategori };
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
    }
  } catch (err) {
    console.error("Prefix Command Error:", err);
    await message.reply("❌ Terjadi kesalahan saat memproses perintah.");
  }
});

if (config.DISCORD_TOKEN) {
  console.log("📡 Mencoba menghubungkan bot ke Discord...");
  client.login(config.DISCORD_TOKEN).then(() => {
    console.log(`✅ Bot berhasil login sebagai ${client.user?.tag}`);
    registerCommands();
  }).catch(err => {
    console.error("❌ Kesalahan Login Discord:", err.message);
    if (err.message.includes("TOKEN_INVALID")) {
      console.error("👉 Masalah: Token tidak valid. Pastikan token di config.json atau Settings > Secrets sudah benar.");
    }
  });
} else {
  console.warn("⚠️ PERINGATAN: DISCORD_TOKEN tidak ditemukan di config.json atau environment variables.");
  console.log("Saran: Masukkan DISCORD_TOKEN di config.json atau menu Settings (ikon gir) > Secrets.");
}

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

    try {
      const stmt = db.prepare("UPDATE transactions SET barang = ? WHERE barang = ?");
      const info = stmt.run(newName, oldName);
      res.json({ success: true, affected: info.changes });
    } catch (err) {
      res.status(500).json({ error: "Database error" });
    }
  });

  // Update category for an item
  app.post("/api/update-category", (req, res) => {
    const { name, category } = req.body;
    if (!name || !category) return res.status(400).json({ error: "Missing data" });

    try {
      const stmt = db.prepare("UPDATE transactions SET kategori = ? WHERE barang = ?");
      const info = stmt.run(category, name);
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

    try {
      const data = db.prepare("SELECT * FROM transactions WHERE barang = ?").all();
      let currentQty = 0;
      data.forEach((row: any) => {
        const amt = Number(row.jumlah);
        currentQty += (row.tipe === "IN" ? amt : -amt);
      });

      // Update metadata for all transactions of this item if provided
      if (category || image_url || icon) {
        db.prepare("UPDATE transactions SET kategori = COALESCE(?, kategori), image_url = COALESCE(?, image_url), icon = COALESCE(?, icon) WHERE barang = ?")
          .run(category || null, image_url || null, icon || null, name);
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
      stmt.run(name, Math.abs(diff), tipe, note || "Penyesuaian Stok", "System (Web)", category || "Umum", image_url || null, icon || null);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Database error" });
    }
  });

  // Delete everything for an item
  app.delete("/api/item/:name", (req, res) => {
    try {
      const stmt = db.prepare("DELETE FROM transactions WHERE barang = ?");
      stmt.run(req.params.name);
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
