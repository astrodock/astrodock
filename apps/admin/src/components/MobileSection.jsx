import { useState, useEffect } from 'react';
import * as api from '../lib/api';
import SettingsGroup from './SettingsGroup';

const MOBILE_KEYS = ['mobile.enabled', 'push.relay_url'];

// Settings › Mobile App. The on/off switch and the relay address are ordinary
// settings; registering is a call to the relay, so it has its own button. The
// registration code is the relay operator's gate on who may register, sent once
// and never stored here.
export default function MobileSection({ settings, onSaved }) {
  const [status, setStatus] = useState(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  async function load() {
    try { setStatus(await api.getMobileSettings()); setError(''); }
    catch (err) { setError(err.message); }
  }
  // Settings reload after a save, and the relay address may have changed with it.
  useEffect(() => { load(); }, [settings]);

  async function register() {
    setBusy(true); setError(''); setDone('');
    try {
      const s = await api.registerPushRelay(code.trim());
      setStatus(s);
      setCode('');
      setDone('Registered. Phones that sign in from now on can receive notifications.');
      onSaved?.();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return (
    <SettingsGroup
      title="Mobile App"
      description="Lets people use this server from the Astrodock app on their phones. Notifications reach phones through a push relay, which only ever sees encrypted text. Registering uses the relay address above, so save that first if you changed it."
      keys={MOBILE_KEYS}
      settings={settings}
      onSave={api.updateSettings}
      onSaved={onSaved}
    >
      <div className="field">
        <div className="lab">
          <b>Relay Status</b>
          <span className="desc">
            Until this server is registered, phones can sign in and open apps but receive no notifications.
          </span>
        </div>
        <div className="ctl" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
          {status && (
            <span className={`chip ${status.registered ? 'ok' : 'warn'}`}>
              {status.registered ? 'Registered' : 'Not Registered'}
            </span>
          )}
          {status?.registered && <code>{status.serverId}</code>}
        </div>
      </div>
      <div className="field">
        <div className="lab">
          <b>Registration Code</b>
          <span className="desc">
            From whoever runs the relay. It is sent once when you register and not stored. Leave it
            blank if the relay does not ask for one.
          </span>
        </div>
        <div className="ctl">
          <input
            type="password"
            autoComplete="off"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            style={{ marginTop: 0, width: 200 }}
          />
          <button type="button" className="primary" onClick={register} disabled={busy}>
            {busy ? 'Registering…' : (status?.registered ? 'Register Again' : 'Register')}
          </button>
        </div>
      </div>
      {error && <div className="error" style={{ margin: '12px 0 0' }}>{error}</div>}
      {done && <p className="desc" style={{ margin: '12px 0 0' }}>{done}</p>}
    </SettingsGroup>
  );
}
