/*
 * VVelcom Mini Apps SDK — include it in your mini app's <head>:
 *   <script src="https://<api-domain>/bot-platform/js/vvelcom-web-app.js"></script>
 *
 * Exposes window.VVelcom.WebApp. Its API and the wire protocol with the app (postEvent /
 * receiveEvent, the #tgWebAppData launch parameters) follow Telegram Mini Apps, so an existing
 * mini app ports over unchanged; the same object is also exposed as window.Telegram.WebApp when
 * that isn't defined yet. Written independently for the VVelcom messenger — nothing here talks to
 * Telegram.
 */
(function () {
  'use strict';
  if (window.VVelcom && window.VVelcom.WebApp) return;

  var VERSION = '8.0';

  // --- launch parameters (URL hash, as the app passes them) ----------------------------------
  function readLaunchParams() {
    var out = {};
    try {
      var hash = window.location.hash.replace(/^#/, '');
      var params = new URLSearchParams(hash);
      params.forEach(function (value, key) {
        out[key] = value;
      });
      if (out.tgWebAppData || out.vvWebAppData) sessionStorage.setItem('__vv_launch', hash);
      else {
        var saved = sessionStorage.getItem('__vv_launch');
        if (saved) new URLSearchParams(saved).forEach(function (value, key) { out[key] = value; });
      }
    } catch (e) {}
    return out;
  }
  var launch = readLaunchParams();
  var param = function (name) {
    return launch['vvWebApp' + name] || launch['tgWebApp' + name] || '';
  };

  var initData = param('Data');
  var initDataUnsafe = {};
  try {
    new URLSearchParams(initData).forEach(function (value, key) {
      if (key === 'user' || key === 'receiver' || key === 'chat') {
        try { initDataUnsafe[key] = JSON.parse(value); } catch (e) {}
      } else if (key === 'auth_date' || key === 'can_send_after') {
        initDataUnsafe[key] = parseInt(value, 10);
      } else {
        initDataUnsafe[key] = value;
      }
    });
  } catch (e) {}

  var themeParams = {};
  try { themeParams = JSON.parse(param('ThemeParams') || '{}'); } catch (e) {}

  // --- transport -----------------------------------------------------------------------------
  var isIframe = window.parent !== window;
  function postEvent(eventType, eventData) {
    var data = eventData === undefined ? '' : JSON.stringify(eventData);
    var proxy = window.VVelcomWebviewProxy || window.TelegramWebviewProxy;
    if (proxy && proxy.postEvent) {
      proxy.postEvent(eventType, data);
    } else if (window.external && window.external.notify) {
      window.external.notify(JSON.stringify({ eventType: eventType, eventData: eventData }));
    } else if (isIframe) {
      window.parent.postMessage(JSON.stringify({ eventType: eventType, eventData: eventData }), '*');
    }
  }

  var handlers = {};
  function emit(eventType, data) {
    (handlers[eventType] || []).slice().forEach(function (fn) {
      try { fn.call(WebApp, data); } catch (e) { setTimeout(function () { throw e; }); }
    });
  }

  function receiveEvent(eventType, eventData) {
    switch (eventType) {
      case 'theme_changed':
        if (eventData && eventData.theme_params) {
          themeParams = eventData.theme_params;
          applyThemeVars();
        }
        emit('themeChanged');
        break;
      case 'viewport_changed':
        if (eventData) {
          if (typeof eventData.height === 'number') viewportHeight = eventData.height;
          if (eventData.is_state_stable) viewportStableHeight = viewportHeight;
          if (typeof eventData.is_expanded === 'boolean') isExpanded = eventData.is_expanded;
          setCssVar('--tg-viewport-height', viewportHeight + 'px');
          setCssVar('--tg-viewport-stable-height', viewportStableHeight + 'px');
          emit('viewportChanged', { isStateStable: Boolean(eventData.is_state_stable) });
        }
        break;
      case 'visibility_changed':
        isActive = Boolean(eventData && eventData.is_visible);
        emit(isActive ? 'activated' : 'deactivated');
        break;
      case 'safe_area_changed':
        safeAreaInset = normalizeInsets(eventData);
        applyInsetVars('--tg-safe-area-inset-', safeAreaInset);
        emit('safeAreaChanged');
        break;
      case 'content_safe_area_changed':
        contentSafeAreaInset = normalizeInsets(eventData);
        applyInsetVars('--tg-content-safe-area-inset-', contentSafeAreaInset);
        emit('contentSafeAreaChanged');
        break;
      case 'fullscreen_changed':
        isFullscreen = Boolean(eventData && eventData.is_fullscreen);
        emit('fullscreenChanged');
        break;
      case 'fullscreen_failed':
        emit('fullscreenFailed', { error: eventData && eventData.error });
        break;
      case 'home_screen_added':
        emit('homeScreenAdded');
        break;
      case 'home_screen_failed':
        emit('homeScreenFailed', { error: eventData && eventData.error });
        break;
      case 'home_screen_checked': {
        var homeStatus = (eventData && eventData.status) || 'unknown';
        finishHomeScreenCheck(homeStatus);
        emit('homeScreenChecked', { status: homeStatus });
        break;
      }
      case 'main_button_pressed':
        emit('mainButtonClicked');
        break;
      case 'secondary_button_pressed':
        emit('secondaryButtonClicked');
        break;
      case 'back_button_pressed':
        emit('backButtonClicked');
        break;
      case 'settings_button_pressed':
        emit('settingsButtonClicked');
        break;
      case 'popup_closed': {
        var buttonId = eventData && eventData.button_id != null ? eventData.button_id : null;
        var cb = popupCallback;
        popupCallback = null;
        if (cb) cb(buttonId);
        emit('popupClosed', { button_id: buttonId });
        break;
      }
      case 'users_request_opened': {
        var opened = usersCallbacks[eventData && eventData.req_id];
        if (opened) clearTimeout(opened.timer);
        break;
      }
      case 'users_requested': {
        var waiting = usersCallbacks[eventData && eventData.req_id];
        if (waiting) {
          delete usersCallbacks[eventData.req_id];
          clearTimeout(waiting.timer);
          var shared = eventData.status === 'shared' && Array.isArray(eventData.users) ? eventData.users : null;
          waiting.callback(shared, shared ? null : 'cancelled');
        }
        emit('usersRequested', eventData || {});
        break;
      }
      case 'feed_shared': {
        var feedCb = feedCallback;
        feedCallback = null;
        var feedStatus = (eventData && eventData.status) || 'failed';
        if (feedCb) feedCb(feedStatus);
        emit('feedShared', { status: feedStatus });
        break;
      }
      case 'custom_method_invoked': {
        var pending = customCallbacks[eventData && eventData.req_id];
        if (pending) {
          delete customCallbacks[eventData.req_id];
          pending(eventData.error || null, eventData.result);
        }
        break;
      }
    }
  }

  // Both names, for pages loaded with either SDK.
  window.VVelcom = window.VVelcom || {};
  window.VVelcom.WebView = { receiveEvent: receiveEvent, postEvent: postEvent };
  window.Telegram = window.Telegram || {};
  if (!window.Telegram.WebView) window.Telegram.WebView = window.VVelcom.WebView;
  if (isIframe) {
    window.addEventListener('message', function (event) {
      if (event.source !== window.parent) return;
      try {
        var msg = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (msg && msg.eventType) receiveEvent(msg.eventType, msg.eventData);
      } catch (e) {}
    });
  }

  // --- state ----------------------------------------------------------------------------------
  var viewportHeight = window.innerHeight;
  var viewportStableHeight = window.innerHeight;
  var isExpanded = true;
  var isActive = true;
  var isFullscreen = false;
  var isClosingConfirmationEnabled = false;
  var isVerticalSwipesEnabled = true;
  var headerColor = themeParams.header_bg_color || themeParams.bg_color || '#000000';
  var backgroundColor = themeParams.bg_color || '#000000';
  var bottomBarColor = themeParams.bottom_bar_bg_color || backgroundColor;
  var safeAreaInset = { top: 0, bottom: 0, left: 0, right: 0 };
  var contentSafeAreaInset = { top: 0, bottom: 0, left: 0, right: 0 };
  var feedCallback = null;
  var popupCallback = null;
  var customCallbacks = {};
  var reqCounter = 0;

  function normalizeInsets(data) {
    data = data || {};
    return { top: data.top || 0, bottom: data.bottom || 0, left: data.left || 0, right: data.right || 0 };
  }
  function setCssVar(name, value) {
    try { document.documentElement.style.setProperty(name, value); } catch (e) {}
  }
  function applyThemeVars() {
    Object.keys(themeParams).forEach(function (key) {
      setCssVar('--tg-theme-' + key.replace(/_/g, '-'), themeParams[key]);
    });
    setCssVar('--tg-color-scheme', WebApp.colorScheme);
  }
  function applyInsetVars(prefix, insets) {
    ['top', 'bottom', 'left', 'right'].forEach(function (side) { setCssVar(prefix + side, insets[side] + 'px'); });
  }
  function isDark(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return true;
    var n = parseInt(m[1], 16);
    var lum = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
    return lum < 128;
  }
  function colorValue(color) {
    if (color === 'bg_color' || color === 'secondary_bg_color' || color === 'bottom_bar_bg_color') {
      return themeParams[color] || null;
    }
    return /^#[0-9a-f]{6}$/i.test(color || '') ? color : null;
  }

  // --- bottom buttons ---------------------------------------------------------------------------
  function BottomButton(type) {
    var isMain = type === 'main';
    var state = {
      type: type,
      text: isMain ? 'Продолжить' : 'Отмена',
      color: isMain ? themeParams.button_color || '#3D9BF5' : themeParams.bottom_bar_bg_color || '#151F2D',
      textColor: isMain ? themeParams.button_text_color || '#FFFFFF' : themeParams.button_color || '#3D9BF5',
      isVisible: false,
      isActive: true,
      isProgressVisible: false,
      hasShineEffect: false,
      position: 'left',
      iconCustomEmojiId: '',
    };
    var button = {};
    function sync() {
      var payload = {
        is_visible: state.isVisible,
        is_active: state.isActive,
        is_progress_visible: state.isProgressVisible,
        text: state.text,
        color: state.color,
        text_color: state.textColor,
        has_shine_effect: state.hasShineEffect,
      };
      if (!isMain) payload.position = state.position;
      postEvent(isMain ? 'web_app_setup_main_button' : 'web_app_setup_secondary_button', payload);
    }
    Object.keys(state).forEach(function (key) {
      Object.defineProperty(button, key, {
        enumerable: true,
        get: function () { return state[key]; },
        set: function (value) { var p = {}; p[key] = value; button.setParams(p); },
      });
    });
    var clickEvent = isMain ? 'mainButtonClicked' : 'secondaryButtonClicked';
    button.setText = function (text) { return button.setParams({ text: text }); };
    button.onClick = function (fn) { WebApp.onEvent(clickEvent, fn); return button; };
    button.offClick = function (fn) { WebApp.offEvent(clickEvent, fn); return button; };
    button.show = function () { return button.setParams({ is_visible: true }); };
    button.hide = function () { return button.setParams({ is_visible: false }); };
    button.enable = function () { return button.setParams({ is_active: true }); };
    button.disable = function () { return button.setParams({ is_active: false }); };
    button.showProgress = function () { state.isProgressVisible = true; sync(); return button; };
    button.hideProgress = function () { state.isProgressVisible = false; sync(); return button; };
    button.setParams = function (params) {
      params = params || {};
      if (params.text !== undefined) state.text = String(params.text).trim().slice(0, 64) || state.text;
      if (params.color !== undefined) state.color = colorValue(params.color) || state.color;
      if (params.text_color !== undefined) state.textColor = colorValue(params.text_color) || state.textColor;
      if (params.textColor !== undefined) state.textColor = colorValue(params.textColor) || state.textColor;
      if (params.is_visible !== undefined) state.isVisible = Boolean(params.is_visible);
      if (params.isVisible !== undefined) state.isVisible = Boolean(params.isVisible);
      if (params.is_active !== undefined) state.isActive = Boolean(params.is_active);
      if (params.isActive !== undefined) state.isActive = Boolean(params.isActive);
      if (params.has_shine_effect !== undefined) state.hasShineEffect = Boolean(params.has_shine_effect);
      if (params.position !== undefined) state.position = params.position;
      sync();
      return button;
    };
    return button;
  }

  function simpleButton(eventName, clickEvent) {
    var visible = false;
    var button = {};
    Object.defineProperty(button, 'isVisible', {
      enumerable: true,
      get: function () { return visible; },
      set: function (value) { value ? button.show() : button.hide(); },
    });
    button.onClick = function (fn) { WebApp.onEvent(clickEvent, fn); return button; };
    button.offClick = function (fn) { WebApp.offEvent(clickEvent, fn); return button; };
    button.show = function () { visible = true; postEvent(eventName, { is_visible: true }); return button; };
    button.hide = function () { visible = false; postEvent(eventName, { is_visible: false }); return button; };
    return button;
  }

  // requestUsers: the app opens its own "pick people" list (contacts + search) and hands back the
  // ones chosen. VVelcom's own extension (Telegram has no such mini app method). An app that
  // doesn't know it never answers "opened" — then the callback gets (null, 'unsupported').
  var usersCallbacks = {};
  function requestUsers(params, callback) {
    params = params || {};
    callback = callback || function () {};
    var reqId = 'vu' + ++reqCounter + '_' + Date.now();
    usersCallbacks[reqId] = {
      callback: callback,
      timer: setTimeout(function () {
        delete usersCallbacks[reqId];
        callback(null, 'unsupported');
      }, 1500),
    };
    postEvent('web_app_request_users', {
      req_id: reqId,
      max_quantity: Math.max(1, Math.min(100, parseInt(params.max_quantity, 10) || 10)),
      title: String(params.title || '').slice(0, 64),
      button_text: String(params.button_text || '').slice(0, 64),
      exclude_user_ids: Array.isArray(params.exclude_user_ids) ? params.exclude_user_ids.slice(0, 200).map(String) : [],
    });
  }

  // checkHomeScreenStatus: an app too old to know web_app_check_home_screen never answers, so
  // after a short wait the callbacks get 'unsupported' instead of hanging forever.
  var homeScreenCallbacks = [];
  var homeScreenTimer = null;
  function finishHomeScreenCheck(status) {
    clearTimeout(homeScreenTimer);
    homeScreenTimer = null;
    var callbacks = homeScreenCallbacks;
    homeScreenCallbacks = [];
    callbacks.forEach(function (cb) { cb(status); });
  }
  function checkHomeScreenStatus(callback) {
    if (callback) homeScreenCallbacks.push(callback);
    if (homeScreenTimer) return;
    homeScreenTimer = setTimeout(function () { finishHomeScreenCheck('unsupported'); }, 1500);
    postEvent('web_app_check_home_screen');
  }

  function invokeCustomMethod(method, params, callback) {
    var reqId = 'vv' + ++reqCounter + '_' + Date.now();
    customCallbacks[reqId] = callback || function () {};
    postEvent('web_app_invoke_custom_method', { req_id: reqId, method: method, params: params || {} });
  }

  var CloudStorage = {
    setItem: function (key, value, callback) {
      invokeCustomMethod('saveStorageValue', { key: key, value: String(value) }, function (err, res) {
        if (callback) callback(err, err ? undefined : Boolean(res));
      });
      return CloudStorage;
    },
    getItem: function (key, callback) {
      return CloudStorage.getItems([key], function (err, values) {
        if (callback) callback(err, err ? undefined : values[key]);
      });
    },
    getItems: function (keys, callback) {
      invokeCustomMethod('getStorageValues', { keys: keys }, function (err, res) {
        if (callback) callback(err, err ? undefined : res || {});
      });
      return CloudStorage;
    },
    removeItem: function (key, callback) {
      return CloudStorage.removeItems([key], callback);
    },
    removeItems: function (keys, callback) {
      invokeCustomMethod('deleteStorageValues', { keys: keys }, function (err, res) {
        if (callback) callback(err, err ? undefined : Boolean(res));
      });
      return CloudStorage;
    },
    getKeys: function (callback) {
      invokeCustomMethod('getStorageKeys', {}, function (err, res) {
        if (callback) callback(err, err ? undefined : res || []);
      });
      return CloudStorage;
    },
  };

  var HapticFeedback = {
    impactOccurred: function (style) {
      postEvent('web_app_trigger_haptic_feedback', { type: 'impact', impact_style: style });
      return HapticFeedback;
    },
    notificationOccurred: function (type) {
      postEvent('web_app_trigger_haptic_feedback', { type: 'notification', notification_type: type });
      return HapticFeedback;
    },
    selectionChanged: function () {
      postEvent('web_app_trigger_haptic_feedback', { type: 'selection_change' });
      return HapticFeedback;
    },
  };

  function versionAtLeast(version) {
    var a = String(VERSION).split('.'), b = String(version).split('.');
    for (var i = 0; i < Math.max(a.length, b.length); i++) {
      var x = parseInt(a[i] || '0', 10), y = parseInt(b[i] || '0', 10);
      if (x !== y) return x > y;
    }
    return true;
  }

  // --- the WebApp object ------------------------------------------------------------------------
  var WebApp = {
    initData: initData,
    initDataUnsafe: initDataUnsafe,
    version: VERSION,
    platform: param('Platform') || 'unknown',
    get colorScheme() { return isDark(themeParams.bg_color) ? 'dark' : 'light'; },
    get themeParams() { return themeParams; },
    get isActive() { return isActive; },
    get isExpanded() { return isExpanded; },
    get viewportHeight() { return viewportHeight; },
    get viewportStableHeight() { return viewportStableHeight; },
    get headerColor() { return headerColor; },
    get backgroundColor() { return backgroundColor; },
    get bottomBarColor() { return bottomBarColor; },
    get isClosingConfirmationEnabled() { return isClosingConfirmationEnabled; },
    get isVerticalSwipesEnabled() { return isVerticalSwipesEnabled; },
    get isFullscreen() { return isFullscreen; },
    isOrientationLocked: false,
    get safeAreaInset() { return safeAreaInset; },
    get contentSafeAreaInset() { return contentSafeAreaInset; },
    BackButton: null,
    MainButton: null,
    SecondaryButton: null,
    SettingsButton: null,
    HapticFeedback: HapticFeedback,
    CloudStorage: CloudStorage,
    isVersionAtLeast: versionAtLeast,
    setHeaderColor: function (color) {
      var key = color === 'bg_color' || color === 'secondary_bg_color' ? color : null;
      headerColor = colorValue(color) || headerColor;
      postEvent('web_app_set_header_color', key ? { color_key: key } : { color: headerColor });
    },
    setBackgroundColor: function (color) {
      backgroundColor = colorValue(color) || backgroundColor;
      postEvent('web_app_set_background_color', { color: backgroundColor });
    },
    setBottomBarColor: function (color) {
      bottomBarColor = colorValue(color) || bottomBarColor;
      postEvent('web_app_set_bottom_bar_color', { color: bottomBarColor });
    },
    enableClosingConfirmation: function () {
      isClosingConfirmationEnabled = true;
      postEvent('web_app_setup_closing_behavior', { need_confirmation: true });
    },
    disableClosingConfirmation: function () {
      isClosingConfirmationEnabled = false;
      postEvent('web_app_setup_closing_behavior', { need_confirmation: false });
    },
    enableVerticalSwipes: function () {
      isVerticalSwipesEnabled = true;
      postEvent('web_app_setup_swipe_behavior', { allow_vertical_swipe: true });
    },
    disableVerticalSwipes: function () {
      isVerticalSwipesEnabled = false;
      postEvent('web_app_setup_swipe_behavior', { allow_vertical_swipe: false });
    },
    requestFullscreen: function () { postEvent('web_app_request_fullscreen'); },
    exitFullscreen: function () { postEvent('web_app_exit_fullscreen'); },
    lockOrientation: function () {},
    unlockOrientation: function () {},
    addToHomeScreen: function () { postEvent('web_app_add_to_home_screen'); },
    // callback(status): 'unsupported' | 'unknown' | 'added' | 'missed'.
    checkHomeScreenStatus: checkHomeScreenStatus,
    onEvent: function (eventType, fn) {
      (handlers[eventType] = handlers[eventType] || []).push(fn);
    },
    offEvent: function (eventType, fn) {
      handlers[eventType] = (handlers[eventType] || []).filter(function (h) { return h !== fn; });
    },
    sendData: function (data) {
      if (!data || String(data).length > 4096) throw new Error('WebAppDataInvalid');
      postEvent('web_app_data_send', { data: String(data) });
    },
    switchInlineQuery: function () { throw new Error('WebAppMethodUnsupported'); },
    openLink: function (url, options) {
      postEvent('web_app_open_link', { url: String(url), try_instant_view: Boolean(options && options.try_instant_view) });
    },
    // Publishes `text` (up to 2000 characters) to the person's own «Глобал» feed — after the app shows
    // them exactly what goes out and they confirm. callback(status): 'published' | 'cancelled' | 'failed'.
    shareToFeed: function (text, callback) {
      text = String(text == null ? '' : text);
      if (!text.trim() || text.length > 2000) throw new Error('WebAppFeedTextInvalid');
      feedCallback = callback || null;
      postEvent('web_app_share_to_feed', { text: text });
    },
    openTelegramLink: function (url) {
      var a = document.createElement('a');
      a.href = url;
      postEvent('web_app_open_tg_link', { path_full: a.pathname + a.search });
    },
    // callback(users, error): users — [{ id, username, display_name }] or null (cancelled / unsupported).
    requestUsers: requestUsers,
    openInvoice: function () { throw new Error('WebAppMethodUnsupported'); },
    shareToStory: function () { throw new Error('WebAppMethodUnsupported'); },
    showPopup: function (params, callback) {
      params = params || {};
      var buttons = (params.buttons && params.buttons.length ? params.buttons : [{ type: 'close' }]).slice(0, 3);
      popupCallback = callback || null;
      postEvent('web_app_open_popup', {
        title: String(params.title || '').slice(0, 64),
        message: String(params.message || '').slice(0, 256),
        buttons: buttons.map(function (b) {
          return { id: String(b.id || ''), type: b.type || 'default', text: String(b.text || '') };
        }),
      });
    },
    showAlert: function (message, callback) {
      WebApp.showPopup({ message: message }, callback ? function () { callback(); } : null);
    },
    showConfirm: function (message, callback) {
      WebApp.showPopup(
        { message: message, buttons: [{ type: 'ok', id: 'ok' }, { type: 'cancel' }] },
        callback ? function (id) { callback(id === 'ok'); } : null,
      );
    },
    ready: function () { postEvent('web_app_ready'); },
    expand: function () { postEvent('web_app_expand'); },
    close: function (options) { postEvent('web_app_close', { return_back: Boolean(options && options.return_back) }); },
    hideKeyboard: function () {
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    },
  };
  WebApp.MainButton = BottomButton('main');
  WebApp.SecondaryButton = BottomButton('secondary');
  WebApp.BackButton = simpleButton('web_app_setup_back_button', 'backButtonClicked');
  WebApp.SettingsButton = simpleButton('web_app_setup_settings_button', 'settingsButtonClicked');

  window.VVelcom.WebApp = WebApp;
  if (!window.Telegram.WebApp) window.Telegram.WebApp = WebApp;

  applyThemeVars();
  postEvent('web_app_request_theme');
  postEvent('web_app_request_viewport');
  postEvent('web_app_request_safe_area');
  postEvent('web_app_request_content_safe_area');
})();
