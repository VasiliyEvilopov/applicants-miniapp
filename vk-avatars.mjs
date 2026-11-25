const ENDPOINT = 'https://api.vk.com/method/users.search';
const PAGE_SIZE = 24;

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
          5: 'Ключ VK недействителен или истёк. Введите новый пользовательский ключ.',
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
  let search = null;
  let offset = 0;
  let busy = false;
  let shown = 0;
  let seen = new Set();

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
