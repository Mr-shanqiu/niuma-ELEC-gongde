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

test('an overlay retains the active previous admin entry and removes unrelated inherited assets', async () => {
  const { cp } = await import('node:fs/promises');
  const root = await mkdtemp(resolve('.local-work/acceptance/admin-overlay-'));
  try {
    const old = join(root, 'old'), next = join(root, 'next');
    await mkdir(join(old, 'admin/assets'), { recursive: true });
    await writeFile(join(old, 'index.html'), '<html><head></head><body><script src="app.js"></script></body></html>');
    await writeFile(join(old, 'app.js'), 'window.app=1;');
    const active = 'admin/assets/index-active001.js', stale = 'admin/assets/index-stale0001.js', css = 'admin/assets/index-style001.css';
    await writeFile(join(old, 'admin/index.html'), `<script src="/${active}"></script><link href="/${css}">`);
    for (const name of [active, stale, css]) await writeFile(join(old, name), name);
    execFileSync(process.execPath, ['scripts/version-website-assets.mjs', old]);
    await writeFile(join(old, stale), 'old unused asset');
    const meta = JSON.parse(await readFile(join(old, 'assets/build/runtime-assets.json'), 'utf8'));
    meta.adminBundles = [[active, stale, css].sort()];
    await writeFile(join(old, 'assets/build/runtime-assets.json'), JSON.stringify(meta));
    const archive = join(root, `gongde-site-${digest('admin-overlay')}.tar.gz`);
    execFileSync('tar', ['-czf', archive, '-C', old, '.']);
    await writeFile(archive + '.sha256', digest(await readFile(archive)) + '\n');
    await cp(old, next, { recursive: true });
    const current = 'admin/assets/index-current01.js';
    await writeFile(join(next, current), 'new admin');
    await writeFile(join(next, 'admin/index.html'), `<script src="/${current}"></script><link href="/${css}">`);
    const obsolete = '0'.repeat(64);
    await mkdir(join(next, 'assets/runtime', obsolete), { recursive: true });
    await writeFile(join(next, 'assets/runtime', obsolete, 'app.js'), 'obsolete');
    execFileSync(process.execPath, ['scripts/version-website-assets.mjs', next, archive]);
    for (const name of [current, active, css]) await access(join(next, name));
    await assert.rejects(access(join(next, stale)));
    await assert.rejects(access(join(next, 'assets/runtime', obsolete)));
    const result = JSON.parse(await readFile(join(next, 'assets/build/runtime-assets.json'), 'utf8'));
    assert.deepEqual(result.adminBundles, [[current, css].sort(), [active, css].sort()]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
