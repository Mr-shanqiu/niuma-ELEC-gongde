import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { MySqlDownloadCounters } from '../dist/downloads/mysql-counters.js';
const port = Number(process.env.GONGDE_DOWNLOAD_TEST_MYSQL_PORT);
const passwordFile = process.env.GONGDE_DOWNLOAD_TEST_MYSQL_PASSWORD_FILE;
if (!port || !passwordFile) throw new Error('local isolated MySQL port/password file required');
const password = (await readFile(passwordFile, 'utf8')).trim();
const pool = mysql.createPool({ host:'127.0.0.1', port, user:'root', password, database:'gongde_download_acceptance', connectionLimit:4, timezone:'Z', multipleStatements:false });
let now = new Date('2026-10-30T04:00:00Z');
const coverage = new Date('2026-10-23T02:26:26Z');
const counter = new MySqlDownloadCounters(pool, coverage, () => now);
const mac='niuma-merit-macos-0.9.5.dmg', win='niuma-merit-windows-0.9.5.exe';
try {
  for(let i=0;i<40;i++) { try { await pool.query('SELECT 1'); break; } catch(error) { if(i===39)throw error; await new Promise(resolve=>setTimeout(resolve,500)); } }
  const [identity] = await pool.query('SELECT DATABASE() AS name');
  assert.equal(identity[0].name,'gongde_download_acceptance');
  for (const table of ['gongde_download_imported_events','gongde_download_recent','gongde_download_daily','gongde_download_totals','gongde_download_counter_state']) await pool.query('DROP TABLE IF EXISTS '+table);
  const sql=await readFile(new URL('../migrations/013_download_counters.sql',import.meta.url),'utf8');
  for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await pool.query(statement);
  await assert.rejects(counter.ready(),/not_initialized/);
  await counter.initializeImport();
  const events=[
    {key:'old-mac',fileName:mac,platform:'macos',downloadedAt:new Date('2026-10-29T01:00:00Z')},
    {key:'pre-coverage',fileName:win,platform:'windows',downloadedAt:new Date('2026-10-20T01:00:00Z')},
    {key:'unknown-name',fileName:'unknown.txt',platform:null,downloadedAt:new Date('2026-10-29T01:00:00Z')}
  ];
  assert.equal(await counter.importLegacy(events),3);
  assert.equal(await counter.importLegacy(events),0);
  await counter.finishImport();
  await Promise.all(Array.from({length:20},()=>counter.recordDownload(win,'windows',new Date(now))));
  await counter.recordDownload(mac,'macos',new Date(now));
  await counter.recordDownload(mac,'macos',new Date(now));
  await counter.recordDownload(win,'windows',new Date(now));
  const from=new Date('2026-10-30T00:00:00+08:00'),to=new Date('2026-10-31T00:00:00+08:00');
  let summary=await counter.summarizeDownloads(from,to,{countedSince:coverage,registeredNames:[mac,win]});
  assert.equal(summary.total,25);assert.equal(summary.period,23);assert.equal(summary.legacyCount,1);assert.equal(summary.unattributed,1);
  assert.deepEqual(summary.byPlatform,{macos:{total:3,period:2},windows:{total:21,period:21}});
  assert.equal((await counter.cumulativeFileTotals()).find(row=>row.fileName===win).total,22);
  // A storage failure after the total/daily writes must roll the entire event back.
  await pool.query("CREATE TRIGGER reject_test_download BEFORE INSERT ON gongde_download_recent FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected_test_failure'");
  try { await assert.rejects(counter.recordDownload(win,'windows',new Date(now))); }
  finally { await pool.query('DROP TRIGGER reject_test_download'); }
  assert.equal((await counter.summarizeDownloads(from,to)).total,25);
  now=new Date('2027-02-01T04:00:00Z');
  const pruned=await counter.prune();assert.ok(pruned.recent>0);
  summary=await counter.summarizeDownloads(from,to);assert.equal(summary.total,25);assert.equal(summary.period,23);
  await assert.rejects(counter.summarizeDownloads(new Date(from.getTime()+1000),to),/whole_days/);
  assert.equal(await counter.importLegacy(events),0);
  assert.equal((await counter.summarizeDownloads(from,to)).total,25);
  now=new Date('2029-02-01T04:00:00Z');
  assert.ok((await counter.prune()).daily>0);
  await assert.rejects(counter.summarizeDownloads(from,to),/not_retained/);
  const todayFrom=new Date('2029-02-01T00:00:00+08:00'),todayTo=new Date('2029-02-02T00:00:00+08:00');
  summary=await counter.summarizeDownloads(todayFrom,todayTo);assert.equal(summary.total,25);assert.equal(summary.period,0);
  await assert.rejects(new MySqlDownloadCounters(pool,new Date(0)).ready(),/not_initialized/);
  console.log('PASS isolated MySQL: import deduplication, concurrent writes, exact recent ranges, rollback, retained daily totals, cumulative totals and coverage guard');
} finally { await pool.end(); }
