// Run from the fixed compatibility candidate after compilation; no production access.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root=await mkdtemp(join(tmpdir(),'gongde-counter-compat-'));let writes=0;
mock.module('cos-nodejs-sdk-v5',{defaultExport:class{putObject(_p,cb){writes++;cb(null,{});}getBucket(_p,cb){cb(null,{Contents:[],IsTruncated:'false'});}}});
const name='niuma-counter-compat.exe',target='https://download.gongde.zqscreen.cn/'+name,password='synthetic-compat-admin-password';
await writeFile(join(root,'registry'),JSON.stringify({schemaVersion:1,items:[{platform:'windows',version:'0.9.5',format:'exe',releaseId:'compat-test',name,bytes:100,sha256:'a'.repeat(64),publicDownloadUrl:target,perpetualCompatible:true}]}));
await writeFile(join(root,'password'),password,{mode:0o600});await writeFile(join(root,'session'),'synthetic-compat-session-secret-at-least32',{mode:0o600});
for(const key of Object.keys(process.env))if(key.startsWith('GONGDE_'))delete process.env[key];
Object.assign(process.env,{HOST:'127.0.0.1',PORT:'0',GONGDE_PAYMENT_MODE:'mock',GONGDE_PAYMENT_TEST_TOKEN:'synthetic-compat-test-token-at-least24',GONGDE_STORE_MODE:'memory',GONGDE_PACK_DELIVERY_MODE:'disabled',GONGDE_FREE_INSTALLERS_FILE:join(root,'registry'),GONGDE_ADMIN_USERNAME:'test-admin',GONGDE_ADMIN_PASSWORD_FILE:join(root,'password'),GONGDE_ADMIN_SESSION_SECRET_FILE:join(root,'session'),GONGDE_COS_SECRET_ID:'synthetic-id',GONGDE_COS_SECRET_KEY:'synthetic-key',GONGDE_DOWNLOAD_COUNT_SINCE:'2026-10-23T02:26:26Z'});
const {server}=await import('../dist/server.js');
try {
 if(!server.listening)await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
 const login=await fetch(origin+'/api/gongde/admin/login',{method:'POST',headers:{origin,'sec-fetch-site':'same-origin','content-type':'application/json'},body:JSON.stringify({username:'test-admin',password})});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
 const report=await (await fetch(origin+'/api/gongde/admin/download-report',{headers:{cookie}})).json();assert.equal(report.status,'error');assert.equal(report.summary,null);
 const overview=await (await fetch(origin+'/api/gongde/admin/overview',{headers:{cookie}})).json();assert.equal(overview.data.downloads.status,'error');assert.equal(overview.data.downloads.summary,null);
 const download=await fetch(origin+'/api/gongde/downloads/'+name,{redirect:'manual'});assert.equal(download.status,302);assert.equal(download.headers.get('location'),target);assert.equal(download.headers.get('x-gongde-count'),null);assert.equal(writes,1);
 assert.equal((await fetch(origin+'/api/gongde/admin/files?kind=installer',{headers:{cookie}})).status,503);
 console.log('PASS compatibility runtime: explicit unavailable statistics, continued COS counting and unchanged installer redirects');
} finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});mock.restoreAll();}
