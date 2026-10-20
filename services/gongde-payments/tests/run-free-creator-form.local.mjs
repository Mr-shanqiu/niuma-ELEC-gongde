// Explicitly approved temporary local DB + real UI form regression, auto cleanup.
import fs from 'node:fs/promises';import {spawn} from 'node:child_process';import assert from 'node:assert/strict';import path from 'node:path';import {fileURLToPath} from 'node:url';
assert.equal(process.env.GONGDE_CREATOR_LOCAL_MYSQL_APPROVED,'1');assert.equal(process.argv.length,2);
const spaceId=Number(process.env.GONGDE_CREATOR_FORM_SPACE_ID);assert.ok(Number.isSafeInteger(spaceId)&&spaceId>0&&spaceId<1000000000,'Owned numeric browser space required');
const here=path.dirname(fileURLToPath(import.meta.url));const root=await fs.mkdtemp('/private/tmp/gongde-creator-form-run-');await fs.chmod(root,0o700);
const driver=await fs.readFile(path.join(here,'free-creator-form-regression.local.mjs'),'utf8');
const environment=spawn(process.execPath,['--max-old-space-size=64',path.join(here,'run-free-creator-browser.local.mjs')],{cwd:process.cwd(),env:{...process.env,GONGDE_CREATOR_LOCAL_MYSQL_APPROVED:'1'},stdio:['pipe','pipe','pipe']});
let buffer='',environmentOutput='',formOutput='',formErrors='',form=null,formCode=null,ready=null,timedOut=false,stopRequested=false;
const stop=()=>{if(!stopRequested){stopRequested=true;environment.stdin.write('STOP_LOCAL_BROWSER_ENVIRONMENT\n')}};
const timeout=setTimeout(()=>{timedOut=true;if(form)form.kill('SIGTERM');stop()},50000);
const done=new Promise((resolve,reject)=>{environment.once('error',reject);environment.once('close',code=>resolve(code))});
environment.stderr.on('data',b=>{process.stderr.write(b);environmentOutput+=b.toString()});environment.stdin.on('error',()=>{});
environment.stdout.on('data',chunk=>{const s=chunk.toString();environmentOutput+=s;process.stdout.write(s);buffer+=s;let newline;while((newline=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);let value;try{value=JSON.parse(line)}catch{continue}if(ready||!value.pid||!value.loopbackUrl)continue;ready=value;const u=new URL(value.loopbackUrl);if(u.hostname!=='127.0.0.1'||u.protocol!=='http:'||Number(u.port)<10000){stop();continue}
form=spawn('/Users/yue/.local/bin/ego-browser',['nodejs'],{cwd:process.cwd(),stdio:['pipe','pipe','pipe']});
form.stdout.on('data',b=>{formOutput+=b.toString();process.stdout.write(b)});form.stderr.on('data',b=>{formErrors+=b.toString();process.stderr.write(b)});form.stdin.on('error',()=>{});
form.on('error',()=>{formErrors+='LOCAL_FORM_CLI_START_FAILED\n';stop()});form.once('close',code=>{formCode=code;stop()});
form.stdin.end('globalThis.GONGDE_CREATOR_FORM_SPACE_ID='+spaceId+';\nglobalThis.GONGDE_CREATOR_FORM_LOOPBACK_URL='+JSON.stringify(value.loopbackUrl)+';\n'+driver);
}});
const environmentCode=await done;clearTimeout(timeout);
await fs.writeFile(root+'/environment.stdout.log',environmentOutput,{mode:0o600});await fs.writeFile(root+'/form.stdout.log',formOutput,{mode:0o600});await fs.writeFile(root+'/form.stderr.log',formErrors,{mode:0o600});
const receipt={evidence:'ACTUAL_UI_FORM_ONLY_AUTO_START_STOP',root,environmentCode,formCode,timedOut,stopRequested,ready:!!ready,production:false};await fs.writeFile(root+'/receipt.json',JSON.stringify(receipt,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(receipt));if(environmentCode!==0||formCode!==0||timedOut)process.exitCode=1;
