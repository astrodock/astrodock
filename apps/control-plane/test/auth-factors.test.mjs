// Integration: needs a live Postgres (ASTRODOCK_PG_*). Run: node test/auth-factors.test.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const CP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(CP, 'server.js'));
process.env.ASTRODOCK_BASE_DOMAIN ||= 'localhost';
// Secrets are encrypted at rest; the factor tests need that path working.
process.env.ASTRODOCK_SECRET_KEY ||= '0'.repeat(64);
const { db, schema, close } = require(CP + '/src/db/index.js');
const F = require(CP + '/src/lib/auth-factors.js');
const totp = require(CP + '/src/lib/totp.js');
const { eq } = require('drizzle-orm');
let p=0,f=0; const t=async(n,fn)=>{try{await fn();console.log('  ok  '+n);p++}catch(e){console.error('  FAIL '+n+'\n       '+e.message);f++}};
const thr=async(fn,re)=>{let threw=false;try{await fn()}catch(e){threw=true;if(!re.test(e.message))throw new Error('wrong error: '+e.message)}if(!threw)throw new Error('expected throw')};
const assert=(c,m)=>{if(!c)throw new Error(m||'assertion failed')};

await db.delete(schema.users).where(eq(schema.users.email,'fac@test.com'));
const [u] = await db.insert(schema.users).values({email:'fac@test.com',name:'F',passwordHash:'x',isActive:true}).returning();

console.log('lockout invariant');
await t('cannot remove the only password when there is no passkey', async()=>{
  await thr(()=>F.removePassword(u.id), /no way to sign in|Add a passkey/);
});
await t('password + passkey: password can then be removed', async()=>{
  await db.insert(schema.webauthnCredentials).values({userId:u.id,credentialId:'c1',publicKey:'k',label:'yubi'});
  await F.removePassword(u.id);
  const fs = await F.factorsFor(u.id);
  assert(fs.password===false && fs.passkeys===1, 'should be passkey-only');
  assert(fs.passwordless===true, 'passwordless flag set');
});
await t('cannot remove the last passkey while passwordless', async()=>{
  await thr(()=>F.assertStillReachable(u.id,'removePasskey'), /only way to sign in|Set a password/);
});
await t('setting a password again re-enables removing the passkey', async()=>{
  await F.setPassword(u.id,'correct-horse-battery');
  await F.assertStillReachable(u.id,'removePasskey');
});

console.log('\nTOTP');
await t('enrolment requires a valid code', async()=>{
  const {secret} = await F.beginTotp(u.id,'fac@test.com');
  await thr(()=>F.confirmTotp(u.id,'000000'), /not right/);
  const code = totp.codeForStep(secret, totp.stepFor());
  await F.confirmTotp(u.id, code);
  const fs = await F.factorsFor(u.id);
  assert(fs.totp===true,'totp enrolled');
});
await t('enrolment itself spends its step, so that code is already dead', async()=>{
  const [uu] = await db.select().from(schema.users).where(eq(schema.users.id,u.id));
  const secret = require(CP + '/src/lib/crypto.js').decryptSecret(uu.totpSecret);
  const enrolCode = totp.codeForStep(secret, totp.stepFor());
  assert(await F.checkTotp({...uu, id:u.id}, enrolCode)===false, 'code used to enrol cannot sign in');
});
await t('a fresh code works once, then is rejected', async()=>{
  const [uu] = await db.select().from(schema.users).where(eq(schema.users.id,u.id));
  const secret = require(CP + '/src/lib/crypto.js').decryptSecret(uu.totpSecret);
  // Next window: within the accepted drift, and beyond the spent step.
  const code = totp.codeForStep(secret, totp.stepFor() + 1);
  const first = await F.checkTotp({...uu, id:u.id}, code);
  const [uu2] = await db.select().from(schema.users).where(eq(schema.users.id,u.id));
  const second = await F.checkTotp({...uu2, id:u.id}, code);
  assert(first===true,'first use accepted'); assert(second===false,'replay rejected');
});

console.log('\nrecovery codes');
await t('ten codes, single use, regenerating invalidates the old set', async()=>{
  const codes = await F.generateRecoveryCodes(u.id);
  assert(codes.length===10,'ten codes');
  assert(await F.consumeRecoveryCode(u.id, codes[0])===true,'first use works');
  assert(await F.consumeRecoveryCode(u.id, codes[0])===false,'second use rejected');
  assert(await F.consumeRecoveryCode(u.id, 'not-a-code')===false,'garbage rejected');
  const fresh = await F.generateRecoveryCodes(u.id);
  assert(await F.consumeRecoveryCode(u.id, codes[1])===false,'old set invalidated');
  assert(await F.consumeRecoveryCode(u.id, fresh[0])===true,'new set works');
});
await t('recovery codes are NOT a primary factor', async()=>{
  const fs = await F.factorsFor(u.id);
  assert(F.primaryFactorCount({password:false,passkeys:0})===0,'no primaries');
  assert(fs.recoveryCodesRemaining===9,'nine left');
});

await db.delete(schema.users).where(eq(schema.users.id,u.id));
await close();
console.log('\n'+p+' passed, '+f+' failed');
process.exit(f?1:0);
