/* ============================================================
 * pet-widget.js ? ??A ?????Fuwari / Astro ???????
 *
 * ???
 *   1. ????? + ?? + ?? + ?????? blink ???????????
 *   2. ??/?? idleTime(??30?) ??? -> ??????????
 *   3. ?????????????????????? + ????????
 *   4. ???????????????? returnToDock:true ?????
 *
 * ???????????? window.PetWidgetConfig
 * ============================================================ */
(function () {
  'use strict';

  var DEFAULTS = {
    dock: 'bottom-right',       // bottom-right | bottom-left | top-right | top-left
    offsetX: 18,
    offsetY: 18,
    size: 220,                  // ?????? px
    idleTime: 30000,            // ???????? (ms)
    blinkMin: 2500,
    blinkMax: 6500,
    returnToDock: false,        // ???????????true ?????
    respectReducedMotion: true, // ??????????????
    hideOnMobile: false,        // ??(<640px)????
    zIndex: 9999,
    humAudio: '',               // ???? URL???????????????
    assets: {
      standing: 'assets/standing.png',       // ????
      blink: 'assets/blink.png',             // ?????????
      sitting: 'assets/sitting.png',         // ??
      sittingClosed: '',                     // ???????
      lifted: 'assets/lifted.png'            // ??????
    },
    debug: false
  };

  function merge(base, extra) {
    var out = {}, k;
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    if (extra) for (k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) {
      var bv = base[k], ev = extra[k];
      out[k] = (bv && ev && typeof bv === 'object' && !Array.isArray(bv) && typeof ev === 'object' && !Array.isArray(ev))
        ? merge(bv, ev) : ev;
    }
    return out;
  }

  function readUrlParams() {
    var out = {}, qs, pairs, i, kv, key, val;
    try {
      qs = (window.location.search || '').replace(/^\?/, '');
      pairs = qs.split('&');
      for (i = 0; i < pairs.length; i++) {
        if (!pairs[i]) continue;
        kv = pairs[i].split('=');
        key = decodeURIComponent(kv[0]);
        val = decodeURIComponent(kv.slice(1).join('=') || '');
        if (/^(idle|size|blinkmin|blinkmax|offsetx|offsety|zindex)$/i.test(key)) {
          out[key.toLowerCase()] = Number(val) || 0;
        }
      }
    } catch (e) { /* ignore */ }
    return out;
  }

  var cfg = merge(DEFAULTS, window.PetWidgetConfig || {});
  var params = readUrlParams();
  if (params.idle) cfg.idleTime = params.idle;
  if (params.size) cfg.size = params.size;
  if (params.offsetx) cfg.offsetX = params.offsetx;
  if (params.offsety) cfg.offsetY = params.offsety;

  var root, stage, body, img, notes;
  var state = 'standing';               // standing | sitting | lifted | dropping
  var dragging = false;
  var idleTimer = null, blinkTimer = null, rafId = null, fadeTimer = null;
  var assets = {};                      // name -> {ok, el}
  var dockPos = { left: 0, top: 0 };
  var dragCur = { x: 0, y: 0 }, dragTarget = { x: 0, y: 0 };
  var lastX = 0, lastVX = 0, swingRot = 0;
  var userInteracted = false;
  var audio = null;
  var instance = null;

  function log() {
    if (cfg.debug) console.log.apply(console, ['[pet-widget]'].concat([].slice.call(arguments)));
  }

  function preload(src) {
    return new Promise(function (resolve) {
      var el = new Image();
      el.onload = function () { resolve({ ok: true, el: el }); };
      el.onerror = function () { resolve({ ok: false, el: null }); };
      el.src = src;
    });
  }

  function swapImg(src, fade) {
    if (!src) return;
    if (!fade) {
      // ????????????????????????
      clearTimeout(fadeTimer);
      if (img.getAttribute('src') !== src) img.setAttribute('src', src);
      img.style.opacity = '1';
      return;
    }
    if (img.getAttribute('src') === src) return;   // ??????????
    clearTimeout(fadeTimer);
    img.style.opacity = '0';
    fadeTimer = setTimeout(function () {
      img.setAttribute('src', src);
      img.style.opacity = '1';
      fadeTimer = null;
    }, 180);
  }

  function getDockPos() {
    var s = cfg.size, o = { left: 0, top: 0 }, d = cfg.dock;
    o.left = (d.indexOf('left') === 0) ? cfg.offsetX : window.innerWidth - cfg.offsetX - s;
    o.top = (d.indexOf('top') === 0) ? cfg.offsetY : window.innerHeight - cfg.offsetY - s;
    return o;
  }

  /* ---------- ??? ---------- */

  function enterSitting() {
    if (state !== 'standing') return;
    state = 'sitting';
    clearTimeout(blinkTimer);
    body.classList.add('sitting');
    var src = (cfg.assets.sittingClosed && assets.sittingClosed && assets.sittingClosed.ok)
      ? cfg.assets.sittingClosed : cfg.assets.sitting;
    swapImg(src, true);
    notes.classList.add('on');
    if (cfg.humAudio && audio && userInteracted) audio.play().catch(function () {});
    log('enterSitting');
  }

  function wake() {
    if (state !== 'sitting') return;
    state = 'standing';
    body.classList.remove('sitting');
    notes.classList.remove('on');
    swapImg(cfg.assets.standing, true);
    if (audio) audio.pause();
    resetIdle();
    scheduleBlink();
    log('wake');
  }

  function resetIdle() {
    clearTimeout(idleTimer);
    if (state !== 'standing') return;
    idleTimer = setTimeout(function () {
      if (state !== 'standing') return;
      // 标签页不可见时不丢弃坐下动作，改为推迟重试，回到可见状态后自动坐下
      if (document.hidden) { resetIdle(); return; }
      enterSitting();
    }, cfg.idleTime);
  }

  function scheduleBlink() {
    clearTimeout(blinkTimer);
    if (state !== 'standing') return;
    var delay = cfg.blinkMin + Math.random() * (cfg.blinkMax - cfg.blinkMin);
    blinkTimer = setTimeout(blinkNow, delay);
  }

  function blinkNow() {
    if (state !== 'standing' || document.hidden) { scheduleBlink(); return; }
    if (assets.blink && assets.blink.ok) {
      swapImg(cfg.assets.blink, false);
      setTimeout(function () {
        if (state === 'standing') swapImg(cfg.assets.standing, false);
        scheduleBlink();
      }, 150);
    } else {
      body.classList.add('squash');
      setTimeout(function () {
        body.classList.remove('squash');
        scheduleBlink();
      }, 160);
    }
  }

  /* ---------- ????????? ---------- */

  function startDrag(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;   // ???
    dragging = true;
    state = 'lifted';
    clearTimeout(idleTimer);
    clearTimeout(blinkTimer);
    root.classList.add('dragging');
    body.classList.add('lifted');
    var rect = root.getBoundingClientRect();
    dragCur.x = rect.left; dragCur.y = rect.top;
    dragTarget.x = e.clientX - cfg.size / 2;   // ??????????????
    dragTarget.y = e.clientY;
    lastX = e.clientX; lastVX = 0; swingRot = 0;
    if (assets.lifted && assets.lifted.ok) swapImg(cfg.assets.lifted, false);
    root.style.left = dragCur.x + 'px';
    root.style.top = dragCur.y + 'px';
    if (stage.setPointerCapture) { try { stage.setPointerCapture(e.pointerId); } catch (err) {} }
    if (!rafId) tick();
    e.preventDefault();
    log('lifted');
  }

  function onMove(e) {
    if (!dragging) return;
    lastVX = e.clientX - lastX;
    lastX = e.clientX;
    dragTarget.x = e.clientX - cfg.size / 2;
    dragTarget.y = e.clientY;
  }

  function tick() {
    if (!dragging) { rafId = null; return; }
    dragCur.x += (dragTarget.x - dragCur.x) * 0.32;
    dragCur.y += (dragTarget.y - dragCur.y) * 0.32;
    // ???????????????
    var maxX = window.innerWidth - cfg.size;
    var maxY = window.innerHeight - cfg.size;
    dragCur.x = Math.max(0, Math.min(maxX, dragCur.x));
    dragCur.y = Math.max(0, Math.min(maxY, dragCur.y));
    root.style.left = dragCur.x + 'px';
    root.style.top = dragCur.y + 'px';
    // ?????????????????? CSS ????????????????
    var target = Math.max(-20, Math.min(20, lastVX * 0.5));
    swingRot += (target - swingRot) * 0.14;
    body.style.transform = 'rotate(' + swingRot.toFixed(2) + 'deg)';
    rafId = requestAnimationFrame(tick);
  }

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    state = 'dropping';
    root.classList.remove('dragging');
    body.classList.remove('lifted');
    body.style.transform = '';
    swingRot = 0;
    if (cfg.returnToDock) {
      dockPos = getDockPos();
      root.classList.add('returning');
      root.style.left = dockPos.left + 'px';
      root.style.top = dockPos.top + 'px';
    }
    // ???????????????
    body.classList.add('drop');
    setTimeout(function () {
      body.classList.remove('drop');
      finishDrop();
    }, 500);
    log('drop');
  }

  function finishDrop() {
    root.classList.remove('returning');
    state = 'standing';
    swapImg(cfg.assets.standing, true);
    resetIdle();
    scheduleBlink();
  }

  /* ---------- ?? ---------- */

  function init() {
    root = document.getElementById('pet-widget');
    if (!root) {
      root = document.createElement('div');
      root.id = 'pet-widget';
      document.body.appendChild(root);
    }
    root.className = 'pet-widget dock-' + cfg.dock;
    root.style.setProperty('--pet-size', cfg.size + 'px');
    root.style.setProperty('--pet-offset-x', cfg.offsetX + 'px');
    root.style.setProperty('--pet-offset-y', cfg.offsetY + 'px');
    root.style.zIndex = cfg.zIndex;

    if (cfg.hideOnMobile && window.matchMedia('(max-width: 640px)').matches) {
      root.style.display = 'none';
      return;
    }
    if (cfg.respectReducedMotion && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      root.classList.add('reduced-motion');
    }

    root.innerHTML =
      '<div class="pet-stage" role="img" aria-label="?????">' +
        '<div class="pet-body">' +
          '<img class="pet-img" alt="" draggable="false">' +
          '<div class="pet-notes"><span>&#9834;</span><span>&#9835;</span></div>' +
        '</div>' +
      '</div>';

    stage = root.querySelector('.pet-stage');
    body = root.querySelector('.pet-body');
    img = root.querySelector('.pet-img');
    notes = root.querySelector('.pet-notes');

    if (cfg.humAudio) {
      audio = new Audio(cfg.humAudio);
      audio.loop = true;
      audio.volume = 0.5;
    }

    var names = ['standing', 'blink', 'sitting', 'sittingClosed', 'lifted'];
    var toLoad = names.filter(function (n) { return !!cfg.assets[n]; });
    Promise.all(toLoad.map(function (n) {
      return preload(cfg.assets[n]).then(function (res) {
        assets[n] = res;
        if (!res.ok) log('asset load failed:', n, cfg.assets[n]);
      });
    })).then(function () {
      var first = (assets.standing && assets.standing.ok) ? cfg.assets.standing : cfg.assets.sitting;
      img.setAttribute('src', first);
      instance.ready = true;
      resetIdle();
      scheduleBlink();
    });

    stage.addEventListener('pointerenter', function () {
      if (state === 'sitting') wake();
      else if (state === 'standing') resetIdle();
    });
    stage.addEventListener('pointerdown', startDrag);
    stage.addEventListener('pointermove', onMove);
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);

    window.addEventListener('pointerdown', function () { userInteracted = true; }, true);
    window.addEventListener('resize', function () {
      if (state === 'lifted' || dragging) return;
      if (cfg.returnToDock) {
        dockPos = getDockPos();
        root.classList.add('returning');
        root.style.left = dockPos.left + 'px';
        root.style.top = dockPos.top + 'px';
        setTimeout(function () { root.classList.remove('returning'); }, 600);
      } else if (root.style.left) {
        // ????????????????
        var s = cfg.size;
        var x = parseFloat(root.style.left) || 0;
        var y = parseFloat(root.style.top) || 0;
        root.style.left = Math.max(0, Math.min(window.innerWidth - s, x)) + 'px';
        root.style.top = Math.max(0, Math.min(window.innerHeight - s, y)) + 'px';
      }
    });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && state === 'standing') { resetIdle(); scheduleBlink(); }
    });
  }

  instance = {
    ready: false,
    getState: function () { return state; },
    sit: function () { if (state === 'standing') enterSitting(); return state; },
    wake: function () { if (state === 'sitting') wake(); return state; },
    blink: function () { blinkNow(); },
    setConfig: function (patch) { cfg = merge(cfg, patch || {}); }
  };
  window.__petWidget = instance;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
