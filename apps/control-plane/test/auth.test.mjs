// Auth end-to-end over real HTTP: sign-in, sessions, whoami, key delegation,
// key-vs-operator limits, and per-route scope enforcement.
// Integration — needs a live Postgres. Run: node test/auth.test.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const CP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(CP, 'server.js'));
process.env.ASTRODOCK_BASE_DOMAIN ||= 'localhost';
process.env.ASTRODOCK_ADMIN_JWT_SECRET ||= 'test-jwt-secret';
process.env.ASTRODOCK_SECRET_KEY ||= '0'.repeat(64);
process.env.ASTRODOCK_TLS_MODE ||= 'off';
const { app } = require(path.join(CP,'server.js'));
const { db, schema, close } = require(CP+'/src/db/index.js');
const { eq } = require('drizzle-orm');
const srv = app.listen(0); await new Promise(r=>srv.once('listening',r));
const B = 'http://127.0.0.1:'+srv.address().port;
let p=0,f=0; const t=async(n,fn)=>{try{await fn();console.log('  ok  '+n);p++}catch(e){console.error('  FAIL '+n+'\n       '+e.message);f++}};
const A=(c,m)=>{if(!c)throw new Error(m||'failed')};
const J=async(m,u,b,tok)=>{const r=await fetch(B+u,{method:m,headers:{'Content-Type':'application/json',...(tok?{Authorization:'Bearer '+tok}:{})},body:b?JSON.stringify(b):undefined});return{s:r.status,d:await r.json().catch(()=>({}))}};

await db.delete(schema.users).where(eq(schema.users.email,'own@e2e.com'));
// Other tests leave owners behind; the last-owner guard needs this one to be the last.
await db.update(schema.users).set({operatorRole:'admin'}).where(eq(schema.users.operatorRole,'owner'));
await db.delete(schema.users).where(eq(schema.users.email,'end@e2e.com'));
const { hashPassword } = require(CP+'/src/lib/passwords.js');
const ph = await hashPassword('correct-horse-battery');
const [owner] = await db.insert(schema.users).values({email:'own@e2e.com',name:'Own',passwordHash:ph,isActive:true,isAdmin:true,operatorRole:'owner'}).returning();
const [enduser] = await db.insert(schema.users).values({email:'end@e2e.com',name:'End',passwordHash:ph,isActive:true,appAccess:[]}).returning();

console.log('operator sign-in + sessions');
let TOK;
await t('an end user cannot sign in to the dashboard', async()=>{
  const r = await J('POST','/admin/login',{email:'end@e2e.com',password:'correct-horse-battery'});
  A(r.s===401,'got '+r.s);
});
await t('an owner can, and gets a session', async()=>{
  const r = await J('POST','/admin/login',{email:'own@e2e.com',password:'correct-horse-battery'});
  A(r.s===200,'got '+r.s+' '+JSON.stringify(r.d)); A(r.d.token,'token'); A(r.d.sessionId,'session id'); TOK=r.d.token;
});
await t('revoking the session kills the token immediately', async()=>{
  const before = await J('GET','/whoami',null,TOK); A(before.s===200,'valid before');
  const sess = await J('GET','/admin/account',null,TOK);
  await require(CP+'/src/lib/sessions.js').revoke(sess.d.sessions.find(s=>s.current).id);
  const after = await J('GET','/whoami',null,TOK); A(after.s===401,'revoked -> 401, got '+after.s);
});

console.log('\nwhoami');
await t('an owner sees their role and full permissions', async()=>{
  const r0 = await J('POST','/admin/login',{email:'own@e2e.com',password:'correct-horse-battery'}); TOK=r0.d.token;
  const r = await J('GET','/whoami',null,TOK);
  A(r.d.kind==='person'); A(r.d.role==='owner'); A(r.d.scopes.includes('tokens:write'));
});

console.log('\nkeys: delegation through the API');
let DEPLOYKEY, PARENTKEY;
await t('a person can mint a deployer key', async()=>{
  const r = await J('POST','/admin/tokens',{name:'deploy-e2e',preset:'deployer'},TOK);
  A(r.s===201,'got '+r.s+' '+JSON.stringify(r.d)); DEPLOYKEY=r.d.token;
  A(!r.d.scopes.includes('apps:delete'),'no delete'); A(!r.d.scopes.includes('exec'),'no exec');
  A(r.d.expiresAt,'expires by default');
});
await t('a deployer key cannot mint keys', async()=>{
  const r = await J('POST','/admin/tokens',{name:'x',preset:'deployer'},DEPLOYKEY);
  A(r.s===403,'got '+r.s);
});
await t('a key WITH tokens:write can mint a strictly smaller key', async()=>{
  const r0 = await J('POST','/admin/tokens',{name:'parent-e2e',scopes:['tokens:write','apps:read','apps:write','deploys:write','env:write']},TOK);
  A(r0.s===201,'parent created'); PARENTKEY=r0.d.token;
  const r1 = await J('POST','/admin/tokens',{name:'child-e2e',scopes:['apps:read','deploys:write']},PARENTKEY);
  A(r1.s===201,'child created, got '+r1.s+' '+JSON.stringify(r1.d));
  const r2 = await J('POST','/admin/tokens',{name:'esc',scopes:['tokens:write','apps:read']},PARENTKEY);
  A(r2.s===400,'cannot grant tokens:write, got '+r2.s);
  const r3 = await J('POST','/admin/tokens',{name:'wide',scopes:['settings:write']},PARENTKEY);
  A(r3.s===400,'cannot exceed, got '+r3.s);
});
await t('revoking a parent revokes what it created', async()=>{
  const list = await J('GET','/admin/tokens',null,TOK);
  const parent = list.d.tokens.find(x=>x.name==='parent-e2e');
  const r = await J('DELETE','/admin/tokens/'+parent.id,null,TOK);
  A(r.d.revokedChildren>=1,'children revoked: '+r.d.revokedChildren);
});

console.log('\nkeys vs users');
await t('a key with users:write cannot touch an operator', async()=>{
  const k = await J('POST','/admin/tokens',{name:'usr-e2e',scopes:['users:read','users:write']},TOK);
  const r = await J('PATCH','/admin/users/'+owner.id,{name:'Hacked'},k.d.token);
  A(r.s===403,'got '+r.s+' '+JSON.stringify(r.d));
  const r2 = await J('PATCH','/admin/users/'+enduser.id,{name:'Renamed'},k.d.token);
  A(r2.s===200,'end user ok, got '+r2.s);
  const r3 = await J('PATCH','/admin/users/'+enduser.id,{operatorRole:'admin'},k.d.token);
  A(r3.s===403,'cannot grant operator access, got '+r3.s);
});
await t('the last owner cannot be demoted or deactivated', async()=>{
  const r = await J('PATCH','/admin/users/'+owner.id,{operatorRole:'admin'},TOK);
  A(r.s===400,'demote refused, got '+r.s+' '+JSON.stringify(r.d));
  const r2 = await J('PATCH','/admin/users/'+owner.id,{isActive:false},TOK);
  A(r2.s===400,'deactivate refused, got '+r2.s);
});

console.log('\nstep-up re-authentication');

// Signing in IS a confirmation, so the window starts fresh and the first
// sensitive action within it is allowed through on purpose. Age it to get the
// challenge this is actually about.
const stale = async () => db.update(schema.sessions)
  .set({reauthAt:new Date(Date.now()-60*60*1000)})
  .where(eq(schema.sessions.userId,owner.id));

await t('a sensitive action asks for confirmation once the window has passed', async()=>{
  await stale();
  const r = await J('PUT','/admin/account/password',{password:'brand-new-password'},TOK);
  A(r.s===403,'expected a challenge, got '+r.s+' '+JSON.stringify(r.d));
  A(r.d.code==='reauth_required','names the reason, got '+JSON.stringify(r.d));
});

await t('confirming with a password unblocks it — and actually sticks', async()=>{
  await stale();
  // The whole bug: /reauth answered ok, but with nothing to write the timestamp
  // to, the very next request asked again. Prove the second request gets through.
  const c = await J('POST','/admin/account/reauth',{password:'correct-horse-battery'},TOK);
  A(c.s===200,'reauth rejected: '+c.s+' '+JSON.stringify(c.d));
  const r = await J('PUT','/admin/account/password',{password:'brand-new-password',currentPassword:'correct-horse-battery'},TOK);
  A(r.s===200,'still blocked after confirming: '+r.s+' '+JSON.stringify(r.d));
  // put it back so later assertions can still sign in
  await J('PUT','/admin/account/password',{password:'correct-horse-battery',currentPassword:'brand-new-password'},TOK);
});

await t('a wrong password is refused without consuming the session', async()=>{
  await stale();
  const r = await J('POST','/admin/account/reauth',{password:'not-it'},TOK);
  A(r.s===401,'got '+r.s);
  const still = await J('GET','/admin/account',null,TOK);
  A(still.s===200,'a failed confirmation must not sign you out, got '+still.s);
});

await t('the prompt reports which factors this account can use', async()=>{
  const r = await J('GET','/admin/account/reauth/options',null,TOK);
  A(r.s===200,'got '+r.s);
  A(r.d.password===true,'password should be available');
  A('passkey' in r.d && 'totp' in r.d && 'recoveryCode' in r.d,'every factor is reported');
});

await t('changing a password requires the current one', async()=>{
  await stale();
  await J('POST','/admin/account/reauth',{password:'correct-horse-battery'},TOK);
  const r = await J('PUT','/admin/account/password',{password:'another-password',currentPassword:'wrong'},TOK);
  A(r.s===401,'expected the current password to be checked, got '+r.s);
});

await t('a session-less token is told to sign in again, not looped', async()=>{
  // What the first-run wizard used to hand out. It can never satisfy step-up, so
  // it must say so once rather than accepting a password and asking forever.
  const jwt = (await import('jsonwebtoken')).default;
  const legacy = jwt.sign({sub:owner.id,email:owner.email,isAdmin:true},
    process.env.ASTRODOCK_ADMIN_JWT_SECRET,{expiresIn:'1h'});
  const r = await J('POST','/admin/account/reauth',{password:'correct-horse-battery'},legacy);
  A(r.s===409,'expected a clear refusal, got '+r.s+' '+JSON.stringify(r.d));
  A(r.d.code==='session_required','names the reason, got '+JSON.stringify(r.d));
});

console.log('\nscope enforcement on routes');
await t('a deployer key is refused app deletion', async()=>{
  const r = await J('DELETE','/admin/apps/nonexistent',null,DEPLOYKEY);
  A(r.s===403,'got '+r.s+' '+JSON.stringify(r.d)); A(r.d.required==='apps:delete','names the scope');
});
await t('a deployer key cannot read settings', async()=>{
  const r = await J('GET','/admin/settings',null,DEPLOYKEY);
  A(r.s===403,'got '+r.s);
});

await db.delete(schema.users).where(eq(schema.users.id,owner.id));
await db.delete(schema.users).where(eq(schema.users.id,enduser.id));
srv.close(); await close();
console.log('\n'+p+' passed, '+f+' failed');
process.exit(f?1:0);
