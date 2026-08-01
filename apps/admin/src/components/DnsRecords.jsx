import { useState } from 'react';

// The "add these records at your registrar" block.
//
// This used to be two boxes stacked on each other: a blue instruction panel and
// then a grey record panel, with different padding, different type and different
// borders — two unrelated-looking objects describing one task. It is one object
// now: the sentence that tells you what to do sits at the top of the same frame
// as the records it is talking about.
//
// The values are also copyable. People transcribe a 40-character TXT record into
// a registrar's web form by hand, and a typo there costs them a support round
// trip and a wait for DNS.

function CopyButton({ text }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="dns-copy"
      title={`Copy ${text}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        } catch { /* clipboard blocked — the value is on screen to select */ }
      }}
    >
      {done ? 'Copied' : 'Copy'}
    </button>
  );
}

export default function DnsRecords({ records = [], lead, footnote }) {
  if (!records.length) return null;
  return (
    <div className="dns-block">
      {lead && <p className="dns-lead">{lead}</p>}
      {records.map((r, i) => (
        <div className="dns-row" key={i}>
          <div className="dns-fields">
            <div className="dns-f">
              <span className="rk">Type</span>
              <span className="rv">{r.type}</span>
            </div>
            <div className="dns-f dns-f-wide">
              <span className="rk">Name</span>
              <span className="rv">{r.name}</span>
              <CopyButton text={r.name} />
            </div>
            <div className="dns-f dns-f-wide">
              <span className="rk">Value</span>
              <span className="rv">{r.value}</span>
              <CopyButton text={r.value} />
            </div>
          </div>
          {r.purpose && <p className="dns-purpose">{r.purpose}</p>}
        </div>
      ))}
      {footnote && <p className="dns-foot">{footnote}</p>}
    </div>
  );
}
