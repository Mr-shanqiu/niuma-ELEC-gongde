// Fixed-scope legacy import: never delete COS objects or rewrite installer files.
import { createHash } from 'node:crypto';
import { MySqlPaymentStore, loadGongdeMySqlConfiguration } from '../dist/storage/mysql-store.js';
import { AdminObjectStore, loadAdminObjectStoreConfiguration } from '../dist/admin/object-store.js';
import { loadDownloadCoverage } from '../dist/downloads/installer-registry.js';
const allowed = new Set(['--import', '--ready']);
if (process.argv.length !== 3 || !allowed.has(process.argv[2])) throw new Error('usage: import-download-events.mjs --import|--ready');
const coverage = loadDownloadCoverage();
if (!coverage.startedAt) throw new Error('download_coverage_required');
const configuration = loadAdminObjectStoreConfiguration();
if (!configuration) throw new Error('download_object_store_required');
const store = MySqlPaymentStore.connect(loadGongdeMySqlConfiguration());
try {
  const counter = store.downloadCounters(new Date(coverage.startedAt));
  const objects = new AdminObjectStore(configuration);
  await counter.initializeImport();
  const events = await objects.downloadEventsForImport();
  events.sort((a, b) => a.key.localeCompare(b.key));
  const digest = createHash('sha256').update(JSON.stringify(events.map(event => event.key))).digest('hex');
  const imported = await counter.importLegacy(events);
  if (process.argv[2] === '--ready') {
    await counter.finishImport();
    const now = Date.now();
    const summary = await counter.summarizeDownloads(new Date(now - 1), new Date(now + 1));
    if (summary.total + summary.legacyCount !== events.length) throw new Error('initial_import_count_mismatch');
  }
  console.log(JSON.stringify({ sourceEventCount: events.length, sourceKeyDigest: digest, imported, deduplicated: events.length - imported, ready: process.argv[2] === '--ready', cosObjectsDeleted: 0 }));
} finally { await store.close(); }
