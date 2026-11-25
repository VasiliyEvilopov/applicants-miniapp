const ENDPOINT = 'https://api.vk.com/method/users.search';
const PAGE_SIZE = 24;
const VK_APP_ID = 54921515;
const VK_REDIRECT_URL = 'https://vasiliyevilopov.github.io/applicants-miniapp/';

function tokenStorageKey() {
  const userId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id ?? 'browser';
  return 'applicants_vk_token_v1_' + userId;
}

const VK_LOGIN_KEY = 'applicants_vk_login_v1';
const VK_LOGIN_TTL = 10 * 60 * 1000;

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export async function startVkLogin() {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(64)));
  const state = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  try {
    sessionStorage.setItem(VK_LOGIN_KEY, JSON.stringify({verifier, state, createdAt: Date.now()}));
  } catch {
    throw Error('Для входа VK разрешите сохранение данных сайта в браузере.');
  }
  const params = new URLSearchParams({
    client_id: String(VK_APP_ID), redirect_uri: VK_REDIRECT_URL,
    response_type: 'code', code_challenge: challenge, code_challenge_method: 's256',
    state, scope: '', prompt: 'select_account',
  });
  window.location.assign('https://id.vk.ru/authorize?' + params);
}

export function hasVkLoginResponse() {
  const params = new URLSearchParams(window.location?.search ?? '');
  return params.has('code') || params.has('error');
}

export async function finishVkLogin() {
  const url = new URL(window.location.href);
  const params = url.searchParams;
  const code = params.get('code');
  const device = params.get('device_id');
  const state = params.get('state');
  const denied = params.has('error');
  for (const key of ['code', 'device_id', 'state', 'expires_in', 'ext_id', 'type', 'error', 'error_description']) {
    url.searchParams.delete(key);
  }
  window.history.replaceState(null, '', url.href);
  let pending;
  try {
    pending = JSON.parse(sessionStorage.getItem(VK_LOGIN_KEY) ?? 'null');
  } catch {
    throw Error('Не удалось прочитать данные входа. Нажмите «Войти через VK» ещё раз.');
  }
  if (!pending || !state || state !== pending.state || typeof pending.verifier !== 'string' ||
      !Number.isFinite(pending.createdAt) || Date.now() - pending.createdAt > VK_LOGIN_TTL || Date.now() < pending.createdAt) {
    throw Error('Сеанс входа VK истёк или открыт в другой вкладке. Нажмите «Войти через VK» ещё раз.');
  }
  sessionStorage.removeItem(VK_LOGIN_KEY);
  if (denied) throw Error('Вход VK отменён или отклонён. Можно повторить вход.');
  if (!code || !device) throw Error('VK вернул неполные данные входа. Повторите авторизацию.');
  const query = new URLSearchParams({
    grant_type: 'authorization_code', client_id: String(VK_APP_ID),
    redirect_uri: VK_REDIRECT_URL, code_verifier: pending.verifier,
    state: pending.state, device_id: device,
  });
  let response;
  try {
    response = await fetch('https://id.vk.ru/oauth2/auth?' + query, {
      method: 'POST', body: new URLSearchParams({code}),
      credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw Error('Не удалось получить ключ от VK. Проверьте соединение и повторите вход.');
  }
  const result = await response.json().catch(() => { throw Error('VK вернул некорректный ответ при входе. Повторите авторизацию.'); });
  if (!response.ok || result.error) throw Error('VK отклонил получение ключа. Проверьте настройки приложения и повторите вход.');
  if (result.state !== pending.state) throw Error('Проверка ответа VK не прошла. Повторите вход.');
  if (typeof result.access_token !== 'string' || !result.access_token) {
    throw Error('VK завершил вход без пользовательского ключа. Проверьте доступы приложения в кабинете VK ID.');
  }
  return result.access_token;
}

function authErrorMessage(error) {
  return error instanceof Error ? error.message : 'Не удалось войти через VK. Повторите авторизацию.';
}

export function photoUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname;
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if (host.endsWith('.userapi.com') || host.endsWith('.vkuserphoto.ru')) return url.href;
  } catch {}
  return null;
}

export function avatarItems(users) {
  return users.filter(user => Number.isSafeInteger(user.id) && user.id > 0 &&
    user.is_closed === false && !user.deactivated && user.has_photo && photoUrl(user.photo_max_orig));
}

export function searchAvatars({token, query, ageFrom, ageTo, offset = 0}) {
  if (!token.trim()) return Promise.reject(Error('Введите пользовательский ключ VK API.'));
  if (!Number.isInteger(ageFrom) || !Number.isInteger(ageTo) || ageFrom < 18 || ageTo > 100 || ageTo < ageFrom) {
    return Promise.reject(Error('Укажите возраст от 18 до 100 лет. Верхняя граница должна быть не меньше нижней.'));
  }
  return new Promise((resolve, reject) => {
    const callback = 'vkAvatars_' + crypto.randomUUID().replaceAll('-', '');
    const script = document.createElement('script');
    const finish = (error, result) => {
      clearTimeout(timer);
      script.remove();
      delete window[callback];
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(Error('VK не ответил за 15 секунд. Повторите поиск.')), 15000);
    window[callback] = payload => {
      if (payload?.error) {
        const messages = {
          5: 'Ключ VK недействителен или истёк. Нажмите «Войти через VK» для повторного входа.',
          6: 'Слишком много запросов к VK. Подождите немного и повторите поиск.',
          14: 'VK требует проверку безопасности. Выполните её в VK и повторите поиск.',
          15: 'VK запретил поиск. Проверьте, что введён пользовательский ключ с доступом к users.search.',
          27: 'Для поиска нужен пользовательский ключ VK, ключ сообщества не подходит.',
          28: 'Для поиска нужен пользовательский ключ VK, сервисный ключ не подходит.',
        };
        finish(Error(messages[payload.error.error_code] ?? `Ошибка VK API (${payload.error.error_code}).`));
        return;
      }
      if (!Array.isArray(payload?.response?.items) || !Number.isFinite(payload.response.count)) {
        finish(Error('VK вернул ответ без результатов поиска.'));
        return;
      }
      finish(null, payload.response);
    };
    const params = new URLSearchParams({
      v: '5.199', access_token: token.trim(), callback,
      q: query.trim(), sex: '1', has_photo: '1', sort: '0',
      age_from: String(ageFrom), age_to: String(ageTo),
      count: String(PAGE_SIZE), offset: String(offset), fields: 'photo_max_orig,has_photo',
    });
    script.referrerPolicy = 'no-referrer';
    script.src = ENDPOINT + '?' + params;
    script.onerror = () => finish(Error('Не удалось подключиться к VK. Проверьте доступ к api.vk.com и повторите поиск.'));
    document.head.append(script);
  });
}

export function setupVkAvatars() {
  const get = id => document.getElementById(id);
  const form = get('vk-avatars-form');
  const results = get('vk-avatars-results');
  const status = get('vk-avatars-status');
  const submit = get('vk-avatars-search');
  const more = get('vk-avatars-more');
  const login = get('vk-avatars-login');
  const authStatus = get('vk-avatars-auth-status');
  const token = get('vk-avatars-token');
  const saveToken = get('vk-avatars-save-token');
  const changeToken = get('vk-avatars-change-token');
  let search = null;
  let offset = 0;
  let busy = false;
  let shown = 0;
  let seen = new Set();

  function showSavedKey() {
    token.readOnly = true;
    saveToken.hidden = true;
    changeToken.hidden = false;
    login.textContent = 'Сменить аккаунт VK';
    authStatus.classList.remove('error');
    authStatus.textContent = 'Ключ сохранён на этом устройстве и подставляется при открытии приложения.';
  }

  function persistKey() {
    const value = token.value.trim();
    authStatus.classList.remove('error');
    if (!value) {
      authStatus.textContent = 'Введите пользовательский ключ VK.';
      authStatus.classList.add('error');
      return false;
    }
    try {
      localStorage.setItem(tokenStorageKey(), value);
      token.value = value;
      showSavedKey();
      return true;
    } catch {
      authStatus.textContent = 'Не удалось сохранить ключ на устройстве. Разрешите хранилище для сайта. Сейчас ключ доступен в этой странице.';
      authStatus.classList.add('error');
      return false;
    }
  }

  try {
    const saved = localStorage.getItem(tokenStorageKey());
    if (saved) {
      token.value = saved;
      showSavedKey();
    }
  } catch {
    authStatus.textContent = 'Хранилище устройства недоступно. Разрешите сохранение данных для сайта.';
    authStatus.classList.add('error');
  }
  saveToken.onclick = persistKey;
  changeToken.onclick = () => {
    token.readOnly = false;
    saveToken.hidden = false;
    changeToken.hidden = true;
    authStatus.classList.remove('error');
    authStatus.textContent = 'Введите новый ключ и нажмите «Сохранить ключ».';
    token.focus();
    token.select();
  };

  function setAuthBusy(value) {
    login.disabled = value;
    saveToken.disabled = value;
    changeToken.disabled = value;
    token.disabled = value;
  }

  login.onclick = async () => {
    setAuthBusy(true);
    authStatus.classList.remove('error');
    authStatus.textContent = 'Переходим к входу VK…';
    try {
      await startVkLogin();
    } catch (error) {
      authStatus.textContent = authErrorMessage(error);
      authStatus.classList.add('error');
      setAuthBusy(false);
    }
  };

  const returningFromVk = hasVkLoginResponse();
  if (returningFromVk) {
    setAuthBusy(true);
    authStatus.classList.remove('error');
    authStatus.textContent = 'Получаем ключ после входа VK…';
    finishVkLogin().then(value => {
      token.value = value;
      if (persistKey()) authStatus.textContent = 'VK подключён. Ключ сохранён на этом устройстве.';
    }).catch(error => {
      authStatus.textContent = authErrorMessage(error);
      authStatus.classList.add('error');
    }).finally(() => setAuthBusy(false));
  }

  function renderAvatar(user) {
    const card = document.createElement('article');
    card.className = 'vk-avatar';
    const image = document.createElement('img');
    image.src = photoUrl(user.photo_max_orig);
    image.alt = 'Аватарка из открытого профиля ВК';
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    const actions = document.createElement('div');
    actions.className = 'actions';
    for (const [label, href] of [['Открыть фото', image.src], ['Профиль ВК', `https://vk.com/id${user.id}`]]) {
      const link = document.createElement('a');
      link.className = 'button';
      link.textContent = label;
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      actions.append(link);
    }
    card.append(image, actions);
    results.append(card);
  }

  async function loadPage() {
    if (busy || !search) return;
    busy = true;
    submit.disabled = true;
    more.disabled = true;
    status.classList.remove('error');
    status.textContent = 'Ищем аватарки в VK…';
    try {
      const response = await searchAvatars({...search, token: get('vk-avatars-token').value, offset});
      offset += response.items.length;
      for (const user of avatarItems(response.items)) {
        if (seen.has(user.id)) continue;
        seen.add(user.id);
        renderAvatar(user);
        shown++;
      }
      more.hidden = offset >= response.count || response.items.length === 0;
      status.textContent = shown
        ? `Показано аватарок: ${shown}. Откройте фото, чтобы сохранить его на устройство.`
        : 'Открытых профилей с аватарками на этой странице нет. Попробуйте другие параметры или следующую страницу.';
    } catch (error) {
      status.textContent = error.message;
      status.classList.add('error');
    } finally {
      busy = false;
      submit.disabled = false;
      more.disabled = false;
    }
  }

  form.onsubmit = event => {
    event.preventDefault();
    if (busy) return;
    if (!token.value.trim()) {
      persistKey();
      return;
    }
    persistKey();
    search = {
      query: get('vk-avatars-query').value,
      ageFrom: Number(get('vk-avatars-age-from').value),
      ageTo: Number(get('vk-avatars-age-to').value),
    };
    offset = 0;
    shown = 0;
    seen = new Set();
    results.replaceChildren();
    more.hidden = true;
    loadPage();
  };
  more.onclick = loadPage;
  return returningFromVk;
}
