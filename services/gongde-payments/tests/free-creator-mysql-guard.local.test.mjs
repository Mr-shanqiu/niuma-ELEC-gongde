// Offline guard regression only. This file never imports mysql2 or constructs
// a pool, starts a container, executes SQL, or requests network access.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approvedLocalMysqlTarget } from './free-creator-mysql-fixtures.local.mjs';

const base = 'mysql://creator_local:0123456789abcdef@127.0.0.1:13306/gongde_creator_local_0123456789abcdef';
const approved = (url) => ({
  GONGDE_CREATOR_LOCAL_MYSQL_APPROVED: '1',
  GONGDE_CREATOR_LOCAL_MYSQL_URL: url,
});
const reject = (environment) => assert.throws(() => approvedLocalMysqlTarget(environment));
const cases = [
  ['accept an explicitly approved dedicated local target', () =>
    assert.deepEqual(approvedLocalMysqlTarget(approved(base)), {
      host: '127.0.0.1', port: 13306, database: 'gongde_creator_local_0123456789abcdef',
      user: 'creator_local', password: '0123456789abcdef',
    })],
  ['reject an actually absent approval field', () =>
    reject({ GONGDE_CREATOR_LOCAL_MYSQL_URL: base })],
  ['reject an inexact approval value', () =>
    reject({ ...approved(base), GONGDE_CREATOR_LOCAL_MYSQL_APPROVED: 'true' })],
  ['reject hostname aliases', () => reject(approved(base.replace('127.0.0.1', 'localhost')))],
  ['reject external hosts', () => reject(approved(base.replace('127.0.0.1', 'example.invalid')))],
  ['reject IPv6 targets', () => reject(approved(base.replace('127.0.0.1', '[::1]')))],
  ['reject abbreviated IPv4 spelling', () => reject(approved(base.replace('127.0.0.1', '127.1')))],
  ['reject low ports', () => reject(approved(base.replace(':13306/', ':3306/')))],
  ['reject existing business database names', () =>
    reject(approved(base.replace('gongde_creator_local_0123456789abcdef', 'existing_business')))],
  ['reject query parameters', () => reject(approved(base + '?ssl=true'))],
  ['reject fragments', () => reject(approved(base + '#fragment'))],
  ['reject encoded control characters in credentials', () =>
    reject(approved(base.replace('0123456789abcdef@', 'a%00b@')))],
];
for (const [name, run] of cases) test(name, run);
