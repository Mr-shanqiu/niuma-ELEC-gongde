import test from 'node:test';
import assert from 'node:assert/strict';
import { createFreeDistributionRuntime } from '../dist/free-distribution/runtime.js';

async function call(error) {
  const runtime = createFreeDistributionRuntime({ database: null, signer: null, packages: null,
    numbers: null, creators: { service: null }, officialStates: async () => ({}),
    requireAdmin: () => { throw error; } });
  const request = { method: 'GET', headers: {}, rawHeaders: [], socket: { remoteAddress: '127.0.0.1' } };
  const response = { writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = JSON.parse(body); } };
  try {
    assert.equal(await runtime.handle(request, response, new URL('http://localhost/api/gongde/v2/admin/group-code')), true);
    return response;
  } finally { await runtime.close(); }
}

test('v2 admin maps missing authentication to 401 and disabled admin to 503', async () => {
  const unauthorized = await call(new Error('admin_auth_required'));
  assert.equal(unauthorized.status, 401); assert.equal(unauthorized.body.error, 'admin_auth_required');
  const disabled = await call(new Error('admin_not_enabled'));
  assert.equal(disabled.status, 503); assert.equal(disabled.body.error, 'admin_not_enabled');
  const unknown = await call(new Error('unexpected'));
  assert.equal(unknown.status, 503); assert.equal(unknown.body.error, 'service_unavailable');
});
