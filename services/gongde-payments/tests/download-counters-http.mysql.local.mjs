import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
const port=process.env.GONGDE_DOWNLOAD_TEST_MYSQL_PORT,passwordFile=process.env.GONGDE_DOWNLOAD_TEST_MYSQL_PASSWORD_FILE;
if(!port||!passwordFile)throw Error('isolated database port/password file required');
const root=await mkdtemp(join(tmpdir(),'gongde-counter-http-'));
const password='synthetic-download-admin-password';
let cosWrites=0;
mock.module('cos-nodejs-sdk-v5',{defaultExport:class {
 getBucket(_p,callback){callback(null,{Contents:[],IsTruncated:'false'});}
 putObject(_p,callback){cosWrites++;callback(Error('unexpected_COS_write'));}
}});
const name='niuma-test-counter-win.exe',target='https://download.gongde.zqscreen.cn/'+name;
await writeFile(join(root,'registry.json'),JSON.stringify({schemaVersion:1,items:[{platform:'windows',version:'0.9.5',format:'exe',releaseId:'test-counter',name,bytes:1024,sha256:'a'.repeat(64),perpetualCompatible:true,publicDownloadUrl:target}]}));
await writeFile(join(root,'admin-password'),password,{mode:0o600});
await writeFile(join(root,'admin-session'),'synthetic-session-secret-at-least-32-bytes',{mode:0o600});
for(const key of Object.keys(process.env))if(key.startsWith('GONGDE_')&&!key.startsWith('GONGDE_DOWNLOAD_TEST_'))delete process.env[key];
Object.assign(process.env,{HOST:'127.0.0.1',PORT:'0',GONGDE_PAYMENT_MODE:'mock',GONGDE_PAYMENT_TEST_TOKEN:'synthetic-download-test-token-at-least-24',GONGDE_STORE_MODE:'mysql',GONGDE_PACK_DELIVERY_MODE:'disabled',GONGDE_MYSQL_HOST:'127.0.0.1',GONGDE_MYSQL_PORT:port,GONGDE_MYSQL_DATABASE:'gongde_download_acceptance',GONGDE_MYSQL_USER:'root',GONGDE_MYSQL_PASSWORD_FILE:passwordFile,GONGDE_MYSQL_CONNECTION_LIMIT:'4',GONGDE_DOWNLOAD_COUNT_SINCE:'2026-10-23T02:26:26Z',GONGDE_FREE_INSTALLERS_FILE:join(root,'registry.json'),GONGDE_ADMIN_USERNAME:'test-admin',GONGDE_ADMIN_PASSWORD_FILE:join(root,'admin-password'),GONGDE_ADMIN_SESSION_SECRET_FILE:join(root,'admin-session'),GONGDE_COS_SECRET_ID:'synthetic-id',GONGDE_COS_SECRET_KEY:'synthetic-key'});
const pool=mysql.createPool({host:'127.0.0.1',port:Number(port),user:'root',password:(await readFile(passwordFile,'utf8')).trim(),database:'gongde_download_acceptance',timezone:'Z'});
const {server}=await import('../dist/server.js');
try {
 if(!server.listening)await once(server,'listening');
 const origin=`http://127.0.0.1:${server.address().port}`;
 const login=await fetch(origin+'/api/gongde/admin/login',{method:'POST',headers:{origin,'sec-fetch-site':'same-origin','content-type':'application/json'},body:JSON.stringify({username:'test-admin',password})});assert.equal(login.status,200);
 const cookie=login.headers.get('set-cookie').split(';')[0];
 const report=async()=>{const r=await fetch(origin+'/api/gongde/admin/download-report',{headers:{cookie}});assert.equal(r.status,200);return r.json();};
 const before=await report();assert.equal(before.status,'available');
 for(let i=0;i<2;i++){const r=await fetch(origin+'/api/gongde/downloads/'+name,{redirect:'manual'});assert.equal(r.status,302);assert.equal(r.headers.get('location'),target);assert.equal(r.headers.get('x-gongde-count'),null);}
 const after=await report();assert.equal(after.summary.total,before.summary.total+2);assert.equal(cosWrites,0);
 await pool.query("CREATE TRIGGER reject_http_download BEFORE INSERT ON gongde_download_recent FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic_http_failure'");
 try {const r=await fetch(origin+'/api/gongde/downloads/'+name,{redirect:'manual'});assert.equal(r.status,302);assert.equal(r.headers.get('x-gongde-count'),'failed');assert.equal(r.headers.get('location'),target);}
 finally {await pool.query('DROP TRIGGER reject_http_download');}
 assert.equal((await report()).summary.total,after.summary.total);
 await pool.query('RENAME TABLE gongde_download_totals TO gongde_download_totals_unavailable');
 try {const failed=await report();assert.equal(failed.status,'error');assert.equal(failed.summary,null);}
 finally {await pool.query('RENAME TABLE gongde_download_totals_unavailable TO gongde_download_totals');}
 const files=await fetch(origin+'/api/gongde/admin/files?kind=installer',{headers:{cookie}});assert.equal(files.status,200);
 assert.equal(cosWrites,0);console.log('PASS real HTTP + MySQL: SQL-only counting, unchanged redirects, transactional failure, explicit read failure and file administration');
} finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await pool.end();await rm(root,{recursive:true,force:true});mock.restoreAll();}
