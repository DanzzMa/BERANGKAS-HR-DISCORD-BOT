import React, { useState, useEffect, useMemo, ReactNode } from "react";
import { 
  Package, 
  ArrowUpRight, 
  ArrowDownLeft, 
  History, 
  RefreshCw, 
  LayoutDashboard, 
  ShoppingBag, 
  Search, 
  Edit2, 
  Trash2, 
  X,
  Cpu,
  Archive,
  Box,
  Truck,
  HardDrive,
  Smartphone,
  Laptop,
  MousePointer2 as Mouse,
  Grid,
  Download,
  ShieldCheck
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

interface Transaction {
  id: number;
  tanggal: string;
  barang: string;
  jumlah: number;
  tipe: "IN" | "OUT";
  keterangan: string;
  oleh: string;
  kategori: string;
  image_url: string | null;
  icon: string | null;
}

interface StockDetail {
  qty: number;
  lastNote: string;
  lastUpdate?: string;
  kategori: string;
  imageUrl?: string | null;
  icon?: string | null;
}

interface BackupInfo {
  name: string;
  time: string;
  size: number;
}

type ViewMode = "dashboard" | "catalog";
type CatalogLayout = "grid" | "table";

export default function App() {
  const [data, setData] = useState<Transaction[]>([]);
  const [botStatus, setBotStatus] = useState<{ online: boolean; tag: string; latency: number; guilds?: number; uptime?: number } | null>(null);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("catalog");
  const [catalogLayout, setCatalogLayout] = useState<CatalogLayout>("grid");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("Semua");

  // Edit State
  const [editingItem, setEditingItem] = useState<{ 
    originalName: string;
    name: string; 
    qty: number; 
    kategori: string; 
    imageUrl: string;
    icon: string;
  } | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [showConfirmEdit, setShowConfirmEdit] = useState(false);
  const [showLogModal, setShowLogModal] = useState(false);
  const [newTransaction, setNewTransaction] = useState({
    name: "",
    qty: 1,
    type: "IN" as "IN" | "OUT",
    category: "Umum",
    note: ""
  });

  const formatUptime = (ms: number | undefined) => {
    if (!ms) return "0s";
    const seconds = Math.floor((ms / 1000) % 60);
    const minutes = Math.floor((ms / (1000 * 60)) % 60);
    const hours = Math.floor((ms / (1000 * 60 * 60)) % 24);
    const days = Math.floor(ms / (1000 * 60 * 60 * 24));

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (parts.length === 0 || seconds > 0) parts.push(`${seconds}s`);

    return parts.join(" ");
  };

  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());

  const fetchBotStatus = async () => {
    try {
      const res = await fetch("/api/bot-status");
      if (res.ok) {
        const json = await res.json();
        setBotStatus(json);
      }
    } catch (err) {
      console.error("Failed to refresh bot status");
    }
  };

  const fetchData = async () => {
    setLoading(true);
    try {
      const [stockRes, statusRes, backupsRes] = await Promise.all([
        fetch("/api/stock"),
        fetch("/api/bot-status"),
        fetch("/api/backups"),
      ]);
      
      if (!stockRes.ok || !statusRes.ok || !backupsRes.ok) throw new Error("Failed to fetch");
      
      const [stockJson, statusJson, backupsJson] = await Promise.all([
        stockRes.json(),
        statusRes.json(),
        backupsRes.json(),
      ]);

      console.log("📦 Data received from API:", stockJson);
      setData(stockJson);
      setBotStatus(statusJson);
      setBackups(backupsJson);
      setLastUpdated(new Date());
      setError(null);
    } catch (err) {
      setError("Gagal memuat data. Periksa konfigurasi API.");
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (dateStr: string) => {
    try {
      // Handle SQLite format YYYY-MM-DD HH:MM:SS
      const d = new Date(dateStr.replace(" ", "T"));
      if (isNaN(d.getTime())) return dateStr;
      return d.toLocaleString("id-ID", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      });
    } catch (e) {
      return dateStr;
    }
  };

  useEffect(() => {
    fetchData();
    // Auto-sync every 5 minutes
    const interval = setInterval(() => {
      console.log("🔄 Auto-syncing dashboard data...");
      fetchData();
    }, 5 * 60 * 1000);
    
    return () => clearInterval(interval);
  }, []);

  const stockData = useMemo(() => {
    const stock: Record<string, StockDetail> = {};
    data.forEach(curr => {
      if (!stock[curr.barang]) {
        stock[curr.barang] = { 
          qty: 0, 
          lastNote: curr.keterangan, 
          lastUpdate: curr.tanggal, 
          kategori: curr.kategori || "Umum", 
          imageUrl: curr.image_url,
          icon: curr.icon
        };
      }
      const amt = Number(curr.jumlah);
      const change = curr.tipe === "IN" ? amt : -amt;
      stock[curr.barang].qty += change;
      stock[curr.barang].lastNote = curr.keterangan;
      stock[curr.barang].lastUpdate = curr.tanggal;
      
      // Only update metadata if present in the current transaction row
      if (curr.kategori) stock[curr.barang].kategori = curr.kategori;
      if (curr.image_url) stock[curr.barang].imageUrl = curr.image_url;
      if (curr.icon) stock[curr.barang].icon = curr.icon;
    });
    return stock;
  }, [data]);

  const categories = useMemo(() => {
    const cats = new Set<string>(["Semua"]);
    (Object.values(stockData) as StockDetail[]).forEach(item => cats.add(item.kategori));
    return Array.from(cats);
  }, [stockData]);

  const filteredItems: [string, StockDetail][] = (Object.entries(stockData) as [string, StockDetail][]).filter(([name, detail]) => {
    const matchesSearch = name.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCategory = selectedCategory === "Semua" || detail.kategori === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  const getProductIcon = (iconName: string | null | undefined, size = 20) => {
    switch (iconName) {
      case "Cpu": return <Cpu size={size} />;
      case "Archive": return <Archive size={size} />;
      case "Box": return <Box size={size} />;
      case "Truck": return <Truck size={size} />;
      case "HardDrive": return <HardDrive size={size} />;
      case "Smartphone": return <Smartphone size={size} />;
      case "Laptop": return <Laptop size={size} />;
      case "Mouse": return <Mouse size={size} />;
      case "ShoppingBag": return <ShoppingBag size={size} />;
      default: return <Package size={size} />;
    }
  };

  const handleExportCSV = () => {
    const headers = ["Nama Barang", "Kategori", "Stok Saat Ini", "Update Terakhir", "Keterangan Terakhir"];
    const rows = Object.entries(stockData as Record<string, StockDetail>).map(([name, detail]) => [
      `"${name}"`,
      `"${detail.kategori}"`,
      detail.qty,
      `"${detail.lastUpdate || "-"}"`,
      `"${(detail.lastNote || "-").replace(/"/g, '""')}"`
    ]);

    const csvContent = [
      headers.join(","),
      ...rows.map(e => e.join(","))
    ].join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `inventory_export_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleLogTransaction = async () => {
    if (!newTransaction.name || newTransaction.qty <= 0) return;
    setIsUpdating(true);
    try {
      await fetch("/api/add-transaction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          name: newTransaction.name, 
          qty: newTransaction.qty,
          type: newTransaction.type,
          category: newTransaction.category,
          note: newTransaction.note || "Logged via Web UI" 
        })
      });
      await fetchData();
      setShowLogModal(false);
      setViewMode("dashboard");
      setNewTransaction({ name: "", qty: 1, type: "IN", category: "Umum", note: "" });
    } catch (err) {
      alert("Gagal mencatat transaksi");
    } finally {
      setIsUpdating(false);
    }
  };

  const handleUpdateItem = async (newName: string, newQty: number, newKategori: string, newImageUrl: string, newIcon: string) => {
    if (!editingItem) return;
    setIsUpdating(true);
    try {
      const original = stockData[editingItem.originalName];
      
      // 1. Handle Rename if name changed
      if (newName !== editingItem.originalName) {
        await fetch("/api/rename-item", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ oldName: editingItem.originalName, newName })
        });
      }
      
      // 2. Handle metadata & qty update
      // Always call adjust-item if any of these changed compared to ORIGINAL values
      const hasQtyChanged = newQty !== (original?.qty ?? 0);
      const hasKategoriChanged = newKategori !== (original?.kategori ?? "Umum");
      const hasImageChanged = newImageUrl !== (original?.imageUrl ?? "");
      const hasIconChanged = newIcon !== (original?.icon ?? "Package");

      if (hasQtyChanged || hasKategoriChanged || hasImageChanged || hasIconChanged) {
        await fetch("/api/adjust-item", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ 
            name: newName, 
            targetQty: newQty, 
            category: newKategori,
            image_url: newImageUrl,
            icon: newIcon,
            note: "Update Manual (Web)" 
          })
        });
      }
      
      await fetchData();
      setEditingItem(null);
      setShowConfirmEdit(false);
      setViewMode("dashboard"); // Switch to dashboard to see the log
    } catch (err) {
      alert("Gagal mengupdate barang");
    } finally {
      setIsUpdating(false);
    }
  };

  const handleDeleteItem = async (name: string) => {
    if (!confirm(`Hapus semua data untuk "${name}"? Tindakan ini tidak bisa dibatalkan.`)) return;
    try {
      await fetch(`/api/item/${encodeURIComponent(name)}`, { method: "DELETE" });
      await fetchData();
    } catch (err) {
      alert("Gagal menghapus barang");
    }
  };

  const handleDeleteTransaction = async (id: number) => {
    if (!confirm("Hapus transaksi ini?")) return;
    try {
      await fetch(`/api/transaction/${id}`, { method: "DELETE" });
      await fetchData();
    } catch (err) {
      alert("Gagal menghapus transaksi");
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans">
      {/* Navigation */}
      <nav className="sticky top-0 z-50 bg-white/80 backdrop-blur-md border-b border-slate-200 px-4 md:px-8">
        <div className="max-w-7xl mx-auto flex items-center justify-between h-14">
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-indigo-200 shadow-lg">
              <Package className="w-6 h-6 text-white" />
            </div>
            <div className="flex flex-col text-left">
              <span className="font-black text-lg tracking-tighter uppercase leading-none block">Gudang</span>
              {botStatus && (
                <div className="flex items-center gap-1.5 mt-0.5">
                  <div className={`w-1.5 h-1.5 rounded-full ${botStatus.online ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'}`} />
                  <span className="text-[8px] font-black uppercase tracking-widest text-slate-400">
                    Bot: {botStatus.online ? (botStatus.tag || "Online") : "Offline"}
                  </span>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-2xl">
            <button
              onClick={() => setViewMode("dashboard")}
              className={`flex items-center gap-2 px-4 py-1.5 rounded-xl text-[10px] font-bold uppercase tracking-wider transition-all ${
                viewMode === "dashboard" ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500 hover:text-slate-700"
              }`}
            >
              <LayoutDashboard className="w-3.5 h-3.5" />
              <span>Dashboard</span>
            </button>
            <button
              onClick={() => setViewMode("catalog")}
              className={`flex items-center gap-2 px-4 py-1.5 rounded-xl text-[10px] font-bold uppercase tracking-wider transition-all ${
                viewMode === "catalog" ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500 hover:text-slate-700"
              }`}
            >
              <ShoppingBag className="w-3.5 h-3.5" />
              <span>Katalog</span>
            </button>
          </div>

          <div className="flex items-center gap-2">
            <div className="hidden lg:flex flex-col items-end mr-2">
              <span className="text-[8px] font-black uppercase tracking-widest text-slate-400 leading-none">Sync Otomatis</span>
              <span className="text-[9px] font-bold text-indigo-400 mt-1">
                Aktif (5m) • {lastUpdated.toLocaleTimeString("id-ID", { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            <button
              onClick={() => setShowLogModal(true)}
              className="flex items-center gap-2 px-3 py-1.5 bg-indigo-600 text-white rounded-xl shadow-lg shadow-indigo-100 hover:bg-indigo-700 transition-all text-[10px] font-bold uppercase tracking-wider"
            >
              <ArrowUpRight className="w-3.5 h-3.5" />
              <span>Log Transaksi</span>
            </button>
            <button
              onClick={handleExportCSV}
              className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-xl border border-slate-200 text-slate-500 hover:text-emerald-600 hover:border-emerald-100 hover:bg-emerald-50 transition-all text-[10px] font-bold uppercase tracking-wider"
              title="Export CSV"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export CSV</span>
            </button>
            <button
              onClick={fetchData}
              className="p-2 text-slate-500 hover:bg-slate-100 rounded-xl transition-colors"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto px-4 md:px-8 py-6">
        <AnimatePresence mode="wait">
          {viewMode === "dashboard" ? (
            <motion.div
              key="dashboard"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              className="space-y-6"
            >
              <div className="space-y-4">
                <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="flex flex-col gap-1">
                    <h1 className="text-xl font-black text-slate-900 tracking-tighter uppercase">Statistik Gudang</h1>
                  </div>
                  {backups.length > 0 && (
                    <div className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-50 border border-emerald-100 rounded-2xl text-[9px] font-black uppercase tracking-widest text-emerald-600 shadow-sm self-start">
                      <ShieldCheck className="w-3.5 h-3.5" />
                      <span>Last Backup: {new Date(backups[0].time).toLocaleString('id-ID')}</span>
                    </div>
                  )}
                </header>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <StatCard title="Total Produk" value={Object.keys(stockData).length} icon={<Package className="w-5 h-5 text-indigo-600" />} color="indigo" />
                  <StatCard 
                    title="Barang Masuk" 
                    value={data.filter(d => d.tipe === 'IN').reduce((acc, curr) => acc + Number(curr.jumlah), 0)} 
                    icon={<ArrowUpRight className="w-5 h-5 text-emerald-600" />} 
                    color="emerald" 
                  />
                  <StatCard 
                    title="Barang Keluar" 
                    value={data.filter(d => d.tipe === 'OUT').reduce((acc, curr) => acc + Number(curr.jumlah), 0)} 
                    icon={<ArrowDownLeft className="w-5 h-5 text-rose-600" />} 
                    color="rose" 
                  />
                </div>

                <section className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden flex flex-col">
                  <div className="p-4 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between">
                    <h2 className="font-bold text-[10px] text-slate-800 flex items-center gap-2 uppercase tracking-widest">
                      <History className="w-4 h-4 text-slate-400" /> Log Transaksi
                    </h2>
                  </div>
                  <div className="overflow-x-auto flex-1">
                    <table className="w-full text-left text-sm border-separate border-spacing-0">
                      <thead className="bg-slate-50/30">
                        <tr>
                          <th className="px-5 py-3 font-black uppercase text-[9px] tracking-widest text-slate-400 border-b border-slate-100">Tanggal</th>
                          <th className="px-5 py-3 font-black uppercase text-[9px] tracking-widest text-slate-400 border-b border-slate-100">Nama Barang</th>
                          <th className="px-5 py-3 font-black uppercase text-[9px] tracking-widest text-slate-400 border-b border-slate-100">Kategori</th>
                          <th className="px-5 py-3 font-black uppercase text-[9px] tracking-widest text-slate-400 border-b border-slate-100">Oleh</th>
                          <th className="px-5 py-3 font-black uppercase text-[9px] tracking-widest text-slate-400 border-b border-slate-100 text-right">Qty</th>
                          <th className="px-5 py-3 border-b border-slate-100"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50">
                        {data.slice().reverse().map((item) => (
                          <tr key={item.id} className="hover:bg-slate-50 transition-colors group">
                            <td className="px-5 py-3 text-[10px] text-slate-400 font-medium">{formatDate(item.tanggal)}</td>
                            <td className="px-5 py-3 font-bold text-sm text-slate-800">{item.barang}</td>
                            <td className="px-5 py-3">
                              <span className="text-[9px] font-black uppercase tracking-widest text-slate-300">
                                {item.kategori || "Umum"}
                              </span>
                            </td>
                            <td className="px-5 py-3">
                              <span className="text-[10px] font-bold text-indigo-400">@{item.oleh}</span>
                            </td>
                            <td className={`px-5 py-3 text-right font-mono font-black text-sm ${item.tipe === 'IN' ? 'text-emerald-600' : 'text-rose-600'}`}>
                              {item.tipe === 'IN' ? '+' : '-'}{item.jumlah}
                            </td>
                            <td className="px-5 py-3 text-right">
                              <button 
                                onClick={() => handleDeleteTransaction(item.id)}
                                className="p-1.5 text-slate-300 hover:text-rose-500 hover:bg-rose-50 rounded-lg transition-all opacity-0 group-hover:opacity-100"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="catalog"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-6"
            >
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <h1 className="text-xl font-black text-slate-900 tracking-tighter uppercase">Daftar Barang</h1>
                
                <div className="flex flex-wrap items-center gap-2">
                  <div className="border-r border-slate-200 pr-2 mr-2 hidden lg:block">
                    <select 
                      value={selectedCategory} 
                      onChange={(e) => setSelectedCategory(e.target.value)}
                      className="bg-transparent text-[10px] font-black uppercase tracking-widest text-slate-400 outline-none cursor-pointer hover:text-indigo-600 transition-colors"
                    >
                      {categories.map(cat => (
                        <option key={cat} value={cat}>{cat}</option>
                      ))}
                    </select>
                  </div>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                    <input
                      type="text"
                      placeholder="Cari..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-9 pr-4 py-1.5 bg-white border border-slate-200 rounded-xl shadow-sm outline-none focus:ring-1 focus:ring-indigo-500 transition-all font-bold text-[11px] w-48"
                    />
                  </div>
                  <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl">
                    <button 
                      onClick={() => setCatalogLayout("grid")}
                      className={`p-1.5 rounded-lg transition-all ${catalogLayout === 'grid' ? 'bg-white shadow-sm text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}
                    >
                      <LayoutDashboard className="w-3.5 h-3.5" />
                    </button>
                    <button 
                      onClick={() => setCatalogLayout("table")}
                      className={`p-1.5 rounded-lg transition-all ${catalogLayout === 'table' ? 'bg-white shadow-sm text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}
                    >
                      <History className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>

              {catalogLayout === "grid" ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-3">
                  {filteredItems.map(([name, detail]) => {
                    const seed = name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
                    return (
                      <motion.div
                        key={name}
                        layout
                        className="bg-white border border-slate-100 rounded-xl overflow-hidden flex flex-col group hover:border-indigo-100 transition-all shadow-sm"
                      >
                        <div className="aspect-square bg-slate-100 relative overflow-hidden flex items-center justify-center">
                          {detail.imageUrl ? (
                            <img
                              src={detail.imageUrl}
                              alt={name}
                              className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                              referrerPolicy="no-referrer"
                            />
                          ) : (
                            <div className="flex flex-col items-center gap-2 text-slate-300">
                              {getProductIcon(detail.icon, 32)}
                              <span className="text-[8px] font-black uppercase tracking-[0.2em] opacity-50">No Image</span>
                            </div>
                          )}
                          <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button 
                              onClick={() => setEditingItem({ 
                                originalName: name,
                                name, 
                                qty: detail.qty, 
                                kategori: detail.kategori, 
                                imageUrl: detail.imageUrl || "",
                                icon: detail.icon || "Package"
                              })}
                              className="w-7 h-7 bg-white/90 backdrop-blur rounded-lg flex items-center justify-center shadow-sm text-slate-600 hover:text-indigo-600 transition-colors"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                            <button 
                              onClick={() => handleDeleteItem(name)}
                              className="w-7 h-7 bg-white/90 backdrop-blur rounded-lg flex items-center justify-center shadow-sm text-slate-600 hover:text-rose-600 transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                          <div className="absolute top-2 left-2">
                            <span className="px-1.5 py-0.5 bg-white/80 backdrop-blur-sm rounded text-[7px] font-black text-slate-400 uppercase tracking-widest shadow-sm">
                              {detail.kategori}
                            </span>
                          </div>
                        </div>
                        <div className="p-2.5 flex flex-col gap-1 bg-white">
                          <h3 className="font-bold text-[10px] text-slate-800 leading-tight truncate px-0.5" title={name}>{name}</h3>
                          <div className="flex items-center justify-between px-0.5 mt-1">
                            <span className="text-[7px] font-bold text-slate-400 uppercase tracking-widest">Stok</span>
                            <span className={`text-xs font-black tracking-tight ${detail.qty <= 0 ? 'text-rose-500' : 'text-indigo-600'}`}>
                              {detail.qty}
                            </span>
                          </div>
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              ) : (
                <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
                  <table className="w-full text-left text-sm border-separate border-spacing-0">
                    <thead className="bg-slate-50 text-slate-400 font-black uppercase text-[9px] tracking-widest">
                      <tr>
                        <th className="px-5 py-3 border-b border-slate-100">Kategori</th>
                        <th className="px-5 py-3 border-b border-slate-100">Nama Barang</th>
                        <th className="px-5 py-3 border-b border-slate-100 text-right">Jumlah Stok</th>
                        <th className="px-5 py-3 border-b border-slate-100"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {filteredItems.map(([name, detail]) => (
                        <tr key={name} className="hover:bg-slate-50 transition-colors group">
                          <td className="px-5 py-3">
                            <span className="text-[9px] font-black uppercase tracking-widest text-slate-300">
                              {detail.kategori}
                            </span>
                          </td>
                          <td className="px-5 py-3">
                            <div className="font-bold text-slate-900 text-sm">{name}</div>
                          </td>
                          <td className="px-5 py-3 text-right">
                            <span className={`text-sm font-black px-2 py-0.5 rounded-md ${detail.qty <= 0 ? 'bg-rose-100 text-rose-600' : 'bg-slate-100 text-slate-600'}`}>
                              {detail.qty}
                            </span>
                          </td>
                          <td className="px-5 py-3 text-right whitespace-nowrap">
                            <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button 
                                onClick={() => setEditingItem({ 
                                  originalName: name,
                                  name, 
                                  qty: detail.qty, 
                                  kategori: detail.kategori, 
                                  imageUrl: detail.imageUrl || "",
                                  icon: detail.icon || "Package"
                                })}
                                className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-all"
                              >
                                <Edit2 className="w-4 h-4" />
                              </button>
                              <button 
                                onClick={() => handleDeleteItem(name)}
                                className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-all"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {filteredItems.length === 0 && !loading && (
                <div className="py-20 text-center">
                  <p className="text-slate-400 text-xs font-bold uppercase tracking-widest">Tidak ada data</p>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* New Transaction Modal */}
      <AnimatePresence>
        {showLogModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowLogModal(false)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-md bg-white rounded-3xl shadow-2xl overflow-hidden"
            >
              <div className="p-6 border-b border-slate-100 flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-black text-slate-900 tracking-tight uppercase">Catat Transaksi</h3>
                  <p className="text-xs text-slate-400 font-medium tracking-wide">Input barang masuk atau keluar.</p>
                </div>
                <button 
                  onClick={() => setShowLogModal(false)}
                  className="p-2 text-slate-300 hover:text-slate-500 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="p-6 space-y-4">
                <div className="flex gap-1 p-1 bg-slate-100 rounded-2xl">
                  <button
                    onClick={() => setNewTransaction({ ...newTransaction, type: "IN" })}
                    className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${
                      newTransaction.type === "IN" ? "bg-white text-emerald-600 shadow-sm" : "text-slate-400"
                    }`}
                  >
                    <ArrowUpRight className="w-3.5 h-3.5" />
                    Barang Masuk
                  </button>
                  <button
                    onClick={() => setNewTransaction({ ...newTransaction, type: "OUT" })}
                    className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${
                      newTransaction.type === "OUT" ? "bg-white text-rose-600 shadow-sm" : "text-slate-400"
                    }`}
                  >
                    <ArrowDownLeft className="w-3.5 h-3.5" />
                    Barang Keluar
                  </button>
                </div>

                <div className="space-y-1.5">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-1">Nama Barang</label>
                  <input
                    type="text"
                    list="inventory-suggestions"
                    value={newTransaction.name}
                    onChange={(e) => {
                      const name = e.target.value;
                      const existing = stockData[name];
                      setNewTransaction({ 
                        ...newTransaction, 
                        name, 
                        category: existing ? existing.kategori : newTransaction.category 
                      });
                    }}
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-100 rounded-2xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all font-bold text-sm"
                    placeholder="Ketik nama barang..."
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-1">Jumlah</label>
                    <input
                      type="number"
                      value={newTransaction.qty}
                      onChange={(e) => setNewTransaction({ ...newTransaction, qty: Number(e.target.value) })}
                      className="w-full px-4 py-3 bg-slate-50 border border-slate-100 rounded-2xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all font-bold text-sm"
                      min="1"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-1">Kategori</label>
                    <input
                      type="text"
                      value={newTransaction.category}
                      onChange={(e) => setNewTransaction({ ...newTransaction, category: e.target.value })}
                      className="w-full px-4 py-3 bg-slate-50 border border-slate-100 rounded-2xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all font-bold text-sm"
                      placeholder="Umum"
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-1">Keterangan</label>
                  <textarea
                    value={newTransaction.note}
                    onChange={(e) => setNewTransaction({ ...newTransaction, note: e.target.value })}
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-100 rounded-2xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all font-bold text-sm resize-none"
                    placeholder="Opsional..."
                    rows={2}
                  />
                </div>
              </div>

              <div className="p-6 bg-slate-50/50 border-t border-slate-100 flex gap-3">
                <button
                  onClick={() => setShowLogModal(false)}
                  className="flex-1 px-6 py-3 border border-slate-200 text-slate-600 font-black text-xs uppercase tracking-widest rounded-2xl hover:bg-white transition-all"
                >
                  Batal
                </button>
                <button
                  onClick={handleLogTransaction}
                  disabled={isUpdating || !newTransaction.name || newTransaction.qty <= 0}
                  className="flex-1 px-6 py-3 bg-indigo-600 text-white font-black text-xs uppercase tracking-widest rounded-2xl hover:bg-indigo-700 shadow-lg shadow-indigo-200 transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:grayscale transition-all"
                >
                  {isUpdating ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : "Simpan"}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Edit Modal */}
      <AnimatePresence>
        {editingItem && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setEditingItem(null)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-md bg-white rounded-3xl shadow-2xl overflow-hidden"
            >
              <div className="p-6 border-b border-slate-100 flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-black text-slate-900 tracking-tight uppercase">Edit Barang</h3>
                  <p className="text-xs text-slate-400 font-medium tracking-wide">Sesuaikan informasi inventaris.</p>
                </div>
                <button 
                  onClick={() => setEditingItem(null)}
                  className="p-2 text-slate-300 hover:text-slate-500 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="p-6 space-y-4">
                {showConfirmEdit ? (
                  <div className="py-8 text-center space-y-4">
                    <div className="w-16 h-16 bg-amber-50 text-amber-500 rounded-full flex items-center justify-center mx-auto mb-4">
                      <RefreshCw className="w-8 h-8" />
                    </div>
                    <h4 className="text-sm font-black text-slate-900 uppercase tracking-tight">Konfirmasi Perubahan?</h4>
                    <p className="text-xs text-slate-500 font-medium max-w-[240px] mx-auto">
                      Anda akan memperbarui informasi inventaris untuk <span className="font-bold text-slate-900">"{editingItem.name}"</span>. Pastikan data sudah benar.
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="space-y-1.5">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-1">Nama Barang</label>
                      <input
                        type="text"
                        list="inventory-suggestions"
                        value={editingItem.name}
                        onChange={(e) => setEditingItem({ ...editingItem, name: e.target.value })}
                        className="w-full px-4 py-3 bg-slate-50 border border-slate-100 rounded-2xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all font-bold text-sm"
                        placeholder="Contoh: Meja Kayu"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-1">Jumlah Stok</label>
                        <input
                          type="number"
                          value={editingItem.qty}
                          onChange={(e) => setEditingItem({ ...editingItem, qty: Number(e.target.value) })}
                          className="w-full px-4 py-3 bg-slate-50 border border-slate-100 rounded-2xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all font-bold text-sm"
                          placeholder="0"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-1">Kategori</label>
                        <input
                          type="text"
                          value={editingItem.kategori}
                          onChange={(e) => setEditingItem({ ...editingItem, kategori: e.target.value })}
                          className="w-full px-4 py-3 bg-slate-50 border border-slate-100 rounded-2xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all font-bold text-sm"
                          placeholder="Elektronik"
                        />
                      </div>
                    </div>
                    
                    <div className="space-y-1.5">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-1">Pilih Icon & Gambar</label>
                      <div className="grid grid-cols-1 gap-3">
                        <input
                          type="text"
                          value={editingItem.imageUrl}
                          onChange={(e) => setEditingItem({ ...editingItem, imageUrl: e.target.value })}
                          className="w-full px-4 py-2 bg-slate-50 border border-slate-100 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all font-bold text-[11px]"
                          placeholder="URL Gambar (Opsional)"
                        />
                        <div className="flex flex-wrap gap-1.5 p-2 bg-slate-50 rounded-xl border border-slate-100">
                          {["Package", "Cpu", "Archive", "Box", "Truck", "HardDrive", "Smartphone", "Laptop", "Mouse", "ShoppingBag"].map((iconName) => (
                            <button
                              key={iconName}
                              onClick={() => setEditingItem({ ...editingItem, icon: iconName })}
                              className={`w-8 h-8 flex items-center justify-center rounded-lg transition-all ${
                                editingItem.icon === iconName 
                                  ? "bg-indigo-600 text-white shadow-md shadow-indigo-100" 
                                  : "bg-white text-slate-300 hover:text-indigo-400 border border-slate-100"
                              }`}
                            >
                              {getProductIcon(iconName, 14)}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>

              <div className="p-6 bg-slate-50/50 border-t border-slate-100 flex gap-3">
                {showConfirmEdit ? (
                  <>
                    <button
                      onClick={() => setShowConfirmEdit(false)}
                      className="flex-1 px-6 py-3 border border-slate-200 text-slate-600 font-black text-xs uppercase tracking-widest rounded-2xl hover:bg-white transition-all"
                    >
                      Kembali
                    </button>
                    <button
                      onClick={() => handleUpdateItem(editingItem.name, editingItem.qty, editingItem.kategori, editingItem.imageUrl, editingItem.icon)}
                      disabled={isUpdating}
                      className="flex-1 px-6 py-3 bg-emerald-600 text-white font-black text-xs uppercase tracking-widest rounded-2xl hover:bg-emerald-700 shadow-lg shadow-emerald-200 transition-all flex items-center justify-center gap-2"
                    >
                      {isUpdating ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : "Ya, Simpan"}
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => {
                        setEditingItem(null);
                        setShowConfirmEdit(false);
                      }}
                      className="flex-1 px-6 py-3 border border-slate-200 text-slate-600 font-black text-xs uppercase tracking-widest rounded-2xl hover:bg-white transition-all"
                    >
                      Batal
                    </button>
                    <button
                      onClick={() => setShowConfirmEdit(true)}
                      disabled={isUpdating}
                      className="flex-1 px-6 py-3 bg-indigo-600 text-white font-black text-xs uppercase tracking-widest rounded-2xl hover:bg-indigo-700 shadow-lg shadow-indigo-200 transition-all flex items-center justify-center gap-2"
                    >
                      Simpan
                    </button>
                  </>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <datalist id="inventory-suggestions">
        {Object.keys(stockData).map(name => (
          <option key={name} value={name} />
        ))}
      </datalist>
    </div>
  );
}

function StatCard({ title, value, icon, color }: { title: string; value: number | string; icon: ReactNode; color: string }) {
  const colors: Record<string, string> = {
    indigo: "bg-indigo-50 border-indigo-100 text-indigo-600",
    emerald: "bg-emerald-50 border-emerald-100 text-emerald-600",
    rose: "bg-rose-50 border-rose-100 text-rose-600",
  };

  return (
    <div className={`p-4 bg-white border border-slate-200 rounded-2xl shadow-sm flex items-center justify-between group transition-all hover:shadow-md`}>
      <div className="space-y-0">
        <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">{title}</p>
        <p className="text-2xl font-black text-slate-900 tracking-tighter">{value}</p>
      </div>
      <div className={`p-2.5 rounded-xl transition-transform group-hover:scale-105 shadow-sm ${colors[color] || 'bg-slate-50'}`}>
        {icon}
      </div>
    </div>
  );
}
