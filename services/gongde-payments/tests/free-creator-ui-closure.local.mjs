// Run only through ego-browser nodejs with the parent's fresh temporary readiness.
// Real application UI/HTTP/MySQL, explicit MemoryCos and synthetic admin fixture.
const ready = globalThis.GONGDE_LOCAL_BROWSER_READY;
if (!ready || !Number.isInteger(ready.spaceId) || !ready.creatorLogin || !ready.adminLogin) throw Error('LOCAL_UI_READY_REQUIRED');
const local = new URL(ready.loopbackUrl);
if (local.protocol !== 'http:' || local.hostname !== '127.0.0.1' || Number(local.port) < 10000 || local.pathname !== '/' || local.search || local.hash) throw Error('LOCAL_UI_LOOPBACK_REQUIRED');
if (!/^\/private\/tmp\/gongde-creator-browser-env-[A-Za-z0-9]+$/.test(ready.temporaryRoot)) throw Error('LOCAL_UI_OWNED_ROOT_REQUIRED');
const origin = local.origin;
const task = await taskSpace(ready.spaceId);
const creator = task.page('p1'), admin = task.page('p2');
const results = [], sources = [];
const evaluate = (page, code) => page.evaluate(`(${code})()`);
const wait = (page, expression) => evaluate(page,`async()=>{const deadline=Date.now()+7000;while(!(${expression})){if(Date.now()>deadline)throw Error('LOCAL_UI_CONDITION_TIMEOUT');await new Promise(resolve=>setTimeout(resolve,40))}return true}`);
const pass = name => { results.push(name); console.log(JSON.stringify({pass:name})); };
const adminRefresh = async () => {
  await wait(admin, "document.querySelector('.creator-admin-shell > .MuiStack-root > button:last-child')?.disabled===false");
  await admin.press('.creator-admin-shell > .MuiStack-root > button:last-child', 'Enter');
  await admin.waitForSelector('.creator-admin-record', {state:'visible',timeout:7000});
};
const openReview = async () => {
  await admin.press('.creator-admin-record','Enter');
  await wait(admin, "document.querySelector('iframe')?.contentDocument?.querySelector('canvas')&&document.body.textContent.includes('真实预览已加载')");
  const pixels = await admin.evaluate(()=>{const c=document.querySelector('iframe').contentDocument.querySelector('canvas');const b=c.getContext('2d').getImageData(0,0,c.width,c.height).data;return b.filter((v,i)=>i%4===3&&v>0).length});
  if (!pixels) throw Error('LOCAL_UI_ADMIN_PREVIEW_EMPTY');
};
if (!ready.resumeWorkId) {
await creator.goto(origin+'/creator.html');
await creator.fill('#creator-login input[name=username]',ready.creatorLogin.username);
await creator.fill('#creator-login input[name=password]',ready.creatorLogin.password);
await creator.press('#creator-login input[name=password]','Enter');
await creator.waitForSelector('#creator-workspace',{state:'visible',timeout:7000});
pass('REAL_UI_CREATOR_LOGIN');
await admin.goto(origin+'/admin/#/creatorCommunity');
await admin.fill('input[type=text]',ready.adminLogin.username);
await admin.fill('input[type=password]',ready.adminLogin.password);
await admin.press('input[type=password]','Enter');
await admin.waitForSelector('.creator-admin-shell',{state:'visible',timeout:7000});
pass('SYNTHETIC_ADMIN_REAL_UI_LOGIN');
} else {
  const session = await creator.evaluate(async()=>({creator:(await fetch('/api/gongde/creators/session')).status,admin:(await fetch('/api/gongde/admin/session')).status}));
  if(session.creator!==200||session.admin!==200)throw Error('LOCAL_UI_RESUME_SESSIONS_REQUIRED');
  pass('CONFIRMED_EXISTING_TEST_SESSIONS');
}
for (let index=1;index<=2;index++) {
  if(index===1&&ready.resumeWorkId){
    await creator.press('.creator-work-item','Enter');
    await wait(creator, `document.querySelector('#creator-work-id').value===${JSON.stringify(ready.resumeWorkId)}`);
  }else{
  if (index>1) await creator.press('#creator-new-work','Enter');
  await creator.fill('#creator-work-form input[name=slug]','closure-work-'+index);
  await creator.fill('#creator-work-form input[name=titleZh]','Local closure work '+index);
  await creator.fill('#creator-work-form textarea[name=description]','Fictional original source for isolated local browser acceptance only.');
  await creator.fill('#creator-work-form input[name=tags]','local,test');
  await creator.press('#creator-work-form input[name=acceptFreeSharing]','Space');
  await creator.press('#creator-work-form input[name=tags]','Enter');
  await creator.waitForSelector('#creator-upload-section',{state:'visible',timeout:7000});
  }
  const source = await evaluate(creator,`async()=>{const r=await fetch('/__local/source-pack?work='+encodeURIComponent(document.querySelector('#creator-work-id').value)+'&variant=${index===1?'approve':'batch'}&format=json');if(!r.ok)throw Error('LOCAL_UI_SOURCE_FAILED');return r.json()}`);
  if (!source.archivePath.startsWith('/private/tmp/gongde-creator-browser-')) throw Error('LOCAL_UI_SOURCE_ROOT_REQUIRED');
  sources.push(source);
  await creator.setInputFiles('#creator-upload-form input[name=pack]',source.archivePath);
  await creator.press('#creator-upload-form button[type=submit]','Enter');
  await creator.waitForSelector('#creator-preview-stage canvas',{state:'visible',timeout:7000});
  const pixels=await creator.evaluate(()=>{const c=document.querySelector('#creator-preview-stage canvas');const b=c.getContext('2d').getImageData(0,0,c.width,c.height).data;return b.filter((v,i)=>i%4===3&&v>0).length});
  if(!pixels) throw Error('LOCAL_UI_CREATOR_PREVIEW_EMPTY');
  pass('REAL_UI_CREATE_UPLOAD_PNG_PREVIEW_'+index);
  await creator.press('#creator-submit-accept','Space');await creator.press('#creator-submit','Enter');
  await wait(creator,"document.querySelector('#creator-version-list').textContent.includes('审核中')");
  await adminRefresh();await openReview();
  if(index===1) {
    await admin.fill('.creator-admin-shell textarea','Local acceptance reject: please resubmit this exact version.');
    await wait(admin,"document.querySelector('.creator-admin-shell button.MuiButton-outlinedWarning')?.disabled===false");
    await admin.press('.creator-admin-shell button.MuiButton-outlinedWarning','Enter');
    await wait(admin,"document.querySelectorAll('.creator-admin-record').length===0&&!document.body.textContent.includes('正在读取…')");
    await creator.press('.creator-work-item','Enter');await wait(creator,"document.querySelector('#creator-version-list').textContent.includes('已拒绝')");
    await creator.press('.creator-version button','Enter');await creator.waitForSelector('#creator-preview-stage canvas',{state:'visible',timeout:7000});
    await creator.press('#creator-submit-accept','Space');await creator.press('#creator-submit','Enter');
    await wait(creator,"document.querySelector('#creator-version-list').textContent.includes('审核中')");
    await adminRefresh();await openReview();pass('REAL_UI_REJECT_AND_RESUBMIT');
  }
  for(let check=1;check<=4;check++) await admin.press(`.creator-admin-shell label.MuiFormControlLabel-root:nth-child(${check}) input[type=checkbox]`,'Space');
  await wait(admin,"document.querySelector('.creator-admin-grid button.MuiButton-containedPrimary')?.disabled===false");
  await admin.press('.creator-admin-grid button.MuiButton-containedPrimary','Enter');
  await wait(admin,"document.querySelectorAll('.creator-admin-record').length===0&&!document.body.textContent.includes('正在读取…')");
  pass('REAL_UI_APPROVE_FROZEN_VERSION_'+index);
}
await creator.press('#creator-logout','Enter');await creator.waitForSelector('#creator-auth',{state:'visible',timeout:7000});
const sessions=await admin.evaluate(async()=>{const logout=await fetch('/api/gongde/admin/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});return {logout:logout.status,creator:(await fetch('/api/gongde/creators/session')).status,admin:(await fetch('/api/gongde/admin/session')).status,reviews:(await fetch('/api/gongde/admin/creators/reviews')).status}});
if(sessions.logout!==200||sessions.creator!==401||sessions.admin!==401||sessions.reviews!==401)throw Error('LOCAL_UI_ANONYMOUS_REQUIRED');pass('BOTH_SESSIONS_LOGGED_OUT_AND_ADMIN_DENIED');
const community=await task.newPage();await community.goto(origin+'/community.html');
await wait(community,"document.querySelectorAll('#community-gallery > article').length===2");
pass('ANONYMOUS_PUBLIC_TWO_WORKS');
await community.press('#community-gallery > article:nth-child(1) input[type=checkbox]','Space');
let downloadPromise=community.waitForEvent('download',{timeout:15000});await community.press('#community-download','Enter');
const one=await downloadPromise;await one.saveAs(ready.temporaryRoot+'/anonymous-one.nmgpack');pass('ANONYMOUS_UI_ONE_ENTRY_DOWNLOAD');
for(let index=1;index<=2;index++) {
  const checked=await evaluate(community,`()=>document.querySelector('#community-gallery > article:nth-child(${index}) input[type=checkbox]').checked`);
  if(!checked)await community.press(`#community-gallery > article:nth-child(${index}) input[type=checkbox]`,'Space');
}
downloadPromise=community.waitForEvent('download',{timeout:15000});await community.press('#community-download','Enter');
const two=await downloadPromise;await two.saveAs(ready.temporaryRoot+'/anonymous-two.nmgpacks');pass('ANONYMOUS_UI_TWO_ENTRY_BATCH_DOWNLOAD');
await creator.fill('#creator-login input[name=username]',ready.creatorLogin.username);await creator.fill('#creator-login input[name=password]',ready.creatorLogin.password);await creator.press('#creator-login input[name=password]','Enter');await creator.waitForSelector('#creator-workspace',{state:'visible',timeout:7000});
await creator.press('.creator-work-item:nth-child(1)','Enter');await creator.waitForSelector('#creator-unpublish',{state:'visible',timeout:7000});const removedId=await creator.evaluate(()=>document.querySelector('#creator-work-id').value);
await creator.press('#creator-unpublish','Enter');await wait(creator,"document.querySelector('#creator-message').textContent.includes('已下架')");
const afterUnpublish=await evaluate(community,`async()=>{const list=await fetch('/api/gongde/community/works');const detail=await fetch('/api/gongde/community/works/'+encodeURIComponent(${JSON.stringify(removedId)}));return {listStatus:list.status,list:await list.json(),detailStatus:detail.status}}`);
if(afterUnpublish.listStatus!==200||afterUnpublish.list.works.length!==1||afterUnpublish.detailStatus!==404)throw Error('LOCAL_UI_UNPUBLISH_NOT_CLOSED');pass('REAL_UI_AUTHOR_UNPUBLISH_PUBLIC_ACCESS_BLOCKED');
await creator.press('#creator-logout','Enter');
console.log(JSON.stringify({evidence:'REAL_UI_HTTP_MYSQL_MEMORY_COS_SYNTHETIC_ADMIN',passed:results.length,results,sessions,sources,one:ready.temporaryRoot+'/anonymous-one.nmgpack',two:ready.temporaryRoot+'/anonymous-two.nmgpacks',suggested:[one.suggestedFilename(),two.suggestedFilename()],removedId}));
