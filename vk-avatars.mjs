const ENDPOINT = 'https://api.vk.com/method/users.search';
const PAGE_SIZE = 24;
const VK_APP_ID = 54921515;
const VK_REDIRECT_URL = 'https://vasiliyevilopov.github.io/applicants-miniapp/';

function tokenStorageKey() {
  const userId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id ?? 'browser';
  return 'applicants_vk_token_v1_' + userId;
}

export async function authorizeVk(sdk = globalThis.VKIDSDK) {
  if (!sdk) throw Error('Не удалось загрузить модуль входа VK. Обновите страницу и повторите.');
  sdk.Config.init({
    app: VK_APP_ID,
    redirectUrl: VK_REDIRECT_URL,
    scope: '',
    mode: sdk.ConfigAuthMode.InNewWindow,
    responseMode: sdk.ConfigResponseMode.Callback,
    prompt: [sdk.Prompt.SelectAccount],
  });
  const authorization = await sdk.Auth.login();
  if (!authorization?.code || !authorization?.device_id) {
    throw Error('VK завершил вход без кода авторизации. Повторите вход.');
  }
  let timer;
  try {
    const result = await Promise.race([
      sdk.Auth.exchangeCode(authorization.code, authorization.device_id),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(Error('VK не ответил при получении ключа. Повторите вход.')), 20000);
      }),
    ]);
    if (typeof result?.access_token !== 'string' || !result.access_token) {
      throw Error('VK завершил вход без пользовательского ключа. Проверьте доступы приложения в кабинете VK ID.');
    }
    return result.access_token;
  } finally {
    clearTimeout(timer);
  }
}

function authErrorMessage(error) {
  const messages = {
    101: 'Браузер не открыл окно VK. Разрешите всплывающие окна для этого сайта и повторите вход.',
    102: 'Окно VK закрыто. Нажмите «Войти через VK», чтобы повторить вход.',
    103: 'VK отклонил авторизацию. Проверьте настройки приложения в кабинете VK ID.',
    104: 'Проверка авторизации VK не прошла. Повторите вход.',
  };
  if (error instanceof Error) return error.message;
  return messages[error?.code] ?? 'Не удалось войти через VK. Проверьте настройки приложения и повторите.';
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

  login.onclick = async () => {
    login.disabled = true;
    saveToken.disabled = true;
    changeToken.disabled = true;
    token.disabled = true;
    authStatus.classList.remove('error');
    authStatus.textContent = 'Завершите вход в открывшемся окне VK…';
    try {
      token.value = await authorizeVk();
      if (persistKey()) authStatus.textContent = 'VK подключён. Ключ сохранён на этом устройстве.';
    } catch (error) {
      authStatus.textContent = authErrorMessage(error);
      authStatus.classList.add('error');
    } finally {
      login.disabled = false;
      saveToken.disabled = false;
      changeToken.disabled = false;
      token.disabled = false;
    }
  };

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
}
