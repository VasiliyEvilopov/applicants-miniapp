import {Zip, ZipPassThrough} from './fflate-0.8.3.mjs';

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

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Returns a technical (not appearance-based) image quality score from 0 to 10.
 * The input is a small RGBA ImageData sample. It measures sharpness, exposure,
 * contrast, clipping and usable resolution; it does not identify or rank people.
 */
export function computeImageQualityScore({width, height, data} = {}) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 3 || height < 3 ||
      !data || data.length < width * height * 4) return null;
  const gray = new Float32Array(width * height);
  let sum = 0;
  let clipped = 0;
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    const value = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
    gray[i] = value;
    sum += value;
    if (value < 8 || value > 247) clipped++;
  }
  const mean = sum / gray.length;
  let variance = 0;
  let laplacianSum = 0;
  let laplacianSquareSum = 0;
  let laplacianCount = 0;
  for (const value of gray) variance += (value - mean) ** 2;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const value = gray[i];
      const laplacian = gray[i - 1] + gray[i + 1] + gray[i - width] + gray[i + width] - 4 * value;
      laplacianSum += laplacian;
      laplacianSquareSum += laplacian ** 2;
      laplacianCount++;
    }
  }
  const standardDeviation = Math.sqrt(variance / gray.length);
  const laplacianVariance = Math.max(0, laplacianSquareSum / Math.max(1, laplacianCount) -
    (laplacianSum / Math.max(1, laplacianCount)) ** 2);
  const sharpness = clamp(Math.log1p(laplacianVariance) / Math.log1p(1800));
  const exposure = clamp(1 - Math.abs(mean / 255 - 0.5) * 1.7 - clipped / gray.length * 2.4);
  const contrast = clamp(standardDeviation / 74);
  const resolution = clamp(Math.log(Math.min(width, height) / 48) / Math.log(1024 / 48));
  const score = 10 * (sharpness * 0.45 + exposure * 0.25 + contrast * 0.2 + resolution * 0.1);
  return Number(clamp(score, 0, 10).toFixed(2));
}

export function qualityMatchesFilters(user, {minQuality = 0, includeUnknownQuality = true} = {}) {
  const threshold = Number.isFinite(minQuality) ? clamp(minQuality, 0, 10) : 0;
  // A zero threshold means that the quality filter is disabled. Do not hide
  // images while their asynchronous score is still being calculated.
  if (threshold <= 0) return true;
  const score = Number(user.image_quality_score ?? user.quality_score);
  if (!Number.isFinite(score)) return includeUnknownQuality;
  return score >= threshold;
}

// VK has returned this flag under both `verified` and `is_verified` in
// different API responses/export formats. Normalize both shapes so the
// verification filter does not silently treat a verified profile as unknown.
export function isVerifiedProfile(user = {}) {
  const value = user.verified ?? user.is_verified;
  return value === 1 || value === true || value === '1' || value === 'true';
}

export function profileMatchesFilters(user, {
  verification = 'all', maxFollowers = 500, includeMissingFollowers = true,
  minQuality = 0, includeUnknownQuality = true,
} = {}) {
  const verified = isVerifiedProfile(user);
  if (verification === 'verified' && !verified) return false;
  if (verification === 'unverified' && verified) return false;
  if (maxFollowers !== null) {
    const rawFollowers = user.followers_count;
    const followers = rawFollowers === '' || rawFollowers === null || rawFollowers === undefined ? null : Number(rawFollowers);
    if (Number.isFinite(followers)) {
      if (followers > maxFollowers) return false;
    } else if (!includeMissingFollowers) {
      return false;
    }
  }
  return qualityMatchesFilters(user, {minQuality, includeUnknownQuality});
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
      count: String(PAGE_SIZE), offset: String(offset), fields: 'photo_max_orig,has_photo,verified,followers_count',
    });
    script.referrerPolicy = 'no-referrer';
    script.src = ENDPOINT + '?' + params;
    script.onerror = () => finish(Error('Не удалось подключиться к VK. Проверьте доступ к api.vk.com и повторите поиск.'));
    document.head.append(script);
  });
}

function parseVariants(value) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1 || count > 100) {
    throw Error('Укажите от 1 до 100 вариантов на изображение.');
  }
  return count;
}

async function decodeImage(blob) {
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
  const image = new Image();
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(Error('Не удалось открыть изображение для аугментации.')); };
    image.src = url;
  });
}

function scoreDecodedImage(image) {
  const sourceWidth = image.width || image.naturalWidth;
  const sourceHeight = image.height || image.naturalHeight;
  if (!sourceWidth || !sourceHeight) throw Error('У изображения отсутствует размер.');
  // Small samples keep the search responsive while preserving enough detail for
  // blur, exposure and contrast measurements.
  const scale = Math.min(1, 160 / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(3, Math.round(sourceWidth * scale));
  const height = Math.max(3, Math.round(sourceHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  try {
    const context = canvas.getContext('2d', {willReadFrequently: true});
    if (!context) throw Error('Браузер не поддерживает чтение изображения.');
    context.drawImage(image, 0, 0, width, height);
    return computeImageQualityScore({width, height, data: context.getImageData(0, 0, width, height).data});
  } finally {
    canvas.width = canvas.height = 0;
  }
}

export async function measureImageQuality(url) {
  const response = await fetch(url, {
    credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Error('Не удалось получить изображение для оценки качества.');
  const image = await decodeImage(await response.blob());
  try {
    return scoreDecodedImage(image);
  } finally {
    image.close?.();
  }
}

async function augmentImage(image) {
  const width = image.width || image.naturalWidth;
  const height = image.height || image.naturalHeight;
  if (!width || !height) throw Error('У изображения отсутствует размер.');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw Error('Браузер не поддерживает обработку изображений.');
  const crop = Math.min(2, Math.floor(Math.min(width, height) / 100));
  const sx = crop ? Math.floor(Math.random() * (crop + 1)) : 0;
  const sy = crop ? Math.floor(Math.random() * (crop + 1)) : 0;
  const sw = Math.max(1, width - crop);
  const sh = Math.max(1, height - crop);
  const angle = (Math.random() - 0.5) * 0.018;
  const scale = 1 + (Math.random() - 0.5) * 0.012;
  const brightness = 98 + Math.random() * 4;
  const contrast = 98 + Math.random() * 4;
  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  context.save();
  context.translate(width / 2, height / 2);
  context.rotate(angle);
  context.scale(scale, scale);
  context.filter = `brightness(${brightness}%) contrast(${contrast}%)`;
  context.drawImage(image, sx, sy, sw, sh, -width / 2, -height / 2, width, height);
  context.restore();
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(Error('Не удалось создать вариант изображения.')), 'image/jpeg', 0.92);
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
  const selectedCount = get('vk-avatars-selected-count');
  const autoCount = get('vk-avatars-auto-count');
  const autoPick = get('vk-avatars-auto-pick');
  const clearSelection = get('vk-avatars-clear-selection');
  const downloadSelected = get('vk-avatars-download');
  const verificationFilter = get('vk-avatars-verification');
  const maxFollowersFilter = get('vk-avatars-max-followers');
  const includeMissingFollowers = get('vk-avatars-include-missing');
  const filterCount = get('vk-avatars-filter-count');
  const resetFilters = get('vk-avatars-filters-reset');
  const exportStatus = get('vk-avatars-export-status');
  const augmentationToggle = get('vk-avatars-augment');
  const variantsInput = get('vk-avatars-variants');
  let search = null;
  let offset = 0;
  let busy = false;
  let profiles = [];
  let matchingCount = 0;
  let seen = new Set();
  let selected = new Map();
  let exportBusy = false;
  let autoPicking = false;
  if (!['all', 'verified', 'unverified'].includes(verificationFilter.value)) verificationFilter.value = 'all';

  function readProfileFilters() {
    const rawMax = String(maxFollowersFilter.value ?? '').trim();
    const parsedMax = Number(rawMax);
    return {
      verification: ['all', 'verified', 'unverified'].includes(verificationFilter.value) ? verificationFilter.value : 'all',
      // An empty field explicitly disables the follower limit. Keep 500 as
      // the default, but let users turn this filter off without a hidden
      // checkbox.
      maxFollowers: rawMax === '' ? null : (Number.isSafeInteger(parsedMax) && parsedMax >= 0 ? parsedMax : 500),
      includeMissingFollowers: includeMissingFollowers.checked !== false,
    };
  }

  let profileFilters = readProfileFilters();

  function matchesProfile(user) {
    return profileMatchesFilters(user, profileFilters);
  }

  function renderFilteredResults() {
    const matching = profiles.filter(matchesProfile);
    const visibleIds = new Set(matching.map(user => user.id));
    for (const id of selected.keys()) {
      if (!visibleIds.has(id)) selected.delete(id);
    }
    results.replaceChildren();
    matching.forEach(renderAvatar);
    matchingCount = matching.length;
    filterCount.textContent = `Подходит: ${matching.length} из ${profiles.length}`;
    updateSelection();
    return matching.length;
  }

  function applyProfileFilters() {
    profileFilters = readProfileFilters();
    if (!busy) renderFilteredResults();
  }

  function updateSelection() {
    selectedCount.textContent = 'Выбрано: ' + selected.size;
    clearSelection.disabled = exportBusy || selected.size === 0;
    downloadSelected.disabled = exportBusy || selected.size === 0;
    autoPick.disabled = exportBusy || autoPicking || matchingCount === 0;
    if (typeof results.querySelectorAll === 'function') {
      results.querySelectorAll('input[type="checkbox"]').forEach(input => { input.disabled = exportBusy; });
    }
    augmentationToggle.disabled = exportBusy;
    variantsInput.disabled = exportBusy;
    verificationFilter.disabled = exportBusy;
    maxFollowersFilter.disabled = exportBusy;
    includeMissingFollowers.disabled = exportBusy;
    resetFilters.disabled = exportBusy;
  }

  function resetSelection() {
    selected.clear();
    updateSelection();
  }

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
    const preview = document.createElement('label');
    preview.className = 'vk-avatar-preview';
    const image = document.createElement('img');
    image.crossOrigin = 'anonymous';
    image.src = photoUrl(user.photo_max_orig);
    image.alt = 'Аватарка из открытого профиля ВК';
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    const select = document.createElement('span');
    select.className = 'vk-avatar-select';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selected.has(user.id);
    if (typeof checkbox.setAttribute === 'function') checkbox.setAttribute('aria-label', 'Выбрать аватарку ' + user.id);
    checkbox.onchange = () => {
      if (checkbox.checked) selected.set(user.id, user);
      else selected.delete(user.id);
      updateSelection();
    };
    select.append(checkbox, typeof document.createTextNode === 'function' ? document.createTextNode('Выбрать') : 'Выбрать');
    preview.append(image, select);
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
    card.append(preview, actions);
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
        profiles.push(user);
      }
      const matching = renderFilteredResults();
      more.hidden = offset >= response.count || response.items.length === 0;
      status.textContent = profiles.length
        ? `Найдено профилей: ${matching} из ${profiles.length}. Откройте фото, чтобы сохранить его на устройство.`
        : 'Открытых профилей с аватарками на этой странице нет. Попробуйте другие параметры или следующую страницу.';
    } catch (error) {
      status.textContent = error.message;
      status.classList.add('error');
    } finally {
      busy = false;
      submit.disabled = false;
      more.disabled = false;
      renderFilteredResults();
      updateSelection();
    }
  }

  autoPick.onclick = async () => {
    if (autoPicking || exportBusy) return;
    const count = Number(autoCount.value);
    if (!Number.isSafeInteger(count) || count < 1) {
      exportStatus.textContent = 'Введите целое количество аватарок от 1.';
      exportStatus.classList.add('error');
      return;
    }
    autoPicking = true;
    exportStatus.classList.remove('error');
    exportStatus.textContent = 'Подбираем ' + count + ' аватарок…';
    selected.clear();
    results.querySelectorAll('input[type="checkbox"]').forEach(input => { input.checked = false; });
    updateSelection();
    try {
      const selectVisible = () => {
        const cards = [...results.querySelectorAll('.vk-avatar')];
        for (const card of cards) {
          if (selected.size >= count) break;
          const input = card.querySelector('input[type="checkbox"]');
          if (input && !input.checked) input.click();
        }
      };
      selectVisible();
      while (selected.size < count && !more.hidden) {
        await loadPage();
        if (status.classList.contains('error')) break;
        selectVisible();
      }
      if (selected.size < count) {
        exportStatus.textContent = 'Доступно только ' + selected.size + ' аватарок. Выбор можно изменить вручную.';
      } else {
        exportStatus.textContent = 'Автовыбор отметил ' + selected.size + ' аватарок. Выбор можно изменить вручную.';
      }
    } finally {
      autoPicking = false;
      updateSelection();
    }
  };

  clearSelection.onclick = () => {
    selected.clear();
    results.querySelectorAll('input[type="checkbox"]').forEach(input => { input.checked = false; });
    exportStatus.textContent = '';
    updateSelection();
  };

  downloadSelected.onclick = async () => {
    if (exportBusy || selected.size === 0) return;
    const augmentationEnabled = augmentationToggle.checked;
    let variantsPerImage = 1;
    try {
      if (augmentationEnabled) variantsPerImage = parseVariants(variantsInput.value);
    } catch (error) {
      exportStatus.textContent = error.message;
      exportStatus.classList.add('error');
      return;
    }
    exportBusy = true;
    exportStatus.classList.remove('error');
    const totalFiles = selected.size * variantsPerImage;
    exportStatus.textContent = augmentationEnabled
      ? 'Создаём аугментации: 0 из ' + totalFiles + '…'
      : 'Собираем ZIP: 0 из ' + totalFiles + '…';
    updateSelection();
    const chunks = [];
    let zipError = null;
    const zip = new Zip((error, chunk) => { if (error) zipError = error; else chunks.push(chunk); });
    try {
      let done = 0;
      for (const user of selected.values()) {
        const response = await fetch(photoUrl(user.photo_max_orig), {credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(20000)});
        if (!response.ok) throw Error('Не удалось скачать фото профиля ' + user.id + '.');
        const type = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
        const extension = {'image/jpeg':'jpg','image/png':'png','image/webp':'webp'}[type];
        if (!extension) throw Error('VK вернул неподдерживаемый формат фото профиля ' + user.id + '.');
        if (augmentationEnabled) {
          const image = await decodeImage(await response.blob());
          try {
            for (let variant = 1; variant <= variantsPerImage; variant++) {
              const blob = await augmentImage(image);
              const entry = new ZipPassThrough(`vk-avatar-${user.id}-aug-${String(variant).padStart(2, '0')}.jpg`);
              zip.add(entry);
              entry.push(new Uint8Array(await blob.arrayBuffer()), true);
              done++;
              exportStatus.textContent = 'Создаём аугментации: ' + done + ' из ' + totalFiles + '…';
            }
          } finally {
            image.close?.();
          }
        } else {
          const entry = new ZipPassThrough('vk-avatar-' + user.id + '.' + extension);
          zip.add(entry);
          entry.push(new Uint8Array(await response.arrayBuffer()), true);
          done++;
          exportStatus.textContent = 'Собираем ZIP: ' + done + ' из ' + totalFiles + '…';
        }
      }
      zip.end();
      if (zipError) throw zipError;
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob(chunks, {type:'application/zip'}));
      link.download = 'vk-avatars-' + new Date().toISOString().slice(0,10) + '.zip';
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      exportStatus.textContent = augmentationEnabled
        ? 'Готово: ' + totalFiles + ' аугментированных вариантов в ZIP. Оригиналы не добавлялись.'
        : 'Готово: ' + selected.size + ' выбранных фото в ZIP.';
    } catch (error) {
      zip.terminate();
      exportStatus.textContent = error.message || 'Не удалось собрать ZIP.';
      exportStatus.classList.add('error');
    } finally {
      exportBusy = false;
      updateSelection();
    }
  };

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
    profiles = [];
    matchingCount = 0;
    seen = new Set();
    resetSelection();
    results.replaceChildren();
    filterCount.textContent = 'Подходит: 0';
    more.hidden = true;
    loadPage();
  };
  more.onclick = loadPage;
  verificationFilter.onchange = applyProfileFilters;
  maxFollowersFilter.oninput = applyProfileFilters;
  includeMissingFollowers.onchange = applyProfileFilters;
  resetFilters.onclick = () => {
    verificationFilter.value = 'all';
    maxFollowersFilter.value = '';
    includeMissingFollowers.checked = true;
    applyProfileFilters();
  };
  updateSelection();
  return returningFromVk;
}
