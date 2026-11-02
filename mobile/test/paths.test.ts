import { describe, expect, it } from '@jest/globals';
import { notificationTarget } from '../src/lib/notification-target';
import { normalizeAppPath } from '../src/lib/paths';

describe('normalizeAppPath', () => {
  it('accepts paths inside an app', () => {
    expect(normalizeAppPath('/tasks/12')).toBe('/tasks/12');
    expect(normalizeAppPath('/')).toBe('/');
    expect(normalizeAppPath('/a?b=c#d')).toBe('/a?b=c#d');
  });

  it('refuses anything that could leave the app', () => {
    expect(normalizeAppPath('//evil.test')).toBeNull();
    expect(normalizeAppPath('/\\evil.test')).toBeNull();
    expect(normalizeAppPath('https://evil.test')).toBeNull();
    expect(normalizeAppPath('tasks')).toBeNull();
    expect(normalizeAppPath('/a\nb')).toBeNull();
    expect(normalizeAppPath('/' + 'a'.repeat(2000))).toBeNull();
    expect(normalizeAppPath(null)).toBeNull();
    expect(normalizeAppPath(12)).toBeNull();
  });
});

describe('notificationTarget', () => {
  it('reads what the extension set', () => {
    expect(
      notificationTarget({ serverId: 'srv_1', notificationId: 'n1', app: 'tasks', appName: 'Tasks', path: '/t/1' }, {}),
    ).toEqual({ relayServerId: 'srv_1', notificationId: 'n1', app: 'tasks', appName: 'Tasks', path: '/t/1' });
  });

  it('falls back to the relay server id alone', () => {
    expect(notificationTarget(undefined, { ad: { s: 'srv_2', x: {} } }).relayServerId).toBe('srv_2');
    expect(notificationTarget({ s: 'srv_3', x: '{}' }, null)).toEqual({
      relayServerId: 'srv_3',
      notificationId: null,
      app: null,
      appName: null,
      path: null,
    });
  });

  it('drops a bad path or slug', () => {
    const t = notificationTarget({ serverId: 's', app: '../x', path: '//evil.test' }, null);
    expect(t.app).toBeNull();
    expect(t.path).toBeNull();
  });
});
