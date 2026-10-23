import assert from 'node:assert/strict';
import test from 'node:test';
import {rangeInstants,rangePreset,rangeQuery} from '../src/ui/date-range.ts';
test('Beijing range includes both dates independently of browser timezone',()=>{
 assert.deepEqual(rangeInstants({start:'2026-10-22',end:'2026-10-23'}),{from:'2026-10-21T16:00:00.000Z',to:'2026-10-23T16:00:00.000Z'});
 assert.equal(rangeInstants({start:'2026-02-30',end:'2026-03-02'}),null);
 assert.equal(rangeInstants({start:'2026-10-23',end:'2026-10-22'}),null);
 assert.equal(rangeInstants({start:'2025-01-01',end:'2026-01-02'}),null);
 assert.equal(new URLSearchParams(rangeQuery({start:'2026-10-23',end:'2026-10-23'})).get('from'),'2026-10-22T16:00:00.000Z');
});
test('shortcuts use Beijing day and month boundaries including leap year',()=>{
 const now=new Date('2026-10-22T16:05:00Z');
 assert.deepEqual(rangePreset('today',now),{start:'2026-10-23',end:'2026-10-23'});
 assert.deepEqual(rangePreset('yesterday',now),{start:'2026-10-22',end:'2026-10-22'});
 assert.deepEqual(rangePreset('7',now),{start:'2026-10-17',end:'2026-10-23'});
 assert.deepEqual(rangePreset('30',now),{start:'2026-09-24',end:'2026-10-23'});
 assert.deepEqual(rangePreset('month',now),{start:'2026-10-01',end:'2026-10-23'});
 assert.deepEqual(rangePreset('previousMonth',new Date('2024-03-01T00:00:00Z')),{start:'2024-02-01',end:'2024-02-29'});
});
