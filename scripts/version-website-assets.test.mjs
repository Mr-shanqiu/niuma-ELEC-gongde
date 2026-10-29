import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const digest = b => createHash('sha256').update(b).digest('hex');
test('two retained runtimes keep their own index and preview dependencies; older generation retires', async () => {
  const root=await mkdtemp(resolve('.local-work/acceptance/runtime-dependencies-'));
  const revisions=[],indexes=[],art=[];
  let previous;
  try {
    for(let i=0;i<4;i++) {
      const stage=join(root,`site-${i}`),assetHash=digest(`image-${i}`);
      const path=`assets/previews/packs-web/test/${assetHash}/cover.png`;
      await mkdir(join(stage,`assets/previews/packs-web/test/${assetHash}`),{recursive:true});
      await writeFile(join(stage,path),`image-${i}`);
      const index=JSON.stringify({packs:{test:{web:{basePath:`/assets/previews/packs-web/test/${assetHash}/`}}}});
      await writeFile(join(stage,'assets/previews/source-map.json'),index);
      await writeFile(join(stage,'index.html'),'<html><head></head><body><script src="app.js"></script></body></html>');
      await writeFile(join(stage,'app.js'),`window.version=${i};`);
      execFileSync(process.execPath,['scripts/version-website-assets.mjs',stage,...(previous?[previous]:[])],{stdio:'pipe'});
      const manifest=JSON.parse(await readFile(join(stage,'assets/build/runtime-assets.json'),'utf8'));
      revisions.push(manifest.revision);indexes.push(digest(index));art.push(path);
      assert.equal(manifest.runtimeVersions.length,Math.min(i+1,3));
      for(let j=Math.max(0,i-2);j<=i;j++) {
        await access(join(stage,'assets/runtime',revisions[j],'app.js'));
        await access(join(stage,`assets/previews/index/${indexes[j]}.json`));
        await access(join(stage,art[j]));
      }
      if(i===3)await assert.rejects(access(join(stage,art[0])));
      previous=join(root,`gongde-site-${digest(`archive-${i}`)}.tar.gz`);
      execFileSync('tar',['-czf',previous,'-C',stage,'.']);
      await writeFile(previous+'.sha256',digest(await readFile(previous))+'\n');
    }
  } finally {await rm(root,{recursive:true,force:true});}
});
