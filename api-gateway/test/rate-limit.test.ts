import './setup-env';
import test from 'node:test';
import assert from 'node:assert/strict';
import fastify from 'fastify';
import fp from 'fastify-plugin';
// @ts-ignore
import RedisMock from 'ioredis-mock';
import fastifyJwt from '@fastify/jwt';
import validationPlugin from '../src/plugins/validation';
import rateLimitPlugin from '../src/plugins/rateLimit';
import { bodyFieldKey, ipKey } from '../src/plugins/rateLimit';

async function build() {
  const app = fastify();
  await app.register(validationPlugin);
  await app.register(fp(async (a) => { a.decorate('redis', new RedisMock()); }, { name: 'redis-plugin' }));
  await app.register(fastifyJwt, { secret: 'x'.repeat(32) });
  app.decorate('authenticate', async (req: any) => { await req.jwtVerify(); });
  await app.register(rateLimitPlugin);
  app.post('/login', { preHandler: [app.limitBy('login-ip', ipKey, 6)], config: { rateLimit: { max: 2, timeWindow: '1 minute', keyGenerator: bodyFieldKey('email') } } as any }, async () => ({ ok: true }));
  app.post('/claim', { preHandler: [(app as any).authenticate], config: { rateLimit: { max: 2, timeWindow: '1 minute' } } as any }, async () => ({ ok: true }));
  return app;
}
test('login limited per email, not per IP; IP ceiling still applies', async () => {
  const app = await build();
  const login = (email: string) => app.inject({ method: 'POST', url: '/login', payload: { email } });
  assert.equal((await login('A@x.com')).statusCode, 200);
  assert.equal((await login(' a@x.com ')).statusCode, 200);
  const third = await login('a@x.com');
  assert.equal(third.statusCode, 429);
  assert.ok(third.headers['retry-after']);
  assert.equal((await login('b@x.com')).statusCode, 200);   // other user behind same IP
  assert.equal((await login('c@x.com')).statusCode, 200);
  assert.equal((await login('d@x.com')).statusCode, 200);   // 6th request from IP
  const ipBlocked = await login('e@x.com');                  // 7th exceeds IP ceiling
  assert.equal(ipBlocked.statusCode, 429);
  assert.match(String(ipBlocked.json().message), /retry in \d+ seconds/);
});
test('authenticated routes are limited per account', async () => {
  const app = await build();
  const t1 = app.jwt.sign({ userId: 'u1' }); const t2 = app.jwt.sign({ userId: 'u2' });
  const claim = (t: string) => app.inject({ method: 'POST', url: '/claim', headers: { authorization: `Bearer ${t}` } });
  assert.equal((await claim(t1)).statusCode, 200);
  assert.equal((await claim(t1)).statusCode, 200);
  assert.equal((await claim(t1)).statusCode, 429);
  assert.equal((await claim(t2)).statusCode, 200);
});
