-- Hapus tabel jika sudah ada (Opsional, hati-hati jika ada data)
-- DROP TABLE IF EXISTS transactions;

-- Buat tabel transactions
CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    tanggal TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    barang VARCHAR(255) NOT NULL,
    jumlah INT NOT NULL,
    tipe VARCHAR(10) CHECK (tipe IN ('IN', 'OUT')) NOT NULL,
    keterangan TEXT,
    oleh VARCHAR(255) NOT NULL
);

-- Contoh data (Opsional)
-- INSERT INTO transactions (barang, jumlah, tipe, keterangan, oleh) VALUES ('Contoh Barang', 10, 'IN', 'Stok Awal', 'Admin');
