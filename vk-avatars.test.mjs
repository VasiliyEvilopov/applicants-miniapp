import {test} from 'node:test';
import assert from 'node:assert/strict';
import {photoUrl, avatarItems, searchAvatars, setupVkAvatars, startVkLogin, finishVkLogin} from './vk-avatars.mjs';

function browserFixture(respond, stored = new Map(), session = new Map()) {
  const elements = new Map();
  function element() {
    return {
      value: '', textContent: '', hidden: false, disabled: false, children: [],
      classList: {add() {}, remove() {}},
      append(...children) { this.children.push(...children); },
      replaceChildren() { this.children = []; },
      remove() { this.removed = true; },
      focus() {},
      select() {},
    };
  }
  const get = id => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const scripts = [];
  const navigation = [];
  globalThis.window = {
    location: {href: 'https://vasiliyevilopov.github.io/applicants-miniapp/', search: '', assign(url) { navigation.push(url); }},
    history: {replaceState(state, title, href) { window.location.href = href; window.location.search = new URL(href).search; }},
    open() { throw Error('Popup login must not be used'); },
  };
  globalThis.sessionStorage = {
    getItem: key => session.get(key) ?? null,
    setItem: (key, value) => session.set(key, value),
    removeItem: key => session.delete(key),
  };
  globalThis.localStorage = {
    getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
  };
  globalThis.document = {
    getElementById: get,
    createElement: element,
    head: {append(script) {
      scripts.push(script);
      queueMicrotask(() => respond(script));
    }},
  };
  return {get, scripts, stored, session, navigation};
}

const user = id => ({id, is_closed: false, has_photo: 1, photo_max_orig: `https://sun9-1.userapi.com/photo${id}.jpg`});

function setCallback(state, extra = {}) {
  const url = new URL('https://vasiliyevilopov.github.io/applicants-miniapp/');
  url.search = new URLSearchParams({code: 'fixture-code', device_id: 'fixture-device', state, ...extra});
  window.location.href = url.href;
  window.location.search = url.search;
}

test('VK login navigates in the same tab with a matching PKCE challenge', async () => {
  const fixture = browserFixture(() => {});
  setupVkAvatars();
  await fixture.get('vk-avatars-login').onclick();
  assert.equal(fixture.navigation.length, 1);
  const url = new URL(fixture.navigation[0]);
  const pending = JSON.parse([...fixture.session.values()][0]);
  assert.equal(url.origin, 'https://id.vk.ru');
  assert.equal(url.searchParams.get('client_id'), '54921515');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://vasiliyevilopov.github.io/applicants-miniapp/');
  assert.equal(url.searchParams.get('state'), pending.state);
  const expected = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pending.verifier))).toString('base64url');
  assert.equal(url.searchParams.get('code_challenge'), expected);
  assert.equal(url.searchParams.has('code_verifier'), false);
});

test('VK redirect callback exchanges its code, saves the token, and clears the callback URL', async t => {
  const fixture = browserFixture(() => {});
  await startVkLogin();
  const pending = JSON.parse([...fixture.session.values()][0]);
  setCallback(pending.state);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const params = new URL(url).searchParams;
    assert.equal(params.get('client_id'), '54921515');
    assert.equal(params.get('code_verifier'), pending.verifier);
    assert.equal(params.get('state'), pending.state);
    assert.equal(options.body.get('code'), 'fixture-code');
    return {ok: true, json: async () => ({access_token: 'fixture-token', state: pending.state})};
  });
  assert.equal(setupVkAvatars(), true);
  await new Promise(setImmediate);
  assert.equal(fixture.get('vk-avatars-token').value, 'fixture-token');
  assert.equal([...fixture.stored.values()][0], 'fixture-token');
  assert.equal(fixture.session.size, 0);
  assert.equal(window.location.search, '');
  assert.match(fixture.get('vk-avatars-auth-status').textContent, /подключён/);
  assert.equal(fixture.get('vk-avatars-login').disabled, false);
});

test('VK redirect rejects a wrong state or stale request before contacting the token endpoint', async t => {
  const fixture = browserFixture(() => {});
  await startVkLogin();
  const pending = JSON.parse([...fixture.session.values()][0]);
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; });
  setCallback('wrong-state');
  await assert.rejects(finishVkLogin(), /истёк/);
  assert.equal(requests, 0);
  pending.createdAt = Date.now() - 11 * 60 * 1000;
  fixture.session.set([...fixture.session.keys()][0], JSON.stringify(pending));
  setCallback(pending.state);
  await assert.rejects(finishVkLogin(), /истёк/);
  assert.equal(requests, 0);
});

test('failed or cancelled redirect keeps the existing saved key and permits retry', async t => {
  const fixture = browserFixture(() => {});
  setupVkAvatars();
  fixture.get('vk-avatars-token').value = 'previous-fixture-key';
  fixture.get('vk-avatars-save-token').onclick();
  await startVkLogin();
  const pending = JSON.parse([...fixture.session.values()][0]);
  setCallback(pending.state);
  t.mock.method(globalThis, 'fetch', async () => { throw Error('offline'); });
  setupVkAvatars();
  await new Promise(setImmediate);
  assert.equal([...fixture.stored.values()][0], 'previous-fixture-key');
  assert.equal(fixture.get('vk-avatars-login').disabled, false);
  assert.match(fixture.get('vk-avatars-auth-status').textContent, /соединение/);
  await startVkLogin();
  const next = JSON.parse([...fixture.session.values()][0]);
  setCallback(next.state, {error: 'access_denied'});
  await assert.rejects(finishVkLogin(), /отменён/);
  assert.equal([...fixture.stored.values()][0], 'previous-fixture-key');
});

test('token responses with a mismatched state are never accepted', async t => {
  const fixture = browserFixture(() => {});
  await startVkLogin();
  const pending = JSON.parse([...fixture.session.values()][0]);
  setCallback(pending.state);
  t.mock.method(globalThis, 'fetch', async () => ({ok: true, json: async () => ({access_token: 'fixture', state: 'wrong'})}));
  await assert.rejects(finishVkLogin(), /Проверка ответа/);
  assert.equal(fixture.stored.size, 0);
});

test('manual key survives reopen and can be replaced without altering contact data', () => {
  const stored = new Map([['applicants_v1', 'contact-data-fixture']]);
  let fixture = browserFixture(() => {}, stored);
  setupVkAvatars();
  fixture.get('vk-avatars-token').value = '  first-fixture-token  ';
  fixture.get('vk-avatars-save-token').onclick();
  assert.equal(fixture.get('vk-avatars-token').readOnly, true);
  fixture = browserFixture(() => {}, stored);
  setupVkAvatars();
  assert.equal(fixture.get('vk-avatars-token').value, 'first-fixture-token');
  assert.equal(fixture.get('vk-avatars-save-token').hidden, true);
  assert.equal(fixture.get('vk-avatars-change-token').hidden, false);
  fixture.get('vk-avatars-change-token').onclick();
  assert.equal(fixture.get('vk-avatars-token').readOnly, false);
  fixture.get('vk-avatars-token').value = '';
  assert.equal(fixture.get('vk-avatars-save-token').onclick(), false);
  assert.match(fixture.get('vk-avatars-auth-status').textContent, /Введите/);
  fixture.get('vk-avatars-token').value = 'second-fixture-token';
  assert.equal(fixture.get('vk-avatars-save-token').onclick(), true);
  fixture = browserFixture(() => {}, stored);
  setupVkAvatars();
  assert.equal(fixture.get('vk-avatars-token').value, 'second-fixture-token');
  assert.equal(stored.get('applicants_v1'), 'contact-data-fixture');
});

test('failed persistence keeps the previous key and reports the failure', () => {
  const stored = new Map();
  let fixture = browserFixture(() => {}, stored);
  setupVkAvatars();
  fixture.get('vk-avatars-token').value = 'first-fixture-token';
  fixture.get('vk-avatars-save-token').onclick();
  fixture.get('vk-avatars-change-token').onclick();
  fixture.get('vk-avatars-token').value = 'replacement-fixture-token';
  globalThis.localStorage.setItem = () => { throw Error('quota'); };
  assert.equal(fixture.get('vk-avatars-save-token').onclick(), false);
  assert.match(fixture.get('vk-avatars-auth-status').textContent, /Не удалось сохранить/);
  fixture = browserFixture(() => {}, stored);
  setupVkAvatars();
  assert.equal(fixture.get('vk-avatars-token').value, 'first-fixture-token');
});

test('saved keys are separated for Telegram accounts on the same device', () => {
  const stored = new Map();
  let fixture = browserFixture(() => {}, stored);
  window.Telegram = {WebApp: {initDataUnsafe: {user: {id: 1}}}};
  setupVkAvatars();
  fixture.get('vk-avatars-token').value = 'account-one-fixture';
  fixture.get('vk-avatars-save-token').onclick();
  fixture = browserFixture(() => {}, stored);
  window.Telegram = {WebApp: {initDataUnsafe: {user: {id: 2}}}};
  setupVkAvatars();
  assert.equal(fixture.get('vk-avatars-token').value, '');
  fixture = browserFixture(() => {}, stored);
  window.Telegram = {WebApp: {initDataUnsafe: {user: {id: 1}}}};
  setupVkAvatars();
  assert.equal(fixture.get('vk-avatars-token').value, 'account-one-fixture');
});

test('avatar results allow public profiles and trusted HTTPS photo hosts', () => {
  assert.equal(photoUrl('https://sun9-1.userapi.com/photo.jpg'), 'https://sun9-1.userapi.com/photo.jpg');
  for (const url of ['javascript:alert(1)', 'http://sun9-1.userapi.com/photo.jpg', 'https://userapi.com.evil.test/photo.jpg', 'https://key@sun9-1.userapi.com/photo.jpg']) {
    assert.equal(photoUrl(url), null);
  }
  assert.deepEqual(avatarItems([user(1), {...user(2), is_closed: true}, {...user(3), deactivated: 'deleted'}, {...user(4), has_photo: 0}, {...user(5), photo_max_orig: 'https://evil.test/p.jpg'}]), [user(1)]);
});

test('VK request uses adult female filters, encodes input, and cleans up callback', async () => {
  const fixture = browserFixture(script => {
    const params = new URL(script.src).searchParams;
    assert.equal(params.get('sex'), '1');
    assert.equal(params.get('age_from'), '18');
    assert.equal(params.get('age_to'), '35');
    assert.equal(params.get('has_photo'), '1');
    assert.equal(params.get('q'), 'Анна & callback=evil');
    window[params.get('callback')]({response: {count: 1, items: [user(1)]}});
  });
  const result = await searchAvatars({token: 'fixture', query: 'Анна & callback=evil', ageFrom: 18, ageTo: 35});
  assert.deepEqual(result.items, [user(1)]);
  assert.equal(fixture.scripts[0].removed, true);
  assert.deepEqual(Object.keys(window).filter(key => key.startsWith('vkAvatars_')), []);
});

test('invalid ages and missing tokens do not send requests; VK access errors are explained', async () => {
  const fixture = browserFixture(script => {
    const callback = new URL(script.src).searchParams.get('callback');
    window[callback]({error: {error_code: 15, request_params: [{key: 'access_token', value: 'fixture'}]}});
  });
  await assert.rejects(searchAvatars({token: '', ageFrom: 18, ageTo: 35}), /Введите/);
  await assert.rejects(searchAvatars({token: 'fixture', ageFrom: 17, ageTo: 35}), /возраст/);
  assert.equal(fixture.scripts.length, 0);
  await assert.rejects(searchAvatars({token: 'fixture', query: '', ageFrom: 18, ageTo: 35}), /запретил поиск/);
  assert.equal(fixture.scripts[0].removed, true);
});

test('avatar form paginates, deduplicates, skips private profiles, and resets a new search', async () => {
  const offsets = [];
  const fixture = browserFixture(script => {
    const params = new URL(script.src).searchParams;
    const offset = Number(params.get('offset'));
    offsets.push(offset);
    const items = offset === 0 ? [user(1), {...user(2), is_closed: true}] : [user(1), user(3)];
    window[params.get('callback')]({response: {count: 4, items}});
  });
  fixture.get('vk-avatars-token').value = 'fixture';
  fixture.get('vk-avatars-age-from').value = '18';
  fixture.get('vk-avatars-age-to').value = '35';
  setupVkAvatars();
  fixture.get('vk-avatars-form').onsubmit({preventDefault() {}});
  await new Promise(setImmediate);
  assert.equal(fixture.get('vk-avatars-results').children.length, 1);
  assert.equal(fixture.get('vk-avatars-more').hidden, false);
  await fixture.get('vk-avatars-more').onclick();
  assert.deepEqual(offsets, [0, 2]);
  assert.equal(fixture.get('vk-avatars-results').children.length, 2);
  assert.equal(fixture.get('vk-avatars-more').hidden, true);
  fixture.get('vk-avatars-form').onsubmit({preventDefault() {}});
  await new Promise(setImmediate);
  assert.equal(fixture.get('vk-avatars-results').children.length, 1);
  assert.deepEqual(Object.keys(window).filter(key => key.startsWith('vkAvatars_')), []);
});
