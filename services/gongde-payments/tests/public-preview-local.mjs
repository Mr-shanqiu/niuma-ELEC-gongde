import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { renderPublicPreview, publicPreviewRevision, publicPreviewPayload, PublicPreviewStore,
  loadOfficialPublicPreview, writePublicPreviewImage } from '../dist/creators/public-preview.js';
import { encodeRgbaPng, decodePng } from '../dist/creators/review-renderer.js';
import { CreatorSourceStore } from '../dist/creators/object-store.js';
import { FreeCreatorService } from '../dist/creators/free-service.js';
import { OFFICIAL_ASSET_IDS } from '../dist/domain/catalog.js';

const sha = data => createHash('sha256').update(data).digest('hex');
const identity = { sourceKind:'official',sourceId:'official.test',versionId:'1.0.0',sourceRevision:'a'.repeat(64) };
const pixels = Buffer.alloc(16 * 16 * 4);
for(let y=2;y<14;y++)for(let x=2;x<14;x++)pixels.set([212,82,28,255],(y*16+x)*4);
const png = encodeRgbaPng(16,16,pixels);
const files = new Map([['body.png',png]]);
const manifest = {schema_version:3,id:identity.sourceId,version:identity.versionId,canvas_width:240,canvas_height:250,
  layers:[{image:'body.png',frame:[100,70,40,120],anchor:[0.5,0],interpolation:'smoothstep',keyframes:[
    {t:0,x:0,y:0,rotation:-90,scale:1,scale_y:1,alpha:1},
    {t:1,x:40,y:20,rotation:90,scale:1.2,scale_y:0.8,alpha:1}]}]};

test('transparent cover, stable identity, complete motion bounds, source bytes unchanged',()=>{
  const original = sha(png), before = JSON.stringify(manifest);
  const result = renderPublicPreview(identity,manifest,files), second = renderPublicPreview(identity,manifest,files);
  assert.equal(result.record.revision,second.record.revision);
  assert.deepEqual([...result.files], [...second.files]);
  assert.equal(sha(png),original);assert.equal(JSON.stringify(manifest),before);
  assert.notEqual(publicPreviewRevision({...identity,sourceRevision:'b'.repeat(64)}),result.record.revision);
  const image = decodePng(result.files.get('cover.png'),240,170);
  assert.ok(image.rgba.some((value,index)=>index%4===3&&value>0));
  assert.equal(image.rgba[3],0);
  const transformed=result.record.manifest.layers[0];
  for(let step=0;step<=1000;step++) {
    const t=step/1000, mix=t*t*(3-2*t), a=transformed.keyframes[0],b=transformed.keyframes[1];
    const value=key=>a[key]+(b[key]-a[key])*mix;
    const [x,y,w,h]=transformed.frame, [u,v]=transformed.anchor, angle=value('rotation')*Math.PI/180;
    for(const px of [2/16,14/16])for(const py of [2/16,14/16]) {
      const dx=(px-u)*w*value('scale'),dy=(py-v)*h*value('scale')*value('scale_y');
      const xx=x+w*u+value('x')+dx*Math.cos(angle)-dy*Math.sin(angle);
      const yy=y+h*v+value('y')+dx*Math.sin(angle)+dy*Math.cos(angle);
      assert.ok(xx>=7.999&&xx<=472.001&&yy>=7.999&&yy<=332.001);
    }
  }
  const payload=publicPreviewPayload(result.record);
  assert.match(payload.coverUrl,/\/api\/gongde\/v2\/previews\/official\/official\.test\/[a-f0-9]{64}\/cover\.png$/);
  assert.equal(payload.manifest.canvas_width,480);assert.equal(payload.coverWidth,240);
});

test('invalid decoding envelope and missing image fail closed without partial output',()=>{
  const oversized=Buffer.from(png);oversized.writeUInt32BE(9000,16);
  assert.throws(()=>renderPublicPreview(identity,manifest,new Map([['body.png',oversized]])));
  assert.throws(()=>renderPublicPreview(identity,manifest,new Map()));
  assert.throws(()=>renderPublicPreview(identity,{...manifest,layers:[{...manifest.layers[0],keyframes:[
    {...manifest.layers[0].keyframes[0],t:0.5},{...manifest.layers[0].keyframes[1],t:0.4}]}]},files));
});

test('private COS storage writes completion marker last; failed asset cannot switch a listing',async()=>{
  const objects=new Map(),puts=[];let fail=false;
  const client={
    getBucketAcl(_p,cb){cb(null,{ACL:'private',Owner:{ID:'owner'},Grants:[{Grantee:{ID:'owner'},Permission:'FULL_CONTROL'}]});},
    getBucketPolicy(_p,cb){cb({code:'NoSuchBucketPolicy',statusCode:404});},
    putObject(p,cb){
      assert.equal(p.ACL,'private');assert.equal(p.CacheControl,'private, no-store');
      if(fail&&p.Key.endsWith('layer-0.png'))return cb(new Error('injected local failure'));
      puts.push(p.Key);objects.set(p.Key,Buffer.from(p.Body));cb(null,{});
    },
    getObject(p,cb){const value=objects.get(p.Key);if(!value)return cb({code:'NoSuchKey',statusCode:404});p.Output.end(value,()=>cb(null,{}));}
  };
  const source=new CreatorSourceStore({bucket:'local-test',region:'local',secretId:'fixture',secretKey:'fixture'},client);
  const store=new PublicPreviewStore(source);
  fail=true;await assert.rejects(store.prepare(identity,manifest,files));
  assert.equal(await store.lookup(identity),null);assert.equal(puts.some(key=>key.endsWith('/ready.json')),false);
  fail=false;const record=await store.prepare(identity,manifest,files);
  assert.ok(puts.at(-1).endsWith('/ready.json'));
  const count=puts.length;await store.prepare(identity,manifest,files);assert.equal(puts.length,count);
  const restarted=new PublicPreviewStore(source);
  assert.equal((await restarted.lookup(identity)).revision,record.revision);
  const image=await restarted.image(identity,record.revision,'cover.png');assert.equal(sha(image.bytes),image.sha256);
  await assert.rejects(restarted.image(identity,'f'.repeat(64),'cover.png'));
  await assert.rejects(restarted.image(identity,record.revision,'source.nmgpack'));
  const changed={...identity,sourceRevision:'c'.repeat(64)};fail=true;
  await assert.rejects(store.prepare(changed,manifest,files));
  assert.equal((await store.lookup(identity)).revision,record.revision);
});

test('public response caches only after publication guard; withdrawn/private versions are denied',async()=>{
  const community={sourceKind:'community',sourceId:`creator.${'1'.repeat(32)}.sample`,versionId:'2'.repeat(32),sourceRevision:'d'.repeat(64)};
  const result=renderPublicPreview(community,{...manifest,id:community.sourceId},files);
  const objects={publicPreviewManifest:async()=>Buffer.from(JSON.stringify(result.record)),
    publicPreviewImage:async(_revision,name)=>result.files.get(name),putPublicPreview:async()=>{}};
  const version={workId:community.sourceId,versionId:community.versionId,revision:community.sourceRevision};
  let published=true,checks=0;
  const repository={getVersion:async()=>version,published:async()=>{checks++;if(!published)throw new Error('not public');}};
  const service=new FreeCreatorService(repository,objects);
  const image=await service.publicPreviewImage(community.versionId,result.record.revision,'cover.png');
  assert.equal(checks,2);
  let status,headers,body;const response={writeHead(s,h){status=s;headers=h;},end(b){body=b;}};
  writePublicPreviewImage({headers:{}},response,image);
  assert.equal(status,200);assert.equal(headers['cache-control'],'public, max-age=31536000, immutable');assert.ok(body.length);
  writePublicPreviewImage({headers:{'if-none-match':headers.etag}},response,image);assert.equal(status,304);assert.equal(body,undefined);
  published=false;await assert.rejects(service.publicPreviewImage(community.versionId,result.record.revision,'cover.png'));
});

test('registered retained official catalog sources render small derivatives without modifying originals',async()=>{
  const root=fileURLToPath(new URL('../../../assets/appearance-packs/',import.meta.url)).replace(/\/$/,'');
  // Local fixture scope: registered official IDs minus the six explicit
  // withdrawals. This is not proof of the current production publication state.
  const withdrawn=new Set(['zqscreen.orange-cat-wave','zqscreen.redpanda-wave','zqscreen.raccoon-cheer',
    'zqscreen.bee-flap','zqscreen.zhuan-yun-bead','zqscreen.koi-bubbles']);
  const expected=new Set(OFFICIAL_ASSET_IDS.filter(id=>!withdrawn.has(id)));
  const entries=(await readdir(root,{withFileTypes:true})).filter(entry=>entry.isDirectory());
  const results=[],ignored=[],seen=new Set();
  for(const entry of entries) {
    const directory=join(root,entry.name),manifestBytes=await readFile(join(directory,'manifest.json'));
    const source=JSON.parse(manifestBytes);
    if(!expected.has(source.id)) {
      ignored.push({directory:entry.name,id:source.id,reason:withdrawn.has(source.id)?'withdrawn':'not_in_official_catalog'});
      continue;
    }
    assert.equal(seen.has(source.id),false,`duplicate official ID: ${source.id}`);seen.add(source.id);
    const names=(await readdir(directory)).sort(),blobs=new Map([['manifest.json',manifestBytes]]);
    for(const name of names)if(name!=='manifest.json')blobs.set(name,await readFile(join(directory,name)));
    const revision=sha(names.map(name=>`${name}\0${sha(blobs.get(name))}\n`).join(''));
    const input=await loadOfficialPublicPreview(root,source.id,{manifest:source,version:source.version,revision,
      deliveryBytesUpperBound:1,previewDirectory:entry.name});
    const started=performance.now();
    const rendered=renderPublicPreview(input.identity,input.manifest,input.files);
    const generationMs=Number((performance.now()-started).toFixed(3));
    const layers=[...rendered.files].filter(([name])=>name!=='cover.png').map(([name,bytes])=>({name,bytes:bytes.length}));
    results.push({id:source.id,directory:entry.name,coverBytes:rendered.files.get('cover.png').length,layers,
      layerBytes:layers.reduce((n,layer)=>n+layer.bytes,0),
      totalBytes:[...rendered.files.values()].reduce((n,bytes)=>n+bytes.length,0),generationMs});
  }
  process.stdout.write(JSON.stringify({scope:'registered_catalog_minus_explicit_withdrawals_local_only',
    officialPreviewFixtureCount:results.length,expectedCount:expected.size,ignored,results,
    coverBytesTotal:results.reduce((n,item)=>n+item.coverBytes,0),
    layerBytesTotal:results.reduce((n,item)=>n+item.layerBytes,0),
    maximumCoverBytes:Math.max(...results.map(item=>item.coverBytes)),
    maximumGenerationMs:Math.max(...results.map(item=>item.generationMs))})+'\n');
  assert.deepEqual([...seen].sort(),[...expected].sort());
  assert.ok(results.every(item=>item.coverBytes<125*1024));
});
