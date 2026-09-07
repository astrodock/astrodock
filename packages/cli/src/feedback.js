'use strict';

// `astrodock feedback …` and `astrodock work …`
//
// The shape is lifted from the CCM project's feedback-sync.mjs, which has been
// the working tool for this job: pull, show, respond, set-status, link. What
// changes here is that the two threads are two commands.
//
//   astrodock feedback note  F-12 "..."   an internal note; the user never sees it
//   astrodock feedback reply F-12 "..."   a message the user reads
//
// There is no flag that turns one into the other. A key holding feedback:write
// but not feedback:reply gets a draft back from `reply`, and the command says
// so rather than pretending it sent.

function ok(status) { return status >= 200 && status < 300; }

function fail(json, status) {
  const msg = (json && (json.error || json.message)) || `request failed (${status})`;
  throw new Error(msg);
}

function pad(s, n) { return String(s == null ? '' : s).padEnd(n); }
function trunc(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function needApp(flags, positional) {
  const app = flags.app || positional.shift();
  if (!app) throw new Error('which app? pass --app <slug>');
  return app;
}

async function cmdFeedback(client, positional, flags) {
  const sub = positional.shift();
  switch (sub) {
    case 'list': {
      const app = needApp(flags, positional);
      const q = flags.status ? `?status=${encodeURIComponent(flags.status)}` : '';
      const { status, json } = await client.request('GET', `/admin/feedback/${app}${q}`);
      if (!ok(status)) return fail(json, status);
      if (!json.feedback.length) return console.log('No feedback.');
      for (const f of json.feedback) {
        const work = f.work && f.work.length ? `  → ${f.work.join(', ')}` : '';
        console.log(`${pad(f.key, 7)} ${pad(f.status, 13)} ${pad(f.category, 9)} ${trunc(f.title, 48)}${work}`);
      }
      return;
    }
    case 'show': {
      const app = needApp(flags, positional);
      const key = positional.shift();
      if (!key) throw new Error('usage: astrodock feedback show <app> <F-n>');
      const { status, json } = await client.request('GET', `/admin/feedback/${app}/${key}`);
      if (!ok(status)) return fail(json, status);
      const f = json.feedback;
      console.log(`${f.key}  ${f.status}  ${f.category}`);
      console.log(f.title);
      console.log(`\n${f.body}\n`);
      if (f.context && Object.keys(f.context).length) {
        for (const [k, v] of Object.entries(f.context)) console.log(`  ${pad(k, 11)} ${trunc(v, 90)}`);
      }
      if (json.internal.length) {
        console.log('\nInternal notes');
        for (const m of json.internal) console.log(`  [${m.authorKind}] ${m.body}`);
      }
      if (json.user.length) {
        console.log('\nSaid to the user');
        for (const m of json.user) console.log(`  ${m.pending ? '(draft) ' : ''}${m.body}`);
      }
      return;
    }
    case 'note': {
      const app = needApp(flags, positional);
      const key = positional.shift();
      const body = positional.join(' ');
      if (!key || !body) throw new Error('usage: astrodock feedback note <app> <F-n> "<text>"');
      const { status, json } = await client.request('POST', `/admin/feedback/${app}/${key}/notes`, { body });
      if (!ok(status)) return fail(json, status);
      console.log(`Noted on ${key}. Internal only.`);
      return;
    }
    case 'reply': {
      const app = needApp(flags, positional);
      const key = positional.shift();
      const body = positional.join(' ');
      if (!key || !body) throw new Error('usage: astrodock feedback reply <app> <F-n> "<text>"');
      const { status, json } = await client.request('POST', `/admin/feedback/${app}/${key}/reply`,
        { body, draft: flags.draft === true });
      if (!ok(status)) return fail(json, status);
      if (json.sent) console.log(`Sent to the person who reported ${key}.`);
      else console.log(`Drafted on ${key}. Nobody has seen it: send it with\n  astrodock feedback send ${app} ${key} ${json.message.id}`);
      return;
    }
    case 'send': {
      const app = needApp(flags, positional);
      const key = positional.shift();
      const id = positional.shift();
      if (!key || !id) throw new Error('usage: astrodock feedback send <app> <F-n> <message-id>');
      const { status, json } = await client.request('POST', `/admin/feedback/${app}/${key}/messages/${id}/send`, {});
      if (!ok(status)) return fail(json, status);
      console.log(`Sent to the person who reported ${key}.`);
      return;
    }
    case 'status': {
      const app = needApp(flags, positional);
      const key = positional.shift();
      const value = positional.shift();
      if (!key || !value) throw new Error('usage: astrodock feedback status <app> <F-n> <status>');
      const { status, json } = await client.request('POST', `/admin/feedback/${app}/${key}/status`, { status: value });
      if (!ok(status)) return fail(json, status);
      console.log(`${key} is now ${json.feedback.status}.`);
      return;
    }
    case 'link': {
      const app = needApp(flags, positional);
      const key = positional.shift();
      const work = positional.shift();
      if (!key || !work) throw new Error('usage: astrodock feedback link <app> <F-n> <I-n>');
      const { status, json } = await client.request('POST', `/admin/feedback/${app}/${key}/link`,
        { work, remove: flags.remove === true });
      if (!ok(status)) return fail(json, status);
      console.log(flags.remove ? `${key} no longer linked to ${work}.` : `${key} linked to ${work}.`);
      return;
    }
    default:
      throw new Error('usage: astrodock feedback <list|show|note|reply|send|status|link> …');
  }
}

async function cmdWork(client, positional, flags) {
  const sub = positional.shift();
  switch (sub) {
    case 'list': {
      const app = needApp(flags, positional);
      const q = flags.status ? `?status=${encodeURIComponent(flags.status)}` : '';
      const { status, json } = await client.request('GET', `/admin/work/${app}${q}`);
      if (!ok(status)) return fail(json, status);
      if (!json.items.length) return console.log('No work items.');
      for (const i of json.items) {
        // Who is waiting to hear about it. An item with reporters behind it is a
        // different thing from one without.
        const waiting = i.feedback && i.feedback.length ? `  ← ${i.feedback.join(', ')}` : '';
        console.log(`${pad(i.key, 7)} ${pad(i.status, 12)} ${pad(i.priority, 4)} ${pad(i.type, 8)} ${trunc(i.title, 46)}${waiting}`);
      }
      return;
    }
    case 'show': {
      const app = needApp(flags, positional);
      const key = positional.shift();
      if (!key) throw new Error('usage: astrodock work show <app> <I-n>');
      const { status, json } = await client.request('GET', `/admin/work/${app}/${key}`);
      if (!ok(status)) return fail(json, status);
      const i = json.item;
      console.log(`${i.key}  ${i.status}  ${i.priority}  ${i.type}${i.area ? `  ${i.area}` : ''}`);
      console.log(i.title);
      if (i.context) console.log(`\n${i.context}`);
      if (i.body) console.log(`\n${i.body}`);
      if (json.feedback.length) {
        console.log('\nReported by');
        for (const f of json.feedback) console.log(`  ${pad(f.key, 7)} ${trunc(f.title, 60)}`);
      }
      return;
    }
    case 'new': {
      const app = needApp(flags, positional);
      const title = positional.join(' ') || flags.title;
      if (!title) throw new Error('usage: astrodock work new <app> "<title>" [--type bug] [--priority P1]');
      const body = { title, type: flags.type || 'bug', priority: flags.priority || 'P2' };
      if (flags.area) body.area = flags.area;
      if (flags.size) body.size = flags.size;
      if (flags.context) body.context = flags.context;
      const { status, json } = await client.request('POST', `/admin/work/${app}`, body);
      if (!ok(status)) return fail(json, status);
      console.log(`${json.item.key}  ${json.item.title}`);
      return;
    }
    case 'status': {
      const app = needApp(flags, positional);
      const key = positional.shift();
      const value = positional.shift();
      if (!key || !value) throw new Error('usage: astrodock work status <app> <I-n> <open|in_progress|done|wont_do>');
      const { status, json } = await client.request('POST', `/admin/work/${app}/${key}/status`, { status: value });
      if (!ok(status)) return fail(json, status);
      console.log(`${key} is now ${json.item.status}.`);
      return;
    }
    case 'relate': {
      const app = needApp(flags, positional);
      const key = positional.shift();
      const to = positional.shift();
      if (!key || !to) throw new Error('usage: astrodock work relate <app> <I-n> <I-m> [--kind blocks]');
      const { status, json } = await client.request('POST', `/admin/work/${app}/${key}/relate`,
        { to, kind: flags.kind || 'relates_to' });
      if (!ok(status)) return fail(json, status);
      console.log(`${key} ${flags.kind || 'relates_to'} ${to}.`);
      return;
    }
    default:
      throw new Error('usage: astrodock work <list|show|new|status|relate> …');
  }
}

module.exports = { cmdFeedback, cmdWork, trunc, pad };
