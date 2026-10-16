"use strict";
(function () {

  // =====================================================================
  //  Конфиг и хранилище
  // =====================================================================
  const APP_VERSION = "6.6";
  const DEFAULT_CITY = { name: "Урюпинск", lat: 50.8047, lon: 42.0138, country: "RU" };

  // Ключи настроек/избранного те же, что в старой версии — данные не потеряются
  const SETTINGS_KEY = "weather_app_settings_v1";
  const FAV_KEY = "weather_app_favs_v1";
  const LAST_KEY = "wx_last_city_v1";
  const CACHE_PREFIX = "wx_cache_v6_";
  const RAIN_KEY = "wx_rain_notified";
  const CACHE_MAX_AGE = 3 * 24 * 3600 * 1000; // офлайн-копия живёт 3 суток
  const MEM_FRESH_MS = 90 * 1000;            // память: не долбим API чаще ~1.5 мин (кнопка ↻ всегда force)
  const STALE_MS = 10 * 60 * 1000;           // при возврате в приложение обновляем, если старше

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* переполнено/запрещено */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  };

  // Чистим кэши старых версий
  try {
    const dead = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf("weather_cache") === 0) dead.push(k);
    }
    dead.forEach(k => localStorage.removeItem(k));
  } catch (e) {}

  const settings = Object.assign({
    theme: "auto", tempUnit: "C", windUnit: "kmh", pressUnit: "mm",
    lang: (navigator.language || "ru").toLowerCase().indexOf("ru") === 0 ? "ru" : "en",
    sound: "off"
  }, store.get(SETTINGS_KEY, {}));
  const saveSettings = () => store.set(SETTINGS_KEY, settings);

  let favorites = store.get(FAV_KEY, []);
  if (!Array.isArray(favorites)) favorites = [];
  const saveFavs = () => store.set(FAV_KEY, favorites.slice(0, 8));

  const state = {
    city: null,
    data: null,
    seq: 0,            // защита от гонок: ответ старого запроса не затирает новый
    hourStep: 3,
    dayRange: 7,
    effectsKey: null,
    fxCode: undefined,
    lastResults: []
  };

  const $ = id => document.getElementById(id);
  const content = $("content");
  const searchInput = $("searchInput");
  const suggestionsEl = $("suggestions");
  const locBtn = $("locBtn");
  const settingsPanel = $("settingsPanel");

  const t = (ru, en) => (settings.lang === "en" ? en : ru);
  const pad = n => String(n).padStart(2, "0");
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g,
    ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

  // =====================================================================
  //  Единицы измерения
  // =====================================================================
  const toTemp = c => Math.round(settings.tempUnit === "F" ? c * 9 / 5 + 32 : c);
  // Разница температур переводится БЕЗ +32 (раньше «+3°C» превращалось в «+37°F»)
  const toTempDelta = d => Math.round(settings.tempUnit === "F" ? d * 9 / 5 : d);
  const tempSym = () => (settings.tempUnit === "F" ? "°F" : "°");
  const toWind = ms => (settings.windUnit === "ms" ? Math.round(ms * 10) / 10 : Math.round(ms * 3.6));
  const windSym = () => (settings.windUnit === "ms" ? t("м/с", "m/s") : t("км/ч", "km/h"));
  const toPress = hpa => (settings.pressUnit === "hpa" ? Math.round(hpa) : Math.round(hpa * 0.750062));
  const pressSym = () => (settings.pressUnit === "hpa" ? t("гПа", "hPa") : t("мм рт. ст.", "mmHg"));

  // =====================================================================
  //  Коды погоды WMO → описание / иконка / «вид» погоды
  // =====================================================================
  const WX_RU = {
    0: "ясно", 1: "преимущественно ясно", 2: "переменная облачность", 3: "пасмурно",
    45: "туман", 48: "изморозь",
    51: "лёгкая морось", 53: "морось", 55: "сильная морось", 56: "лёгкая ледяная морось", 57: "ледяная морось",
    61: "небольшой дождь", 63: "дождь", 65: "сильный дождь", 66: "ледяной дождь", 67: "сильный ледяной дождь",
    71: "небольшой снег", 73: "снег", 75: "сильный снег", 77: "снежные зёрна",
    80: "небольшой ливень", 81: "ливень", 82: "сильный ливень", 85: "снегопад", 86: "сильный снегопад",
    95: "гроза", 96: "гроза с градом", 99: "сильная гроза с градом"
  };
  const WX_EN = {
    0: "clear", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
    45: "fog", 48: "rime fog",
    51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 56: "light freezing drizzle", 57: "freezing drizzle",
    61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "heavy freezing rain",
    71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
    80: "light showers", 81: "showers", 82: "heavy showers", 85: "snow showers", 86: "heavy snow showers",
    95: "thunderstorm", 96: "thunderstorm with hail", 99: "severe thunderstorm with hail"
  };
  const describe = code => (settings.lang === "en" ? WX_EN : WX_RU)[code] || t("облачно", "cloudy");

  function kindOf(code) {
    if (code >= 95) return "storm";
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
    if (code === 45 || code === 48) return "fog";
    if (code === 0 || code === 1) return "clear";
    return "clouds";
  }

  // Раньше для часов и «сейчас» всегда ставился дневной значок — ночью показывалось солнце
  function iconOf(code, isDay) {
    switch (kindOf(code)) {
      case "storm": return "⛈️";
      case "snow": return "🌨️";
      case "fog": return "🌫️";
      case "rain": return (code === 61 || code === 63 || code === 65 || code === 66 || code === 67 || !isDay) ? "🌧️" : "🌦️";
      case "clear": return code === 0 ? (isDay ? "☀️" : "🌙") : (isDay ? "🌤️" : "🌙");
      default: return code === 2 ? (isDay ? "⛅" : "☁️") : "☁️";
    }
  }

  // ---- Собственные значки погоды (SVG): одинаковые на любом телефоне, с лёгкой анимацией ----
  const CLOUD_PATH = "M19 47c-6 0-11-4.4-11-10 0-5 3.9-9.2 9-9.9C18.6 22 23.4 18 29.2 18c5.2 0 9.7 3.1 11.6 7.6.8-.2 1.6-.3 2.5-.3 5.7 0 10.2 4.3 10.2 9.6S49.9 47 44.2 47H19z";
  // облако по целевому прямоугольнику: левый верх (x, y) и ширина w
  function cloudAt(x, y, w, fill, cls) {
    const s = w / 45.5;
    return `<g class="${cls || ""}"><g transform="translate(${(x - 8 * s).toFixed(2)} ${(y - 18 * s).toFixed(2)}) scale(${s.toFixed(3)})">` +
      `<path d="${CLOUD_PATH}" fill="url(#${fill})"/><path d="${CLOUD_PATH}" fill="none" stroke="#fff" stroke-opacity=".45" stroke-width="1.1"/></g></g>`;
  }
  function sunAt(cx, cy, r) {
    let l = "";
    for (let i = 0; i < 8; i++) l += `<line x1="${cx}" y1="${cy - r - 4}" x2="${cx}" y2="${cy - r - 8.5}" transform="rotate(${i * 45} ${cx} ${cy})"/>`;
    return `<g class="rays" style="transform-origin:${cx}px ${cy}px" stroke="#ffc233" stroke-width="3" stroke-linecap="round">${l}</g>` +
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#g-sun)"/>`;
  }
  const moonAt = (tx, ty, sc) => `<g transform="translate(${tx} ${ty}) scale(${sc})"><path d="M38.5 17.3A17 17 0 1 0 38.5 46.7A14.8 14.8 0 0 1 38.5 17.3z" fill="url(#g-moon)"/></g>`;
  const STARS = `<circle class="star" cx="48" cy="18" r="1.7" fill="#fff"/><circle class="star s2" cx="53" cy="29" r="1.2" fill="#fff"/><circle class="star s3" cx="44" cy="10" r="1.1" fill="#fff"/>`;

  function iconSvg(code, isDay, anim) {
    const k = kindOf(code);
    let b = "";
    if (k === "clear") {
      if (code === 0) b = isDay ? sunAt(32, 32, 11) : moonAt(1, 0, 1) + STARS;
      else b = (isDay ? sunAt(27, 25, 9) : moonAt(-5, -7, 0.85)) + cloudAt(20, 33, 36, "g-cloud", "cl-front");
    } else if (k === "clouds") {
      if (code === 2) b = (isDay ? sunAt(24, 24, 9) : moonAt(-7, -8, 0.8)) + cloudAt(14, 28, 42, "g-cloud", "cl-front");
      else b = cloudAt(5, 13, 34, "g-cloud-dark", "cl-back") + cloudAt(14, 24, 44, "g-cloud", "cl-front");
    } else if (k === "fog") {
      b = cloudAt(11, 8, 42, "g-cloud", "cl-front") +
        `<g stroke="#a3b5d0" stroke-width="3.8" stroke-linecap="round"><path class="fog-l" d="M12 42h40"/><path class="fog-l f2" d="M18 49h34"/><path class="fog-l f3" d="M12 56h28"/></g>`;
    } else if (k === "rain") {
      const heavy = code === 65 || code === 82 || code === 67;
      const sunBehind = isDay && (code === 51 || code === 53 || code === 61 || code === 80);
      const drops = heavy ? [[20, 42], [28, 46], [36, 42], [44, 46]] : [[22, 42], [32, 46], [42, 42]];
      b = (sunBehind ? sunAt(46, 17, 7) : "") + cloudAt(8, 12, 46, "g-cloud-dark", "cl-front") +
        drops.map((d, i) => `<line class="drop" style="animation-delay:${(i * 0.32).toFixed(2)}s" x1="${d[0] + 2}" y1="${d[1]}" x2="${d[0] - 1}" y2="${d[1] + 7}" stroke="#2a98ee" stroke-width="3.2" stroke-linecap="round"/>`).join("");
    } else if (k === "snow") {
      b = cloudAt(8, 12, 46, "g-cloud-dark", "cl-front") +
        [[22, 44], [32, 50], [42, 44]].map((d, i) => `<circle class="flake" style="animation-delay:${(i * 0.7).toFixed(2)}s" cx="${d[0]}" cy="${d[1]}" r="2.7" fill="#fff" stroke="#8fb4dc" stroke-width="0.9"/>`).join("");
    } else { // storm
      b = cloudAt(8, 8, 46, "g-cloud-dark", "cl-front") +
        `<polygon class="bolt" points="35,35 26,50 32,50 29,61 42,44 35,44 39,35" fill="#ffd23f" stroke="#ff9a1a" stroke-width="1" stroke-linejoin="round"/>`;
    }
    return `<svg class="wi${anim ? " anim" : ""}" viewBox="0 0 64 64" aria-hidden="true" focusable="false">${b}</svg>`;
  }

  // =====================================================================
  //  Время в часовом поясе ГОРОДА (а не устройства)
  // =====================================================================
  const DAYS_RU = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
  const DAYS_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS_RU = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const dayName = i => (settings.lang === "en" ? DAYS_EN : DAYS_RU)[i];
  const monthName = i => (settings.lang === "en" ? MONTHS_EN : MONTHS_RU)[i];

  const shifted = (ts, off) => new Date((ts + off) * 1000); // читать через getUTC*
  const fmtHM = (ts, off) => { const d = shifted(ts, off); return pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()); };
  const fmtHour = (ts, off) => pad(shifted(ts, off).getUTCHours()) + ":00";
  const hoursOf = (ts, off) => { const d = shifted(ts, off); return d.getUTCHours() + d.getUTCMinutes() / 60; };
  const deviceOffset = () => -new Date().getTimezoneOffset() * 60;
  const curOffset = () => (state.data ? state.data.tz : deviceOffset());

  // Open-Meteo отдаёт местное время без пояса ("2026-10-13T14:00"). Переводим в настоящий unix.
  function localToUnix(str, off) {
    const ms = Date.parse(str.length === 10 ? str + "T12:00Z" : str + "Z");
    return Math.floor(ms / 1000) - off;
  }

  function fmtDateLine(ts, off) {
    const d = shifted(ts, off);
    return d.getUTCDate() + " " + monthName(d.getUTCMonth()) + ", " + dayName(d.getUTCDay());
  }

  function agoText(ms) {
    const min = Math.max(0, Math.round((Date.now() - ms) / 60000));
    if (min < 1) return t("только что", "just now");
    if (min < 60) return t(min + " мин назад", min + " min ago");
    const h = Math.round(min / 60);
    if (h < 24) return t(h + " ч назад", h + " h ago");
    const d = Math.round(h / 24);
    return t(d + " дн. назад", d + " d ago");
  }

  // =====================================================================
  //  Сеть и кэш
  // =====================================================================
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const fail = code => Object.assign(new Error(code), { code });
  const reasonOf = e => (e && e.code) || (e && e.name === "AbortError" ? "таймаут" : "ошибка");

  function xhrJson(url, ms) {
    return new Promise((resolve, reject) => {
      try {
        const x = new XMLHttpRequest();
        x.open("GET", url, true);
        x.timeout = ms;
        x.onload = () => {
          if (x.status >= 200 && x.status < 300) { try { resolve(JSON.parse(x.responseText)); } catch (e) { reject(fail("формат данных")); } }
          else reject(fail("HTTP " + x.status));
        };
        x.onerror = () => reject(fail("сеть"));
        x.ontimeout = () => reject(fail("таймаут"));
        x.send();
      } catch (e) { reject(fail("сеть")); }
    });
  }

  // fetch, а если он не дошёл до сервера (сеть/блокировка/таймаут) — XHR, как в исходной версии.
  // Если сервер ответил ошибкой (например 429), второй запрос не шлём: он только увеличил бы нагрузку.
  async function getJson(url, ms) {
    ms = ms || 9000;
    if (typeof fetch === "function") {
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = setTimeout(() => { if (ctrl) { try { ctrl.abort(); } catch (e) {} } }, ms);
      try {
        const r = await fetch(url, { mode: "cors", cache: "no-store", credentials: "omit", signal: ctrl ? ctrl.signal : undefined });
        if (!r.ok) throw fail("HTTP " + r.status);
        try { return await r.json(); } catch (e) { throw fail("формат данных"); }
      } catch (e) {
        if (e && e.code) throw e;
      } finally { clearTimeout(timer); }
    }
    return xhrJson(url, Math.min(ms, 7000));
  }

  const keyFor = (lat, lon) => CACHE_PREFIX + Number(lat).toFixed(2) + "_" + Number(lon).toFixed(2);
  const memCache = new Map();

  function isValid(d) {
    return !!(d && d.v === 6 && d.current && Array.isArray(d.hourly) && Array.isArray(d.daily) && d.daily.length);
  }
  function readCache(lat, lon) {
    const d = store.get(keyFor(lat, lon), null);
    if (isValid(d) && Date.now() - d.fetchedAt < CACHE_MAX_AGE) return d;
    return null;
  }
  function writeCache(d) {
    store.set(keyFor(d.lat, d.lon), d);
    memCache.set(keyFor(d.lat, d.lon), d);
  }

  function parseForecast(m, lat, lon) {
    const off = m.utc_offset_seconds || 0;
    const c = m.current || {};
    const D = m.daily || {};
    const H = m.hourly || {};
    const nowSec = Math.floor(Date.now() / 1000);
    const U = s => localToUnix(s, off);

    // «Сегодня» — по календарю города, а не устройства
    const todayStr = new Date((nowSec + off) * 1000).toISOString().slice(0, 10);
    const times = D.time || [];
    let ti = times.findIndex(x => x >= todayStr);
    if (ti < 0) ti = Math.max(0, times.length - 1);

    const daily = [];
    for (let i = ti; i < times.length; i++) {
      daily.push({
        date: times[i],
        max: D.temperature_2m_max[i],
        min: D.temperature_2m_min[i],
        code: D.weather_code[i],
        pop: D.precipitation_probability_max ? D.precipitation_probability_max[i] : null,
        uv: D.uv_index_max ? D.uv_index_max[i] : null,
        sunrise: D.sunrise && D.sunrise[i] ? U(D.sunrise[i]) : null,
        sunset: D.sunset && D.sunset[i] ? U(D.sunset[i]) : null
      });
    }
    const yesterday = ti > 0 ? { max: D.temperature_2m_max[ti - 1], min: D.temperature_2m_min[ti - 1] } : null;

    const hourly = [];
    (H.time || []).forEach((s, i) => {
      const dt = U(s);
      if (dt < nowSec - 3600 || hourly.length >= 50) return;
      hourly.push({
        dt,
        temp: H.temperature_2m[i],
        code: H.weather_code[i],
        isDay: H.is_day ? H.is_day[i] !== 0 : true,
        pop: H.precipitation_probability ? H.precipitation_probability[i] : null
      });
    });

    return {
      v: 6, lat: Number(lat), lon: Number(lon), tz: off, fetchedAt: Date.now(),
      current: {
        temp: c.temperature_2m,
        feels: c.apparent_temperature,
        humidity: c.relative_humidity_2m,
        pressure: c.pressure_msl,           // давление, приведённое к уровню моря (как в прогнозах)
        windSpeed: c.wind_speed_10m,
        windDeg: c.wind_direction_10m,
        visibility: c.visibility > 0 ? c.visibility : null,
        code: c.weather_code,
        isDay: c.is_day !== 0
      },
      hourly, daily, yesterday,
      air: null, pollen: null
    };
  }

  const WX = window.WX_CONFIG || {};
  const HEDGE_MS = 9000; // даём Open-Meteo больше времени; запасной OWM только если OM реально молчит

  // Лёгкий запрос: почасовые данные только на ближайшие ~2 суток (а не на все 16) — ответ примерно в 5 раз меньше.
  function omUrl(lat, lon, light) {
    return "https://api.open-meteo.com/v1/forecast?latitude=" + lat + "&longitude=" + lon +
      "&timezone=auto&wind_speed_unit=ms" +
      "&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,pressure_msl,wind_speed_10m,wind_direction_10m,visibility" +
      "&hourly=temperature_2m,weather_code,is_day,precipitation_probability" +
      "&daily=weather_code,temperature_2m_max,temperature_2m_min,uv_index_max,precipitation_probability_max,sunrise,sunset" +
      "&past_days=1&forecast_days=16" + (light ? "&past_hours=1&forecast_hours=50" : "");
  }

  async function fetchOpenMeteo(lat, lon) {
    let m;
    try { m = await getJson(omUrl(lat, lon, true), 14000); }
    catch (e) {
      // 400 на «лёгких» параметрах → полный запрос; таймаут/сеть → ещё одна попытка
      if (e && e.code === "HTTP 400") m = await getJson(omUrl(lat, lon, false), 16000);
      else {
        await sleep(800);
        try { m = await getJson(omUrl(lat, lon, false), 16000); }
        catch (e2) { throw e; }
      }
    }
    if (!m || !m.current || !m.daily) throw fail("формат данных");
    let d;
    try { d = parseForecast(m, lat, lon); } catch (e) { throw fail("формат данных"); }
    if (!isValid(d)) throw fail("формат данных");
    d.src = "om";
    return d;
  }

  // ---- Запасной источник: OpenWeatherMap → та же модель данных ----
  function owmToWmo(id) {
    if (id >= 200 && id < 300) return 95;
    const map = { 300: 51, 301: 53, 302: 55, 310: 53, 311: 53, 312: 55, 313: 80, 314: 82, 321: 80,
      500: 61, 501: 63, 502: 65, 503: 65, 504: 65, 511: 66, 520: 80, 521: 81, 522: 82, 531: 81,
      600: 71, 601: 73, 602: 75, 611: 66, 612: 66, 613: 67, 615: 71, 616: 73, 620: 85, 621: 85, 622: 86,
      771: 82, 781: 99, 800: 0, 801: 1, 802: 2, 803: 3, 804: 3 };
    if (map[id] != null) return map[id];
    if (id >= 700 && id < 800) return 45;
    return 3;
  }
  const SEVERITY = { clear: 0, clouds: 1, fog: 2, rain: 3, snow: 4, storm: 5 };

  async function fetchOwm(lat, lon) {
    const key = WX.OWM_KEY;
    if (!key) throw fail("нет ключа");
    const q = "?lat=" + lat + "&lon=" + lon + "&appid=" + key + "&units=metric";
    const [cur, fc] = await Promise.all([
      getJson("https://api.openweathermap.org/data/2.5/weather" + q, 8000),
      getJson("https://api.openweathermap.org/data/2.5/forecast" + q, 8000).catch(() => null)
    ]);
    if (!cur || !cur.main) throw fail("формат данных");

    const tz = cur.timezone || 0;
    const now = Math.floor(Date.now() / 1000);
    const sr = cur.sys && cur.sys.sunrise, ss = cur.sys && cur.sys.sunset;
    const DAY = 86400;
    const isDayAt = tt => {
      if (!sr || !ss) return true;
      const x = (((tt - sr) % DAY) + DAY) % DAY, len = (((ss - sr) % DAY) + DAY) % DAY;
      return x < len;
    };
    const w0 = (cur.weather && cur.weather[0]) || { id: 804 };
    const code = owmToWmo(w0.id);

    const list = ((fc && fc.list) || []).slice().sort((a, b) => a.dt - b.dt);

    // Почасовой ряд: прогноз OWM шагом 3 ч → линейная интерполяция до 1 часа
    const hourly = [];
    if (list.length) {
      let t0 = Math.floor(now / 3600) * 3600 - 3600;
      for (let tt = t0; tt <= t0 + 50 * 3600; tt += 3600) {
        let a = null, b = null;
        for (let i = 0; i < list.length; i++) { if (list[i].dt <= tt) a = list[i]; else { b = list[i]; break; } }
        if (!a && !b) break;
        if (!a) a = b;
        if (!b) { if (tt > a.dt + 3 * 3600) break; b = a; }
        const span = b.dt - a.dt, f = span > 0 ? (tt - a.dt) / span : 0;
        const near = f < 0.5 ? a : b;
        hourly.push({
          dt: tt,
          temp: a.main.temp + (b.main.temp - a.main.temp) * f,
          code: owmToWmo(((near.weather || [])[0] || {}).id),
          isDay: isDayAt(tt),
          pop: Math.round(((a.pop || 0)) * 100)
        });
      }
    }

    // Дни: группируем 3-часовые записи по местной дате
    const byDay = {};
    const dayKey = ts => new Date((ts + tz) * 1000).toISOString().slice(0, 10);
    const todayKey = dayKey(now);
    byDay[todayKey] = { temps: [cur.main.temp], codes: [], pop: 0 };
    list.forEach(it => {
      const k = dayKey(it.dt);
      const d = byDay[k] || (byDay[k] = { temps: [], codes: [], pop: 0 });
      d.temps.push(it.main.temp_max != null ? it.main.temp_max : it.main.temp, it.main.temp_min != null ? it.main.temp_min : it.main.temp);
      const hh = new Date((it.dt + tz) * 1000).getUTCHours();
      if (hh >= 6 && hh <= 21) d.codes.push(owmToWmo(((it.weather || [])[0] || {}).id));
      d.pop = Math.max(d.pop, Math.round((it.pop || 0) * 100));
    });
    const keys = Object.keys(byDay).filter(k => k >= todayKey).sort();
    const daily = keys.map((k, i) => {
      const d = byDay[k];
      // типичная погода дня: самый частый код, при равенстве — тяжелее
      const cnt = {};
      d.codes.forEach(c => { cnt[c] = (cnt[c] || 0) + 1; });
      let best = k === todayKey ? code : 3, bestN = -1;
      Object.keys(cnt).forEach(c => {
        const n = cnt[c];
        // при равенстве побеждает более «тяжёлая» погода, но грозу одна запись не делает
        const sev = Math.min(SEVERITY[kindOf(Number(c))], n >= 2 ? 5 : 3);
        const bestSev = Math.min(SEVERITY[kindOf(best)], bestN >= 2 ? 5 : 3);
        if (n > bestN || (n === bestN && sev > bestSev)) { best = Number(c); bestN = n; }
      });
      return {
        date: k, max: Math.max.apply(null, d.temps), min: Math.min.apply(null, d.temps), code: best, pop: d.pop, uv: null,
        sunrise: sr ? sr + i * DAY : null, sunset: ss ? ss + i * DAY : null
      };
    });

    return {
      v: 6, src: "owm", lat: Number(lat), lon: Number(lon), tz, fetchedAt: Date.now(),
      current: {
        temp: cur.main.temp, feels: cur.main.feels_like, humidity: cur.main.humidity,
        pressure: cur.main.sea_level || cur.main.pressure,
        windSpeed: (cur.wind && cur.wind.speed) || 0, windDeg: cur.wind ? cur.wind.deg : null,
        visibility: cur.visibility > 0 ? cur.visibility : null,
        code, isDay: isDayAt(now)
      },
      hourly, daily, yesterday: null, air: null, pollen: null
    };
  }

  // Первый УСПЕШНЫЙ ответ из набора (ошибка — только если не удалось ничего)
  function firstOk(list) {
    return new Promise((resolve, reject) => {
      let left = list.length, last = null;
      list.forEach(p => Promise.resolve(p).then(resolve, e => { last = e; if (--left === 0) reject(last); }));
    });
  }

  async function fetchWeather(lat, lon, force, onUpgrade) {
    const k = keyFor(lat, lon);
    if (force) memCache.delete(k);
    const mem = memCache.get(k);
    if (!force && mem && Date.now() - mem.fetchedAt < MEM_FRESH_MS) return mem;

    // navigator.onLine намеренно НЕ используем: на Android (особенно с VPN) он бывает false при рабочей сети.
    const errors = [];
    let hedgeOver = false, owPromise = null;
    const startOw = () => {
      if (!owPromise) {
        owPromise = fetchOwm(lat, lon).catch(e => { errors.push("OpenWeatherMap: " + reasonOf(e)); throw e; });
        owPromise.catch(() => {}); // чтобы не было «unhandled rejection», если результат уже не нужен
      }
      return owPromise;
    };

    // Open-Meteo: попытка → при сбое сразу будим запасной источник и ещё раз пробуем основной
    const omPromise = (async () => {
      try { return await fetchOpenMeteo(lat, lon); }
      catch (e1) {
        errors.push("Open-Meteo: " + reasonOf(e1));
        startOw();
        await sleep(1200);
        return await fetchOpenMeteo(lat, lon);
      }
    })();
    omPromise.catch(() => {});
    const hedge = sleep(HEDGE_MS).then(() => (hedgeOver ? new Promise(() => {}) : startOw()));

    let res;
    try {
      res = await firstOk([omPromise, hedge, omPromise.catch(() => startOw())]);
    } catch (e) {
      hedgeOver = true;
      const err = new Error("all providers failed");
      err.details = errors.join(" · ");
      throw err;
    }
    hedgeOver = true;

    if (res.src === "owm") {
      // Показываем запасные данные сразу, но Open-Meteo не бросаем: как только он ответит, картинка обновится до полной
      res.note = errors.filter(x => x.indexOf("Open-Meteo") === 0).join(" · ") ||
        t("Open-Meteo не ответил вовремя", "Open-Meteo did not answer in time");
      if (onUpgrade) omPromise.then(d => { if (d) onUpgrade(d); }, () => {});
    }
    return res;
  }

  // Воздух и пыльца: Open-Meteo, а если не ответил — AQI из OpenWeatherMap
  // Воздух, УФ и пыльца — один запрос к API качества воздуха Open-Meteo. УФ берём отсюда, потому что
  // у запасного источника (OpenWeatherMap) его нет. Если сервер не примет расширенные параметры (400) — минимальный запрос.
  function parseAir(r) {
    const c = (r && r.current) || {};
    let air = null;
    if (c.european_aqi != null) {
      const e = c.european_aqi;
      air = {
        eaqi: Math.round(e),
        level: e <= 20 ? 1 : e <= 40 ? 2 : e <= 60 ? 3 : e <= 80 ? 4 : e <= 100 ? 5 : 6,
        p: { pm2_5: c.pm2_5, pm10: c.pm10, no2: c.nitrogen_dioxide, o3: c.ozone, so2: c.sulphur_dioxide },
        stamp: c.time ? String(c.time).slice(11, 16) : null
      };
    }
    const pollen = {};
    let any = false;
    ["grass_pollen", "birch_pollen", "alder_pollen", "mugwort_pollen", "ragweed_pollen"].forEach(k => { if (c[k] != null) { pollen[k] = c[k]; any = true; } });
    let uvx = null;
    const hu = r && r.hourly && r.hourly.uv_index;
    const vals = (hu || []).filter(v => v != null);
    if (c.uv_index != null || vals.length) {
      uvx = { now: c.uv_index != null ? c.uv_index : null, max: vals.length ? Math.max.apply(null, vals) : c.uv_index };
    }
    return { air, pollen: any ? pollen : null, uvx };
  }

  async function owmAir(lat, lon) {
    const r = await getJson("https://api.openweathermap.org/data/2.5/air_pollution?lat=" + lat + "&lon=" + lon + "&appid=" + WX.OWM_KEY, 6000);
    const it = r && r.list && r.list[0];
    if (!it || !it.main) throw fail("формат данных");
    const comp = it.components || {};
    const raw = it.main.aqi;
    return {
      air: raw ? { eaqi: null, owm: raw, level: Math.max(1, Math.min(6, raw)),
        p: { pm2_5: comp.pm2_5, pm10: comp.pm10, no2: comp.no2, o3: comp.o3, so2: comp.so2 }, stamp: null } : null,
      pollen: null, uvx: null
    };
  }

  async function fetchAir(lat, lon) {
    const base = "https://air-quality-api.open-meteo.com/v1/air-quality?latitude=" + lat + "&longitude=" + lon + "&timezone=auto";
    const pol = "alder_pollen,birch_pollen,grass_pollen,mugwort_pollen,ragweed_pollen";
    const full = base + "&forecast_days=1&current=european_aqi,pm2_5,pm10,nitrogen_dioxide,ozone,sulphur_dioxide,uv_index," + pol + "&hourly=uv_index";
    const mini = base + "&current=european_aqi," + pol;
    try {
      let r;
      try { r = await getJson(full, 9000); }
      catch (e) { if (e && e.code === "HTTP 400") r = await getJson(mini, 9000); else throw e; }
      return parseAir(r);
    } catch (e) {
      if (!WX.OWM_KEY) throw e;
      return owmAir(lat, lon);
    }
  }

  const setSlot = (el, html) => { if (el && el.__html !== html) { el.innerHTML = html; el.__html = html; } };

  async function loadExtras(data, seq) {
    // свежие данные (младше 10 минут) не перезапрашиваем — не нагружаем API
    if (data.air && data.extrasAt && Date.now() - data.extrasAt < 10 * 60 * 1000) return;
    try {
      const x = await fetchAir(data.lat, data.lon);
      if (seq !== state.seq || state.data !== data) return; // пользователь уже ушёл в другой город
      data.air = x.air;
      data.pollen = x.pollen;
      data.uvx = x.uvx;
      data.extrasAt = Date.now();
      writeCache(data);
      setSlot($("aqiSlot"), aqiInner(data));
      setSlot($("pollenSlot"), pollenCard(data));
      setSlot($("uvCard"), uvCard(data));
    } catch (e) { /* не критично */ }
  }

  // =====================================================================
  //  Вычисления для карточек
  // =====================================================================
  // Шкала качества воздуха: 6 ступеней европейского индекса EAQI (границы 20 / 40 / 60 / 80 / 100)
  const AIR_COLORS = ["#2fd47a", "#9bdc2e", "#f5c518", "#fb8c1a", "#ef4444", "#9f1239"];
  const AIR_COLORS_DARK = ["#0b8f4a", "#4f8f0a", "#9a7400", "#c2570c", "#c62828", "#9f1239"];
  const AIR_NAMES = {
    ru: ["Отлично", "Хорошо", "Умеренно", "Плохо", "Очень плохо", "Опасно"],
    en: ["Excellent", "Good", "Moderate", "Poor", "Very poor", "Hazardous"]
  };
  const AIR_TEXT = {
    ru: ["Воздух чистый. Можно спокойно гулять и заниматься спортом.",
      "Качество воздуха приемлемое. Очень чувствительным людям стоит быть внимательнее.",
      "Чувствительным людям лучше ограничить нагрузки на улице.",
      "Воздух загрязнён. Сократите время и нагрузки на улице.",
      "Сильное загрязнение. Лучше остаться в помещении.",
      "Опасный уровень загрязнения. Не выходите без необходимости."],
    en: ["The air is clean. Enjoy the outdoors.",
      "Air quality is acceptable. Very sensitive people should take care.",
      "Sensitive people should limit outdoor activity.",
      "The air is polluted. Reduce time and effort outdoors.",
      "Heavy pollution. Better stay indoors.",
      "Dangerous pollution. Do not go out unless necessary."]
  };
  // верхние границы ступеней по каждому веществу, мкг/м³ (европейские пороги EEA, редакция 2024)
  const POLLUTANTS = [
    ["pm2_5", "PM2.5", [5, 15, 50, 90, 140]],
    ["pm10", "PM10", [15, 45, 120, 195, 270]],
    ["no2", "NO₂", [10, 25, 60, 100, 150]],
    ["o3", "O₃", [60, 100, 120, 160, 180]],
    ["so2", "SO₂", [20, 40, 125, 190, 275]]
  ];
  const bandIdx = (v, bounds) => { for (let i = 0; i < bounds.length; i++) if (v <= bounds[i]) return i; return bounds.length; };

  function windDir(deg) {
    if (deg == null) return "";
    const dirs = settings.lang === "en"
      ? ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
      : ["северный", "северо-восточный", "восточный", "юго-восточный", "южный", "юго-западный", "западный", "северо-западный"];
    return dirs[Math.round(deg / 45) % 8];
  }

  function uvInfo(uv) {
    if (uv == null) return { text: "—", sub: "" };
    const r = uv < 10 ? String(Math.round(uv * 10) / 10) : String(Math.round(uv)); // 2.8 остаётся 2.8, а не «3 — слабый»
    if (uv < 3) return { text: r, sub: t("Слабый", "Low") };
    if (uv < 6) return { text: r, sub: t("Умеренный", "Moderate") };
    if (uv < 8) return { text: r, sub: t("Высокий", "High") };
    if (uv < 11) return { text: r, sub: t("Очень высокий", "Very high") };
    return { text: r, sub: t("Экстремальный", "Extreme") };
  }

  function wearText(feelsC, kind, windMs) {
    const rainy = kind === "rain" || kind === "storm";
    let s;
    if (kind === "snow") s = t("Тёплая куртка, шапка, перчатки и непромокаемая обувь", "Warm jacket, hat, gloves and waterproof shoes");
    else if (feelsC < -10) s = t("Пуховик, термобельё, шапка и шарф", "Down jacket, thermal wear, hat and scarf");
    else if (feelsC < 0) s = t("Зимняя куртка, свитер, шапка", "Winter coat, sweater, hat");
    else if (feelsC < 8) s = t("Пальто или куртка, закрытая обувь", "Coat or jacket, closed shoes");
    else if (feelsC < 15) s = rainy ? t("Лёгкая куртка и зонт", "Light jacket and umbrella") : t("Лёгкая куртка или толстовка", "Light jacket or hoodie");
    else if (feelsC < 22) s = rainy ? t("Рубашка/футболка и зонт", "Shirt/tee and umbrella") : t("Футболка или рубашка, можно без куртки", "T-shirt or shirt, jacket optional");
    else if (feelsC < 28) s = rainy ? t("Лёгкая одежда и зонт", "Light clothes and umbrella") : t("Лёгкая одежда, кепка от солнца", "Light clothes, sun cap");
    else s = t("Очень жарко — минимум одежды, вода и крем от солнца", "Very hot — light clothes, water and sunscreen");
    if (windMs >= 10) s += t(". Ветрено — возьмите ветровку", ". Windy — take a windbreaker");
    return s;
  }

  function moonPhase(nowSec) {
    const SYN = 29.530588853;
    const ref = Date.UTC(2000, 0, 6, 18, 14) / 86400000; // известное новолуние
    let ph = ((nowSec / 86400 - ref) / SYN) % 1;
    if (ph < 0) ph += 1;
    const idx = Math.floor(ph * 8 + 0.5) % 8;
    const names = settings.lang === "en"
      ? ["New Moon", "Waxing Crescent", "First Quarter", "Waxing Gibbous", "Full Moon", "Waning Gibbous", "Last Quarter", "Waning Crescent"]
      : ["Новолуние", "Растущий серп", "Первая четверть", "Растущая луна", "Полнолуние", "Убывающая луна", "Последняя четверть", "Убывающий серп"];
    const icons = ["🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"];
    return { name: names[idx], icon: icons[idx], illum: Math.round((1 - Math.cos(2 * Math.PI * ph)) / 2 * 100) };
  }

  const POLLEN_COLORS = ["#94a3b8", "#2fd47a", "#f5c518", "#fb8c1a", "#ef4444"];
  const pollenLvl = v => (v < 1 ? 0 : v < 10 ? 1 : v < 50 ? 2 : v < 100 ? 3 : 4);
  const pollenName = l => (settings.lang === "en"
    ? ["None", "Low", "Moderate", "High", "Very high"] : ["Нет", "Низкий", "Умеренный", "Высокий", "Очень высокий"])[l];

  function pollenSummary(p) {
    if (!p) return null;
    const keys = [
      ["grass_pollen", t("Злаки", "Grass")], ["birch_pollen", t("Берёза", "Birch")],
      ["alder_pollen", t("Ольха", "Alder")], ["mugwort_pollen", t("Полынь", "Mugwort")],
      ["ragweed_pollen", t("Амброзия", "Ragweed")]
    ];
    const items = [];
    let top = 0;
    keys.forEach(([k, label]) => {
      const v = p[k];
      if (v == null || v < 0) return;
      const lvl = pollenLvl(v);
      top = Math.max(top, lvl);
      items.push({ label, v: Math.round(v), lvl });
    });
    if (!items.length) return null;
    items.sort((a, b) => b.lvl - a.lvl || b.v - a.v);
    return { top, items };
  }

  // Ряд для «по часам»: «сейчас» + каждые N часов из почасовых данных.
  // (раньше при шаге 3 показывались 8 подряд идущих ЧАСОВ, а не слотов через 3 часа)
  function hourlyPoints(data, step) {
    const now = Math.floor(Date.now() / 1000), c = data.current;
    const pts = [{ dt: now, temp: c.temp, code: c.code, isDay: c.isDay, pop: null, now: true }];
    const future = data.hourly.filter(h => h.dt > now + 900);
    const want = Math.ceil(24 / step);
    for (let i = 0; i < future.length && pts.length <= want; i += step) {
      const win = future.slice(i, i + step);
      const hasPop = win.some(x => x.pop != null);
      pts.push({
        dt: future[i].dt, temp: future[i].temp, code: future[i].code, isDay: future[i].isDay,
        pop: hasPop ? Math.max.apply(null, win.map(x => x.pop || 0)) : null
      });
    }
    return pts;
  }

  // =====================================================================
  //  HTML-шаблоны
  // =====================================================================
  function hourCards(data) {
    const off = data.tz;
    return hourlyPoints(data, state.hourStep).map((p, i) => {
      const pop = p.pop != null && p.pop >= 10 ? `<div class="pop">💧${p.pop}%</div>` : "";
      return `<div class="hour-card anim-slide" style="animation-delay:${Math.min(i * 0.04, 0.4)}s">
        <div class="time">${p.now ? t("Сейчас", "Now") : fmtHour(p.dt, off)}</div>
        <div class="icon">${iconSvg(p.code, p.isDay)}</div>
        <div class="temp">${toTemp(p.temp)}${tempSym()}</div>${pop}</div>`;
    }).join("");
  }

  function dayRows(data) {
    return data.daily.slice(0, state.dayRange).map((d, i) => {
      const dd = new Date(d.date + "T12:00:00Z");
      const name = i === 0 ? t("Сегодня", "Today") : i === 1 ? t("Завтра", "Tomorrow") : dayName(dd.getUTCDay());
      const dateStr = dd.getUTCDate() + " " + monthName(dd.getUTCMonth());
      const pop = d.pop != null && d.pop >= 10 ? "💧" + Math.round(d.pop) + "%" : "";
      return `<div class="day-row anim-fade-up" style="animation-delay:${Math.min(0.1 + i * 0.04, 0.6)}s">
        <div class="day-name">${name}<span style="display:block;font-size:11px;opacity:0.65;font-weight:400">${dateStr}</span></div>
        <div class="icon">${iconSvg(d.code, true)}</div>
        <div class="day-pop">${pop}</div>
        <div class="temps"><span class="max">${toTemp(d.max)}°</span> <span class="min">${toTemp(d.min)}°</span></div></div>`;
    }).join("");
  }

  function chartSvg(data) {
    const pts = hourlyPoints(data, 3).slice(0, 9);
    if (pts.length < 2) return "";
    const temps = pts.map(p => p.temp);
    const min = Math.min.apply(null, temps) - 2, max = Math.max.apply(null, temps) + 2;
    const w = 320, h = 120, pad2 = 20, span = max - min || 1;
    const co = pts.map((p, i) => ({
      x: pad2 + (i / (pts.length - 1)) * (w - pad2 * 2),
      y: h - pad2 - ((p.temp - min) / span) * (h - pad2 * 2),
      tv: toTemp(p.temp),
      label: p.now ? "·" : fmtHour(p.dt, data.tz)
    }));
    const line = co.map((c, i) => (i ? "L" : "M") + c.x.toFixed(1) + "," + c.y.toFixed(1)).join(" ");
    const area = line + ` L${co[co.length - 1].x.toFixed(1)},${h - pad2} L${co[0].x.toFixed(1)},${h - pad2} Z`;
    const dots = co.map(c => `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="4" fill="#38bdf8"/><text x="${c.x.toFixed(1)}" y="${(c.y - 10).toFixed(1)}" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.85">${c.tv}°</text>`).join("");
    const labels = co.map(c => `<text x="${c.x.toFixed(1)}" y="${h - 4}" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.55">${c.label}</text>`).join("");
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${t("График температуры на 24 часа", "24-hour temperature chart")}">
      <path d="${area}" fill="rgba(56,189,248,0.15)"/>
      <path d="${line}" fill="none" stroke="#38bdf8" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>${dots}${labels}</svg>`;
  }

  // Круговая шкала EAQI: шесть цветных ступеней, активная подсвечена, указатель плавно «выезжает» на значение
  function aqiGauge(a) {
    const cx = 100, cy = 100, R = 82;
    const pt = (deg, r) => [cx + r * Math.cos(deg * Math.PI / 180), cy - r * Math.sin(deg * Math.PI / 180)];
    let arcs = "";
    for (let i = 0; i < 6; i++) {
      const [x0, y0] = pt(180 - i * 30 - 2.4, R), [x1, y1] = pt(180 - (i + 1) * 30 + 2.4, R);
      arcs += `<path class="arc" d="M${x0.toFixed(1)} ${y0.toFixed(1)} A${R} ${R} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}" stroke="${AIR_COLORS[i]}"${i === a.level - 1 ? "" : ' opacity=".35"'}/>`;
    }
    const val = a.eaqi != null ? a.eaqi : (a.level - 1) * 20 + 10; // у запасного источника только ступень — ставим в середину
    const ang = Math.max(0, Math.min(120, val)) / 120 * 180;
    const col = AIR_COLORS[a.level - 1];
    const num = a.eaqi != null ? a.eaqi : a.owm;
    const cap = a.eaqi != null ? "EAQI" : t("из 5", "of 5");
    return `<svg viewBox="0 0 200 128" role="img" aria-label="${t("Индекс качества воздуха", "Air quality index")} ${num}">
      ${arcs}
      <g class="aqi-needle" style="--a:${ang.toFixed(1)}deg;transform:rotate(${ang.toFixed(1)}deg)">
        <circle cx="${cx - R}" cy="${cy}" r="11" fill="#fff" stroke="rgba(15,23,42,.35)" stroke-width="1.5"/>
        <circle cx="${cx - R}" cy="${cy}" r="5.5" fill="${col}"/>
      </g>
      <text class="num" x="100" y="98" text-anchor="middle">${num}</text>
      <text class="cap" x="100" y="118" text-anchor="middle">${cap}</text></svg>`;
  }

  function aqiInner(data) {
    const a = data.air;
    const label = `<div class="aqi-label">${t("Качество воздуха", "Air quality")}</div>`;
    if (!a) {
      return label + `<div class="aqi-title">${t("Нет данных", "No data")}</div>
        <div class="aqi-desc" style="margin-bottom:0">${t("Не удалось получить качество воздуха", "Air quality unavailable")}</div>`;
    }
    const lg = settings.lang === "en" ? "en" : "ru";
    const col = AIR_COLORS[a.level - 1];
    const tiles = POLLUTANTS.filter(x => a.p && a.p[x[0]] != null).map(x => {
      const v = a.p[x[0]];
      return `<div class="aqi-tile" style="--c:${AIR_COLORS[bandIdx(v, x[2])]}"><div class="n">${x[1]}</div><div class="v">${v < 10 ? Math.round(v * 10) / 10 : Math.round(v)}</div></div>`;
    }).join("");
    return label + `<div class="aqi-body">
        <div class="aqi-gauge">${aqiGauge(a)}</div>
        <div class="aqi-side">
          <div class="aqi-title" style="--c:${col};--cd:${AIR_COLORS_DARK[a.level - 1]}">${AIR_NAMES[lg][a.level - 1]}</div>
          <div class="aqi-desc">${AIR_TEXT[lg][a.level - 1]}</div>
        </div>
      </div>
      ${tiles ? `<div class="aqi-tiles">${tiles}</div>` : ""}
      <div class="aqi-foot">${tiles ? t("мкг/м³", "µg/m³") + " · " : ""}${a.stamp ? t("данные на ", "data for ") + a.stamp + " · " : ""}CAMS · Open-Meteo</div>`;
  }

  function pollenCard(data) {
    const pol = pollenSummary(data.pollen);
    if (!pol) return "";
    const stamp = data.air && data.air.stamp ? `<div class="pollen-stamp">${t("данные на ", "data for ")}${data.air.stamp}</div>` : "";
    return `<div class="pollen-card">
      <div class="pollen-head"><div class="pollen-title">🌼 ${t("Пыльца", "Pollen")}</div>${stamp}</div>
      <div class="pollen-level"><span class="lvl-dot" style="background:${POLLEN_COLORS[pol.top]};color:${POLLEN_COLORS[pol.top]}"></span>${pol.top === 0 ? t("Пыльцы в воздухе нет", "No pollen in the air") : pollenName(pol.top)}</div>
      <div class="pollen-items">${pol.items.map(i => `<span class="pollen-chip" style="--c:${POLLEN_COLORS[i.lvl]}">${i.label}<b>${i.v}</b></span>`).join("")}</div>
      <div class="pollen-note">${t("зёрен/м³ · ", "grains/m³ · ")}CAMS · Open-Meteo</div></div>`;
  }

  // УФ: максимум за день (из прогноза, а если его нет — из API воздуха) и текущее значение
  function uvCard(data) {
    const today = data.daily[0] || {};
    const maxUv = today.uv != null ? today.uv : (data.uvx ? data.uvx.max : null);
    const now = data.uvx && data.uvx.now != null ? data.uvx.now : null;
    const u = uvInfo(maxUv);
    return `<div class="d-icon">☀️</div><div class="d-label">${t("УФ", "UV")}</div>
      <div class="d-value">${u.text}</div><div class="d-sub">${u.sub}</div>
      ${now != null ? `<div class="d-sub">${t("сейчас ", "now ")}${Math.round(now * 10) / 10}</div>` : ""}`;
  }

  function sunProgressPct(sr, ss) {
    if (!sr || !ss) return null;
    const now = Date.now() / 1000;
    if (now <= sr) return 0;
    if (now >= ss) return 100;
    return ((now - sr) / (ss - sr)) * 100;
  }

  function render(data, city, opts) {
    opts = opts || {};
    const animate = opts.animate !== false;
    state.data = data;
    state.city = city;

    const cur = data.current, off = data.tz;
    const nowSec = Math.floor(Date.now() / 1000);
    const kind = kindOf(cur.code);
    const today = data.daily[0] || {};
    const isFav = favorites.some(f => Math.abs(f.lat - city.lat) < 0.01 && Math.abs(f.lon - city.lon) < 0.01);

    const favBar = favorites.length
      ? `<div class="fav-bar">${favorites.map((f, i) =>
        `<button type="button" class="fav-chip${Math.abs(f.lat - city.lat) < 0.01 && Math.abs(f.lon - city.lon) < 0.01 ? " active" : ""}" data-fav="${i}">${esc(f.name)}</button>`).join("")}</div>`
      : "";

    let pill = "";
    if (opts.status === "updating") pill = `<div class="status-pill">${t("Обновление…", "Updating…")}</div>`;
    else if (opts.status === "offline") pill = `<div class="status-pill offline">${t("Нет связи · обновлено ", "No connection · updated ")}${agoText(data.fetchedAt)}</div>${opts.reason ? `<div class="err-details" style="margin:-4px 0 10px">${esc(opts.reason)}</div>` : ""}`;

    // «Сравнение со вчера»: прогноз на сегодня vs вчера (раньше сравнивалась текущая температура со средним, да ещё и °F считались неверно)
    let hist = "";
    if (data.yesterday && today.max != null) {
      const diff = (today.max + today.min) / 2 - (data.yesterday.max + data.yesterday.min) / 2;
      const shown = toTempDelta(diff);
      hist = `<div class="hist-card">
        <div style="font-size:13px;color:var(--muted);margin-bottom:4px">${t("Сравнение со вчера", "Vs yesterday")}</div>
        <div style="font-size:16px;font-weight:600">${shown > 0 ? "+" : ""}${shown}${tempSym()} ${shown > 0 ? t("теплее", "warmer") : shown < 0 ? t("холоднее", "colder") : t("как вчера", "same as yesterday")}</div></div>`;
    }

    const notifBanner = ("Notification" in window && Notification.permission === "default")
      ? `<div class="notif-banner"><span>${t("Включить уведомления о дожде?", "Enable rain alerts?")}</span><button type="button" data-act="notif">${t("Да", "Yes")}</button></div>`
      : "";

    const moon = moonPhase(nowSec);
    const vis = cur.visibility != null
      ? (cur.visibility >= 1000 ? Math.round(cur.visibility / 1000) : Math.round(cur.visibility / 100) / 10)
      : null;
    const sunPct = sunProgressPct(today.sunrise, today.sunset);
    const sunIcon = sunPct != null && sunPct > 0 && sunPct < 100 ? "☀️" : "🌙";
    const km = t("км", "km");

    content.classList.toggle("static", !animate);
    content.innerHTML = `
      ${favBar}
      <div class="current">
        ${pill}
        <div class="city-name anim-fade-up">${esc(city.name)}
          <button type="button" class="fav-star" data-act="fav" aria-label="${t("Избранное", "Favorite")}" aria-pressed="${isFav}">${isFav ? "★" : "☆"}</button>
        </div>
        <div class="date anim-fade-up delay-1">${fmtDateLine(nowSec, off)} · <span id="liveClock">${fmtHM(nowSec, off)}</span></div>
        <div class="weather-icon-big anim-float anim-scale delay-1">${iconSvg(cur.code, cur.isDay, true)}</div>
        <div class="temp-main anim-temp delay-2">${toTemp(cur.temp)}<span>${tempSym()}</span></div>
        <div class="condition anim-fade-up delay-3">${describe(cur.code)}</div>
        <div class="feels anim-fade-up delay-4">${t("Ощущается как", "Feels like")} ${toTemp(cur.feels)}${tempSym()}</div>
      </div>

      ${notifBanner}
      ${hist}

      <div class="wear-card anim-fade-up delay-2">
        <div class="wear-title">👔 ${t("Что надеть", "What to wear")}</div>
        <div class="wear-text">${wearText(cur.feels, kind, cur.windSpeed || 0)}</div>
      </div>

      <div class="moon-card anim-fade-up delay-2">
        <div class="moon-title">${t("Луна", "Moon")}</div>
        <div class="moon-row">
          <div class="moon-emoji">${moon.icon}</div>
          <div><div class="moon-name">${moon.name}</div>
          <div class="moon-sub">${t("Освещённость", "Illumination")} ${moon.illum}%</div></div>
        </div>
      </div>

      <div id="pollenSlot" class="anim-fade-up delay-2">${pollenCard(data)}</div>

      <div class="aqi-card anim-fade-up delay-2" id="aqiSlot">${aqiInner(data)}</div>

      <div class="details-grid anim-fade-up delay-3">
        <div class="detail-card" id="uvCard">${uvCard(data)}</div>
        <div class="detail-card"><div class="d-icon">🌡️</div><div class="d-label">${t("Ощущается как", "Feels like")}</div>
          <div class="d-value">${toTemp(cur.feels)}${tempSym()}</div></div>
        <div class="detail-card"><div class="d-icon">💧</div><div class="d-label">${t("Влажность", "Humidity")}</div>
          <div class="d-value">${Math.round(cur.humidity)}%</div></div>
        <div class="detail-card"><div class="d-icon">💨</div><div class="d-label">${t("Ветер", "Wind")} ${windDir(cur.windDeg)}</div>
          <div class="d-value">${toWind(cur.windSpeed || 0)} <span style="font-size:12px;font-weight:500">${windSym()}</span></div></div>
        <div class="detail-card"><div class="d-icon">📉</div><div class="d-label">${t("Давление", "Pressure")}</div>
          <div class="d-value">${cur.pressure != null ? toPress(cur.pressure) : "—"}</div><div class="d-sub">${pressSym()}</div></div>
        <div class="detail-card"><div class="d-icon">👁️</div><div class="d-label">${t("Видимость", "Visibility")}</div>
          <div class="d-value">${vis == null ? "—" : vis + ' <span style="font-size:12px;font-weight:500">' + km + "</span>"}</div></div>
      </div>

      <div class="chart-card anim-fade-up delay-3">
        <div style="font-size:13px;color:var(--muted);margin-bottom:8px">📈 ${t("Температура 24 ч", "Temperature 24h")}</div>
        <div class="chart-wrap" id="chartWrap">${chartSvg(data)}</div>
      </div>

      <div class="sun-card anim-fade-up delay-3">
        <div class="sun-row">
          <div class="sun-side"><div class="s-icon">🌅</div><div class="s-label">${t("Восход", "Sunrise")}</div></div>
          <div class="sun-side"><div class="s-icon">🌇</div><div class="s-label">${t("Закат", "Sunset")}</div></div>
        </div>
        ${sunPct == null ? "" : `<div class="sun-track"><div class="sun-track-fill" style="width:${sunPct}%"></div><div class="sun-track-icon" style="left:${sunPct}%">${sunIcon}</div></div>`}
        <div class="sun-row" style="margin-bottom:0;margin-top:10px">
          <div class="sun-side"><div class="s-time">${today.sunrise ? fmtHM(today.sunrise, off) : "—"}</div></div>
          <div class="sun-side"><div class="s-time">${today.sunset ? fmtHM(today.sunset, off) : "—"}</div></div>
        </div>
      </div>

      <div class="radar-card anim-fade-up delay-3">
        <div style="font-size:13px;color:var(--muted);margin-bottom:10px">📡 ${t("Карта осадков", "Precipitation radar")}</div>
        <a class="radar-btn" href="https://www.rainviewer.com/map.html?loc=${city.lat},${city.lon},8" target="_blank" rel="noopener">
          ${t("Открыть радар RainViewer", "Open RainViewer radar")}</a>
      </div>

      <div class="section-title anim-fade-up delay-3">🕒 ${t("По часам", "Hourly")}</div>
      <div class="interval-tabs anim-fade-up delay-3" id="hourTabs">
        ${[1, 2, 3].map(h => `<button type="button" class="interval-tab${state.hourStep === h ? " active" : ""}" data-step="${h}">${h} ${t(h === 1 ? "час" : "часа", "h")}</button>`).join("")}
      </div>
      <div class="hourly-scroll" id="hourly">${hourCards(data)}</div>

      <div class="section-title anim-fade-up delay-4" id="dailyTitle">📅 ${t("На", "For")} ${state.dayRange} ${t("дней", "days")}</div>
      <div class="interval-tabs anim-fade-up delay-4" id="dayTabs">
        ${[5, 7, 14].map(n => `<button type="button" class="interval-tab${state.dayRange === n ? " active" : ""}" data-range="${n}">${n}</button>`).join("")}
      </div>
      <div class="daily-list" id="dailyList">${dayRows(data)}</div>

      <div class="footer anim-fade-up delay-5">${data.src === "owm" ? "OpenWeatherMap" : "Open-Meteo"} · <span id="updatedLabel">${t("обновлено ", "updated ")}${agoText(data.fetchedAt)}</span> · <button type="button" class="refresh-link" data-act="refresh">↻ ${t("обновить", "refresh")}</button> · v${APP_VERSION}${data.src === "owm" && data.note ? `<div class="err-details" style="margin-top:6px">${esc(t("Основной источник недоступен: ", "Primary source unavailable: "))}${esc(data.note)}</div>` : ""}</div>
    `;

    // запоминаем, что показано, — повторная перерисовка карточек без изменений не проигрывает анимацию заново
    $("aqiSlot").__html = aqiInner(data); $("pollenSlot").__html = pollenCard(data); $("uvCard").__html = uvCard(data);

    updateSky();
    applyEffects(data, city);
  }

  function showLoading(city) {
    content.classList.remove("static");
    content.innerHTML = `
      <div class="current" style="opacity:0.7">
        <div class="city-name">${esc(city ? city.name : "…")}</div>
        <div class="date">${t("Загрузка…", "Loading…")}</div>
        <div class="weather-icon-big">🌤️</div>
        <div class="temp-main" style="opacity:0.35">--<span>°</span></div>
      </div>
      <div class="loading" style="padding:24px 0"><div class="spinner"></div></div>`;
  }

  function showError(msg, details) {
    content.classList.remove("static");
    content.innerHTML = `<div class="error"><div style="font-size:48px;margin-bottom:12px">😕</div>${esc(msg)}
      ${details ? `<div class="err-details">${esc(details)}</div>` : ""}<br>
      <button type="button" class="retry-btn" data-act="retry">${t("Попробовать снова", "Try again")}</button></div>`;
  }

  // Частичные перерисовки без сброса прокрутки страницы
  function updateHourly() {
    if (!state.data) return;
    const el = $("hourly"); if (el) { el.innerHTML = hourCards(state.data); el.scrollLeft = 0; }
    const ch = $("chartWrap"); if (ch) ch.innerHTML = chartSvg(state.data);
    document.querySelectorAll("#hourTabs .interval-tab").forEach(b => b.classList.toggle("active", Number(b.dataset.step) === state.hourStep));
  }
  function updateDaily() {
    if (!state.data) return;
    const el = $("dailyList"); if (el) el.innerHTML = dayRows(state.data);
    const ti = $("dailyTitle"); if (ti) ti.textContent = "📅 " + t("На", "For") + " " + state.dayRange + " " + t("дней", "days");
    document.querySelectorAll("#dayTabs .interval-tab").forEach(b => b.classList.toggle("active", Number(b.dataset.range) === state.dayRange));
  }

  // =====================================================================
  //  Загрузка
  // =====================================================================
  function normalizeCity(c) {
    if (!c || !isFinite(Number(c.lat)) || !isFinite(Number(c.lon))) return DEFAULT_CITY;
    return { name: String(c.name || "—"), lat: Number(c.lat), lon: Number(c.lon), country: c.country || "" };
  }

  // Open-Meteo ответил позже запасного источника — заменяем данные на полные (16 дней, УФ, вчерашний день)
  function makeUpgrade(seq) {
    return d => {
      if (seq !== state.seq || !state.city) return;
      if (Math.abs(d.lat - state.city.lat) > 0.02 || Math.abs(d.lon - state.city.lon) > 0.02) return;
      if (state.data) { d.air = state.data.air; d.pollen = state.data.pollen; d.uvx = state.data.uvx; }
      writeCache(d);
      render(d, state.city, { animate: false });
      afterData(d, seq);
    };
  }

  async function loadCity(cityIn, force) {
    const city = normalizeCity(cityIn);
    const seq = ++state.seq;
    state.city = city;
    store.set(LAST_KEY, city);

    const cached = readCache(city.lat, city.lon);
    if (cached) { state.data = cached; render(cached, city, { animate: true, status: "updating" }); }
    else { state.data = null; showLoading(city); updateSky(); }

    try {
      const data = await fetchWeather(city.lat, city.lon, force, makeUpgrade(seq));
      if (seq !== state.seq) return;
      if (cached) { data.air = cached.air; data.pollen = cached.pollen; data.uvx = cached.uvx; }
      writeCache(data);
      render(data, city, { animate: !cached });
      afterData(data, seq);
    } catch (e) {
      if (seq !== state.seq) return;
      if (cached) render(cached, city, { animate: false, status: "offline", reason: e && e.details });
      else showError(t("Не удалось загрузить погоду. Проверьте интернет.", "Could not load weather. Check your connection."), e && e.details);
    }
  }

  // Обновление текущего города без «загрузки» (pull-to-refresh, возврат в приложение, сеть вернулась)
  async function refresh(force) {
    if (!state.city) return false;
    const seq = ++state.seq;
    try {
      const data = await fetchWeather(state.city.lat, state.city.lon, force, makeUpgrade(seq));
      if (seq !== state.seq) return false;
      if (state.data && state.data.lat === data.lat) { data.air = state.data.air; data.pollen = state.data.pollen; data.uvx = state.data.uvx; }
      writeCache(data);
      render(data, state.city, { animate: false });
      afterData(data, seq);
      return true;
    } catch (e) {
      if (seq === state.seq) {
        if (state.data) render(state.data, state.city, { animate: false, status: "offline", reason: e && e.details });
        toast(t("Нет соединения — показаны сохранённые данные", "No connection — showing saved data"));
      }
      return false;
    }
  }

  function afterData(data, seq) {
    loadExtras(data, seq);
    maybeRainAlert(data);
  }

  // =====================================================================
  //  Небо, солнце, луна
  // =====================================================================
  const SKY = {
    dawn:   { bg: "linear-gradient(180deg, #1a237e 0%, #5c6bc0 25%, #ff8a65 60%, #ffccbc 100%)", stars: 0.1,  sun: 0.95, hOp: 0.7,  hBg: "linear-gradient(transparent, rgba(255,140,80,0.4))",  html: "#ffab91", day: true },
    day:    { bg: "linear-gradient(180deg, #0277bd 0%, #039be5 30%, #4fc3f7 65%, #b3e5fc 100%)", stars: 0,    sun: 1,    hOp: 0.3,  hBg: "linear-gradient(transparent, rgba(255,230,150,0.25))", html: "#4fc3f7", day: true },
    sunset: { bg: "linear-gradient(180deg, #0d47a1 0%, #6a1b9a 20%, #e65100 50%, #ff6f00 75%, #ffab40 100%)", stars: 0.15, sun: 1, hOp: 0.75, hBg: "linear-gradient(transparent, rgba(255,90,30,0.45))", html: "#ff6f00", day: true },
    dusk:   { bg: "linear-gradient(180deg, #0a1628 0%, #1a237e 30%, #4a148c 60%, #6a1b9a 100%)", stars: 0.5,  sun: 0.25, hOp: 0.4,  hBg: "linear-gradient(transparent, rgba(80,40,120,0.35))",  html: "#1a237e", day: false },
    night:  { bg: "linear-gradient(180deg, #020617 0%, #0b1220 35%, #111827 100%)",               stars: 0.85, sun: 0,    hOp: 0.12, hBg: "linear-gradient(transparent, rgba(30,40,80,0.25))",  html: "#0b1220", day: false }
  };

  function updateSky() {
    const sky = $("sky"), sun = $("sun"), moon = $("moon"), stars = $("stars"), horizon = $("horizon");
    const d = state.data, off = curOffset();
    const h = hoursOf(Date.now() / 1000, off);

    // Реальные восход/закат выбранного города (вместо жёстких 6:00 и 20:00 по часам телефона)
    let sr = 6, ss = 20;
    const t0 = d && d.daily[0];
    if (t0 && t0.sunrise && t0.sunset) {
      const a = hoursOf(t0.sunrise, off), b = hoursOf(t0.sunset, off);
      if (b > a) { sr = a; ss = b; }
    }

    let phase;
    if (h >= sr - 0.75 && h < sr + 1) phase = "dawn";
    else if (h >= sr + 1 && h < ss - 1.5) phase = "day";
    else if (h >= ss - 1.5 && h < ss + 0.75) phase = "sunset";
    else if (h >= ss + 0.75 && h < ss + 2) phase = "dusk";
    else phase = "night";

    // «Тема: День/Ночь» меняет и небо, а не только цвет интерфейса —
    // иначе тёмный текст «дня» оказывался на ночном небе и не читался
    const forced = settings.theme === "day" ? "day" : settings.theme === "night" ? "night" : null;
    if (forced) phase = forced;
    const P = SKY[phase];
    const cover = d ? coverOf(d.current.code) : 0;

    let sunProg = Math.max(0, Math.min(1, (h - sr) / (ss - sr)));
    let showMoon = h >= ss || h < sr;
    let moonProg = ((h - ss + 24) % 24) / (24 - (ss - sr));
    if (forced === "day") { sunProg = 0.45; showMoon = false; }
    if (forced === "night") { showMoon = true; moonProg = 0.5; }

    sun.style.left = (8 + sunProg * 84) + "%";
    sun.style.top = (42 - Math.sin(sunProg * Math.PI) * 34) + "%";
    if (showMoon) {
      moon.style.left = (8 + moonProg * 84) + "%";
      moon.style.top = (38 - Math.sin(Math.max(0.05, Math.min(0.95, moonProg)) * Math.PI) * 30) + "%";
      moon.style.opacity = String(1 - cover * 0.8);
      moon.style.filter = cover > 0.05 ? `blur(${(cover * 10).toFixed(1)}px)` : "none";
    } else moon.style.opacity = "0";

    sky.style.background = P.bg;
    sky.style.filter = cover > 0.3 ? `saturate(${(1 - cover * 0.65).toFixed(2)})` : "none";
    stars.style.opacity = P.stars * (1 - cover);
    stars.style.animation = P.stars > 0.3 ? "twinkle 4s ease-in-out infinite alternate" : "none";
    sun.style.opacity = P.sun * (1 - cover * 0.85);
    // чем плотнее облака, тем сильнее размытие и обесцвечивание: вместо жёлтого диска, просвечивающего зеленью сквозь синеву,
    // получается бледное тёплое сияние за облаками
    sun.style.filter = cover > 0.05
      ? `blur(${(cover * 20).toFixed(1)}px) saturate(${(1 - cover * 0.8).toFixed(2)}) brightness(${(1 + cover * 0.35).toFixed(2)})`
      : "none";
    horizon.style.opacity = P.hOp * (1 - cover * 0.75);
    horizon.style.background = P.hBg;
    document.documentElement.style.background = P.html;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", P.html); // цвет системной строки состояния = цвет неба
    // в грозу небо тёмное даже днём — оставляем светлый текст
    const stormy = d && kindOf(d.current.code) === "storm";
    document.body.classList.toggle("day-mode", P.day && !stormy);
    paintFx(phase);
  }

  // =====================================================================
  //  Эффекты: частицы, звук, уведомления
  // =====================================================================
  const reduceMotion = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  function setParticles(kind) {
    const box = $("weatherParticles"); if (!box) return;
    box.innerHTML = "";
    if (reduceMotion) return;
    const type = kind === "rain" || kind === "storm" ? "rain" : kind === "snow" ? "snow" : null;
    if (!type) return;
    const count = type === "rain" ? (kind === "storm" ? 90 : 70) : 35;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < count; i++) {
      const el = document.createElement("div");
      el.className = "particle " + type;
      if (type === "rain") {
        // капли разной «глубины»: дальние короче, тусклее и медленнее
        const near = Math.random() < 0.4;
        el.style.left = (-8 + Math.random() * 118) + "%";
        el.style.height = (near ? 20 + Math.random() * 14 : 10 + Math.random() * 8) + "px";
        el.style.width = near ? "2px" : "1px";
        el.style.opacity = near ? 0.65 : 0.35;
        el.style.animationDuration = (near ? 0.45 + Math.random() * 0.25 : 0.8 + Math.random() * 0.4) + "s";
        el.style.animationDelay = -Math.random() * 2 + "s"; // отрицательная задержка: дождь идёт сразу
      } else {
        el.style.left = Math.random() * 100 + "%";
        el.style.animationDuration = 0.8 + Math.random() * 1.2 + "s";
        el.style.animationDelay = Math.random() * 5 + "s";
        el.style.width = el.style.height = 4 + Math.random() * 5 + "px";
      }
      frag.appendChild(el);
    }
    box.appendChild(frag);
  }

  // =====================================================================
  //  Погодное небо: облака / туман / затемнение / вспышки
  // =====================================================================
  const rnd = (a, b) => a + Math.random() * (b - a);
  const FX_BRIGHT = { dawn: 0.9, day: 1, sunset: 0.85, dusk: 0.5, night: 0.28 };

  // Насколько небо закрыто (прячет солнце, луну и звёзды)
  function coverOf(code) {
    const k = kindOf(code);
    if (k === "clear") return code === 1 ? 0.1 : 0;
    if (k === "clouds") return code === 2 ? 0.35 : 0.85;
    return { fog: 0.9, rain: 0.9, storm: 0.95, snow: 0.85 }[k];
  }

  // Палитры облаков: светлые «шапки», средние тона для объёма и тёмное основание
  const TONES = {
    white: { lite: "255,255,255", mid: "234,240,249", shade: "172,188,210" },
    grey:  { lite: "241,244,250", mid: "207,215,228", shade: "122,135,156" },
    dark:  { lite: "178,186,200", mid: "121,131,149", shade: "50,58,74" }
  };

  // Одно облако = набор мягких радиальных пятен (сверху светлые, снизу тёмные)
  function cloudBackground(tone) {
    const T = TONES[tone] || TONES.white;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    // мягкие эллипсы с длинным затуханием — без резких краёв и «квадратов»
    const blob = (rgb, a, w, h, x, y) => {
      x = clamp(x, w * 0.6, 100 - w * 0.6); y = clamp(y, h * 0.5, 100 - h * 0.5);
      return `radial-gradient(ellipse ${w.toFixed(0)}% ${h.toFixed(0)}% at ${x.toFixed(0)}% ${y.toFixed(0)}%, rgba(${rgb},${a}) 0%, rgba(${rgb},${(a * 0.4).toFixed(2)}) 38%, rgba(${rgb},0) 72%)`;
    };
    const parts = [];
    const tops = 5 + Math.floor(Math.random() * 2);
    for (let i = 0; i < tops; i++) parts.push(blob(T.lite, 0.92, rnd(16, 26), rnd(20, 32), rnd(15, 85), rnd(26, 46)));
    const mids = 3 + Math.floor(Math.random() * 2);
    for (let i = 0; i < mids; i++) parts.push(blob(T.mid, 0.82, rnd(20, 32), rnd(20, 30), rnd(12, 88), rnd(42, 58)));
    const base = 3;
    for (let i = 0; i < base; i++) parts.push(blob(T.shade, 0.72, rnd(20, 30), rnd(16, 24), 18 + i * 28 + rnd(-6, 6), rnd(58, 72)));
    return parts.join(",");
  }

  // =====================================================================
  //  Облака на WebGL: процедурный шум (fbm) с тенями и подсветкой по времени суток.
  //  Если WebGL недоступен, остаются прежние CSS-облака.
  // =====================================================================
  const GLFX = (function () {
    const canvas = $("cloudGL");
    const PHASE = {
      dawn:   { light: [1.0, 0.88, 0.80],  shade: [0.54, 0.56, 0.70] },
      day:    { light: [1.0, 1.0, 1.0],    shade: [0.55, 0.63, 0.77] },
      sunset: { light: [1.0, 0.76, 0.58],  shade: [0.52, 0.45, 0.60] },
      dusk:   { light: [0.62, 0.58, 0.78], shade: [0.28, 0.29, 0.48] },
      night:  { light: [0.34, 0.38, 0.50], shade: [0.11, 0.13, 0.23] }
    };
    const VS = "attribute vec2 a; void main(){ gl_Position = vec4(a, 0.0, 1.0); }";
    const FS = [
      "precision highp float;",
      "uniform vec2 u_res; uniform float u_time; uniform float u_cover; uniform float u_dark;",
      "uniform vec3 u_light; uniform vec3 u_shade;",
      "float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }",
      "float noise(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);",
      "  float a = hash(i), b = hash(i + vec2(1.0, 0.0)), c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));",
      "  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y); }",
      "float fbm3(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 3; i++){ v += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; } return v; }",
      "float fbm4(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++){ v += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; } return v; }",
      "float fbm5(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ v += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; } return v; }",
      "void main(){",
      "  vec2 uv = gl_FragCoord.xy / u_res.y;",
      "  float t = u_time;",
      "  vec2 p = uv * vec2(1.15, 1.55) + vec2(t * 0.010, 0.0);",
      "  vec2 w = vec2(fbm3(p * 0.8 + vec2(0.0, t * 0.010)), fbm3(p * 0.8 + vec2(5.2, 1.3)));",
      "  vec2 q = p + 0.85 * (w - 0.5) + vec2(t * 0.020, 0.0);",
      // крупная форма облаков и тот же слой, сдвинутый в сторону света (для теней)
      "  float f  = fbm5(q);",
      "  float f2 = fbm5(q + vec2(-0.05, 0.07));",
      // мелкая «барашковая» деталь: рваные края и объём
      "  vec2 r = q * 3.6 + vec2(3.1, t * 0.030);",
      "  float det  = fbm4(r);",
      "  float det2 = fbm4(r + vec2(-0.12, 0.17));",
      "  float th = 0.66 - u_cover * 0.50;",
      "  float e = mix(0.030, 0.095, u_cover);",
      "  float d = smoothstep(th - e, th + e * 1.7, f + (det - 0.5) * 0.15);",
      "  float shadow = (f2 - f) * 14.0 + smoothstep(0.45, 0.85, f) * 0.65 + (det2 - det) * 4.6;",
      "  shadow = clamp(shadow, 0.0, 1.0);",
      "  shadow = clamp(shadow * (0.75 + 0.5 * u_dark), 0.0, 1.0);",
      "  vec3 col = mix(u_light, u_shade, shadow);",
      "  col *= 0.86 + 0.28 * det;",
      // светлая кайма по краям облаков
      "  float rim = clamp(d * (1.0 - d) * 4.0, 0.0, 1.0);",
      "  col += u_light * rim * 0.24 * (1.0 - u_dark);",
      "  col *= mix(1.0, 1.0 - 0.30 * u_dark, 1.0 - uv.y);",
      "  float alpha = clamp(d * (0.80 + u_cover * 0.35), 0.0, 1.0);",
      "  gl_FragColor = vec4(col * alpha, alpha);",
      "}"
    ].join("\n");

    let gl = null, ok = null, raf = 0, shown = false, last = 0;
    const loc = {};
    const st = { cover: 0, dark: 0, phase: "day" };
    const T0 = performance.now();

    function init() {
      if (ok !== null) return ok;
      ok = false;
      if (!canvas) return false;
      try {
        gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: true, depth: false, stencil: false, powerPreference: "default" });
        if (!gl) return false;
        const hp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
        if (!hp || hp.precision === 0) return false; // без highp шум даёт артефакты — лучше CSS-облака
        const sh = (type, src) => {
          const x = gl.createShader(type); gl.shaderSource(x, src); gl.compileShader(x);
          if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error("shader");
          return x;
        };
        const prog = gl.createProgram();
        gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
        gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
        gl.bindAttribLocation(prog, 0, "a");
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error("link");
        gl.useProgram(prog);
        gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        ["u_res", "u_time", "u_cover", "u_dark", "u_light", "u_shade"].forEach(n => { loc[n] = gl.getUniformLocation(prog, n); });
        canvas.addEventListener("webglcontextlost", e => {
          e.preventDefault(); ok = false; hide();
          state.fxCode = undefined; updateSky(); // перерисуем CSS-облаками
        });
        ok = true;
      } catch (e) { ok = false; }
      return ok;
    }

    let quality = 1;     // автоподстройка: на слабых телефонах разрешение снижается само
    function resize() {
      // Высокое внутреннее разрешение + CSS-сглаживание — без «квадратиков»
      const h = window.innerHeight || 800, w = window.innerWidth || 400;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const k = Math.min(1.25, 1100 / h) * quality * dpr;
      const cw = Math.max(2, Math.round(w * k)), ch = Math.max(2, Math.round(h * k));
      if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
      gl.viewport(0, 0, cw, ch);
    }

    function draw(now) {
      if (!gl) return;
      const P = PHASE[st.phase] || PHASE.day, d = st.dark;
      const L = P.light.map(v => v * (1 - d * 0.58)), S = P.shade.map(v => v * (1 - d * 0.72));
      gl.uniform2f(loc.u_res, canvas.width, canvas.height);
      gl.uniform1f(loc.u_time, reduceMotion ? 40 : (now - T0) / 1000);
      gl.uniform1f(loc.u_cover, st.cover);
      gl.uniform1f(loc.u_dark, d);
      gl.uniform3f(loc.u_light, L[0], L[1], L[2]);
      gl.uniform3f(loc.u_shade, S[0], S[1], S[2]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    let prevT = 0, slow = 0;
    function loop(now) {
      raf = 0;
      if (!shown || document.hidden) { prevT = 0; return; }
      // если кадры идут реже ~13/с, снижаем разрешение (не дольше, чем до 45%)
      if (prevT) {
        const dtm = now - prevT;
        if (dtm > 90) slow++; else if (slow > 0) slow--;
        // не опускаем ниже 0.75 — иначе появляются пиксельные «квадраты» на фоне
        if (slow > 18 && quality > 0.75) { quality = Math.max(0.75, quality * 0.9); slow = 0; resize(); }
      }
      prevT = now;
      if (now - last >= 40) { last = now; draw(now); } // ~25 кадров/с достаточно для медленных облаков
      raf = requestAnimationFrame(loop);
    }
    function start() { if (!raf && !reduceMotion) raf = requestAnimationFrame(loop); }

    function show(cover, dark) {
      if (!init()) return false;
      st.cover = cover; st.dark = dark;
      resize();
      canvas.classList.add("on");
      shown = true;
      draw(performance.now());
      start();
      return true;
    }
    function hide() {
      shown = false;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      if (canvas) canvas.classList.remove("on");
    }
    function setPhase(name) {
      if (name === st.phase) return;
      st.phase = name;
      if (shown) draw(performance.now());
    }
    window.addEventListener("resize", () => { if (shown) { resize(); draw(performance.now()); } });
    document.addEventListener("visibilitychange", () => { if (!document.hidden && shown) start(); });
    return { show, hide, setPhase, available: init };
  })();

  // Три «глубины» CSS-облаков (запасной вариант без WebGL)
  const DEPTH = [
    { share: 0.28, top: [0, 30],  w: 0.75, op: [0.5, 0.7],   blur: 3, speed: 1.7 },
    { share: 0.44, top: [8, 48],  w: 1,    op: [0.85, 0.97], blur: 0, speed: 1 },
    { share: 0.28, top: [22, 66], w: 1.2,  op: [0.92, 1],    blur: 0, speed: 0.75 }
  ];

  function buildFx(code) {
    const box = $("cloudFx"); if (!box) return;
    box.innerHTML = "";
    const kind = kindOf(code);
    let n = 0, tone = "white", dim = 0, fog = false, flash = false, vig = 0, wMin = 70, wMax = 110, gp = null;
    if (kind === "clouds") {
      if (code === 3) { n = 11; tone = "grey"; dim = 0.4; vig = 0.6; wMin = 110; wMax = 150; gp = [0.9, 0.2]; }
      else { n = 5; wMin = 60; wMax = 95; gp = [0.6, 0]; }
    }
    else if (kind === "clear" && code === 1) { n = 2; wMin = 55; wMax = 80; gp = [0.2, 0]; }
    else if (kind === "rain") { n = 11; tone = "dark"; dim = 0.42; vig = 0.9; wMin = 100; wMax = 140; gp = [1, 0.5]; }
    else if (kind === "storm") { n = 12; tone = "dark"; dim = 0.52; vig = 1; flash = true; wMin = 100; wMax = 145; gp = [1, 0.85]; }
    else if (kind === "snow") { n = 8; tone = "grey"; dim = 0.28; vig = 0.5; wMin = 90; wMax = 125; gp = [0.9, 0.2]; }
    else if (kind === "fog") { fog = true; dim = 0.2; }

    // WebGL-облака вместо CSS-пятен, если получилось
    const useGL = !!gp && GLFX.available() && GLFX.show(gp[0], gp[1]);
    if (!useGL) GLFX.hide();
    if (useGL) { n = 0; dim = 0; }

    const frag = document.createDocumentFragment();
    const add = (cls, css) => { const el = document.createElement("div"); el.className = cls; el.style.cssText = css; frag.appendChild(el); return el; };

    if (dim) add("fx-dim", `background:rgba(92,106,128,${dim})`);

    const windy = kind === "storm" || kind === "rain" ? 0.65 : 1; // в непогоду ветер сильнее
    DEPTH.forEach(L => {
      const cnt = n ? Math.max(1, Math.round(n * L.share)) : 0;
      for (let j = 0; j < cnt; j++) {
        const w = rnd(wMin, wMax) * L.w;
        const dur = rnd(110, 240) * L.speed * windy;
        const delay = -(dur * (j / cnt) + rnd(0, dur / cnt));
        const top = L.top[0] + (j / cnt) * (L.top[1] - L.top[0]) + rnd(-3, 3);
        add("cloud",
          `--w:${w.toFixed(0)}vw;--x:${rnd(-40, 60).toFixed(0)}vw;top:${top.toFixed(1)}%;width:${w.toFixed(0)}vw;height:${(w * 0.46).toFixed(0)}vw;` +
          `opacity:${rnd(L.op[0], L.op[1]).toFixed(2)};background:${cloudBackground(tone)};` +
          (L.blur ? `filter:blur(${L.blur}px);` : "") +
          `animation-duration:${dur.toFixed(0)}s;animation-delay:${delay.toFixed(0)}s`);
      }
    });

    if (vig) add("fx-vignette", `opacity:${vig}`);

    if (fog) {
      add("fx-haze", "");
      for (let i = 0; i < 6; i++) {
        add("fog-band",
          `top:${(4 + i * 15 + rnd(-3, 3)).toFixed(0)}%;height:${rnd(24, 38).toFixed(0)}vh;opacity:${rnd(0.55, 0.9).toFixed(2)};` +
          `animation-duration:${rnd(34, 70).toFixed(0)}s;animation-delay:${(-rnd(0, 60)).toFixed(0)}s;` +
          `animation-direction:${i % 2 ? "alternate" : "alternate-reverse"}`);
      }
    }
    if (flash) add("fx-flash", `animation-duration:${rnd(6, 11).toFixed(1)}s;animation-delay:${(-rnd(0, 6)).toFixed(1)}s`);
    box.appendChild(frag);
  }

  // Вызывается из updateSky: пересобирает слой только при смене погоды, яркость и цвет — при смене времени суток
  function paintFx(phase) {
    const box = $("cloudFx"); if (!box) return;
    const code = state.data ? state.data.current.code : null;
    GLFX.setPhase(phase);
    if (code !== state.fxCode) {
      state.fxCode = code;
      if (code == null) { box.innerHTML = ""; GLFX.hide(); } else buildFx(code);
    }
    box.style.filter = "brightness(" + (FX_BRIGHT[phase] || 1) + ")";
  }

  let audioCtx = null, noiseNode = null;
  const SOUND = { rain: [1200, 0.03], storm: [1200, 0.035], snow: [700, 0.02], fog: [600, 0.015], clouds: [500, 0.015] };
  function stopSound() {
    try { if (noiseNode) noiseNode.stop(); } catch (e) {}
    noiseNode = null;
    if (audioCtx) { try { audioCtx.close(); } catch (e) {} audioCtx = null; }
  }
  function startSound(kind) {
    stopSound();
    if (settings.sound !== "on" || !SOUND[kind] || document.hidden) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AC();
      // Браузеры запускают звук только после касания — возобновим при первом же жесте
      if (audioCtx.state === "suspended") {
        const resume = () => { if (audioCtx) audioCtx.resume(); window.removeEventListener("pointerdown", resume); };
        window.addEventListener("pointerdown", resume, { once: true });
      }
      const size = 2 * audioCtx.sampleRate;
      const buf = audioCtx.createBuffer(1, size, audioCtx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < size; i++) data[i] = Math.random() * 2 - 1;
      noiseNode = audioCtx.createBufferSource();
      noiseNode.buffer = buf; noiseNode.loop = true;
      const filter = audioCtx.createBiquadFilter();
      filter.type = "lowpass"; filter.frequency.value = SOUND[kind][0];
      const gain = audioCtx.createGain(); gain.gain.value = SOUND[kind][1];
      noiseNode.connect(filter); filter.connect(gain); gain.connect(audioCtx.destination);
      noiseNode.start();
    } catch (e) { /* звук не критичен */ }
  }

  // Эффекты запускаются только при смене города/погоды, а не при каждой перерисовке
  // (раньше смена единиц или ★ перезапускала звук и дублировала уведомления)
  function applyEffects(data, city) {
    const kind = kindOf(data.current.code);
    const key = city.lat.toFixed(2) + "," + city.lon.toFixed(2) + "|" + kind;
    if (key === state.effectsKey) return;
    state.effectsKey = key;
    requestAnimationFrame(() => setTimeout(() => { setParticles(kind); startSound(kind); }, 50));
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { stopSound(); return; }
    if (state.data) {
      startSound(kindOf(state.data.current.code));
      updateSky();
      if (Date.now() - state.data.fetchedAt > STALE_MS) refresh(false);
    }
  });

  // --- Уведомления ---
  async function showNotice(title, body, tag) {
    const opts = { body, tag, icon: "icons/icon-192.png", badge: "icons/icon-192.png", lang: settings.lang };
    try {
      // На Android new Notification() не работает — нужен showNotification через Service Worker
      if ("serviceWorker" in navigator) {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) { await reg.showNotification(title, opts); return; }
      }
      new Notification(title, opts);
    } catch (e) { /* нет разрешения/поддержки */ }
  }

  function maybeRainAlert(data) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const now = Date.now() / 1000;
    const soon = data.hourly.find(h => h.dt > now && h.dt - now < 3 * 3600 && (h.pop || 0) >= 50);
    if (!soon) return;
    const slot = data.lat.toFixed(2) + "," + data.lon.toFixed(2) + "@" + soon.dt;
    if (store.get(RAIN_KEY, "") === slot) return; // этот дождь уже анонсировали
    store.set(RAIN_KEY, slot);
    const when = fmtHM(soon.dt, data.tz);
    showNotice(t("Скоро дождь", "Rain soon"),
      t("Вероятность осадков " + soon.pop + "% около " + when, "Chance of precipitation " + soon.pop + "% around " + when), "rain-alert");
  }

  async function enableNotifications() {
    if (!("Notification" in window)) { toast(t("Уведомления не поддерживаются на этом устройстве", "Notifications are not supported on this device")); return; }
    if (Notification.permission === "denied") { toast(t("Уведомления запрещены в настройках браузера", "Notifications are blocked in browser settings")); return; }
    const p = await Notification.requestPermission();
    updateNotifBtn();
    if (p === "granted") { if (state.data) maybeRainAlert(state.data); if (state.data && state.city) render(state.data, state.city, { animate: false }); }
  }
  function updateNotifBtn() {
    const b = $("notifEnableBtn"); if (!b) return;
    if (!("Notification" in window)) { b.textContent = t("Недоступно", "Unavailable"); b.disabled = true; return; }
    if (Notification.permission === "granted") b.textContent = t("Включены ✓", "Enabled ✓");
    else if (Notification.permission === "denied") b.textContent = t("Запрещены", "Blocked");
    else b.textContent = t("Разрешить", "Allow");
  }

  // =====================================================================
  //  Toast
  // =====================================================================
  let toastTimer = null;
  function toast(msg, action) {
    const el = $("toast");
    el.innerHTML = "<span></span>";
    el.firstChild.textContent = msg;
    if (action) {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = action.label;
      b.addEventListener("click", () => { el.classList.remove("show"); action.run(); });
      el.appendChild(b);
    }
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), action ? 12000 : 3500);
  }

  // =====================================================================
  //  Поиск
  // =====================================================================
  const LOCAL_CITIES = [
    { name: "Урюпинск", latitude: 50.8047, longitude: 42.0138, country: "RU", admin1: "Волгоградская область" },
    { name: "Москва", latitude: 55.7558, longitude: 37.6173, country: "RU", admin1: "" },
    { name: "Санкт-Петербург", latitude: 59.9343, longitude: 30.3351, country: "RU", admin1: "" },
    { name: "Волгоград", latitude: 48.7080, longitude: 44.5133, country: "RU", admin1: "" },
    { name: "Саратов", latitude: 51.5336, longitude: 46.0343, country: "RU", admin1: "" },
    { name: "Воронеж", latitude: 51.6720, longitude: 39.1843, country: "RU", admin1: "" },
    { name: "Ростов-на-Дону", latitude: 47.2357, longitude: 39.7015, country: "RU", admin1: "" },
    { name: "Краснодар", latitude: 45.0355, longitude: 38.9753, country: "RU", admin1: "" },
    { name: "Казань", latitude: 55.7961, longitude: 49.1064, country: "RU", admin1: "" },
    { name: "Нижний Новгород", latitude: 56.2965, longitude: 43.9361, country: "RU", admin1: "" },
    { name: "Екатеринбург", latitude: 56.8389, longitude: 60.6057, country: "RU", admin1: "" },
    { name: "Новосибирск", latitude: 55.0084, longitude: 82.9357, country: "RU", admin1: "" },
    { name: "Самара", latitude: 53.1959, longitude: 50.1002, country: "RU", admin1: "" },
    { name: "Уфа", latitude: 54.7388, longitude: 55.9721, country: "RU", admin1: "" },
    { name: "Пермь", latitude: 58.0105, longitude: 56.2502, country: "RU", admin1: "" }
  ];

  async function searchCities(query) {
    const q = query.toLowerCase().trim();
    if (q.length < 2) return [];
    const local = LOCAL_CITIES.filter(c => c.name.toLowerCase().indexOf(q) !== -1);
    const lang = settings.lang === "en" ? "en" : "ru";
    const base = "https://geocoding-api.open-meteo.com/v1/search?name=" + encodeURIComponent(query) + "&language=" + lang;
    const [ru, world] = await Promise.all([
      getJson(base + "&count=6&countryCode=RU", 6000).catch(() => null),
      getJson(base + "&count=5", 6000).catch(() => null)
    ]);
    const map = c => ({ name: c.name, latitude: c.latitude, longitude: c.longitude, country: c.country_code || "", admin1: c.admin1 || "" });
    const all = [].concat(local, ((ru && ru.results) || []).map(map), ((world && world.results) || []).map(map));
    const seen = new Set(), out = [];
    all.forEach(c => {
      const key = c.name.toLowerCase() + "|" + c.latitude.toFixed(1) + "|" + c.longitude.toFixed(1);
      if (!seen.has(key)) { seen.add(key); out.push(c); }
    });
    return out.slice(0, 8);
  }

  function showSuggestions(list, emptyMsg) {
    state.lastResults = list;
    if (!list.length) {
      suggestionsEl.innerHTML = `<div class="suggestion-item empty">${esc(emptyMsg || t("Ничего не найдено", "Nothing found"))}</div>`;
    } else {
      suggestionsEl.innerHTML = list.map((r, i) =>
        `<div class="suggestion-item" role="option" tabindex="0" data-i="${i}">${esc(r.name)}${r.admin1 ? ", " + esc(r.admin1) : ""}${r.country ? ", " + esc(r.country) : ""}</div>`).join("");
    }
    suggestionsEl.classList.add("show");
  }

  function pickResult(r) {
    suggestionsEl.classList.remove("show");
    searchInput.value = "";
    searchInput.blur();
    loadCity({ name: r.name, lat: r.latitude, lon: r.longitude, country: r.country });
  }

  let searchTimer = null, searchSeq = 0;
  async function runSearch(q) {
    const my = ++searchSeq;
    try {
      const res = await searchCities(q);
      if (my !== searchSeq) return null; // пришёл устаревший ответ
      showSuggestions(res);
      return res;
    } catch (e) {
      if (my === searchSeq) showSuggestions([], t("Ошибка поиска", "Search error"));
      return null;
    }
  }

  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const q = searchInput.value.trim();
    if (q.length < 2) { searchSeq++; suggestionsEl.classList.remove("show"); return; }
    searchTimer = setTimeout(() => runSearch(q), 300);
  });
  searchInput.addEventListener("keydown", async e => {
    if (e.key === "Escape") { suggestionsEl.classList.remove("show"); searchInput.blur(); return; }
    if (e.key !== "Enter") return;
    e.preventDefault();
    clearTimeout(searchTimer);
    const q = searchInput.value.trim();
    if (q.length < 2) return;
    const res = state.lastResults.length && suggestionsEl.classList.contains("show") ? state.lastResults : await runSearch(q);
    if (res && res[0]) pickResult(res[0]);
  });
  suggestionsEl.addEventListener("click", e => {
    const it = e.target.closest(".suggestion-item[data-i]");
    if (it) pickResult(state.lastResults[Number(it.dataset.i)]);
  });
  suggestionsEl.addEventListener("keydown", e => {
    if (e.key === "Enter") { const it = e.target.closest(".suggestion-item[data-i]"); if (it) pickResult(state.lastResults[Number(it.dataset.i)]); }
  });
  document.addEventListener("click", e => {
    if (!e.target.closest(".search-box")) suggestionsEl.classList.remove("show");
  });

  // =====================================================================
  //  Геолокация
  // =====================================================================
  locBtn.addEventListener("click", () => {
    if (!navigator.geolocation) { toast(t("Геолокация не поддерживается", "Geolocation is not supported")); return; }
    toast(t("Определяю местоположение…", "Locating…"));
    navigator.geolocation.getCurrentPosition(async pos => {
      const lat = pos.coords.latitude, lon = pos.coords.longitude;
      let name = t("Моё местоположение", "My location"), country = "";
      try {
        const r = await getJson("https://nominatim.openstreetmap.org/reverse?lat=" + lat + "&lon=" + lon +
          "&format=json&zoom=10&accept-language=" + settings.lang, 6000);
        const a = (r && r.address) || {};
        name = a.city || a.town || a.village || a.municipality || a.county || a.state || name;
        country = (a.country_code || "").toUpperCase();
      } catch (e) { /* оставляем «Моё местоположение» */ }
      loadCity({ name, lat, lon, country });
    }, err => {
      const msg = err && err.code === 1
        ? t("Доступ к геолокации запрещён. Разрешите его в настройках браузера.", "Location access denied. Allow it in browser settings.")
        : err && err.code === 3
          ? t("Не удалось определить местоположение вовремя", "Location request timed out")
          : t("Не удалось определить местоположение", "Could not determine location");
      toast(msg);
    }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 5 * 60 * 1000 });
  });

  // =====================================================================
  //  Клики по контенту (делегирование вместо onclick="…" в разметке)
  // =====================================================================
  content.addEventListener("click", e => {
    const el = e.target.closest("[data-act],[data-fav],[data-step],[data-range]");
    if (!el) return;
    if (el.dataset.fav != null) {
      const f = favorites[Number(el.dataset.fav)];
      if (f) loadCity(f);
    } else if (el.dataset.step != null) {
      state.hourStep = Number(el.dataset.step) || 3; updateHourly();
    } else if (el.dataset.range != null) {
      state.dayRange = Number(el.dataset.range) || 7; updateDaily();
    } else if (el.dataset.act === "fav") toggleFavorite();
    else if (el.dataset.act === "retry") loadCity(state.city || DEFAULT_CITY, true);
    else if (el.dataset.act === "notif") enableNotifications();
    else if (el.dataset.act === "refresh") manualRefresh();
  });

  async function manualRefresh() {
    toast(t("Обновляю…", "Refreshing…"));
    if (await refresh(true)) toast(t("Данные обновлены", "Data updated"));
  }

  function toggleFavorite() {
    const c = state.city; if (!c) return;
    const idx = favorites.findIndex(f => Math.abs(f.lat - c.lat) < 0.01 && Math.abs(f.lon - c.lon) < 0.01);
    if (idx >= 0) favorites.splice(idx, 1);
    else {
      if (favorites.length >= 8) { toast(t("Можно сохранить до 8 городов", "You can save up to 8 cities")); return; }
      favorites.push({ name: c.name, lat: c.lat, lon: c.lon });
    }
    saveFavs();
    if (state.data) render(state.data, c, { animate: false });
  }

  // =====================================================================
  //  Настройки
  // =====================================================================
  let settingsOpen = false, historyPushed = false;
  function openSettings() {
    if (settingsOpen) return;
    settingsOpen = true;
    settingsPanel.classList.add("open");
    syncSettingsUI(); updateNotifBtn();
    // чтобы системная кнопка «Назад» закрывала панель, а не выходила из приложения
    try { history.pushState({ settings: 1 }, ""); historyPushed = true; } catch (e) {}
  }
  function closeSettings() {
    if (!settingsOpen) return;
    settingsOpen = false;
    settingsPanel.classList.remove("open");
    if (historyPushed) { historyPushed = false; try { history.back(); } catch (e) {} }
  }
  window.addEventListener("popstate", () => {
    if (settingsOpen) { settingsOpen = false; historyPushed = false; settingsPanel.classList.remove("open"); }
  });

  function syncSettingsUI() {
    document.querySelectorAll(".settings-opt[data-k]").forEach(b => b.classList.toggle("active", settings[b.dataset.k] === b.dataset.v));
  }

  function applyLang() {
    document.documentElement.lang = settings.lang;
    document.querySelectorAll("[data-ru]").forEach(el => { el.textContent = settings.lang === "en" ? el.dataset.en : el.dataset.ru; });
    searchInput.placeholder = t("Поиск города...", "Search city...");
    searchInput.setAttribute("aria-label", t("Поиск города", "Search city"));
    locBtn.setAttribute("aria-label", t("Моё местоположение", "My location"));
    $("settingsBtn").setAttribute("aria-label", t("Настройки", "Settings"));
    $("ptrIndicator").textContent = t("Потяните, чтобы обновить", "Pull to refresh");
    updateNotifBtn();
  }

  $("settingsBtn").addEventListener("click", openSettings);
  $("settingsClose").addEventListener("click", closeSettings);
  settingsPanel.addEventListener("click", e => { if (e.target === settingsPanel) closeSettings(); });
  document.querySelectorAll(".settings-opt[data-k]").forEach(btn => {
    btn.addEventListener("click", () => {
      const k = btn.dataset.k;
      settings[k] = btn.dataset.v;
      saveSettings(); syncSettingsUI();
      if (k === "lang") applyLang();
      if (k === "sound") { if (settings.sound === "off") stopSound(); else if (state.data) startSound(kindOf(state.data.current.code)); }
      if (k === "theme") updateSky();
      if (state.data && state.city) render(state.data, state.city, { animate: false });
    });
  });
  $("notifEnableBtn").addEventListener("click", enableNotifications);

  // Проверка связи: показывает, какой именно источник доступен и за сколько отвечает
  async function runDiagnostics() {
    const out = $("diagOut");
    out.hidden = false;
    out.textContent = t("Проверяю…", "Checking…");
    const lat = state.city ? state.city.lat : 55.75, lon = state.city ? state.city.lon : 37.62;
    const tests = [
      ["Open-Meteo", "https://api.open-meteo.com/v1/forecast?latitude=" + lat + "&longitude=" + lon + "&current=temperature_2m"],
      ["Open-Meteo " + t("воздух", "air"), "https://air-quality-api.open-meteo.com/v1/air-quality?latitude=" + lat + "&longitude=" + lon + "&current=european_aqi"],
      ["Open-Meteo " + t("поиск", "search"), "https://geocoding-api.open-meteo.com/v1/search?name=Moscow&count=1"]
    ];
    if (WX.OWM_KEY) tests.push(["OpenWeatherMap", "https://api.openweathermap.org/data/2.5/weather?lat=" + lat + "&lon=" + lon + "&appid=" + WX.OWM_KEY + "&units=metric"]);
    const ms = t("мс", "ms");
    const lines = await Promise.all(tests.map(async ([name, url]) => {
      const t0 = performance.now();
      try { await getJson(url, 10000); return "✓ " + name + " — " + Math.round(performance.now() - t0) + " " + ms; }
      catch (e) { return "✗ " + name + " — " + reasonOf(e) + " (" + Math.round(performance.now() - t0) + " " + ms + ")"; }
    }));
    out.textContent = lines.join("\n") + "\n" + t("Браузер сообщает: ", "Browser reports: ") + (navigator.onLine === false ? t("нет сети", "offline") : t("сеть есть", "online"));
  }
  $("diagBtn").addEventListener("click", runDiagnostics);

  // --- Установка приложения ---
  let installEvent = null;
  const isStandalone = () => (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
  window.addEventListener("beforeinstallprompt", e => {
    e.preventDefault(); installEvent = e;
    if (!isStandalone()) $("installRow").hidden = false;
  });
  $("installBtn").addEventListener("click", async () => {
    if (!installEvent) return;
    installEvent.prompt();
    try { await installEvent.userChoice; } catch (e) {}
    installEvent = null; $("installRow").hidden = true;
  });
  window.addEventListener("appinstalled", () => { $("installRow").hidden = true; toast(t("Приложение установлено", "App installed")); });
  if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !isStandalone()) $("iosHint").hidden = false;

  // =====================================================================
  //  Жесты: pull-to-refresh и скрытие шапки при прокрутке
  // =====================================================================
  (function setupPTR() {
    const ind = $("ptrIndicator");
    let startY = 0, startX = 0, active = false, dy = 0, busy = false;
    const hide = () => ind.classList.remove("show");
    window.addEventListener("touchstart", e => {
      if (busy || settingsOpen || window.scrollY > 0 || e.touches.length !== 1) return;
      startY = e.touches[0].clientY; startX = e.touches[0].clientX; active = true; dy = 0;
    }, { passive: true });
    window.addEventListener("touchmove", e => {
      if (!active) return;
      dy = e.touches[0].clientY - startY;
      if (Math.abs(e.touches[0].clientX - startX) > Math.abs(dy)) { active = false; hide(); return; } // горизонтальный свайп — не наш
      if (dy > 50) {
        ind.textContent = dy > 90 ? t("Отпустите для обновления", "Release to refresh") : t("Потяните, чтобы обновить", "Pull to refresh");
        ind.classList.add("show");
      } else hide();
    }, { passive: true });
    window.addEventListener("touchend", async () => {
      if (!active) return;
      active = false;
      if (dy > 90 && state.city) {
        busy = true;
        ind.textContent = t("Обновление…", "Refreshing…"); ind.classList.add("show");
        await refresh(true);   // force: игнорируем 5-минутный кэш (раньше «потянуть» ничего не делало)
        busy = false;
      }
      hide(); dy = 0;
    });
    window.addEventListener("touchcancel", () => { active = false; hide(); });
  })();

  (function setupHeaderScroll() {
    const header = $("header");
    let lastY = window.scrollY || 0, ticking = false;
    window.addEventListener("scroll", () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const y = window.scrollY || 0;
        const keep = suggestionsEl.classList.contains("show") || document.activeElement === searchInput;
        if (keep || y <= lastY || y <= 60) header.classList.remove("header-hidden");
        else header.classList.add("header-hidden");
        lastY = y; ticking = false;
      });
    }, { passive: true });
  })();

  // =====================================================================
  //  Таймеры, сеть, Service Worker
  // =====================================================================
  setInterval(updateSky, 60 * 1000);
  setInterval(() => {
    const off = curOffset();
    const c = $("liveClock"); if (c) c.textContent = fmtHM(Date.now() / 1000, off);
    const u = $("updatedLabel"); if (u && state.data) u.textContent = t("обновлено ", "updated ") + agoText(state.data.fetchedAt);
  }, 30 * 1000);

  window.addEventListener("online", () => { if (state.city) refresh(true); });
  // пока приложение открыто, данные сами обновляются раз в 10 минут
  setInterval(() => {
    if (!document.hidden && state.data && Date.now() - state.data.fetchedAt > 10 * 60 * 1000) refresh(false);
  }, 60 * 1000);

  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController || reloading) return; // первая установка — перезагрузка не нужна
      reloading = true; location.reload();
    });
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").then(reg => {
        const offer = worker => toast(t("Доступна новая версия", "A new version is available"), {
          label: t("Обновить", "Update"), run: () => worker.postMessage({ type: "SKIP_WAITING" })
        });
        if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
        reg.addEventListener("updatefound", () => {
          const w = reg.installing;
          if (w) w.addEventListener("statechange", () => { if (w.state === "installed" && navigator.serviceWorker.controller) offer(w); });
        });
      }).catch(() => {});
    });
  }

  // =====================================================================
  //  Старт: последний открытый город (а не всегда Урюпинск)
  // =====================================================================
  applyLang();
  syncSettingsUI();
  updateSky();
  loadCity(store.get(LAST_KEY, DEFAULT_CITY));

})();
