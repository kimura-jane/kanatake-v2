// ===== APNs プッシュ通知（iOSネイティブアプリ用） =====
(async function initApnsPush() {
  if (!window.Capacitor || !window.Capacitor.isNativePlatform()) {
    return;
  }
  var PushNotifications = window.Capacitor.Plugins.PushNotifications;
  if (!PushNotifications) {
    return;
  }
  try {
    var permission = await PushNotifications.requestPermissions();
    if (permission.receive !== 'granted') {
      return;
    }
    await PushNotifications.register();
    PushNotifications.addListener('registration', async function(token) {
      try {
        await fetch('https://kanatae-push.la-kofu.workers.dev/apns-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token: token.value,
            device_id: localStorage.getItem('kanatake_device_id') || ''
          })
        });
      } catch (err) {
        console.error('APNs token send error', err);
      }
    });
    PushNotifications.addListener('registrationError', function(error) {
      console.error('APNs registration error', error);
    });
    PushNotifications.addListener('pushNotificationReceived', function(notification) {
      console.log('APNs notification received', notification);
    });
    PushNotifications.addListener('pushNotificationActionPerformed', function(action) {
      console.log('APNs notification tapped', action);
    });
  } catch (err) {
    console.error('APNs init error', err);
  }
})();

// ===== 設定 =====
const API_BASE = "https://kanatake-api.la-kofu.workers.dev";
const PUSH_API_BASE = "https://kanatae-push.la-kofu.workers.dev";
const ASSETS_BASE = "https://kimura-jane.github.io/kanatae-app";
const APP_URL = "https://kanatake-v2.pages.dev";

const CHOICE_IMAGES = {
  "お茶": "IMG_5006.jpeg",
  "ラムネ": "IMG_5012.jpeg",
  "ダンゴ": "IMG_5007.jpeg"
};

const CHOICE_EMOJI = {
  "お茶": "🍵 お茶",
  "ラムネ": "🥤 ラムネ",
  "ダンゴ": "🍡 ダンゴ"
};

// ===== 端末ID =====
function getDeviceId() {
  let id = localStorage.getItem("kanatake_device_id");
  if (!id) {
    id = "dev_" + crypto.randomUUID();
    localStorage.setItem("kanatake_device_id", id);
  }
  return id;
}
const DEVICE_ID = getDeviceId();

// ===== ページナビ =====
const navBtns = document.querySelectorAll(".nav-btn");
const pages = document.querySelectorAll(".page");
let currentPage = "home";
let mapInitialized = false;
let mapInstance = null;
let markersArray = [];

navBtns.forEach(btn => {
  btn.addEventListener("click", () => {
    switchPage(btn.dataset.page);
  });
});

function switchPage(page) {
  currentPage = page;
  navBtns.forEach(b => b.classList.toggle("active", b.dataset.page === page));
  pages.forEach(p => p.classList.toggle("active", p.id === `page-${page}`));

  if (page === "home" && !mapInitialized) {
    setTimeout(() => { initMap(); mapInitialized = true; }, 100);
  }
  if (page === "home" && mapInstance) {
    setTimeout(() => mapInstance.invalidateSize(), 100);
  }
  if (page === "reviews") loadReviews();
  if (page === "settings") loadCheckinHistory();

  const pageEl = document.getElementById(`page-${page}`);
  if (pageEl) pageEl.scrollTop = 0;
}

// ===== 初期化 =====
document.addEventListener("DOMContentLoaded", async () => {
  await registerDevice();
  document.getElementById("device-id-display").textContent = DEVICE_ID;

  initStampGrid();
  await loadPoints();
  await loadNotices();

  initCalendarRangeAndStartMonth();
  renderCalendar();

  setTimeout(() => {
    if (!mapInitialized) { initMap(); mapInitialized = true; }
  }, 300);

  await checkWelcomeCoupon();
  await checkBirthdayCoupon();
  await loadBirthMonth();

  syncPlaceUI();
  registerSW().catch(() => {});
});

// ===== デバイス登録 =====
async function registerDevice() {
  try {
    await fetch(`${API_BASE}/devices`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: DEVICE_ID })
    });
  } catch (e) { console.warn("device register failed:", e); }
}

// ===== お知らせ =====
let noticesShowAll = false;

async function loadNotices(all) {
  const el = document.getElementById("notices-list");
  const moreBtn = document.getElementById("notices-more-btn");
  try {
    const url = all ? `${API_BASE}/notices?all=1` : `${API_BASE}/notices`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.notices || data.notices.length === 0) {
      el.innerHTML = '<p class="loading-text">お知らせはありません</p>';
      moreBtn.style.display = "none";
      return;
    }
    el.innerHTML = data.notices.map(n => {
      const bodyHtml = renderNoticeBody(n.body);
      return `
        <div class="notice-item">
          <span class="notice-date">${formatDate(n.created_at)}</span>
          <div class="notice-body">${bodyHtml}</div>
        </div>
      `;
    }).join("");

    if (el.querySelector(".twitter-tweet")) {
      loadTwitterWidget();
    }

    if (!all && data.notices.length >= 3) {
      moreBtn.style.display = "block";
    } else {
      moreBtn.style.display = "none";
    }
  } catch (e) {
    el.innerHTML = '<p class="loading-text">読み込みに失敗しました</p>';
  }
}

function renderNoticeBody(text) {
  if (!text) return "";
  const escaped = escapeHtml(text);
  const xRegex = /https?:\/\/(x\.com|twitter\.com)\/\w+\/status\/(\d+)[^\s]*/g;
  const replaced = escaped.replace(xRegex, (url) => {
    return `<div class="notice-embed"><blockquote class="twitter-tweet"><a href="${url}"></a></blockquote></div>`;
  });
  return replaced;
}

function loadTwitterWidget() {
  if (window.twttr) {
    window.twttr.widgets.load();
    return;
  }
  const s = document.createElement("script");
  s.src = "https://platform.twitter.com/widgets.js";
  s.async = true;
  document.head.appendChild(s);
}

document.getElementById("notices-more-btn").addEventListener("click", () => {
  noticesShowAll = true;
  loadNotices(true);
});

// ===== スタンプ / ポイント =====
let megamiCouponActive = false;

function initStampGrid() {
  const grid = document.getElementById("stamp-grid");
  let html = "";
  for (let i = 0; i < 20; i++) {
    html += `<div class="stamp-dot" data-index="${i}"></div>`;
  }
  grid.innerHTML = html;
}

async function loadPoints() {
  try {
    const res = await fetch(`${API_BASE}/points`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: DEVICE_ID })
    });
    const data = await res.json();
    updateStampUI(data.current_points || 0);
    megamiCouponActive = !!(data.megami_coupon_active);
    updateMegamiCouponUI();
  } catch (e) {
    console.warn("load points failed:", e);
  }
}

function updateStampUI(points) {
  document.getElementById("stamp-current").textContent = points;
  const dots = document.querySelectorAll(".stamp-dot");
  dots.forEach((dot, i) => {
    dot.classList.toggle("filled", i < points);
  });
  document.getElementById("redeem-btn").style.display = (points >= 20 && !megamiCouponActive) ? "block" : "none";
}

function updateMegamiCouponUI() {
  const area = document.getElementById("megami-coupon-area");
  area.style.display = megamiCouponActive ? "block" : "none";
}

document.getElementById("redeem-btn").addEventListener("click", async () => {
  if (!confirm("20ポイントで「女神のほほえみ」と交換しますか？\nポイントは0にリセットされます。")) return;
  try {
    const res = await fetch(`${API_BASE}/redeem-points`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: DEVICE_ID, required_points: 20 })
    });
    const data = await res.json();
    if (data.ok) {
      alert("🎉 おめでとうございます！\nクーポンタブに「女神のほほえみ」クーポンが届きました！");
      megamiCouponActive = true;
      updateStampUI(0);
      updateMegamiCouponUI();
    } else {
      alert("交換できませんでした: " + (data.error || ""));
    }
  } catch (e) {
    alert("通信エラーが発生しました");
  }
});

document.getElementById("megami-use-btn").addEventListener("click", async () => {
  if (!confirm("⚠️ 「女神のほほえみ」を使用済みにしますか？\n店主の目の前で押してください。")) return;
  try {
    const res = await fetch(`${API_BASE}/megami-coupon/use`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: DEVICE_ID })
    });
    const data = await res.json();
    if (data.ok) {
      megamiCouponActive = false;
      updateMegamiCouponUI();
      alert("✅ 使用済みにしました！ありがとうございます！");
    }
  } catch (e) {
    alert("通信エラーが発生しました");
  }
});

// ===== カレンダー =====
let currentYear, currentMonth;
let minYM = null, maxYM = null;

function ymToNum(y, m) { return y * 100 + m; }

function clampYM(y, m) {
  if (!minYM || !maxYM) return { y, m };
  const n = ymToNum(y, m);
  if (n < ymToNum(minYM.y, minYM.m)) return { y: minYM.y, m: minYM.m };
  if (n > ymToNum(maxYM.y, maxYM.m)) return { y: maxYM.y, m: maxYM.m };
  return { y, m };
}

function getAllSpotsFlat() {
  if (window.spotsAllByYear && typeof window.spotsAllByYear === "object") {
    const flat = [];
    Object.keys(window.spotsAllByYear).forEach(y => {
      (window.spotsAllByYear[y] || []).forEach(s => flat.push({ ...s, year: Number(y) }));
    });
    return flat;
  }
  if (Array.isArray(window.spots) && window.spots.length) return window.spots;
  return [];
}

function getSpotsForYM(year, month) {
  if (window.spotsAllByYear && window.spotsAllByYear[year]) {
    return window.spotsAllByYear[year].filter(s => {
      const m = (s.date || "").match(/(\d+)\//);
      return m && parseInt(m[1], 10) === month;
    });
  }
  return getAllSpotsFlat().filter(s => {
    if (s.year != null && Number(s.year) !== year) return false;
    const m = (s.date || "").match(/(\d+)\//);
    return m && parseInt(m[1], 10) === month;
  });
}

function getEventsForMonth(year, month) {
  const spots = getSpotsForYM(year, month);
  const events = {};
  spots.forEach(s => {
    const m = (s.date || "").match(/(\d+)\/(\d+)/);
    if (!m) return;
    const d = parseInt(m[2], 10);
    if (!events[d]) events[d] = [];
    events[d].push(s);
  });
  return events;
}

function computeMinMaxYM() {
  const list = getAllSpotsFlat();
  let minN = Infinity, maxN = -Infinity;
  list.forEach(s => {
    const y = Number(s.year);
    if (!isFinite(y)) return;
    const m = (s.date || "").match(/(\d+)\//);
    if (!m) return;
    const month = parseInt(m[1], 10);
    if (month < 1 || month > 12) return;
    const n = ymToNum(y, month);
    if (n < minN) minN = n;
    if (n > maxN) maxN = n;
  });
  if (!isFinite(minN)) { minYM = null; maxYM = null; return; }
  minYM = { y: Math.floor(minN / 100), m: minN % 100 };
  maxYM = { y: Math.floor(maxN / 100), m: maxN % 100 };
}

function initCalendarRangeAndStartMonth() {
  computeMinMaxYM();
  const t = new Date();
  const d = clampYM(t.getFullYear(), t.getMonth() + 1);
  currentYear = d.y;
  currentMonth = d.m;
}

function getShortName(name) {
  const shortcuts = {
    '川口さくら病院': 'さくら病院', '獨協大学 草加キャンパス': '獨協大学',
    'さいたま市役所 浦和本庁舎': 'さいたま市役所', 'ダイナム戸ヶ崎店': 'ダイナム'
  };
  return shortcuts[name] || (name || "").substring(0, 6);
}

function renderCalendar() {
  const title = document.getElementById("calendarTitle");
  const grid = document.getElementById("calendarGrid");

  title.textContent = `${currentYear}年${currentMonth}月`;

  const firstDay = new Date(currentYear, currentMonth - 1, 1);
  const daysInMonth = new Date(currentYear, currentMonth, 0).getDate();
  const startDow = firstDay.getDay();
  const events = getEventsForMonth(currentYear, currentMonth);

  const today = new Date();
  const isCurrentMonth = today.getFullYear() === currentYear && today.getMonth() + 1 === currentMonth;
  const todayDate = today.getDate();

  let html = ["日","月","火","水","木","金","土"].map(d => `<div class="calendar-dow">${d}</div>`).join("");
  for (let i = 0; i < startDow; i++) html += '<div class="calendar-day empty"></div>';

  for (let d = 1; d <= daysInMonth; d++) {
    const hasEvent = !!(events[d] && events[d].length);
    const isToday = isCurrentMonth && d === todayDate;
    let cls = "calendar-day";
    if (hasEvent) cls += " has-event";
    if (isToday) cls += " today";
    const place = hasEvent ? `<div class="calendar-place">${getShortName(events[d][0].name)}</div>` : "";
    html += `<div class="${cls}" data-day="${d}"><span class="calendar-date">${d}</span>${place}</div>`;
  }
  grid.innerHTML = html;

  grid.querySelectorAll(".calendar-day.has-event").forEach(el => {
    el.addEventListener("click", () => {
      const day = parseInt(el.dataset.day, 10);
      showEventModal(day, events[day]);
    });
  });

  const prevBtn = document.getElementById("prevMonth");
  const nextBtn = document.getElementById("nextMonth");
  if (minYM && maxYM) {
    prevBtn.disabled = ymToNum(currentYear, currentMonth) <= ymToNum(minYM.y, minYM.m);
    nextBtn.disabled = ymToNum(currentYear, currentMonth) >= ymToNum(maxYM.y, maxYM.m);
  }
}

function showEventModal(day, eventList) {
  const event = eventList[0];
  document.getElementById("modalDate").textContent = `${currentYear}年${currentMonth}月${day}日`;
  document.getElementById("modalTitle").textContent = event.name;
  document.getElementById("modalTime").textContent = event.time || "時間未定";
  const mapLink = document.getElementById("modalMap");
  if (event.lat && event.lng) {
    mapLink.href = `https://www.google.com/maps?q=${event.lat},${event.lng}`;
    mapLink.style.display = "block";
  } else {
    mapLink.style.display = "none";
  }
  document.getElementById("modal").classList.add("active");
}

document.getElementById("modal").addEventListener("click", e => {
  if (e.target.id === "modal" || e.target.id === "modalClose") {
    document.getElementById("modal").classList.remove("active");
  }
});

document.getElementById("prevMonth").addEventListener("click", () => {
  if (minYM && ymToNum(currentYear, currentMonth) <= ymToNum(minYM.y, minYM.m)) return;
  currentMonth--;
  if (currentMonth < 1) { currentMonth = 12; currentYear--; }
  const c = clampYM(currentYear, currentMonth);
  currentYear = c.y; currentMonth = c.m;
  renderCalendar();
});

document.getElementById("nextMonth").addEventListener("click", () => {
  if (maxYM && ymToNum(currentYear, currentMonth) >= ymToNum(maxYM.y, maxYM.m)) return;
  currentMonth++;
  if (currentMonth > 12) { currentMonth = 1; currentYear++; }
  const c = clampYM(currentYear, currentMonth);
  currentYear = c.y; currentMonth = c.m;
  renderCalendar();
});

// ===== マップ =====
function initMap() {
  if (!window.L) return;
  const mapEl = document.getElementById("map");
  if (!mapEl) return;

  mapInstance = L.map("map").setView([35.82, 139.80], 11);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    attribution: "© OSM © CARTO"
  }).addTo(mapInstance);

  const icon = L.icon({
    iconUrl: `${ASSETS_BASE}/icon.png`,
    iconSize: [40, 40], iconAnchor: [20, 30], popupAnchor: [0, -26]
  });

  const spots = Array.isArray(window.spots) ? window.spots : [];
  const list = document.getElementById("spotList");
  list.innerHTML = "";
  markersArray = [];

  spots.forEach((s, i) => {
    if (s.lat && s.lng) {
      const m = L.marker([s.lat, s.lng], { icon }).addTo(mapInstance).bindPopup(
        `<strong>${s.name}</strong><br>${s.date || ""}${s.time ? " ・ " + s.time : ""}<br>` +
        `<a href="https://www.google.com/maps?q=${s.lat},${s.lng}" target="_blank" rel="noopener">Googleマップで開く</a>`
      );
      markersArray[i] = m;
    }
    const li = document.createElement("li");
    li.innerHTML = `<span class="spot-name">${s.name}</span> <span class="badge">${s.date || ""}</span>`;
    li.addEventListener("click", () => {
      if (markersArray[i]) {
        mapInstance.setView(markersArray[i].getLatLng(), 14, { animate: true });
        markersArray[i].openPopup();
      }
    });
    list.appendChild(li);
  });

  const existing = markersArray.filter(Boolean);
  if (existing.length) mapInstance.fitBounds(L.featureGroup(existing).getBounds().pad(0.15));
}

// ===== 今日の出店場所を探す =====
function getTodaySpot() {
  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();

  if (Array.isArray(window.spots)) {
    for (const s of window.spots) {
      if (!s.lat || !s.lng) continue;
      const m = (s.date || "").match(/(\d+)\/(\d+)/);
      if (m && parseInt(m[1], 10) === month && parseInt(m[2], 10) === day) return s;
    }
  }

  if (window.spotsAllByYear) {
    const year = now.getFullYear();
    const arr = window.spotsAllByYear[year] || [];
    for (const s of arr) {
      if (!s.lat || !s.lng) continue;
      const m = (s.date || "").match(/(\d+)\/(\d+)/);
      if (m && parseInt(m[1], 10) === month && parseInt(m[2], 10) === day) return s;
    }
  }

  return null;
}

// ===== 初回クーポン =====
let welcomeSelectedChoice = null;

async function checkWelcomeCoupon() {
  try {
    const res = await fetch(`${API_BASE}/welcome-coupon/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: DEVICE_ID })
    });
    const data = await res.json();
    if (data.used) {
      document.getElementById("welcome-coupon-content").style.display = "none";
      document.getElementById("welcome-coupon-used").style.display = "block";
    }
  } catch (e) { console.warn("welcome coupon check failed:", e); }
}

document.querySelectorAll("#welcome-choices .welcome-choice-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#welcome-choices .welcome-choice-btn").forEach(b => b.classList.remove("selected"));
    btn.classList.add("selected");
    welcomeSelectedChoice = btn.dataset.choice;
    document.getElementById("welcome-confirm-btn").style.display = "block";
    document.getElementById("choice-hint").style.display = "none";
  });
});

document.getElementById("welcome-confirm-btn").addEventListener("click", async () => {
  if (!welcomeSelectedChoice) return;
  if (!confirm(`⚠️ 1回限りです！\n\n「${welcomeSelectedChoice}」をもらいますか？\n\n店主の目の前で押してください。`)) return;

  try {
    const res = await fetch(`${API_BASE}/welcome-coupon`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: DEVICE_ID, choice: welcomeSelectedChoice })
    });
    const data = await res.json();
    if (data.ok) {
      document.getElementById("welcome-coupon-content").style.display = "none";
      document.getElementById("welcome-coupon-show").style.display = "block";
      document.getElementById("welcome-coupon-img").src = CHOICE_IMAGES[welcomeSelectedChoice] || "";
      document.getElementById("welcome-coupon-item").textContent = CHOICE_EMOJI[welcomeSelectedChoice] || welcomeSelectedChoice;
    } else if (data.error === "already used") {
      document.getElementById("welcome-coupon-content").style.display = "none";
      document.getElementById("welcome-coupon-used").style.display = "block";
    } else {
      alert("エラー: " + (data.error || "不明なエラー"));
    }
  } catch (e) {
    alert("通信エラーが発生しました");
  }
});

// ===== 誕生日クーポン =====
let birthdaySelectedChoice = null;

async function checkBirthdayCoupon() {
  try {
    const res = await fetch(`${API_BASE}/birthday-coupon/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: DEVICE_ID })
    });
    const data = await res.json();
    if (!data.registered || !data.is_birth_month) {
      document.getElementById("birthday-coupon-area").style.display = "none";
      return;
    }
    document.getElementById("birthday-coupon-area").style.display = "block";
    if (data.used_this_year) {
      document.getElementById("birthday-coupon-content").style.display = "none";
      document.getElementById("birthday-coupon-used").style.display = "block";
    }
  } catch (e) { console.warn("birthday coupon check failed:", e); }
}

document.querySelectorAll("#birthday-choices .birthday-choice-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#birthday-choices .birthday-choice-btn").forEach(b => b.classList.remove("selected"));
    btn.classList.add("selected");
    birthdaySelectedChoice = btn.dataset.choice;
    document.getElementById("birthday-confirm-btn").style.display = "block";
    document.getElementById("birthday-choice-hint").style.display = "none";
  });
});

document.getElementById("birthday-confirm-btn").addEventListener("click", async () => {
  if (!birthdaySelectedChoice) return;
  if (!confirm(`⚠️ 年1回限りです！\n\n「${birthdaySelectedChoice}」をもらいますか？\n\n店主の目の前で押してください。`)) return;

  try {
    const res = await fetch(`${API_BASE}/birthday-coupon`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: DEVICE_ID, choice: birthdaySelectedChoice })
    });
    const data = await res.json();
    if (data.ok) {
      document.getElementById("birthday-coupon-content").style.display = "none";
      document.getElementById("birthday-coupon-show").style.display = "block";
      document.getElementById("birthday-coupon-img").src = CHOICE_IMAGES[birthdaySelectedChoice] || "";
      document.getElementById("birthday-coupon-item").textContent = CHOICE_EMOJI[birthdaySelectedChoice] || birthdaySelectedChoice;
    } else if (data.error === "already used this year") {
      document.getElementById("birthday-coupon-content").style.display = "none";
      document.getElementById("birthday-coupon-used").style.display = "block";
    } else {
      alert("エラー: " + (data.error || "不明なエラー"));
    }
  } catch (e) {
    alert("通信エラーが発生しました");
  }
});

// ===== FiNANCiEクーポン =====
document.getElementById("coupon-code-btn").addEventListener("click", async () => {
  const code = document.getElementById("coupon-code-input").value.trim();
  const resultEl = document.getElementById("coupon-code-result");
  if (!code) { resultEl.className = "result-text error"; resultEl.textContent = "コードを入力してください"; return; }

  resultEl.className = "result-text loading";
  resultEl.textContent = "確認中…";

  try {
    const res = await fetch(`${API_BASE}/redeem-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: DEVICE_ID, code })
    });
    const data = await res.json();
    if (data.ok) {
      resultEl.className = "result-text success";
      resultEl.textContent = `🎉 ${data.prize} をゲット！店頭で見せてね！`;
      document.getElementById("coupon-code-input").value = "";
    } else {
      resultEl.className = "result-text error";
      const msgs = { "invalid code": "無効なコードです", "already used": "このコードは使用済みです" };
      resultEl.textContent = "❌ " + (msgs[data.error] || data.error);
    }
  } catch (e) {
    resultEl.className = "result-text error";
    resultEl.textContent = "❌ 通信エラー";
  }
});

// ===== QRスキャン =====
let html5QrCode = null;

document.getElementById("qr-start-btn").addEventListener("click", async () => {
  const resultEl = document.getElementById("qr-result");
  resultEl.className = "result-text";
  resultEl.textContent = "";

  if (!window.Html5Qrcode) {
    resultEl.className = "result-text error";
    resultEl.textContent = "❌ QRスキャナーの読み込みに失敗しました";
    return;
  }

  if (html5QrCode) {
    try { await html5QrCode.stop(); } catch (e) {}
    html5QrCode = null;
  }

  html5QrCode = new Html5Qrcode("qr-reader");

  try {
    await html5QrCode.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 250, height: 250 } },
      async (decodedText) => {
        try { await html5QrCode.stop(); } catch (e) {}
        html5QrCode = null;
        await processCheckin(decodedText);
      },
      () => {}
    );
  } catch (e) {
    resultEl.className = "result-text error";
    resultEl.textContent = "❌ カメラを起動できませんでした。カメラ権限を確認してください。";
  }
});

async function processCheckin(qrText) {
  const resultEl = document.getElementById("qr-result");
  resultEl.className = "result-text loading";
  resultEl.textContent = "📍 今日の出店場所を確認中…";

  const todaySpot = getTodaySpot();
  if (!todaySpot) {
    resultEl.className = "result-text error";
    resultEl.textContent = "❌ 今日の出店データが見つかりません";
    return;
  }

  resultEl.textContent = "📍 位置情報を取得中…";

  let latitude, longitude;
  try {
    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true, timeout: 10000, maximumAge: 0
      });
    });
    latitude = pos.coords.latitude;
    longitude = pos.coords.longitude;
  } catch (e) {
    resultEl.className = "result-text error";
    resultEl.textContent = "❌ 位置情報を取得できませんでした。位置情報を許可してください。";
    return;
  }

  resultEl.textContent = "⏳ チェックイン中…";
  try {
    const res = await fetch(`${API_BASE}/checkin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_id: DEVICE_ID,
        latitude,
        longitude,
        spot_lat: todaySpot.lat,
        spot_lng: todaySpot.lng,
        spot_name: todaySpot.name
      })
    });
    const data = await res.json();
    if (data.ok) {
      resultEl.className = "result-text success";
      resultEl.textContent = `🎉 チェックイン成功！\n📍 ${data.location}\n⭐ 現在 ${data.current_points} ポイント`;
      updateStampUI(data.current_points);
    } else {
      resultEl.className = "result-text error";
      const msgs = {
        "already checked in today": "本日はすでにチェックイン済みです",
        "not within 500m of today's location": `お店から離れすぎています（${data.distance || "?"}m）`
      };
      resultEl.textContent = "❌ " + (msgs[data.error] || data.error);
    }
  } catch (e) {
    resultEl.className = "result-text error";
    resultEl.textContent = "❌ 通信エラー";
  }
}

// ===== 口コミ =====
async function loadReviews() {
  const el = document.getElementById("reviews-list");
  el.innerHTML = '<p class="loading-text">読み込み中…</p>';
  try {
    const res = await fetch(`${API_BASE}/reviews`);
    const data = await res.json();
    if (!data.reviews || data.reviews.length === 0) {
      el.innerHTML = '<p class="loading-text">まだ口コミはありません</p>';
      return;
    }
    el.innerHTML = data.reviews.map(r => `
      <div class="review-item">
        <span class="review-nickname">${escapeHtml(r.nickname)}</span>
        <span class="review-date">${formatDate(r.created_at)}</span>
        <div class="review-body">${escapeHtml(r.body)}</div>
        ${r.owner_reply ? `
          <div class="review-reply">
            <div class="review-reply-label">🍙 店主からの返信</div>
            ${escapeHtml(r.owner_reply)}
          </div>
        ` : ""}
      </div>
    `).join("");
  } catch (e) {
    el.innerHTML = '<p class="loading-text">読み込みに失敗しました</p>';
  }
}

document.getElementById("review-body").addEventListener("input", (e) => {
  document.getElementById("review-char-current").textContent = e.target.value.length;
});

document.getElementById("review-submit-btn").addEventListener("click", async () => {
  const nickname = document.getElementById("review-nickname").value.trim();
  const body = document.getElementById("review-body").value.trim();
  const resultEl = document.getElementById("review-result");

  if (!nickname) { resultEl.className = "result-text error"; resultEl.textContent = "ニックネームを入力してください"; return; }
  if (!body) { resultEl.className = "result-text error"; resultEl.textContent = "口コミを入力してください"; return; }

  resultEl.className = "result-text loading";
  resultEl.textContent = "投稿中…";

  try {
    const res = await fetch(`${API_BASE}/reviews`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: DEVICE_ID, nickname, body })
    });
    const data = await res.json();
    if (data.ok) {
      resultEl.className = "result-text success";
      resultEl.textContent = "✅ 投稿しました！店主の承認後に表示されます。";
      document.getElementById("review-nickname").value = "";
      document.getElementById("review-body").value = "";
      document.getElementById("review-char-current").textContent = "0";
    } else {
      resultEl.className = "result-text error";
      const msgs = { "one review per day": "1日1件まで投稿できます" };
      resultEl.textContent = "❌ " + (msgs[data.error] || data.error);
    }
  } catch (e) {
    resultEl.className = "result-text error";
    resultEl.textContent = "❌ 通信エラー";
  }
});

// ===== 誕生月登録 =====
let birthMonthLocked = false;

async function loadBirthMonth() {
  try {
    const res = await fetch(`${API_BASE}/birthday-coupon/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: DEVICE_ID })
    });
    const data = await res.json();
    if (data.registered && data.birth_month) {
      birthMonthLocked = true;
      showBirthMonthLocked(data.birth_month);
    }
  } catch (e) {}
}

function showBirthMonthLocked(month) {
  const container = document.getElementById("birth-month-form");
  container.innerHTML = `
    <div class="birth-month-locked">
      <p class="birth-month-display">🎂 誕生月：<strong>${month}月</strong></p>
      <p class="birth-month-note">※ 誕生月は変更できません</p>
    </div>
  `;
}

document.getElementById("birth-month-btn").addEventListener("click", async () => {
  if (birthMonthLocked) return;
  const month = parseInt(document.getElementById("birth-month-select").value);
  const resultEl = document.getElementById("birth-month-result");
  if (!month) { resultEl.className = "result-text error"; resultEl.textContent = "月を選択してください"; return; }

  if (!confirm(`誕生月を「${month}月」で登録しますか？\n\n⚠️ 一度登録すると変更できません。`)) return;

  resultEl.className = "result-text loading";
  resultEl.textContent = "登録中…";

  try {
    const res = await fetch(`${API_BASE}/birthday`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: DEVICE_ID, birth_month: month })
    });
    const data = await res.json();
    if (data.ok) {
      resultEl.className = "result-text success";
      resultEl.textContent = `✅ ${month}月で登録しました！`;
      birthMonthLocked = true;
      showBirthMonthLocked(month);
      await checkBirthdayCoupon();
    } else {
      resultEl.className = "result-text error";
      if (data.error === "birth_month already set") {
        resultEl.textContent = "❌ 誕生月は変更できません";
      } else {
        resultEl.textContent = "❌ " + (data.error || "エラーが発生しました");
      }
    }
  } catch (e) {
    resultEl.className = "result-text error";
    resultEl.textContent = "❌ 通信エラー";
  }
});

// ===== チェックイン履歴 =====
async function loadCheckinHistory() {
  const el = document.getElementById("checkin-history");
  try {
    const res = await fetch(`${API_BASE}/checkin-history`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: DEVICE_ID })
    });
    const data = await res.json();
    if (!data.history || data.history.length === 0) {
      el.innerHTML = '<p class="loading-text">まだ来店履歴はありません</p>';
      return;
    }
    el.innerHTML = data.history.map(h => `
      <div class="checkin-item">
        <span class="checkin-spot">${escapeHtml(h.spot_name || "出店場所")}</span>
        <span class="checkin-date">${formatDate(h.checked_in_at)}</span>
      </div>
    `).join("");
  } catch (e) {
    el.innerHTML = '<p class="loading-text">読み込みに失敗しました</p>';
  }
}

// ===== シェア =====
document.getElementById("share-x-btn").addEventListener("click", () => {
  const text = "おにぎり屋かなたけのアプリ🍙\n出店スケジュールやクーポンがチェックできるよ！";
  window.open(`https://x.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(APP_URL)}`, "_blank");
});

document.getElementById("share-line-btn").addEventListener("click", () => {
  const text = "おにぎり屋かなたけのアプリ🍙 " + APP_URL;
  window.open(`https://line.me/R/share?text=${encodeURIComponent(text)}`, "_blank");
});

// ===== キャッシュクリア =====
document.getElementById("cache-clear-btn").addEventListener("click", async () => {
  const resultEl = document.getElementById("cache-clear-result");
  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
    resultEl.className = "result-text success";
    resultEl.textContent = "✅ キャッシュをクリアしました。ページを再読み込みします…";
    setTimeout(() => location.reload(), 1500);
  } catch (e) {
    resultEl.className = "result-text error";
    resultEl.textContent = "❌ クリアに失敗しました";
  }
});

// ===== 通知設定 =====
function syncPlaceUI() {
  const all = document.getElementById("place_all").checked;
  document.querySelectorAll("#placeList .settings-option").forEach(opt => {
    opt.classList.toggle("disabled", all);
  });
  document.querySelectorAll(".placeChk").forEach(chk => {
    chk.disabled = all;
    if (all) chk.checked = false;
  });
}

document.getElementById("place_all").addEventListener("change", syncPlaceUI);
document.querySelectorAll(".placeChk").forEach(chk => {
  chk.addEventListener("change", () => {
    if (chk.checked) document.getElementById("place_all").checked = false;
    syncPlaceUI();
  });
});

document.getElementById("pushBtn").addEventListener("click", () => {
  doPushRegister().catch(err => {
    const el = document.getElementById("pushStatus");
    el.className = "result-text error";
    el.textContent = "❌ " + (err?.message || String(err));
  });
});

async function doPushRegister() {
  const statusEl = document.getElementById("pushStatus");
  statusEl.className = "result-text loading";
  statusEl.textContent = "⏳ 登録中…";

  if (!("Notification" in window)) {
    statusEl.className = "result-text error";
    statusEl.textContent = "❌ このブラウザは通知に未対応";
    return;
  }

  const reg = await registerSW();
  if (!reg) {
    statusEl.className = "result-text error";
    statusEl.textContent = "❌ SW登録に失敗";
    return;
  }

  if (!reg.pushManager) {
    statusEl.className = "result-text error";
    statusEl.textContent = "❌ Push未対応（iPhoneはホーム画面に追加してSafariで開く）";
    return;
  }

  const perm = await Notification.requestPermission();
  if (perm !== "granted") {
    statusEl.className = "result-text error";
    statusEl.textContent = "❌ 通知が許可されていません";
    return;
  }

  const publicKey = await getVapidPublicKey();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64ToUint8Array(publicKey)
    });
  }

  const hour = document.querySelector('input[name="notifyHour"]:checked')?.value || "21";
  const allPlaces = document.getElementById("place_all").checked;
  const places = allPlaces ? [] : [...document.querySelectorAll(".placeChk:checked")].map(x => x.value);

  await upsertSubscription(sub, parseInt(hour), places);
  statusEl.className = "result-text success";
  statusEl.textContent = "✅ 登録完了！通知が届くようになりました";
}

// ===== Push ヘルパー =====
function b64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const arr = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) arr[i] = rawData.charCodeAt(i);
  return arr;
}

async function getVapidPublicKey() {
  const res = await fetch(`${PUSH_API_BASE}/vapid`);
  const data = await res.json();
  if (!res.ok || !data.publicKey) throw new Error(data.error || "vapid fetch failed");
  return data.publicKey;
}

async function upsertSubscription(subscription, hour, places) {
  const res = await fetch(`${PUSH_API_BASE}/subs/upsert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription, places, hour })
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.error || "upsert failed");
}

// ===== Service Worker =====
async function registerSW() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("sw.js");
  } catch (e) { return null; }
}

// ===== ユーティリティ =====
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

function formatDate(isoStr) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  if (isNaN(d)) return isoStr;
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,"0")}/${String(d.getDate()).padStart(2,"0")}`;
}
