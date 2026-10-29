/* ============================================================
   晴雨 · 天气 Web 应用
   ------------------------------------------------------------
   纯原生 HTML / CSS / JS，没有框架、没有构建步骤。
   数据来源：和风天气 QWeather（新版 API，使用专属 API Host）
   认证方式：每个请求的请求头带上 X-QW-Api-Key

   和风天气返回的 code === "200" 才代表成功，其余都是错误码。
   文档：https://dev.qweather.com/docs/api/
   ============================================================ */

(() => {
  'use strict';

  /* ==========================================================
     1. 配置区：换 Key / 换默认城市只改这里
     ========================================================== */
  const CONFIG = {
    host: 'ng36xawmx7.re.qweatherapi.com', // 不要在结尾加斜杠
    apiKey: 'bd6726f1e0134ef685b00d01268f3fac',
    lang: 'zh',   // 返回中文
    unit: 'm',    // m = 摄氏度 / 公里
  };

  const BASE_URL = `https://${CONFIG.host}`;
  const STORAGE_KEY = 'qingyu:last-city';

  // 第一次打开、本地又没有缓存城市时，先显示北京
  const DEFAULT_CITY = {
    id: '101010100',
    name: '北京',
    adm1: '北京市',
    adm2: '北京',
    country: '中国',
  };

  /* ==========================================================
     2. 通用小工具
     ========================================================== */
  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, '0');

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value;
  }

  function setHTML(id, html) {
    const el = $(id);
    if (el) el.innerHTML = html;
  }

  const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  /** "2026-10-28T14:32+08:00" -> "14:32"
   *  直接截取字符串里的时间，避免被浏览器转成本机时区（查国外城市时会差几个小时） */
  function hhmm(iso) {
    if (!iso) return '--:--';
    const matched = String(iso).match(/T(\d{2}):(\d{2})/);
    if (matched) return `${matched[1]}:${matched[2]}`;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '--:--';
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /** "05:48" -> 348（分钟），方便比较大小 */
  function toMinutes(str) {
    if (!str || !/^\d{1,2}:\d{2}$/.test(str)) return null;
    const [h, m] = str.split(':').map(Number);
    return h * 60 + m;
  }

  /** iOS/Safari 对 "2026-10-28" 的解析不稳定，换成斜杠 */
  function parseDate(str) {
    return new Date(String(str).replace(/-/g, '/'));
  }

  /** 今天 / 明天 / 后天 / 周三 */
  function dayLabel(dateStr, index) {
    if (index === 0) return '今天';
    if (index === 1) return '明天';
    if (index === 2) return '后天';
    const d = parseDate(dateStr);
    return Number.isNaN(d.getTime()) ? '—' : WEEK[d.getDay()];
  }

  /** "2026-10-28" -> "10/28" */
  function mmdd(dateStr) {
    const parts = String(dateStr).split('-');
    return `${Number(parts[1])}/${Number(parts[2])}`;
  }

  /* ==========================================================
     3. 网络请求
     ========================================================== */
  // 常见错误码翻译成人话
  const ERROR_TEXT = {
    '204': '查不到这个城市的数据，换个关键词试试',
    '400': '请求参数有误',
    '401': 'API Key 认证失败，请检查 Key 是否填写正确',
    '402': '账号超出调用额度或余额不足',
    '403': '当前 Key 没有访问该数据的权限',
    '404': '查询的数据不存在',
    '429': '请求太频繁了，休息一会儿再试',
    '500': '和风天气服务器开小差了，请稍后重试',
  };

  /**
   * 统一请求方法
   * @param {string} path   例如 '/v7/weather/now'
   * @param {object} params 查询参数
   */
  async function request(path, params = {}) {
    const url = new URL(BASE_URL + path);
    url.searchParams.set('lang', CONFIG.lang);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, value);
      }
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);

    let response;
    try {
      response = await fetch(url.toString(), {
        // 新版 API 的认证方式：请求头带 Key
        headers: { 'X-QW-Api-Key': CONFIG.apiKey },
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('请求超时，请检查网络后重试');
      throw new Error('网络连接失败：请检查网络，或确认该 Host 允许浏览器跨域访问');
    } finally {
      clearTimeout(timer);
    }

    let data = null;
    try {
      data = await response.json();
    } catch (err) {
      // 有些错误直接返回 HTML，这里兜底
      data = null;
    }

    const code = data && data.code !== undefined ? String(data.code) : String(response.status);
    if (!response.ok || !data || code !== '200') {
      throw new Error(ERROR_TEXT[code] || `请求失败（HTTP ${response.status} / code ${code}）`);
    }
    return data;
  }

  /* ==========================================================
     4. 应用状态
     ========================================================== */
  const state = {
    city: null,   // 当前城市
    now: null,    // 实况
    daily: [],    // 7 天预报（自带日出日落、降水量字段）
    loading: false,
  };

  /* ==========================================================
     5. 天气图标：根据和风图标代码画 SVG
     图标代码表：https://dev.qweather.com/docs/resource/icons/
     ========================================================== */

  // 24x24 网格上的云朵路径
  const CLOUD_PATH = 'M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z';

  const cloud = (transform = '') =>
    `<path class="cloud" d="${CLOUD_PATH}" transform="${transform}" />`;

  // 太阳的 8 条光线（整体会缓慢自转）
  const SUN_RAYS = `
    <g class="rays" stroke="var(--w-sun)" stroke-width="1.4" stroke-linecap="round">
      <path d="M12 1.8v2.2M12 20v2.2M1.8 12h2.2M20 12h2.2M4.8 4.8l1.6 1.6M17.6 17.6l1.6 1.6M19.2 4.8l-1.6 1.6M6.4 17.6l-1.6 1.6" />
    </g>`;

  /** 图标代码 -> 图形类型 */
  function glyphKind(code) {
    const n = Number(code);
    if (n === 100) return 'sun';                         // 晴（白天）
    if (n === 150) return 'moon';                         // 晴（夜间）
    if (n === 104) return 'cloud';                        // 阴
    if (n >= 302 && n <= 304) return 'storm';             // 雷阵雨
    if (n >= 300 && n <= 399) return 'rain';              // 各类降雨
    if (n >= 400 && n <= 499) return 'snow';              // 各类降雪
    if (n >= 500 && n <= 515) return 'fog';               // 雾 / 霾
    if (n >= 151 && n <= 153) return 'moon-cloud';        // 夜间多云
    if (n >= 101 && n <= 103) return 'sun-cloud';         // 多云
    if (n === 900 || n === 901) return 'sun';             // 炎热 / 寒冷
    return 'sun';
  }

  /** 生成内联 SVG 天气图标 */
  function weatherIcon(code) {
    const kind = glyphKind(code);
    let body = '';

    if (kind === 'sun') {
      body = `
        <circle cx="12" cy="12" r="7.2" fill="var(--w-sun)" opacity=".18" />
        ${SUN_RAYS}
        <circle cx="12" cy="12" r="4.3" fill="var(--w-sun)" />`;
    }

    if (kind === 'moon') {
      body = `
        <circle cx="13" cy="12" r="8" fill="var(--w-moon)" opacity=".14" />
        <path d="M12.5 3.4a6.2 6.2 0 0 0 8.1 8.1 9.2 9.2 0 1 1-8.1-8.1Z" fill="var(--w-moon)" />
        <circle cx="19" cy="5.2" r=".9" fill="var(--w-moon)" />
        <circle cx="6.4" cy="6.6" r=".7" fill="var(--w-moon)" opacity=".8" />`;
    }

    if (kind === 'sun-cloud') {
      body = `
        <circle cx="16.6" cy="6.6" r="5.2" fill="var(--w-sun)" opacity=".16" />
        <g stroke="var(--w-sun)" stroke-width="1.2" stroke-linecap="round">
          <path d="M16.6 .8v1.5M23.4 6.6h-1.5M21.9 1.3l-1.1 1.1M21.9 11.9l-1.1-1.1M11.3 1.3l1.1 1.1" />
        </g>
        <circle cx="16.6" cy="6.6" r="3.1" fill="var(--w-sun)" />
        ${cloud('translate(-1.4 3.6) scale(0.82)')}`;
    }

    if (kind === 'moon-cloud') {
      body = `
        <path d="M17.4 3a5 5 0 0 0 6.9 6.9A6.4 6.4 0 1 1 17.4 3Z" fill="var(--w-moon)" opacity=".9" />
        ${cloud('translate(-1.4 3.6) scale(0.82)')}`;
    }

    if (kind === 'cloud') {
      body = cloud();
    }

    if (kind === 'rain') {
      body = `
        ${cloud('translate(0 -1.8)')}
        <g stroke="var(--w-rain)" stroke-width="1.5" stroke-linecap="round">
          <path class="drop" d="M8.6 18.4l-1 2.6" />
          <path class="drop" style="animation-delay:.3s" d="M12.4 18.4l-1 2.6" />
          <path class="drop" style="animation-delay:.6s" d="M16.2 18.4l-1 2.6" />
        </g>`;
    }

    if (kind === 'storm') {
      body = `
        ${cloud('translate(0 -2.6)')}
        <path class="bolt" d="M12.9 15.6l-2.6 4.1h3l-1.2 3.6" stroke="var(--w-sun)"
              stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />`;
    }

    if (kind === 'snow') {
      body = `
        ${cloud('translate(0 -2.4)')}
        <g class="flakes" fill="var(--w-snow)">
          <circle cx="8.4" cy="19.8" r="1" />
          <circle cx="12.2" cy="21.4" r="1" />
          <circle cx="16" cy="19.8" r="1" />
        </g>`;
    }

    if (kind === 'fog') {
      body = `
        ${cloud('translate(0 -3)')}
        <g class="mist" stroke="var(--w-rain)" stroke-width="1.4" stroke-linecap="round">
          <path d="M5 18.4h14" />
          <path d="M7.6 21.6h8.8" />
        </g>`;
    }

    return `<svg class="wicon" viewBox="0 0 24 24" fill="none" aria-hidden="true">${body}</svg>`;
  }

  /* ==========================================================
     6. 主题：按天气切换配色（晴天暖黄 / 雨天蓝调）
     ========================================================== */
  function pickTheme(icon, isNight) {
    const n = Number(icon);

    if (n === 302 || n === 303 || n === 304) return 'storm';
    if (n >= 300 && n <= 399) return 'rain';
    if (n >= 400 && n <= 499) return 'snow';
    if (n >= 500 && n <= 515) return 'fog';
    if (n === 104) return 'overcast';
    if ([101, 102, 103, 151, 152, 153].includes(n)) return isNight ? 'night' : 'cloudy';
    return isNight ? 'night' : 'sunny';
  }

  /** 根据今天的日出日落判断现在是不是夜里 */
  function isNightNow() {
    const today = state.daily[0] || {};
    const rise = toMinutes(today.sunrise);
    const set = toMinutes(today.sunset);
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    if (rise !== null && set !== null) return minutes < rise || minutes > set;
    return minutes < 360 || minutes >= 1140; // 兜底：6 点前 / 19 点后
  }

  function applyTheme(name) {
    if (document.body.dataset.theme === name) return;
    document.body.dataset.theme = name;
  }

  /* ==========================================================
     7. 渲染
     ========================================================== */
  function renderAll() {
    const now = state.now;
    if (!now) return;

    applyTheme(pickTheme(now.icon, isNightNow()));
    renderHero();
    renderSun();
    renderRain();
    renderForecast();
  }

  function renderHero() {
    const { now, city, daily } = state;
    const today = daily[0] || {};

    const place = [city.country, city.adm1].filter(Boolean).join(' · ');

    setText('cityName', city.name);
    setText('cityMeta', `${place} · 更新于 ${hhmm(now.obsTime)}`);
    setText('temp', Math.round(Number(now.temp)));
    setText('tempText', now.text || '—');
    setText('feelsLike', `体感 ${Math.round(Number(now.feelsLike))}°`);
    setText('todayRange', `${today.tempMax ?? '--'}° / ${today.tempMin ?? '--'}°`);
    setHTML('heroIcon', weatherIcon(now.icon));

    setText('humidity', `${now.humidity}%`);
    setText('wind', `${now.windDir || ''} ${now.windScale || '-'} 级`.trim());
    setText('pressure', `${now.pressure} hPa`);
    setText('visibility', `${now.vis} km`);
  }

  /** 弧线是二次贝塞尔曲线，按 t 求点坐标 */
  const ARC = {
    p0: { x: 20, y: 108 },
    p1: { x: 150, y: -14 },
    p2: { x: 280, y: 108 },
  };

  function arcPoint(t) {
    const k = 1 - t;
    return {
      x: k * k * ARC.p0.x + 2 * k * t * ARC.p1.x + t * t * ARC.p2.x,
      y: k * k * ARC.p0.y + 2 * k * t * ARC.p1.y + t * t * ARC.p2.y,
    };
  }

  function renderSun() {
    // 7 天预报的第一天自带 sunrise / sunset，无需再调天文接口
    const today = state.daily[0] || {};
    const sunrise = today.sunrise || '';
    const sunset = today.sunset || '';

    setText('sunrise', sunrise || '--:--');
    setText('sunset', sunset || '--:--');

    const riseMinutes = toMinutes(sunrise);
    const setMinutes = toMinutes(sunset);
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    setText('sunNow', `${pad(now.getHours())}:${pad(now.getMinutes())}`);

    if (riseMinutes === null || setMinutes === null || setMinutes <= riseMinutes) {
      setText('dayLength', '昼长 --');
      return;
    }

    const dayLength = setMinutes - riseMinutes;
    setText('dayLength', `昼长 ${Math.floor(dayLength / 60)} 小时 ${dayLength % 60} 分`);

    // 当前时间在“日出->日落”之间的进度，0 = 刚日出，1 = 已日落
    let progress = (nowMinutes - riseMinutes) / dayLength;
    progress = Math.min(Math.max(progress, 0), 1);

    const point = arcPoint(progress);
    // 太阳组初始画在 (20,108)，整体平移即可
    $('sunGroup').setAttribute(
      'transform',
      `translate(${(point.x - 20).toFixed(2)} ${(point.y - 108).toFixed(2)})`
    );
    // pathLength="1"，所以 dashoffset 从 1 减到 0 就是“走完”比例
    $('arcProgress').style.strokeDashoffset = String(1 - progress);
  }

  /** 判断某天是否可能下雨/下雪 */
  function isWet(day) {
    const text = `${day.textDay || ''}${day.textNight || ''}`;
    return /雨|雷|雪|冰雹/.test(text) || Number(day.precip) > 0;
  }

  function renderRain() {
    const card = $('rainCard');
    const daily = state.daily || [];
    const now = state.now || {};

    // 未来 7 天里所有可能下雨/下雪的日子
    const wetDays = daily
      .map((day, index) => ({ day, index }))
      .filter(({ day }) => isWet(day));

    const tags = [];
    let main = '';
    let sub = '';
    let raining = false;

    if (Number(now.precip) > 0) {
      // 1) 此刻正在下雨，最优先
      main = '正在下雨，出门记得带伞';
      sub = `当前降水 ${now.precip} mm · 湿度 ${now.humidity}%`;
      raining = true;
    } else if (wetDays.length) {
      // 2) 未来几天里有雨雪
      const { day, index } = wetDays[0];
      main = `${dayLabel(day.fxDate, index)}有${day.textDay}，记得带把伞`;
      sub = `${mmdd(day.fxDate)} · 最高 ${day.tempMax}° / 最低 ${day.tempMin}°`;
      raining = true;
      if (Number(day.precip) > 0) tags.push(`预计降水 ${day.precip} mm`);
    } else {
      // 3) 一周都挺干爽
      main = '未来 7 天没有明显降雨';
      sub = '天气比较稳定，放心安排出行';
    }

    if (now.humidity) tags.push(`湿度 ${now.humidity}%`);
    if (now.vis) tags.push(`能见度 ${now.vis} km`);

    setText('rainText', main);
    setText('rainSub', sub);
    setHTML('rainTags', tags.map((t) => `<span class="chip">${t}</span>`).join(''));
    card.classList.toggle('is-rain', raining);
    card.classList.toggle('is-calm', !raining);
  }

  function renderForecast() {
    const daily = state.daily || [];
    if (!daily.length) return;

    const lows = daily.map((d) => Number(d.tempMin));
    const highs = daily.map((d) => Number(d.tempMax));
    const min = Math.min(...lows);
    const max = Math.max(...highs);
    const span = Math.max(max - min, 1); // 防止除以 0

    const html = daily.map((day, index) => {
      const lowPct = ((Number(day.tempMin) - min) / span) * 100;
      const widthPct = Math.max(((Number(day.tempMax) - Number(day.tempMin)) / span) * 100, 8);
      const precip = Number(day.precip) > 0 ? ` · ${day.precip}mm` : '';

      return `
        <li class="fc-row" style="--i:${index}">
          <div class="fc-day">
            <strong>${dayLabel(day.fxDate, index)}</strong>
            <span>${mmdd(day.fxDate)}</span>
          </div>
          <div class="fc-icon">${weatherIcon(day.iconDay)}</div>
          <div class="fc-text">${day.textDay}${precip}</div>
          <div class="fc-bar">
            <span class="bar-fill" style="left:${lowPct.toFixed(1)}%;width:${widthPct.toFixed(1)}%"></span>
          </div>
          <div class="fc-temp">
            <span class="hi">${day.tempMax}°</span>
            <span class="lo">${day.tempMin}°</span>
          </div>
        </li>`;
    }).join('');

    setHTML('forecastList', html);
  }

  /* ==========================================================
     8. 数据加载
     ========================================================== */
  function setLoading(on) {
    state.loading = on;
    document.body.classList.toggle('is-loading', on);
  }

  let toastTimer = null;
  function showToast(message) {
    const toast = $('toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 4000);
  }

  /**
   * 拉取一个城市的所有天气数据
   * 实况和 7 天预报是必需的，日出日落 / 预警 / 分钟级降水失败也不影响页面
   */
  async function loadWeather(city) {
    setLoading(true);
    // 先把城市名显示出来，减少等待时的空白感
    setText('cityName', city.name);
    setText('cityMeta', '正在获取天气数据…');

    try {
      const location = city.id; // 用 LocationID 查询最准确，也可以传 "经度,纬度"

      // 实况 + 7 天预报：7 天预报里已经包含日出日落、降水量、湿度等字段
      const [nowRes, dailyRes] = await Promise.all([
        request('/v7/weather/now', { location, unit: CONFIG.unit }),
        request('/v7/weather/7d', { location, unit: CONFIG.unit }),
      ]);

      state.city = city;
      state.now = nowRes.now;
      state.daily = dailyRes.daily || [];

      renderAll();
    } catch (err) {
      console.error('[loadWeather]', err);
      showToast(err.message);
      setText('cityMeta', err.message);
    } finally {
      setLoading(false);
    }
  }

  /* ==========================================================
     9. 城市搜索
     ----------------------------------------------------------
     内置 324 个中国地级市（数据取自和风天气官方城市列表），
     格式：[LocationID, 城市名, 省份, 英文/拼音]
     这样即使 API Key 没有开通 GeoAPI，搜索也照样能用；
     本地匹配不到时，再尝试调用 GeoAPI 补国外城市（没权限会自动跳过）。
     ========================================================== */
  const CITY_DATA = [
    ["101010100", "北京", "北京市", "Beijing"],
    ["101020100", "上海", "上海市", "Shanghai"],
    ["101030100", "天津", "天津市", "Tianjin"],
    ["101040100", "重庆", "重庆市", "Chongqing"],
    ["101050101", "哈尔滨", "黑龙江省", "Harbin"],
    ["101050201", "齐齐哈尔", "黑龙江省", "Qiqihar"],
    ["101050301", "牡丹江", "黑龙江省", "Mudanjiang"],
    ["101050401", "佳木斯", "黑龙江省", "Jiamusi"],
    ["101050501", "绥化", "黑龙江省", "Suihua"],
    ["101050601", "黑河", "黑龙江省", "Heihe"],
    ["101050801", "伊春", "黑龙江省", "Yichun"],
    ["101050901", "大庆", "黑龙江省", "Daqing"],
    ["101051002", "七台河", "黑龙江省", "Qitaihe"],
    ["101051101", "鸡西", "黑龙江省", "Jixi"],
    ["101051201", "鹤岗", "黑龙江省", "Hegang"],
    ["101051301", "双鸭山", "黑龙江省", "Shuangyashan"],
    ["101060101", "长春", "吉林省", "Changchun"],
    ["101060201", "吉林", "吉林省", "Jilin"],
    ["101060401", "四平", "吉林省", "Siping"],
    ["101060501", "通化", "吉林省", "Tonghua"],
    ["101060601", "白城", "吉林省", "Baicheng"],
    ["101060701", "辽源", "吉林省", "Liaoyuan"],
    ["101060801", "松原", "吉林省", "Songyuan"],
    ["101060901", "白山", "吉林省", "Baishan"],
    ["101070101", "沈阳", "辽宁省", "Shenyang"],
    ["101070201", "大连", "辽宁省", "Dalian"],
    ["101070301", "鞍山", "辽宁省", "Anshan"],
    ["101070401", "抚顺", "辽宁省", "Fushun"],
    ["101070501", "本溪", "辽宁省", "Benxi"],
    ["101070601", "丹东", "辽宁省", "Dandong"],
    ["101070701", "锦州", "辽宁省", "Jinzhou"],
    ["101070801", "营口", "辽宁省", "Yingkou"],
    ["101070901", "阜新", "辽宁省", "Fuxin"],
    ["101071001", "辽阳", "辽宁省", "Liaoyang"],
    ["101071101", "铁岭", "辽宁省", "Tieling"],
    ["101071201", "朝阳", "辽宁省", "Chaoyang"],
    ["101071301", "盘锦", "辽宁省", "Panjin"],
    ["101071401", "葫芦岛", "辽宁省", "Huludao"],
    ["101080101", "呼和浩特", "内蒙古自治区", "Hohhot"],
    ["101080201", "包头", "内蒙古自治区", "Baotou"],
    ["101080301", "乌海", "内蒙古自治区", "Wuhai"],
    ["101080405", "乌兰察布", "内蒙古自治区", "Ulanqab"],
    ["101080501", "通辽", "内蒙古自治区", "Tongliao"],
    ["101080601", "赤峰", "内蒙古自治区", "Chifeng"],
    ["101080701", "鄂尔多斯", "内蒙古自治区", "Ordos"],
    ["101080811", "巴彦淖尔", "内蒙古自治区", "Bayannur"],
    ["101081013", "呼伦贝尔", "内蒙古自治区", "Hulunbuir"],
    ["101081108", "兴安盟", "内蒙古自治区", "Hinggan League"],
    ["101081213", "阿拉善盟", "内蒙古自治区", "Alxa League"],
    ["101090101", "石家庄", "河北省", "Shijiazhuang"],
    ["101090201", "保定", "河北省", "Baoding"],
    ["101090301", "张家口", "河北省", "Zhangjiakou"],
    ["101090402", "承德", "河北省", "Chengde"],
    ["101090501", "唐山", "河北省", "Tangshan"],
    ["101090601", "廊坊", "河北省", "Langfang"],
    ["101090701", "沧州", "河北省", "Cangzhou"],
    ["101090801", "衡水", "河北省", "Hengshui"],
    ["101090901", "邢台", "河北省", "Xingtai"],
    ["101091001", "邯郸", "河北省", "Handan"],
    ["101091101", "秦皇岛", "河北省", "Qinhuangdao"],
    ["101091201", "雄安新区", "河北省", "Xiong'an"],
    ["101100101", "太原", "山西省", "Taiyuan"],
    ["101100201", "大同", "山西省", "Datong"],
    ["101100301", "阳泉", "山西省", "Yangquan"],
    ["101100401", "晋中", "山西省", "Jinzhong"],
    ["101100501", "长治", "山西省", "Changzhi"],
    ["101100601", "晋城", "山西省", "Jincheng"],
    ["101100701", "临汾", "山西省", "Linfen"],
    ["101100801", "运城", "山西省", "Yuncheng"],
    ["101100901", "朔州", "山西省", "Shuozhou"],
    ["101101001", "忻州", "山西省", "Xinzhou"],
    ["101101100", "吕梁", "山西省", "Lyuliang"],
    ["101110101", "西安", "陕西省", "Xi'an"],
    ["101110200", "咸阳", "陕西省", "Xianyang"],
    ["101110300", "延安", "陕西省", "Yan'an"],
    ["101110401", "榆林", "陕西省", "Yulin"],
    ["101110501", "渭南", "陕西省", "Weinan"],
    ["101110601", "商洛", "陕西省", "Shangluo"],
    ["101110701", "安康", "陕西省", "Ankang"],
    ["101110801", "汉中", "陕西省", "Hanzhong"],
    ["101110901", "宝鸡", "陕西省", "Baoji"],
    ["101111001", "铜川", "陕西省", "Tongchuan"],
    ["101120101", "济南", "山东省", "Jinan"],
    ["101120201", "青岛", "山东省", "Qingdao"],
    ["101120301", "淄博", "山东省", "Zibo"],
    ["101120401", "德州", "山东省", "Dezhou"],
    ["101120501", "烟台", "山东省", "Yantai"],
    ["101120601", "潍坊", "山东省", "Weifang"],
    ["101120701", "济宁", "山东省", "Jining"],
    ["101120801", "泰安", "山东省", "Tai'an"],
    ["101120901", "临沂", "山东省", "Linyi"],
    ["101121001", "菏泽", "山东省", "Heze"],
    ["101121101", "滨州", "山东省", "Binzhou"],
    ["101121201", "东营", "山东省", "Dongying"],
    ["101121301", "威海", "山东省", "Weihai"],
    ["101121401", "枣庄", "山东省", "Zaozhuang"],
    ["101121501", "日照", "山东省", "Rizhao"],
    ["101121701", "聊城", "山东省", "Liaocheng"],
    ["101130101", "乌鲁木齐", "新疆维吾尔自治区", "Urumqi"],
    ["101130201", "克拉玛依", "新疆维吾尔自治区", "Karamay"],
    ["101130301", "石河子", "新疆维吾尔自治区", "Shihezi"],
    ["101130501", "吐鲁番", "新疆维吾尔自治区", "Turpan"],
    ["101130701", "阿拉尔", "新疆维吾尔自治区", "Aral"],
    ["101130901", "喀什地区", "新疆维吾尔自治区", "Kashgar Prefecture"],
    ["101131101", "塔城地区", "新疆维吾尔自治区", "Tacheng Prefecture"],
    ["101131201", "哈密", "新疆维吾尔自治区", "Hami"],
    ["101131301", "和田地区", "新疆维吾尔自治区", "Hotan Prefecture"],
    ["101131401", "阿勒泰地区", "新疆维吾尔自治区", "Altay Prefecture"],
    ["101131701", "图木舒克", "新疆维吾尔自治区", "Tumxuk"],
    ["101131801", "五家渠", "新疆维吾尔自治区", "Wujiaqu"],
    ["101131901", "铁门关", "新疆维吾尔自治区", "Tiemenguan"],
    ["101131920", "昆玉", "新疆维吾尔自治区", "Kunyu"],
    ["101132101", "北屯", "新疆维吾尔自治区", "Beitun"],
    ["101132201", "双河", "新疆维吾尔自治区", "Shuanghe"],
    ["101132301", "可克达拉", "新疆维吾尔自治区", "Kokdala"],
    ["101132401", "胡杨河", "新疆维吾尔自治区", "Huyanghe"],
    ["101140101", "拉萨", "西藏自治区", "Lhasa"],
    ["101140201", "日喀则", "西藏自治区", "Xigazê"],
    ["101140301", "山南", "西藏自治区", "Shannan"],
    ["101140401", "林芝", "西藏自治区", "Nyingchi"],
    ["101140501", "昌都", "西藏自治区", "Qamdo"],
    ["101140601", "那曲", "西藏自治区", "Nagqu"],
    ["101140701", "阿里地区", "西藏自治区", "Ngari Prefecture"],
    ["101150101", "西宁", "青海省", "Xining"],
    ["101150207", "海东", "青海省", "Haidong"],
    ["101160101", "兰州", "甘肃省", "Lanzhou"],
    ["101160201", "定西", "甘肃省", "Dingxi"],
    ["101160301", "平凉", "甘肃省", "Pingliang"],
    ["101160401", "庆阳", "甘肃省", "Qingyang"],
    ["101160501", "武威", "甘肃省", "Wuwei"],
    ["101160601", "金昌", "甘肃省", "Jinchang"],
    ["101160701", "张掖", "甘肃省", "Zhangye"],
    ["101160801", "酒泉", "甘肃省", "Jiuquan"],
    ["101160901", "天水", "甘肃省", "Tianshui"],
    ["101161010", "陇南", "甘肃省", "Longnan"],
    ["101161301", "白银", "甘肃省", "Baiyin"],
    ["101161401", "嘉峪关", "甘肃省", "Jiayuguan"],
    ["101170101", "银川", "宁夏回族自治区", "Yinchuan"],
    ["101170201", "石嘴山", "宁夏回族自治区", "Shizuishan"],
    ["101170301", "吴忠", "宁夏回族自治区", "Wuzhong"],
    ["101170401", "固原", "宁夏回族自治区", "Guyuan"],
    ["101170501", "中卫", "宁夏回族自治区", "Zhongwei"],
    ["101180101", "郑州", "河南省", "Zhengzhou"],
    ["101180201", "安阳", "河南省", "Anyang"],
    ["101180301", "新乡", "河南省", "Xinxiang"],
    ["101180401", "许昌", "河南省", "Xuchang"],
    ["101180501", "平顶山", "河南省", "Pingdingshan"],
    ["101180601", "信阳", "河南省", "Xinyang"],
    ["101180701", "南阳", "河南省", "Nanyang"],
    ["101180801", "开封", "河南省", "Kaifeng"],
    ["101180901", "洛阳", "河南省", "Luoyang"],
    ["101181001", "商丘", "河南省", "Shangqiu"],
    ["101181101", "焦作", "河南省", "Jiaozuo"],
    ["101181201", "鹤壁", "河南省", "Hebi"],
    ["101181301", "濮阳", "河南省", "Puyang"],
    ["101181401", "周口", "河南省", "Zhoukou"],
    ["101181501", "漯河", "河南省", "Luohe"],
    ["101181601", "驻马店", "河南省", "Zhumadian"],
    ["101181701", "三门峡", "河南省", "Sanmenxia"],
    ["101181801", "济源", "河南省", "Jiyuan"],
    ["101190101", "南京", "江苏省", "Nanjing"],
    ["101190201", "无锡", "江苏省", "Wuxi"],
    ["101190301", "镇江", "江苏省", "Zhenjiang"],
    ["101190401", "苏州", "江苏省", "Suzhou"],
    ["101190501", "南通", "江苏省", "Nantong"],
    ["101190601", "扬州", "江苏省", "Yangzhou"],
    ["101190701", "盐城", "江苏省", "Yancheng"],
    ["101190801", "徐州", "江苏省", "Xuzhou"],
    ["101190901", "淮安", "江苏省", "Huaian"],
    ["101191001", "连云港", "江苏省", "Lianyungang"],
    ["101191101", "常州", "江苏省", "Changzhou"],
    ["101191201", "泰州", "江苏省", "Taizhou"],
    ["101191301", "宿迁", "江苏省", "Suqian"],
    ["101200101", "武汉", "湖北省", "Wuhan"],
    ["101200201", "襄阳", "湖北省", "Xiangyang"],
    ["101200301", "鄂州", "湖北省", "Ezhou"],
    ["101200401", "孝感", "湖北省", "Xiaogan"],
    ["101200501", "黄冈", "湖北省", "Huanggang"],
    ["101200601", "黄石", "湖北省", "Huangshi"],
    ["101200701", "咸宁", "湖北省", "Xianning"],
    ["101200801", "荆州", "湖北省", "Jingzhou"],
    ["101200901", "宜昌", "湖北省", "Yichang"],
    ["101201101", "十堰", "湖北省", "Shiyan"],
    ["101201301", "随州", "湖北省", "Suizhou"],
    ["101201401", "荆门", "湖北省", "Jingmen"],
    ["101201501", "天门", "湖北省", "Tianmen"],
    ["101201601", "仙桃", "湖北省", "Xiantao"],
    ["101201701", "潜江", "湖北省", "Qianjiang"],
    ["101210101", "杭州", "浙江省", "Hangzhou"],
    ["101210201", "湖州", "浙江省", "Huzhou"],
    ["101210301", "嘉兴", "浙江省", "Jiaxing"],
    ["101210401", "宁波", "浙江省", "Ningbo"],
    ["101210507", "绍兴", "浙江省", "Shaoxing"],
    ["101210601", "台州", "浙江省", "Taizhou"],
    ["101210701", "温州", "浙江省", "Wenzhou"],
    ["101210801", "丽水", "浙江省", "Lishui"],
    ["101210901", "金华", "浙江省", "Jinhua"],
    ["101211001", "衢州", "浙江省", "Quzhou"],
    ["101211101", "舟山", "浙江省", "Zhoushan"],
    ["101220101", "合肥", "安徽省", "Hefei"],
    ["101220201", "蚌埠", "安徽省", "Bengbu"],
    ["101220301", "芜湖", "安徽省", "Wuhu"],
    ["101220401", "淮南", "安徽省", "Huainan"],
    ["101220501", "马鞍山", "安徽省", "Ma'anshan"],
    ["101220601", "安庆", "安徽省", "Anqing"],
    ["101220701", "宿州", "安徽省", "Suzhou"],
    ["101220801", "阜阳", "安徽省", "Fuyang"],
    ["101220901", "亳州", "安徽省", "Bozhou"],
    ["101221001", "黄山", "安徽省", "Huangshan"],
    ["101221101", "滁州", "安徽省", "Chuzhou"],
    ["101221201", "淮北", "安徽省", "Huaibei"],
    ["101221301", "铜陵", "安徽省", "Tongling"],
    ["101221401", "宣城", "安徽省", "Xuancheng"],
    ["101221501", "六安", "安徽省", "Lu'an"],
    ["101221701", "池州", "安徽省", "Chizhou"],
    ["101230101", "福州", "福建省", "Fuzhou"],
    ["101230201", "厦门", "福建省", "Xiamen"],
    ["101230301", "宁德", "福建省", "Ningde"],
    ["101230401", "莆田", "福建省", "Putian"],
    ["101230501", "泉州", "福建省", "Quanzhou"],
    ["101230601", "漳州", "福建省", "Zhangzhou"],
    ["101230701", "龙岩", "福建省", "Longyan"],
    ["101230801", "三明", "福建省", "Sanming"],
    ["101230901", "南平", "福建省", "Nanping"],
    ["101240101", "南昌", "江西省", "Nanchang"],
    ["101240201", "九江", "江西省", "Jiujiang"],
    ["101240301", "上饶", "江西省", "Shangrao"],
    ["101240401", "抚州", "江西省", "Fuzhou"],
    ["101240501", "宜春", "江西省", "Yichun"],
    ["101240601", "吉安", "江西省", "Ji'an"],
    ["101240701", "赣州", "江西省", "Ganzhou"],
    ["101240801", "景德镇", "江西省", "Jingdezhen"],
    ["101240901", "萍乡", "江西省", "Pingxiang"],
    ["101241001", "新余", "江西省", "Xinyu"],
    ["101241101", "鹰潭", "江西省", "Yingtan"],
    ["101250101", "长沙", "湖南省", "Changsha"],
    ["101250201", "湘潭", "湖南省", "Xiangtan"],
    ["101250301", "株洲", "湖南省", "Zhuzhou"],
    ["101250401", "衡阳", "湖南省", "Hengyang"],
    ["101250501", "郴州", "湖南省", "Chenzhou"],
    ["101250601", "常德", "湖南省", "Changde"],
    ["101250700", "益阳", "湖南省", "Yiyang"],
    ["101250801", "娄底", "湖南省", "Loudi"],
    ["101250901", "邵阳", "湖南省", "Shaoyang"],
    ["101251001", "岳阳", "湖南省", "Yueyang"],
    ["101251101", "张家界", "湖南省", "Zhangjiajie"],
    ["101251201", "怀化", "湖南省", "Huaihua"],
    ["101251401", "永州", "湖南省", "Yongzhou"],
    ["101260101", "贵阳", "贵州省", "Guiyang"],
    ["101260201", "遵义", "贵州省", "Zunyi"],
    ["101260301", "安顺", "贵州省", "Anshun"],
    ["101260601", "铜仁", "贵州省", "Tongren"],
    ["101260701", "毕节", "贵州省", "Bijie"],
    ["101260803", "六盘水", "贵州省", "Liupanshui"],
    ["101270101", "成都", "四川省", "Chengdu"],
    ["101270201", "攀枝花", "四川省", "Panzhihua"],
    ["101270301", "自贡", "四川省", "Zigong"],
    ["101270401", "绵阳", "四川省", "Mianyang"],
    ["101270501", "南充", "四川省", "Nanchong"],
    ["101270601", "达州", "四川省", "Dazhou"],
    ["101270701", "遂宁", "四川省", "Suining"],
    ["101270801", "广安", "四川省", "Guang'an"],
    ["101270901", "巴中", "四川省", "Bazhong"],
    ["101271001", "泸州", "四川省", "Luzhou"],
    ["101271101", "宜宾", "四川省", "Yibin"],
    ["101271201", "内江", "四川省", "Neijiang"],
    ["101271301", "资阳", "四川省", "Ziyang"],
    ["101271401", "乐山", "四川省", "Leshan"],
    ["101271501", "眉山", "四川省", "Meishan"],
    ["101271701", "雅安", "四川省", "Ya'an"],
    ["101272001", "德阳", "四川省", "Deyang"],
    ["101272101", "广元", "四川省", "Guangyuan"],
    ["101280101", "广州", "广东省", "Guangzhou"],
    ["101280201", "韶关", "广东省", "Shaoguan"],
    ["101280301", "惠州", "广东省", "Huizhou"],
    ["101280401", "梅州", "广东省", "Meizhou"],
    ["101280501", "汕头", "广东省", "Shantou"],
    ["101280601", "深圳", "广东省", "Shenzhen"],
    ["101280701", "珠海", "广东省", "Zhuhai"],
    ["101280800", "佛山", "广东省", "Foshan"],
    ["101280901", "肇庆", "广东省", "Zhaoqing"],
    ["101281001", "湛江", "广东省", "Zhanjiang"],
    ["101281101", "江门", "广东省", "Jiangmen"],
    ["101281201", "河源", "广东省", "Heyuan"],
    ["101281301", "清远", "广东省", "Qingyuan"],
    ["101281401", "云浮", "广东省", "Yunfu"],
    ["101281501", "潮州", "广东省", "Chaozhou"],
    ["101281601", "东莞", "广东省", "Dongguan"],
    ["101281701", "中山", "广东省", "Zhongshan"],
    ["101281801", "阳江", "广东省", "Yangjiang"],
    ["101281901", "揭阳", "广东省", "Jieyang"],
    ["101282001", "茂名", "广东省", "Maoming"],
    ["101282101", "汕尾", "广东省", "Shanwei"],
    ["101290101", "昆明", "云南省", "Kunming"],
    ["101290401", "曲靖", "云南省", "Qujing"],
    ["101290501", "保山", "云南省", "Baoshan"],
    ["101290701", "玉溪", "云南省", "Yuxi"],
    ["101290901", "普洱", "云南省", "Pu'er City"],
    ["101291001", "昭通", "云南省", "Zhaotong"],
    ["101291101", "临沧", "云南省", "Lincang"],
    ["101291401", "丽江", "云南省", "Lijiang"],
    ["101300101", "南宁", "广西壮族自治区", "Nanning"],
    ["101300201", "崇左", "广西壮族自治区", "Chongzuo"],
    ["101300301", "柳州", "广西壮族自治区", "Liuzhou"],
    ["101300401", "来宾", "广西壮族自治区", "Laibin"],
    ["101300501", "桂林", "广西壮族自治区", "Guilin"],
    ["101300601", "梧州", "广西壮族自治区", "Wuzhou"],
    ["101300701", "贺州", "广西壮族自治区", "Hezhou"],
    ["101300801", "贵港", "广西壮族自治区", "Guigang"],
    ["101300901", "玉林", "广西壮族自治区", "Yulin"],
    ["101301001", "百色", "广西壮族自治区", "Baise"],
    ["101301101", "钦州", "广西壮族自治区", "Qinzhou"],
    ["101301201", "河池", "广西壮族自治区", "Hechi"],
    ["101301301", "北海", "广西壮族自治区", "Beihai"],
    ["101301401", "防城港", "广西壮族自治区", "Fangchenggang"],
    ["101310101", "海口", "海南省", "Haikou"],
    ["101310201", "三亚", "海南省", "Sanya"],
    ["101310202", "东方", "海南省", "Dongfang"],
    ["101310205", "儋州", "海南省", "Danzhou"],
    ["101310211", "琼海", "海南省", "Qionghai"],
    ["101310212", "文昌", "海南省", "Wenchang"],
    ["101310215", "万宁", "海南省", "Wanning"],
    ["101310222", "五指山", "海南省", "Wuzhishan"],
    ["101310301", "三沙", "海南省", "Sansha"],
  ].map(([id, name, adm1, en]) => ({ id, name, adm1, en }));

  /** 本地城市库匹配：中文名 / 省份 / 拼音前缀 */
  function matchLocalCities(keyword) {
    const q = keyword.trim();
    if (!q) return [];
    const lower = q.toLowerCase();
    return CITY_DATA
      .filter((city) => city.name.includes(q) || city.adm1.includes(q) || city.en.toLowerCase().startsWith(lower))
      .slice(0, 8)
      .map((city) => ({ id: city.id, name: city.name, adm1: city.adm1, country: '中国' }));
  }

  let searchTimer = null;
  let searchSeq = 0; // 用来丢弃过期的搜索结果（打字快时会有多个请求在飞）

  function normalizeCity(item) {
    return {
      id: item.id,
      name: item.name,
      adm1: item.adm1,
      country: item.country,
      lat: item.lat,
      lon: item.lon,
    };
  }

  function hideSuggest() {
    const list = $('suggestList');
    list.hidden = true;
    list.innerHTML = '';
  }

  function renderSuggest(list) {
    const ul = $('suggestList');
    ul.innerHTML = '';

    if (!list || !list.length) {
      hideSuggest();
      return;
    }

    list.forEach((item) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'suggest-item';

      const main = document.createElement('span');
      main.className = 'suggest-main';

      const name = document.createElement('span');
      name.className = 'suggest-name';
      name.textContent = item.name;

      const meta = document.createElement('span');
      meta.className = 'suggest-meta';
      meta.textContent = [item.adm1, item.country]
        .filter(Boolean)
        .filter((v, i, arr) => arr.indexOf(v) === i)
        .join(' · ');

      main.append(name, meta);
      btn.append(main);
      btn.addEventListener('click', () => selectCity(normalizeCity(item)));
      li.append(btn);
      ul.append(li);
    });

    ul.hidden = false;
  }

  // GeoAPI 是可选能力：一旦发现没权限（403）就只提示一次，之后完全用本地城市库
  let geoApiAvailable = true;

  async function matchRemoteCities(keyword) {
    if (!geoApiAvailable) return [];
    try {
      const data = await request('/geo/v2/city/lookup', { location: keyword, number: 6 });
      return (data.location || []).map(normalizeCity);
    } catch (err) {
      geoApiAvailable = false;
      console.info('[城市搜索] GeoAPI 不可用，已改用内置城市库：', err.message);
      return [];
    }
  }

  /** 输入联想：本地库先把结果画出来，再尝试用 GeoAPI 补充（比如国外城市） */
  async function loadSuggestions(keyword) {
    const seq = ++searchSeq;

    const local = matchLocalCities(keyword);
    renderSuggest(local);

    const remote = await matchRemoteCities(keyword);
    if (seq !== searchSeq) return; // 期间用户又改了输入，这次结果作废

    if (!remote.length) return;

    // 按 LocationID 去重后合并
    const merged = [...local];
    remote.forEach((item) => {
      if (!merged.some((city) => city.id === item.id)) merged.push(item);
    });
    renderSuggest(merged.slice(0, 8));
  }

  function selectCity(city) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(city));
    $('cityInput').value = '';
    $('cityInput').blur();
    hideSuggest();
    loadWeather(city);
  }

  /** 点击“查询”或回车：有联想就选第一条，没有就先查本地库、再试 GeoAPI */
  async function submitSearch() {
    const keyword = $('cityInput').value.trim();
    if (!keyword) {
      showToast('先输入一个城市名吧');
      return;
    }

    const firstItem = $('suggestList').querySelector('.suggest-item');
    if (!($('suggestList').hidden) && firstItem) {
      firstItem.click();
      return;
    }

    const local = matchLocalCities(keyword);
    if (local.length) {
      selectCity(local[0]);
      return;
    }

    const remote = await matchRemoteCities(keyword);
    if (remote.length) {
      selectCity(remote[0]);
      return;
    }
    showToast('没有找到这个城市，换个关键词试试');
  }

  function readSavedCity() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const city = JSON.parse(raw);
      return city && city.id ? city : null;
    } catch (err) {
      return null;
    }
  }

  /* ==========================================================
     10. 事件绑定与启动
     ========================================================== */
  function bindEvents() {
    const input = $('cityInput');

    $('searchBtn').addEventListener('click', submitSearch);

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submitSearch();
      }
      if (event.key === 'Escape') hideSuggest();
    });

    // 输入防抖：停手 320ms 后才请求，避免每敲一个字都发请求
    input.addEventListener('input', () => {
      const keyword = input.value.trim();
      clearTimeout(searchTimer);
      if (!keyword) {
        hideSuggest();
        return;
      }
      searchTimer = setTimeout(() => loadSuggestions(keyword), 320);
    });

    // 点到搜索框以外的地方就收起联想
    document.addEventListener('click', (event) => {
      if (!$('searchBox').contains(event.target) && !$('suggestList').contains(event.target)) {
        hideSuggest();
      }
    });

    $('toast').addEventListener('click', () => $('toast').classList.remove('show'));
  }

  function init() {
    bindEvents();

    const city = readSavedCity() || DEFAULT_CITY;
    setText('cityName', city.name);
    setText('cityMeta', '正在获取天气数据…');
    loadWeather(city);

    // 每分钟刷新一次“现在”指针，让太阳沿着弧线慢慢走
    setInterval(() => {
      if (state.daily.length) renderSun();
    }, 60 * 1000);

    // 每 10 分钟自动刷新一次天气
    setInterval(() => {
      if (state.city && !state.loading) loadWeather(state.city);
    }, 10 * 60 * 1000);
  }

  init();
})();
