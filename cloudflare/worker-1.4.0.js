
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Content-Type": "application/json"
    };

    if (method === "OPTIONS") {
      return new Response(null, { headers });
    }

    try {
      // === デバイス登録 ===
      if (path === "/devices" && method === "POST") {
        const { device_id } = await request.json();
        if (!device_id) return json({ error: "device_id required" }, 400, headers);
        await env.DB.prepare(
          "INSERT OR IGNORE INTO devices (device_id) VALUES (?)"
        ).bind(device_id).run();
        return json({ ok: true }, 200, headers);
      }

      // === 初回クーポン使用 ===
      if (path === "/welcome-coupon" && method === "POST") {
        const { device_id, choice } = await request.json();
        if (!device_id || !choice) return json({ error: "device_id and choice required" }, 400, headers);
        const device = await env.DB.prepare(
          "SELECT welcome_coupon_used FROM devices WHERE device_id = ?"
        ).bind(device_id).first();
        if (!device) return json({ error: "device not found" }, 404, headers);
        if (device.welcome_coupon_used) return json({ error: "already used" }, 409, headers);
        await env.DB.prepare(
          "UPDATE devices SET welcome_coupon_used = 1 WHERE device_id = ?"
        ).bind(device_id).run();
        return json({ ok: true, choice }, 200, headers);
      }

      // === 初回クーポン状態確認 ===
      if (path === "/welcome-coupon/status" && method === "POST") {
        const { device_id } = await request.json();
        if (!device_id) return json({ error: "device_id required" }, 400, headers);
        const device = await env.DB.prepare(
          "SELECT welcome_coupon_used FROM devices WHERE device_id = ?"
        ).bind(device_id).first();
        if (!device) return json({ used: false }, 200, headers);
        return json({ used: !!device.welcome_coupon_used }, 200, headers);
      }

      // ★★ 追加: 誕生月取得 (GET /birthday) ★★
      if (path === "/birthday" && method === "GET") {
        const device_id = url.searchParams.get("device_id");
        if (!device_id) return json({ error: "device_id required" }, 400, headers);
        const device = await env.DB.prepare(
          "SELECT birth_month FROM devices WHERE device_id = ?"
        ).bind(device_id).first();
        if (!device) return json({ ok: true, birth_month: null }, 200, headers);
        return json({ ok: true, birth_month: device.birth_month ?? null }, 200, headers);
      }

      // === 誕生月登録 ===
      if (path === "/birthday" && method === "POST") {
        const { device_id, birth_month } = await request.json();
        if (!device_id || !birth_month) return json({ error: "device_id and birth_month required" }, 400, headers);
        if (birth_month < 1 || birth_month > 12) return json({ error: "invalid month" }, 400, headers);
        // 既に登録済みか確認 → 変更不可
        const device = await env.DB.prepare(
          "SELECT birth_month FROM devices WHERE device_id = ?"
        ).bind(device_id).first();
        if (!device) return json({ error: "device not found" }, 404, headers);
        if (device.birth_month !== null) {
          return json({ error: "birth_month already set" }, 403, headers);
        }
        await env.DB.prepare(
          "UPDATE devices SET birth_month = ? WHERE device_id = ?"
        ).bind(birth_month, device_id).run();
        return json({ ok: true, birth_month }, 200, headers);
      }

      // === 誕生日クーポン状態確認 ===
      if (path === "/birthday-coupon/status" && method === "POST") {
        const { device_id } = await request.json();
        if (!device_id) return json({ error: "device_id required" }, 400, headers);
        const device = await env.DB.prepare(
          "SELECT birth_month, birthday_coupon_used_year FROM devices WHERE device_id = ?"
        ).bind(device_id).first();
        if (!device || !device.birth_month) return json({ registered: false }, 200, headers);
        const now = new Date();
        const currentMonth = now.getMonth() + 1;
        const currentYear = now.getFullYear();
        const isBirthMonth = device.birth_month === currentMonth;
        const alreadyUsed = device.birthday_coupon_used_year === currentYear;
        return json({
          registered: true,
          birth_month: device.birth_month,
          is_birth_month: isBirthMonth,
          available: isBirthMonth && !alreadyUsed,
          used_this_year: alreadyUsed
        }, 200, headers);
      }

      // === 誕生日クーポン使用 ===
      if (path === "/birthday-coupon" && method === "POST") {
        const { device_id, choice } = await request.json();
        if (!device_id || !choice) return json({ error: "device_id and choice required" }, 400, headers);
        const device = await env.DB.prepare(
          "SELECT birth_month, birthday_coupon_used_year FROM devices WHERE device_id = ?"
        ).bind(device_id).first();
        if (!device || !device.birth_month) return json({ error: "birth_month not set" }, 400, headers);
        const now = new Date();
        const currentMonth = now.getMonth() + 1;
        const currentYear = now.getFullYear();
        if (device.birth_month !== currentMonth) return json({ error: "not your birth month" }, 403, headers);
        if (device.birthday_coupon_used_year === currentYear) return json({ error: "already used this year" }, 409, headers);
        await env.DB.prepare(
          "UPDATE devices SET birthday_coupon_used_year = ? WHERE device_id = ?"
        ).bind(currentYear, device_id).run();
        return json({ ok: true, choice }, 200, headers);
      }

      // === FiNANCiEクーポンコード入力 ===
      if (path === "/redeem-code" && method === "POST") {
        const { device_id, code } = await request.json();
        if (!device_id || !code) return json({ error: "device_id and code required" }, 400, headers);
        const coupon = await env.DB.prepare(
          "SELECT * FROM coupon_codes WHERE code = ?"
        ).bind(code).first();
        if (!coupon) return json({ error: "invalid code" }, 404, headers);
        if (coupon.used) return json({ error: "already used" }, 409, headers);
        await env.DB.prepare(
          "UPDATE coupon_codes SET used = 1, used_by_device = ?, used_at = datetime('now') WHERE code = ?"
        ).bind(device_id, code).run();
        return json({ ok: true, prize: coupon.prize }, 200, headers);
      }

      // === 1.4.0 GPS任意・オフライン再送対応の来店ポイント ===
      if (path === "/checkin-v2" && method === "POST") {
        const body = await request.json();
        const deviceId = typeof body.device_id === "string" ? body.device_id.trim() : "";
        const requestId = typeof body.request_id === "string" ? body.request_id.trim() : "";
        const qrData = typeof body.qr_data === "string" ? body.qr_data : "";
        const scanTime = typeof body.scanned_at === "string" ? body.scanned_at : "";
        const scanDay = typeof body.scanned_date_jst === "string" ? body.scanned_date_jst : "";

        if (!deviceId || deviceId.length > 128 || !requestId || requestId.length > 128 ||
            !qrData.trim() || qrData.length > 4096) {
          return json({ error: "invalid checkin payload" }, 400, headers);
        }
        const at = new Date(scanTime);
        if (!Number.isFinite(at.getTime()) || getJstDate(at) !== scanDay) {
          return json({ error: "invalid scanned date" }, 400, headers);
        }
        // QR検証は次回の専用シール導入時に検討。現時点の任意QRは来店証明にならない。
        const outcome = await grantCheckinPoint(env.DB, {
          deviceId, requestId, dayJst: scanDay, scannedAt: at.toISOString(),
          spotName: typeof body.spot_name === "string" ? body.spot_name.slice(0, 200) : ""
        });
        return json(outcome.body, outcome.status, headers);
      }

      // === 旧アプリ互換: GPS要件を残し、付与処理だけ一元化 ===
      if (path === "/checkin" && method === "POST") {
        const { device_id, latitude, longitude, spot_lat, spot_lng, spot_name } = await request.json();
        if (!device_id || latitude == null || longitude == null || spot_lat == null || spot_lng == null) {
          return json({ error: "device_id, latitude, longitude, spot_lat, spot_lng required" }, 400, headers);
        }
        const dist = getDistance(latitude, longitude, spot_lat, spot_lng);
        if (!Number.isFinite(dist) || dist > 500) {
          return json({ error: "not within 500m of today's location",
            distance: Number.isFinite(dist) ? Math.round(dist) : null }, 403, headers);
        }
        const now = new Date();
        const outcome = await grantCheckinPoint(env.DB, {
          deviceId: String(device_id), requestId: crypto.randomUUID(),
          dayJst: getJstDate(now), scannedAt: now.toISOString(),
          spotName: typeof spot_name === "string" ? spot_name.slice(0, 200) : ""
        });
        return json(outcome.body, outcome.status, headers);
      }

      // === チェックイン履歴取得 ===
      if (path === "/checkin-history" && method === "POST") {
        const { device_id } = await request.json();
        if (!device_id) return json({ error: "device_id required" }, 400, headers);
        const logs = await env.DB.prepare(
          "SELECT spot_name, checked_in_at FROM checkin_logs WHERE device_id = ? ORDER BY checked_in_at DESC LIMIT 50"
        ).bind(device_id).all();
        return json({ history: logs.results }, 200, headers);
      }

      // === ポイント取得 ===
      if (path === "/points" && method === "POST") {
        const { device_id } = await request.json();
        if (!device_id) return json({ error: "device_id required" }, 400, headers);
        const points = await env.DB.prepare(
          "SELECT current_points, total_redeemed, megami_coupon_active FROM stamp_points WHERE device_id = ?"
        ).bind(device_id).first();
        if (!points) return json({ current_points: 0, total_redeemed: 0, megami_coupon_active: 0 }, 200, headers);
        return json(points, 200, headers);
      }

      // === ポイント特典交換（女神のほほえみクーポン受け取り） ===
      if (path === "/redeem-points" && method === "POST") {
        const { device_id, required_points } = await request.json();
        if (!device_id || !required_points) return json({ error: "device_id and required_points required" }, 400, headers);
        const points = await env.DB.prepare(
          "SELECT current_points FROM stamp_points WHERE device_id = ?"
        ).bind(device_id).first();
        if (!points || points.current_points < required_points) {
          return json({ error: "not enough points" }, 400, headers);
        }
        await env.DB.prepare(
          "UPDATE stamp_points SET current_points = 0, total_redeemed = total_redeemed + 1, megami_coupon_active = 1 WHERE device_id = ?"
        ).bind(device_id).run();
        return json({ ok: true }, 200, headers);
      }

      // === 女神のほほえみクーポン使用 ===
      if (path === "/megami-coupon/use" && method === "POST") {
        const { device_id } = await request.json();
        if (!device_id) return json({ error: "device_id required" }, 400, headers);
        await env.DB.prepare(
          "UPDATE stamp_points SET megami_coupon_active = 0 WHERE device_id = ?"
        ).bind(device_id).run();
        return json({ ok: true }, 200, headers);
      }

      // === 口コミ一覧（承認済み） ===
      if (path === "/reviews" && method === "GET") {
        const reviews = await env.DB.prepare(
          "SELECT id, nickname, body, owner_reply, owner_reply_at, created_at FROM reviews WHERE approved = 1 ORDER BY created_at DESC LIMIT 50"
        ).all();
        return json({ reviews: reviews.results }, 200, headers);
      }

      // === 口コミ投稿 ===
      if (path === "/reviews" && method === "POST") {
        const { device_id, nickname, body } = await request.json();
        if (!device_id || !nickname || !body) return json({ error: "device_id, nickname, body required" }, 400, headers);
        if (nickname.length > 50) return json({ error: "nickname max 50 chars" }, 400, headers);

        const today = new Date().toISOString().slice(0, 10);
        const already = await env.DB.prepare(
          "SELECT id FROM reviews WHERE device_id = ? AND date(created_at) = ?"
        ).bind(device_id, today).first();
        if (already) return json({ error: "one review per day" }, 429, headers);

        await env.DB.prepare(
          "INSERT INTO reviews (device_id, nickname, body) VALUES (?, ?, ?)"
        ).bind(device_id, nickname, body).run();
        return json({ ok: true }, 200, headers);
      }

      // === お知らせ取得 ===
      if (path === "/notices" && method === "GET") {
        const all = url.searchParams.get("all");
        const limit = all === "1" ? 50 : 3;
        const notices = await env.DB.prepare(
          "SELECT id, body, created_at FROM notices ORDER BY created_at DESC LIMIT ?"
        ).bind(limit).all();
        return json({ notices: notices.results }, 200, headers);
      }

      // ========== 管理画面API ==========

      // === 管理認証チェック ===
      if (path.startsWith("/admin/")) {
        const auth = request.headers.get("Authorization");
        if (!auth || auth !== `Bearer ${env.ADMIN_PASSWORD}`) {
          return json({ error: "unauthorized" }, 401, headers);
        }
      }

      // === 口コミ一覧（管理用・全件） ===
      if (path === "/admin/reviews" && method === "GET") {
        const reviews = await env.DB.prepare(
          "SELECT * FROM reviews ORDER BY created_at DESC LIMIT 100"
        ).all();
        return json({ reviews: reviews.results }, 200, headers);
      }

      // === 口コミ承認 ===
      if (path.match(/^\/admin\/reviews\/(\d+)\/approve$/) && method === "POST") {
        const id = path.match(/^\/admin\/reviews\/(\d+)\/approve$/)[1];
        await env.DB.prepare(
          "UPDATE reviews SET approved = 1 WHERE id = ?"
        ).bind(id).run();
        return json({ ok: true }, 200, headers);
      }

      // === 口コミ返信 ===
      if (path.match(/^\/admin\/reviews\/(\d+)\/reply$/) && method === "POST") {
        const id = path.match(/^\/admin\/reviews\/(\d+)\/reply$/)[1];
        const { reply } = await request.json();
        if (!reply) return json({ error: "reply required" }, 400, headers);
        await env.DB.prepare(
          "UPDATE reviews SET owner_reply = ?, owner_reply_at = datetime('now') WHERE id = ?"
        ).bind(reply, id).run();
        return json({ ok: true }, 200, headers);
      }

      // === 口コミ削除 ===
      if (path.match(/^\/admin\/reviews\/(\d+)$/) && method === "DELETE") {
        const id = path.match(/^\/admin\/reviews\/(\d+)$/)[1];
        await env.DB.prepare(
          "DELETE FROM reviews WHERE id = ?"
        ).bind(id).run();
        return json({ ok: true }, 200, headers);
      }

      // === クーポン発行 ===
      if (path === "/admin/coupons" && method === "POST") {
        const { prize } = await request.json();
        if (!prize) return json({ error: "prize required" }, 400, headers);
        const code = "KNT-" + Math.random().toString(36).substring(2, 8).toUpperCase();
        await env.DB.prepare(
          "INSERT INTO coupon_codes (code, prize) VALUES (?, ?)"
        ).bind(code, prize).run();
        return json({ ok: true, code }, 200, headers);
      }

      // === クーポン一覧 ===
      if (path === "/admin/coupons" && method === "GET") {
        const coupons = await env.DB.prepare(
          "SELECT * FROM coupon_codes ORDER BY created_at DESC"
        ).all();
        return json({ coupons: coupons.results }, 200, headers);
      }

      // === お知らせ投稿 ===
      if (path === "/admin/notices" && method === "POST") {
        const { body } = await request.json();
        if (!body) return json({ error: "body required" }, 400, headers);
        await env.DB.prepare(
          "INSERT INTO notices (body) VALUES (?)"
        ).bind(body).run();
        return json({ ok: true }, 200, headers);
      }

      // === お知らせ削除 ===
      if (path.match(/^\/admin\/notices\/(\d+)$/) && method === "DELETE") {
        const id = path.match(/^\/admin\/notices\/(\d+)$/)[1];
        await env.DB.prepare(
          "DELETE FROM notices WHERE id = ?"
        ).bind(id).run();
        return json({ ok: true }, 200, headers);
      }

      // === 出店場所登録 ===
      if (path === "/admin/locations" && method === "POST") {
        const { name, latitude, longitude } = await request.json();
        if (!name || latitude == null || longitude == null) return json({ error: "name, latitude, longitude required" }, 400, headers);
        await env.DB.prepare(
          "INSERT INTO locations (name, latitude, longitude) VALUES (?, ?, ?)"
        ).bind(name, latitude, longitude).run();
        return json({ ok: true }, 200, headers);
      }

      // === 出店場所一覧 ===
      if (path === "/admin/locations" && method === "GET") {
        const locations = await env.DB.prepare(
          "SELECT * FROM locations ORDER BY id"
        ).all();
        return json({ locations: locations.results }, 200, headers);
      }

      // === 端末情報検索（管理用） ===
      if (path === "/admin/device-info" && method === "POST") {
        const { device_id } = await request.json();
        if (!device_id) return json({ error: "device_id required" }, 400, headers);

        const device = await env.DB.prepare(
          "SELECT device_id, welcome_coupon_used, birth_month, birthday_coupon_used_year FROM devices WHERE device_id = ?"
        ).bind(device_id).first();
        if (!device) return json({ error: "device not found" }, 404, headers);

        const points = await env.DB.prepare(
          "SELECT current_points, total_redeemed, megami_coupon_active FROM stamp_points WHERE device_id = ?"
        ).bind(device_id).first();

        const checkins = await env.DB.prepare(
          "SELECT COUNT(*) as count FROM checkin_logs WHERE device_id = ?"
        ).bind(device_id).first();

        return json({
          device_id: device.device_id,
          welcome_coupon_used: !!device.welcome_coupon_used,
          birth_month: device.birth_month,
          birthday_coupon_used_year: device.birthday_coupon_used_year,
          current_points: points ? points.current_points : 0,
          total_redeemed: points ? points.total_redeemed : 0,
          megami_coupon_active: points ? points.megami_coupon_active : 0,
          checkin_count: checkins ? checkins.count : 0
        }, 200, headers);
      }

      // === ポイント手動付与（管理用） ===
      if (path === "/admin/add-points" && method === "POST") {
        const { device_id, points } = await request.json();
        if (!device_id || !points || points < 1) return json({ error: "device_id and points (>=1) required" }, 400, headers);

        const device = await env.DB.prepare(
          "SELECT device_id FROM devices WHERE device_id = ?"
        ).bind(device_id).first();
        if (!device) return json({ error: "device not found" }, 404, headers);

        const current = await env.DB.prepare(
          "SELECT current_points FROM stamp_points WHERE device_id = ?"
        ).bind(device_id).first();

        if (current) {
          const newPoints = current.current_points + points;
          if (newPoints > 20) return json({ error: "points would exceed 20 (current: " + current.current_points + ")" }, 400, headers);
          await env.DB.prepare(
            "UPDATE stamp_points SET current_points = ? WHERE device_id = ?"
          ).bind(newPoints, device_id).run();
        } else {
          if (points > 20) return json({ error: "points cannot exceed 20" }, 400, headers);
          await env.DB.prepare(
            "INSERT INTO stamp_points (device_id, current_points, megami_coupon_active) VALUES (?, ?, 0)"
          ).bind(device_id, points).run();
        }

        const updated = await env.DB.prepare(
          "SELECT current_points FROM stamp_points WHERE device_id = ?"
        ).bind(device_id).first();

        return json({ ok: true, current_points: updated.current_points }, 200, headers);
      }

      return json({ error: "not found" }, 404, headers);

    } catch (err) {
      return json({ error: err.message }, 500, headers);
    }
  }
};

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers });
}

function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}


function getJstDate(date) {
  return new Date(date.getTime() + 32400000).toISOString().slice(0, 10);
}

// DB.batch は原子的。今回発行した attemptId と一致する受付だけ加算・記録。
async function grantCheckinPoint(db, visit) {
  const { deviceId, requestId, dayJst, scannedAt } = visit;
  const spotName = visit.spotName || "出店場所";
  const previous = await db.prepare(
    "SELECT device_id, checkin_date_jst FROM checkin_claims_v2 WHERE request_id = ?"
  ).bind(requestId).first();
  if (previous) {
    if (previous.device_id !== deviceId || previous.checkin_date_jst !== dayJst) {
      return { status: 400, body: { error: "request_id reused" } };
    }
    const points = await db.prepare(
      "SELECT current_points FROM stamp_points WHERE device_id = ?"
    ).bind(deviceId).first();
    return { status: 200, body: { ok: true, location: spotName,
      current_points: points ? points.current_points : 0 } };
  }
  const attemptId = crypto.randomUUID();
  await db.batch([
    db.prepare(
      "INSERT INTO checkin_claims_v2 " +
      "(request_id, device_id, checkin_date_jst, attempt_id) " +
      "SELECT ?, ?, ?, ? WHERE NOT EXISTS (" +
      "SELECT 1 FROM checkin_logs WHERE device_id = ? " +
      "AND date(checked_in_at, '+9 hours') = ?" +
      ") ON CONFLICT DO NOTHING"
    ).bind(requestId, deviceId, dayJst, attemptId, deviceId, dayJst),
    db.prepare(
      "UPDATE stamp_points SET current_points = current_points + 1 WHERE device_id = ? " +
      "AND EXISTS (SELECT 1 FROM checkin_claims_v2 WHERE request_id = ? AND attempt_id = ?)"
    ).bind(deviceId, requestId, attemptId),
    db.prepare(
      "INSERT INTO stamp_points (device_id, current_points, megami_coupon_active) " +
      "SELECT ?, 1, 0 WHERE NOT EXISTS (" +
      "SELECT 1 FROM stamp_points WHERE device_id = ?" +
      ") AND EXISTS (" +
      "SELECT 1 FROM checkin_claims_v2 WHERE request_id = ? AND attempt_id = ?)"
    ).bind(deviceId, deviceId, requestId, attemptId),
    db.prepare(
      "INSERT INTO checkin_logs (device_id, location_id, spot_name, checked_in_at) " +
      "SELECT ?, 0, ?, datetime(?) WHERE EXISTS (" +
      "SELECT 1 FROM checkin_claims_v2 WHERE request_id = ? AND attempt_id = ?)"
    ).bind(deviceId, spotName, scannedAt, requestId, attemptId)
  ]);
  const recorded = await db.prepare(
    "SELECT device_id, checkin_date_jst FROM checkin_claims_v2 WHERE request_id = ?"
  ).bind(requestId).first();
  if (!recorded) return { status: 409, body: { error: "already checked in today" } };
  if (recorded.device_id !== deviceId || recorded.checkin_date_jst !== dayJst) {
    return { status: 400, body: { error: "request_id reused" } };
  }
  const points = await db.prepare(
    "SELECT current_points FROM stamp_points WHERE device_id = ?"
  ).bind(deviceId).first();
  return { status: 200, body: { ok: true, location: spotName,
    current_points: points ? points.current_points : 0 } };
}
