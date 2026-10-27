
/* Additional admin screens; existing coupon/review/notices code is untouched. */
(function () {
  'use strict';

  var base = (window.KANATAKE_SALES_API_BASE || '').replace(/\/$/, '');
  var products = [];
  var today = null;
  var editing = null;
  var busy = false;
  var selectionDirty = false;
  var createRequestId = null;
  var photoPreviewBlobUrl = null;
  var boardRefreshBusy = false;
  var boardGenerationBusy = false;

  var $ = id => document.getElementById(id);

  var categories = {
    onigiri: 'おにぎり',
    bento: 'お弁当',
    other: 'その他'
  };

  var statuses = {
    selling: '販売中',
    low: '残りわずか',
    sold_out: '売り切れ'
  };

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(
      /[&<>"']/g,
      ch => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      }[ch])
    );
  }

  function errorText(e) {
    return (e && e.message) || '通信エラー';
  }

  function message(id, msg, isError) {
    var el = $(id);
    if (!el) return;
    el.textContent = msg;
    el.style.color = isError ? '#b42318' : '#346a3d';
  }

  async function api(path, opts) {
    if (!base) {
      throw new Error(
        '販売状況APIのURLが未設定です。Cloudflareテスト環境の接続設定が必要です。'
      );
    }

    var token = typeof AUTH_TOKEN !== 'undefined' ? AUTH_TOKEN : '';

    if (!token) {
      throw new Error('先に管理画面へログインしてください');
    }

    opts = opts || {};

    var headers = new Headers(opts.headers || {});
    headers.set('Authorization', 'Bearer ' + token);

    if (opts.json !== undefined) {
      headers.set('Content-Type', 'application/json');
      opts.body = JSON.stringify(opts.json);
    }

    var response = await fetch(base + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body,
      cache: 'no-store'
    });

    var text = await response.text();
    var data = {};

    try {
      data = JSON.parse(text);
    } catch (e) {
      if (!response.ok) {
        throw new Error('HTTP ' + response.status);
      }
    }

    if (!response.ok) {
      throw new Error(data.error || ('HTTP ' + response.status));
    }

    return data;
  }

  async function loadProducts() {
    var r = await api('/admin/products');
    products = r.products || [];
    renderProducts();
  }

  function renderPhotoPreview() {
    var host = $('sale-photo-preview');
    if (!host) return;

    if (photoPreviewBlobUrl) {
      URL.revokeObjectURL(photoPreviewBlobUrl);
      photoPreviewBlobUrl = null;
    }

    host.replaceChildren();

    var file = $('sale-p-photo').files[0];
    var existing = editing && products.find(p => p.id === editing);
    var imgUrl = null;
    var label = '';

    if (file) {
      photoPreviewBlobUrl = URL.createObjectURL(file);
      imgUrl = photoPreviewBlobUrl;
      label = '選択中の新しい写真（保存すると現在の画像と入れ替わります）';
    } else if (existing && existing.image_url) {
      imgUrl = existing.image_url;
      label = '現在の登録画像（変更する場合のみ写真を選択）';
    } else {
      label = existing
        ? '画像未登録：新しい写真を選択できます'
        : '商品画像は任意。後から編集して登録できます';
    }

    if (imgUrl) {
      var img = document.createElement('img');
      img.src = imgUrl;
      img.alt = file
        ? '変更後の写真プレビュー'
        : '現在登録されている商品画像';

      img.onerror = function () {
        img.remove();
      };

      host.appendChild(img);
    }

    var caption = document.createElement('span');
    caption.textContent = label;
    host.appendChild(caption);
  }

  function resetForm() {
    editing = null;
    createRequestId = null;

    $('sale-product-form-title').textContent = '商品を追加';
    $('sale-p-name').value = '';
    $('sale-p-category').value = 'onigiri';
    $('sale-p-price').value = '';
    $('sale-p-limited').checked = false;
    $('sale-p-active').checked = true;
    $('sale-p-from').value = '';
    $('sale-p-until').value = '';
    $('sale-p-photo').value = '';
    $('sale-p-cancel').hidden = true;

    renderPhotoPreview();
  }

  function editProduct(id) {
    var p = products.find(x => x.id === id);
    if (!p) return;

    editing = id;
    createRequestId = null;

    $('sale-product-form-title').textContent = '商品を編集';
    $('sale-p-name').value = p.name;
    $('sale-p-category').value = p.category;
    $('sale-p-price').value = p.price_yen == null ? '' : p.price_yen;
    $('sale-p-limited').checked = !!p.is_limited;
    $('sale-p-active').checked = !!p.is_active;
    $('sale-p-from').value = p.available_from || '';
    $('sale-p-until').value = p.available_until || '';
    $('sale-p-photo').value = '';
    $('sale-p-cancel').hidden = false;

    renderPhotoPreview();

    $('tab-products').scrollIntoView({
      behavior: 'smooth',
      block: 'start'
    });
  }

  async function preparePhoto(file) {
    if (!file) return null;

    if (!file.size || file.size > 20 * 1024 * 1024) {
      throw new Error('写真は20MB以内のファイルを選んでください');
    }

    var url = URL.createObjectURL(file);

    try {
      var img = new Image();

      await new Promise(function (resolve, reject) {
        img.onload = resolve;
        img.onerror = () => reject(new Error('写真を読み込めません'));
        img.src = url;
      });

      if (!img.naturalWidth || !img.naturalHeight) {
        throw new Error('画像が不正です');
      }

      var ratio = Math.min(
        1,
        1600 / Math.max(img.naturalWidth, img.naturalHeight)
      );

      var canvas = document.createElement('canvas');

      canvas.width = Math.max(
        1,
        Math.round(img.naturalWidth * ratio)
      );

      canvas.height = Math.max(
        1,
        Math.round(img.naturalHeight * ratio)
      );

      var ctx = canvas.getContext('2d');

      if (!ctx) {
        throw new Error('写真の変換ができません');
      }

      ctx.drawImage(
        img,
        0,
        0,
        canvas.width,
        canvas.height
      );

      var blob = await new Promise((resolve, reject) => {
        canvas.toBlob(
          b => b
            ? resolve(b)
            : reject(new Error('JPEG変換に失敗しました')),
          'image/jpeg',
          0.85
        );
      });

      if (blob.size > 5 * 1024 * 1024) {
        throw new Error(
          'JPEG変換後の写真が5MBを超えています'
        );
      }

      return blob;

    } catch (e) {
      throw new Error(
        'この写真をJPEGに変換できません。別の写真またはJPEG画像を選んでください。'
      );
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function saveProduct() {
    if (busy) return;

    busy = true;

    var savedDetails = false;
    var attemptedPhoto = false;
    var savedPhoto = false;

    var btn = $('sale-p-save');
    btn.disabled = true;

    try {
      var name = $('sale-p-name').value.trim();
      var priceText = $('sale-p-price').value.trim();
      var price = priceText === '' ? null : Number(priceText);

      if (!name) {
        throw new Error('商品名を入力してください');
      }

      if (
        price !== null &&
        (!Number.isInteger(price) || price < 0)
      ) {
        throw new Error(
          '価格は0円以上の整数で入力してください'
        );
      }

      var payload = {
        name: name,
        category: $('sale-p-category').value,
        price_yen: price,
        is_limited: $('sale-p-limited').checked,
        is_active: $('sale-p-active').checked,
        available_from: $('sale-p-from').value || null,
        available_until: $('sale-p-until').value || null,
        sort_order: editing
          ? (products.find(x => x.id === editing) || {}).sort_order
          : (products.length + 1) * 10
      };

      if (
        (payload.available_from || payload.available_until) &&
        !payload.is_limited
      ) {
        throw new Error(
          '販売期間を設定するときは「期間限定」にチェックしてください'
        );
      }

      if (
        payload.available_from &&
        payload.available_until &&
        payload.available_from > payload.available_until
      ) {
        throw new Error(
          '販売終了日は開始日以降にしてください'
        );
      }

      var file = $('sale-p-photo').files[0];
      var preparedPhoto = await preparePhoto(file);
      var id = editing;

      if (id) {
        await api(
          '/admin/products/' + encodeURIComponent(id),
          {
            method: 'PATCH',
            json: payload
          }
        );
      } else {
        createRequestId = createRequestId || crypto.randomUUID();
        payload.client_id = createRequestId;

        var created = await api('/admin/products', {
          method: 'POST',
          json: payload
        });

        id = created.id;
      }

      savedDetails = true;
      editing = id;

      if (preparedPhoto) {
        attemptedPhoto = true;

        await api(
          '/admin/products/' +
          encodeURIComponent(id) +
          '/photo',
          {
            method: 'PUT',
            headers: {
              'Content-Type': preparedPhoto.type
            },
            body: preparedPhoto
          }
        );

        savedPhoto = true;
      }

      message(
        'sale-p-message',
        '商品を保存しました',
        false
      );

      resetForm();
      await loadProducts();

      if (today) {
        await loadToday();
      }

    } catch (e) {
      var note =
        savedDetails && attemptedPhoto && !savedPhoto
          ? '。商品名・価格などは保存済みですが、写真は未更新です。同じ商品を編集したまま再試行してください。'
          : '';

      message(
        'sale-p-message',
        errorText(e) + note,
        true
      );

    } finally {
      busy = false;
      btn.disabled = false;
    }
  }

  async function archiveProduct(id) {
    var p = products.find(x => x.id === id);

    if (
      !p ||
      !confirm(
        '「' + p.name + '」を削除（一覧から非表示）しますか？'
      )
    ) {
      return;
    }

    try {
      await api(
        '/admin/products/' + encodeURIComponent(id),
        { method: 'DELETE' }
      );

      await loadProducts();
      await loadToday();

      message(
        'sale-p-message',
        '削除しました',
        false
      );

    } catch (e) {
      message(
        'sale-p-message',
        errorText(e),
        true
      );
    }
  }

  async function moveProduct(id, delta) {
    var i = products.findIndex(x => x.id === id);
    var j = i + delta;

    if (
      i < 0 ||
      j < 0 ||
      j >= products.length
    ) {
      return;
    }

    var ids = products.map(x => x.id);
    var tmp = ids[i];

    ids[i] = ids[j];
    ids[j] = tmp;

    try {
      await api('/admin/products/order', {
        method: 'PUT',
        json: { ids: ids }
      });

      await loadProducts();

      message(
        'sale-p-message',
        '並び順を変更しました',
        false
      );

    } catch (e) {
      message(
        'sale-p-message',
        errorText(e),
        true
      );
    }
  }

  function renderProducts() {
    var host = $('sale-products-list');
    host.innerHTML = '';

    if (!products.length) {
      host.textContent = '登録された商品はありません';
      return;
    }

    products.forEach(function (p, i) {
      var div = document.createElement('div');
      div.className = 'sales-product';

      var img = document.createElement('img');
      img.alt = '';

      if (p.image_url) {
        img.src = p.image_url;
      }

      div.appendChild(img);

      var details = document.createElement('div');
      details.className = 'sales-product-details';

      details.innerHTML =
        '<strong>' + escapeHtml(p.name) + '</strong>' +
        '<small>' +
        (categories[p.category] || '') +
        ' / ' +
        (
          p.price_yen == null
            ? '価格未設定'
            : p.price_yen + '円'
        ) +
        (p.is_limited ? ' / 期間限定' : '') +
        (p.available_from ? ' / ' + p.available_from + 'から' : '') +
        (p.available_until ? ' / ' + p.available_until + 'まで' : '') +
        (p.is_active ? '' : ' / 非表示') +
        '</small>';

      div.appendChild(details);

      var actions = document.createElement('div');
      actions.className = 'sales-actions';

      [
        ['編集', () => editProduct(p.id)],
        ['↑', () => moveProduct(p.id, -1)],
        ['↓', () => moveProduct(p.id, 1)],
        ['削除', () => archiveProduct(p.id)]
      ].forEach(pair => {
        var btn = document.createElement('button');

        btn.type = 'button';
        btn.className = 'btn btn-secondary btn-sm';
        btn.textContent = pair[0];

        btn.addEventListener('click', pair[1]);

        actions.appendChild(btn);
      });

      div.appendChild(actions);
      host.appendChild(div);
    });
  }

  // ======================================================
  // 販売状況
  // ======================================================

  async function loadToday(force) {
    if (selectionDirty && !force) return;

    today = await api('/admin/today');
    products = today.products || products;

    renderSales();
  }

  function renderSales() {
    if (!today) return;

    var date = new Date(
      today.day + 'T12:00:00+09:00'
    );

    $('sales-date').textContent =
      new Intl.DateTimeFormat('ja-JP', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        weekday: 'long'
      }).format(date);

    $('sales-phase').textContent = ({
      draft: '準備中',
      live: '配信中',
      paused: '中止中',
      ended: '営業終了'
    })[today.phase] || today.phase;

    $('sales-story').checked = !!today.story_enabled;

    updateInstagramStatus();

    var selected = new Set(
      today.items.map(x => x.product_id)
    );

    if (
      !today.initialized &&
      today.phase === 'draft'
    ) {
      (today.products || []).forEach(p => {
        if (
          p.is_active &&
          !p.is_limited &&
          p.id !== 'other_soup' &&
          (
            !p.available_from ||
            p.available_from <= today.day
          ) &&
          (
            !p.available_until ||
            p.available_until >= today.day
          )
        ) {
          selected.add(p.id);
        }
      });
    }

    var host = $('sales-select-list');
    host.innerHTML = '';

    var order = ['onigiri', 'bento', 'other'];
    var day = today.day;

    var list = (today.products || []).filter(x =>
      x.is_active &&
      (
        !x.available_from ||
        x.available_from <= day
      ) &&
      (
        !x.available_until ||
        x.available_until >= day
      )
    );

    [false, true].forEach(limited => {
      var section = list.filter(
        x => !!x.is_limited === limited
      );

      if (!section.length) return;

      var h = document.createElement('h3');
      h.className = 'sales-list-group';

      h.textContent = limited
        ? '期間限定・数量限定'
        : '定番';

      host.appendChild(h);

      order.forEach(cat => {
        section
          .filter(x => x.category === cat)
          .forEach(p => {
            var label = document.createElement('label');
            label.className = 'sales-pick';

            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.value = p.id;
            cb.checked = selected.has(p.id);

            cb.disabled =
              today.closed_for_today ||
              today.phase === 'ended';

            var text = document.createElement('span');

            text.textContent =
              p.name +
              (
                p.price_yen == null
                  ? ''
                  : ' (' + p.price_yen + '円)'
              );

            label.appendChild(cb);
            label.appendChild(text);
            host.appendChild(label);
          });
      });
    });

    $('sales-update-list').disabled =
      today.closed_for_today ||
      today.phase === 'ended';

    $('sales-start').hidden =
      today.phase !== 'draft';

    $('sales-pause').hidden =
      today.phase !== 'live';

    $('sales-resume').hidden =
      today.phase !== 'paused';

    $('sales-end').hidden =
      !['live', 'paused'].includes(today.phase);

    $('sales-closed').hidden =
      !today.closed_for_today;

    var statusHost = $('sales-status-list');
    statusHost.innerHTML = '';

    today.items.forEach(p => {
      var card = document.createElement('div');
      card.className = 'sales-current';

      var name = document.createElement('strong');
      name.textContent = p.name;

      card.appendChild(name);

      var bar = document.createElement('div');
      bar.className = 'sales-actions';

      Object.entries(statuses).forEach(([value, label]) => {
        var btn = document.createElement('button');

        btn.type = 'button';

        btn.className =
          'btn btn-sm ' +
          (
            p.status === value
              ? 'btn-success is-active'
              : 'btn-secondary'
          );

        btn.textContent = label;

        btn.disabled =
          today.closed_for_today ||
          !['live', 'paused'].includes(today.phase);

        btn.addEventListener(
          'click',
          () => setStatus(p.product_id, value)
        );

        bar.appendChild(btn);
      });

      card.appendChild(bar);
      statusHost.appendChild(card);
    });

    renderBoardPreview(today, false);
    updateGenerateButton();
  }

  async function saveSelection() {
    var ids = [
      ...$('sales-select-list').querySelectorAll('input:checked')
    ].map(x => x.value);

    today = await api('/admin/today', {
      method: 'PUT',
      json: {
        product_ids: ids,
        story_enabled: $('sales-story').checked
      }
    });

    selectionDirty = false;

    await loadToday(true);
  }

  async function updateSelection() {
    try {
      await saveSelection();

      message(
        'sales-message',
        '本日の商品とInstagramストーリー設定を保存しました',
        false
      );

    } catch (e) {
      message(
        'sales-message',
        errorText(e),
        true
      );
    }
  }

  async function doAction(action) {
    if (busy) return;

    if (
      action === 'end' &&
      !confirm(
        '営業を終了しますか？アプリの販売状況画像が消えます。'
      )
    ) {
      return;
    }

    busy = true;

    try {
      if (action === 'start') {
        var ids = [
          ...$('sales-select-list').querySelectorAll('input:checked')
        ];

        if (!ids.length) {
          throw new Error(
            '商品を1つ以上選択してください'
          );
        }

        await saveSelection();
      }

      await api('/admin/today/action', {
        method: 'POST',
        json: { action: action }
      });

      selectionDirty = false;

      await loadToday(true);

      message(
        'sales-message',
        '操作を反映しました。画像はMuseが自動更新します',
        false
      );

    } catch (e) {
      message(
        'sales-message',
        errorText(e),
        true
      );

    } finally {
      busy = false;
    }
  }

  async function setStatus(id, status) {
    if (busy) return;

    busy = true;

    try {
      today = await api(
        '/admin/today/items/' + encodeURIComponent(id),
        {
          method: 'PATCH',
          json: { status: status }
        }
      );

      await loadToday();

      message(
        'sales-message',
        '販売状況を変更しました',
        false
      );

    } catch (e) {
      message(
        'sales-message',
        errorText(e),
        true
      );

    } finally {
      busy = false;
    }
  }

  // ======================================================
  // 追加機能：Instagram設定の見やすさ改善
  // ======================================================

  function updateInstagramStatus() {
    var el = $('sales-instagram-status');

    if (!el || !today) return;

    var selected = $('sales-story').checked;
    var saved = !!today.story_enabled;

    if (selected !== saved) {
      el.textContent = selected
        ? '変更未保存：Instagram反映をONに変更しています'
        : '変更未保存：Instagram反映をOFFに変更しています';

      el.style.color = '#9a5800';
      return;
    }

    el.textContent = saved
      ? '現在の保存設定：ON（Instagram投稿の対象）'
      : '現在の保存設定：OFF（アプリ表示のみ）';

    el.style.color = saved
      ? '#267348'
      : '#555';
  }

  // ======================================================
  // 追加機能：最新画像の表示更新
  // ======================================================

  function imageUrlWithCacheBust(url, force) {
    if (!url) return '';

    if (!force) return url;

    try {
      var u = new URL(url, window.location.href);

      u.searchParams.set(
        '_sales_refresh',
        String(Date.now())
      );

      return u.toString();

    } catch (e) {
      return url;
    }
  }

  function hasPendingBoard(data) {
    if (!data || data.phase !== 'live') {
      return false;
    }

    if (
      data.version == null ||
      data.board_version == null
    ) {
      return false;
    }

    var current = Number(data.version);
    var board = Number(data.board_version);

    return Number.isFinite(current) &&
      Number.isFinite(board) &&
      current > board;
  }

  function renderBoardPreview(data, force) {
    var prev = $('sales-board-preview');

    if (!prev || !data) return;

    prev.replaceChildren();

    var pending = hasPendingBoard(data);

    if (data.board_url) {
      var img = document.createElement('img');

      img.src = imageUrlWithCacheBust(
        data.board_url,
        force
      );

      img.alt = '本日の販売状況画像';

      prev.appendChild(img);

      var info = document.createElement('p');
      info.className = 'sales-note';

      if (
        data.board_version != null &&
        data.version != null
      ) {
        info.textContent =
          '表示画像 version ' +
          data.board_version +
          ' ／ 最新データ version ' +
          data.version +
          (
            pending
              ? '（新しい画像を生成待ち）'
              : ''
          );

      } else {
        info.textContent =
          '現在登録されている画像を表示しています';
      }

      prev.appendChild(info);

    } else {
      var text = document.createElement('p');
      text.className = 'sales-note';

      if (data.phase === 'live') {
        text.textContent =
          'Museによる最新画像の生成待ちです';
      } else {
        text.textContent =
          '現在、画像は公開していません';
      }

      prev.appendChild(text);
    }

    var generated = $('sales-board-generated');

    if (generated) {
      var dateText = data.board_generated_at || '';

      generated.textContent = dateText
        ? '画像生成記録：' + dateText
        : '画像生成時刻：取得できません';
    }
  }

  async function refreshLatestBoard(manual) {
    if (boardRefreshBusy) return;

    boardRefreshBusy = true;

    var btn = $('sales-board-refresh');

    if (btn) {
      btn.disabled = true;
      btn.textContent = '確認中…';
    }

    try {
      var latest = await api('/admin/today');

      // 未保存のチェック状態がある場合、
      // 商品一覧・Instagram設定を上書きしない。
      if (selectionDirty) {
        renderBoardPreview(latest, !!manual);
      } else {
        today = latest;
        products = latest.products || products;

        renderSales();

        if (manual) {
          renderBoardPreview(latest, true);
        }
      }

      if (manual) {
        var note = '';

        if (hasPendingBoard(latest)) {
          note =
            '新しい画像はまだ生成中です。少し後にもう一度確認してください。';
        } else if (latest.board_url) {
          note =
            'Workerから最新の画像情報を再取得しました。';
        } else {
          note =
            '最新情報を確認しました。現在表示できる画像はありません。';
        }

        message(
          'sales-board-message',
          note,
          false
        );
      }

    } catch (e) {
      message(
        'sales-board-message',
        '画像の更新確認に失敗しました：' + errorText(e),
        true
      );

    } finally {
      boardRefreshBusy = false;

      if (btn) {
        btn.disabled = false;
        btn.textContent = '最新画像を更新';
      }
    }
  }

  // ======================================================
  // 追加機能：手動画像再生成
  //
  // Workerが再生成対応を明示した場合だけ有効化する。
  // 現在のv5 Workerでは未対応。
  //
  // 将来必要なWorker仕様：
  // GET /admin/today:
  //   regenerate_supported: true
  //
  // POST /admin/today/action:
  //   { action: "regenerate" }
  //
  // Worker側でversionを更新し、
  // Muse watcherが新versionを検出して画像生成する。
  // ======================================================

  function updateGenerateButton() {
    var btn = $('sales-board-generate');
    var note = $('sales-generate-note');

    if (!btn || !note) return;

    var supported =
      !!today &&
      today.regenerate_supported === true;

    if (!supported) {
      btn.disabled = true;
      btn.textContent = '画像を再生成（準備中）';

      note.textContent =
        '手動再生成はWorker側の対応待ちです。販売状態を変更した場合は、これまでどおりMuseが自動生成します。';

      return;
    }

    var available =
      today.phase === 'live' &&
      !today.closed_for_today &&
      !selectionDirty &&
      !boardGenerationBusy;

    btn.disabled = !available;
    btn.textContent = boardGenerationBusy
      ? '生成依頼中…'
      : '画像を再生成';

    if (selectionDirty) {
      note.textContent =
        '先に「選択・設定を反映」を押して保存してください。';
    } else if (today.phase !== 'live') {
      note.textContent =
        '配信中のみ手動再生成できます。';
    } else {
      note.textContent =
        '現在保存されている販売状況で画像を再生成します。';
    }
  }

  async function requestRegeneration() {
    if (boardGenerationBusy || busy) return;

    if (
      !today ||
      today.regenerate_supported !== true
    ) {
      message(
        'sales-board-message',
        '現在のWorkerは手動再生成に対応していません。',
        true
      );
      return;
    }

    if (selectionDirty) {
      message(
        'sales-board-message',
        '先に選択・設定を保存してください。',
        true
      );
      return;
    }

    if (
      today.phase !== 'live' ||
      today.closed_for_today
    ) {
      message(
        'sales-board-message',
        '配信中のみ画像を再生成できます。',
        true
      );
      return;
    }

    if (
      !confirm(
        '現在の販売状況で画像を再生成しますか？'
      )
    ) {
      return;
    }

    boardGenerationBusy = true;
    updateGenerateButton();

    try {
      await api('/admin/today/action', {
        method: 'POST',
        json: {
          action: 'regenerate'
        }
      });

      message(
        'sales-board-message',
        '再生成を依頼しました。Museによる画像生成と登録を待っています。',
        false
      );

      await loadToday(true);

    } catch (e) {
      message(
        'sales-board-message',
        '再生成依頼に失敗しました：' + errorText(e),
        true
      );

    } finally {
      boardGenerationBusy = false;
      updateGenerateButton();
    }
  }

  // ======================================================
  // UI追加：既存HTMLは変更しない
  // ======================================================

  function setupSalesEnhancements() {
    if ($('sales-board-refresh')) return;

    var style = document.createElement('style');

    style.textContent = `
      #tab-sales .sales-instagram-toggle {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 14px;
        border: 1px solid #d8d8d8;
        border-radius: 10px;
        background: #f8f8f8;
        font-size: 14px;
        line-height: 1.5;
      }

      #tab-sales .sales-instagram-toggle input {
        width: 24px;
        height: 24px;
        flex-shrink: 0;
        margin: 0;
      }

      #tab-sales .sales-instagram-help {
        margin: 4px 0 12px;
        padding: 0 4px;
        font-size: 12px;
        line-height: 1.7;
        color: #555;
      }

      #tab-sales .sales-instagram-status {
        margin: 8px 0 4px;
        font-weight: bold;
        font-size: 13px;
      }

      #tab-sales .sales-board-tools {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px;
        margin: 12px 0;
      }

      #tab-sales .sales-board-tools .btn {
        min-height: 44px;
      }

      #tab-sales .sales-board-message {
        margin: 8px 0;
        font-size: 13px;
        line-height: 1.6;
        white-space: pre-wrap;
      }

      #tab-sales .sales-board-generated {
        margin: 8px 0;
        font-size: 12px;
        color: #666;
        overflow-wrap: anywhere;
      }

      #tab-sales .sales-board-note {
        font-size: 12px;
        line-height: 1.6;
        color: #666;
        margin: 8px 0;
      }

      #tab-sales .sales-board-tools .btn:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
    `;

    document.head.appendChild(style);

    // Instagram設定を分かりやすくする
    var story = $('sales-story');
    var storyLabel = story.closest('label');

    storyLabel.classList.add('sales-instagram-toggle');

    Array.from(storyLabel.childNodes).forEach(node => {
      if (node !== story) {
        node.remove();
      }
    });

    var storyText = document.createElement('strong');
    storyText.textContent =
      'Instagramストーリーにも反映する';

    storyLabel.appendChild(storyText);

    var storyStatus = document.createElement('p');
    storyStatus.id = 'sales-instagram-status';
    storyStatus.className = 'sales-instagram-status';

    storyLabel.insertAdjacentElement(
      'afterend',
      storyStatus
    );

    var storyHelp = document.createElement('p');
    storyHelp.className = 'sales-instagram-help';

    storyHelp.textContent =
      'ON：Instagram投稿の対象にします。' +
      ' OFF：アプリの販売状況だけを更新します。' +
      ' ※現在Instagramへの自動投稿連携は未完成です。' +
      ' ONでも実際には投稿されません。' +
      ' 設定を変更したら「選択・設定を反映」で保存してください。';

    storyStatus.insertAdjacentElement(
      'afterend',
      storyHelp
    );

    // 現在の画像カードに操作ボタンを追加
    var preview = $('sales-board-preview');
    var card = preview.parentElement;

    var tools = document.createElement('div');
    tools.className = 'sales-board-tools';

    var refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.id = 'sales-board-refresh';
    refresh.className = 'btn btn-primary';
    refresh.textContent = '最新画像を更新';

    var generate = document.createElement('button');
    generate.type = 'button';
    generate.id = 'sales-board-generate';
    generate.className = 'btn btn-secondary';
    generate.textContent = '画像を再生成（準備中）';
    generate.disabled = true;

    tools.appendChild(refresh);
    tools.appendChild(generate);

    card.insertBefore(tools, preview);

    var generated = document.createElement('p');
    generated.id = 'sales-board-generated';
    generated.className = 'sales-board-generated';

    card.insertBefore(generated, preview);

    var generateNote = document.createElement('p');
    generateNote.id = 'sales-generate-note';
    generateNote.className = 'sales-board-note';

    generateNote.textContent =
      '手動再生成はWorker側の対応待ちです。';

    card.insertBefore(generateNote, preview);

    var boardMessage = document.createElement('p');
    boardMessage.id = 'sales-board-message';
    boardMessage.className = 'sales-board-message';
    boardMessage.setAttribute('role', 'status');

    card.insertBefore(boardMessage, preview);

    refresh.addEventListener(
      'click',
      () => refreshLatestBoard(true)
    );

    generate.addEventListener(
      'click',
      requestRegeneration
    );
  }

  // ======================================================
  // イベント登録
  // ======================================================

  setupSalesEnhancements();

  $('sales-select-list').addEventListener('change', () => {
    selectionDirty = true;
    updateGenerateButton();
  });

  $('sales-story').addEventListener('change', () => {
    selectionDirty = true;
    updateInstagramStatus();
    updateGenerateButton();
  });

  $('sale-p-photo').addEventListener(
    'change',
    renderPhotoPreview
  );

  $('sale-p-save').addEventListener(
    'click',
    saveProduct
  );

  $('sale-p-cancel').addEventListener(
    'click',
    resetForm
  );

  $('sales-update-list').addEventListener(
    'click',
    updateSelection
  );

  ['start', 'pause', 'resume', 'end'].forEach(k => {
    $('sales-' + k).addEventListener(
      'click',
      () => doAction(k)
    );
  });

  document.querySelectorAll('.tabs .tab-btn')
    .forEach(btn => {
      btn.addEventListener('click', async function () {
        if (
          !['products', 'sales'].includes(btn.dataset.tab)
        ) {
          return;
        }

        try {
          if (btn.dataset.tab === 'products') {
            await loadProducts();
          } else {
            await loadToday();
          }

        } catch (e) {
          message(
            btn.dataset.tab === 'products'
              ? 'sale-p-message'
              : 'sales-message',
            errorText(e),
            true
          );
        }
      });
    });

  // 60秒間隔の自動確認を維持する。
  // 未保存の操作がある場合は画像だけを確認し、
  // チェックボックスの選択状態は消さない。
  setInterval(function () {
    var tab = document.querySelector(
      '#tab-sales.active'
    );

    var loggedIn =
      typeof AUTH_TOKEN !== 'undefined' &&
      AUTH_TOKEN;

    if (
      !tab ||
      document.visibilityState !== 'visible' ||
      !loggedIn
    ) {
      return;
    }

    if (selectionDirty) {
      refreshLatestBoard(false).catch(e => {
        message(
          'sales-board-message',
          errorText(e),
          true
        );
      });
    } else {
      loadToday().catch(e => {
        message(
          'sales-message',
          errorText(e),
          true
        );
      });
    }
  }, 60000);

})();
