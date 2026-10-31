# 📦 Hệ Thống Báo Cáo Đối Soát Tồn Kho 3D & Kiểm Kê PDA Multi-Agent

Hệ thống Dashboard 3D động & Đối soát Kiểm kê Đa Tác Tử (**Multi-Agent Inventory Reconciliation**) cho **Kho `01` & `61`** với các nhóm mã hàng **`3*`, `5*`, `7*`**.

---

## 📊 1. Tóm Tắt Báo Cáo Đối Soát Lãnh Đạo (Executive Summary — 31/10/2026)

> **Nguyên tắc đối soát Multi-Agent:** Khi quét kiểm kê bằng súng PDA, thiết bị chỉ ghi nhận `Tag ID` (`BATCH`) và `Vị trí` mà không có số lượng. Hệ thống sử dụng 4 Agent chuyên biệt để tự động lọc phạm vi (**Kho `01`, `61` & Mã `3*`, `5*`, `7*`**), khử trùng lặp `Tag ID` bị quét nhiều lần, và đối chiếu trực tiếp với `BATCH` trên bảng tồn kho để trả về **Số lượng kiểm được** và **Số lượng thiếu** chính xác tuyệt đối.

| Chỉ Số KPI Đối Soát | Số Lượng TagID (Batch) | Tỷ Lệ Tag (%) | Tổng Số Lượng (Qty) | Tỷ Lệ SL (%) | Ghi Chú Đối Soát |
| :--- | ---: | ---: | ---: | ---: | :--- |
| **1. Tổng Tồn Kho Hệ Thống (`Kho 01 & 61` \| `3*, 5*, 7*`)** | **4,328** | `100.00%` | **35,774,265** | `100.00%` | `850` Mã hàng (`901` cặp Kho–Mã) từ `24,961` dòng gốc |
| **2. Đã Kiểm Được (Quét PDA khớp TagID)** | **3,782** | `87.38%` | **33,460,239** | **`93.53%`** | Tự động quy đổi từ TagID sang Số lượng tồn |
| **3. Chưa Kiểm / Thiếu So Với Tồn Kho** | **546** | `12.62%` | **2,314,026** | **`6.47%`** | Các TagID trên sổ tồn kho chưa được quét PDA |
| **4. Cảnh Báo Quét Trùng TagID (Đã khử trùng)** | **18** | `0.47%` | **+455,399** *(Đã chặn)* | — | `19` lượt quét dư (`17` mã quét 2 lần, `1` mã quét 3 lần) |
| **5. Cảnh Báo Lệch Vị Trí (`BIN` Sổ ≠ `Vị Trí` Quét)** | **109** | `2.88%` | — | — | Khớp TagID nhưng vị trí thực tế khác BIN trên sổ |
| **6. TagID Ngoài Phạm Vi / Chưa Có Trên Tồn Kho** | **85** | — | — | — | `35` Tag thuộc kho/mã khác + `50` Tag chưa có trên sổ |

---

## 🏛️ 2. Bảng Phân Tích Chi Tiết Theo Kho (`01`, `61`) & Nhóm Mã Hàng (`3*`, `5*`, `7*`)

| Kho (WH) | Nhóm Mã | Số Mã Hàng | Tổng Tag Tồn | Tag Kiểm Được | Tag Thiếu | Tỷ Lệ Tag (%) | Tổng SL Tồn Kho | SL Kiểm Được | SL Thiếu So Với Tồn | Tỷ Lệ Đạt SL (%) |
| :---: | :---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **Kho 01** | **`3*`** | 18 | 19 | 0 | 19 | `0.00%` | 26,092 | 0 | 26,092 | `0.00%` |
| **Kho 01** | **`5*`** | 3 | 7 | 6 | 1 | `85.71%` | 224,875 | 224,875 | 0 | **`100.00%`** |
| **Kho 01** | **`7*`** | 57 | 96 | 63 | 33 | `65.63%` | 2,870,000 | 2,711,475 | 158,525 | **`94.48%`** |
| **Kho 61** | **`3*`** | 687 | 3,082 | 2,701 | 381 | `87.64%` | 3,023,067 | 2,728,764 | 294,303 | **`90.26%`** |
| **Kho 61** | **`5*`** | 7 | 55 | 55 | 0 | `100.00%` | 1,317,425 | 1,251,425 | 66,000 | **`94.99%`** |
| **Kho 61** | **`7*`** | 129 | 1,069 | 957 | 112 | `89.52%` | 28,312,806 | 26,543,700 | 1,769,106 | **`93.75%`** |
| **TỔNG** | **`3*, 5*, 7*`** | **850** | **4,328** | **3,782** | **546** | **`87.38%`** | **35,774,265** | **33,460,239** | **2,314,026** | **`93.53%`** |

---

## 🚀 3. Tính Năng Chính Của Bảng Báo Cáo Dashboard 3D (`index.html`)

1. **Mô Hình Không Gian Kho 3D Động (WebGL / Three.js) & 6 Thẻ KPI 3D Động**:
   - Xoay 360° trực quan hóa tương quan **Số lượng kiểm được** và **Số lượng thiếu** của Kho `01` & `61` theo các nhóm mã `3*`, `5*`, `7*`.
2. **Đọc Mọi Định Dạng File (`.xlsx`, `.xls`, `.csv`, `.tsv`, `.json`, `.txt`, `.xml`) & Nút Xóa Dữ Liệu Cũ Về 0**:
   - Hai bảng nguồn độc lập (**Bảng Nguồn 1: File Tồn Kho** và **Bảng Nguồn 2: File Kiểm Kê PDA**).
   - Mỗi bảng đều có nút **[📂 Nhập File Mới]** và **[🗑️ Xóa Dữ Liệu Cũ]**. Khi xóa dữ liệu nguồn, toàn bộ hệ thống tự động đưa số liệu về `0` khi không có dữ liệu đối soát.
3. **Giao Diện Nổi Máy Quét Mã Vạch PDA (`pda-scanner.html` / Nút `Mở Máy Quét PDA`)**:
   - Giao diện mô phỏng máy quét PDA thực tế:
     1. Nhập **Tên người dùng (`USER / USE`)**
     2. **Ô quét Vị trí (`BIN / Location`)** $\rightarrow$ nhấn `Enter` xuống dưới:
     3. **Ô quét TagID (`Batch`)** *(tự động tra cứu ngay Mã hàng, Kho, BIN & Số lượng từ Tồn kho và cảnh báo nếu trùng TagID)* $\rightarrow$ nhấn `Enter` xuống dưới:
     4. **Ô Số lượng (`Qty`)** $\rightarrow$ nhấn **[OK — GHI NHẬN]**.
   - **Ghi nhận lên dòng trên cùng (Dòng 1)** của bảng quét và lập tức đối soát trực tiếp với dữ liệu tồn kho.
4. **Xuất Báo Cáo Excel Đa Sheet (`Bao_Cao_Doi_Soat_Ton_Kho_31.10.2026.xlsx`)**:
   - `1_Tong_Hop_Bao_Cao`: Bảng KPI & Ma trận Tổng hợp Lãnh đạo.
   - `2_Theo_Ma_Hang_Vi_Tri`: Tổng hợp theo từng Mã hàng kèm Số lượng & Vị trí (`BIN` sổ vs `Vị trí` quét).
   - `3_Chi_Tiet_TagID`: Chi tiết đối soát từng `TagID / Batch` (`4,328` dòng).
   - `4_Canh_Bao_Trung_TagID`: Danh sách chi tiết `18` TagID bị quét trùng & `85` TagID ngoài phạm vi.
   - `5_Du_Lieu_Quet_PDA`: Toàn bộ lịch sử quét PDA.
