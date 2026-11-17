# SQL Guard

VS Code extension เล็ก ๆ ที่ครอบคำสั่ง **Execute Query** ของ mssql extension
ก่อนรันจะสแกน SQL (ส่วนที่ select ไว้ หรือทั้งไฟล์ถ้าไม่ได้ select) แล้วเด้ง popup ยืนยันถ้าเจอ:

- `UPDATE` / `DELETE` ที่ไม่มี `WHERE` (WHERE ใน subquery หรือใน statement ถัดไปไม่นับ)
- `UPDATE` / `DELETE` ที่ WHERE เป็นจริงเสมอ เช่น `WHERE 1=1`, `WHERE (1=1)`, `WHERE x = 5 OR 1=1`
  (`WHERE 1=1 AND x = 5` ไม่เตือน เพราะยังกรองจริง)
- `DROP ...` และ `TRUNCATE TABLE` (ยกเว้น temp table `#tmp`)

ไม่ตรวจ: dynamic SQL ใน `EXEC('...')`, body ของ `CREATE PROCEDURE/FUNCTION/TRIGGER`,
และ `MERGE`

## ใช้งาน

- `Cmd+Shift+E` ในไฟล์ `.sql` → ผ่าน SQL Guard (ต้องปิด keybinding เดิมของ mssql ใน `keybindings.json`
  ด้วย `"-mssql.runQuery"`)
- ปุ่มโล่สีเขียวมี ▶ (`media/safe-run-*.svg`) บน editor title / คลิกขวา → **Execute Query (Safe)**

## รันทีละ method (`-- #region`)

ครอบ query ด้วย `-- #region ชื่อ` … `-- #endregion` แล้วจะได้:

- ปุ่ม **▶ Run** เหนือบรรทัด `#region` — select เนื้อในแล้วรันผ่าน SQL Guard (popup เตือนเหมือนเดิม)
- รายชื่อ region ใน Outline / breadcrumbs / `Cmd+Shift+O` เหมือน function
- พับ/กาง region ได้ (built-in ของ VS Code) — `Cmd+K Cmd+0` พับทั้งหมด

region ซ้อนกันได้ ถ้าไม่มี `#endregion` จะนับไปถึงท้ายไฟล์

### panel SQL Regions

panel **SQL Regions** ใน Explorer แสดง region ของไฟล์ `.sql` ล่าสุดที่เปิด (ชื่อไฟล์อยู่ข้างหัว panel)

- จัดกลุ่มตามบรรทัด `-- ==== ชื่อกลุ่ม ====` (`=` อย่างน้อย 3 ตัวทั้งสองฝั่ง) — region อยู่ใต้กลุ่มที่อยู่เหนือมัน,
  region ก่อนกลุ่มแรกอยู่ชั้นบนสุด
- ปุ่ม ▶ ข้างชื่อ (ชี้เมาส์แล้วขึ้น) รัน region นั้นผ่าน SQL Guard เหมือน ▶ Run ใน editor
- คลิกชื่อ → กระโดดไปที่ region, ชี้เมาส์ค้าง → เห็น SQL 8 บรรทัดแรก
- อัปเดตเองตอนแก้ไฟล์ / สลับไปไฟล์ `.sql` อื่น; ซ่อนเองถ้ายังไม่ได้เปิดไฟล์ `.sql`
- ย้าย panel ไป sidebar อื่นได้ (ลากหัว panel) เช่นไปไว้ใน SQL Server ของ mssql

## Refresh IntelliSense อัตโนมัติ

IntelliSense ของ mssql มักจับ error จาก database เดิมค้างไว้หลังเปลี่ยน connection/database
(ขีดแดงทั้งที่รันได้) SQL Guard จึงสั่ง **MS SQL: Refresh IntelliSense Cache** ให้เองเมื่อ connection หรือ
database ของไฟล์ `.sql` ที่เปิดอยู่เปลี่ยน — รัน `USE ...`, Change Database, Change Connection

- ฟังจาก `getSharedConnectionsApi(1).onDidChangeActiveEditorConnection` ของ mssql (มีใน mssql รุ่นใหม่;
  รุ่นเก่าที่ไม่มี API นี้จะไม่ refresh เอง)
- แค่สลับแท็บไปไฟล์ที่ต่อ connection อื่นไม่นับ
- ปิดได้ด้วย setting `sqlGuard.autoRefreshIntelliSense`
- สั่งเองได้ด้วย `Cmd+Shift+R` ในไฟล์ `.sql`
- ไม่แก้ขีดแดงที่ IntelliSense อ่านไม่ถึงจริง ๆ เช่นคอลัมน์ผ่าน synonym ที่ชี้ข้าม linked server (ใช้ view แทน)
- สร้าง/แก้ตาราง view หรือ synonym ไม่ได้เปลี่ยน connection จึงไม่ refresh เอง — กด `Cmd+Shift+R` หลังรัน

## ซ่อน Execute Query เดิมของ mssql

setting `sqlGuard.hideMssqlExecute` (ค่าเริ่มต้น `true`) ซ่อนปุ่ม ▶, เมนูคลิกขวา และ Command Palette
ของ `mssql.runQuery` ให้รันผ่าน SQL Guard ได้ทางเดียว

- VS Code ไม่มี API ซ่อนเมนูของ extension อื่น จึงแก้ `when` ใน `package.json` ของ mssql เป็น `false`
  (เก็บต้นฉบับไว้ที่ `package.json.sql-guard-backup` ข้าง ๆ)
- ทำซ้ำทุกครั้งที่ VS Code เปิด — mssql อัปเดตเมื่อไหร่จะ patch ใหม่แล้วขึ้นปุ่ม Reload Window
- คืนปุ่มเดิม: ตั้ง `sqlGuard.hideMssqlExecute` เป็น `false` หรือ uninstall SQL Guard
  (`vscode:uninstall` คืนให้หลัง restart VS Code) — แค่ Disable จะไม่คืน

## Build / install

```bash
node --test
python3 package.py
code --install-extension sql-guard-0.6.0.vsix
```
