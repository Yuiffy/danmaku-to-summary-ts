// ==UserScript==
// @name         四时小路Komichi+
// @name:zh-CN   Bilibili 直播间弹幕前后缀
// @namespace    https://space.bilibili.com/1512246445
// @version      2.0.0
// @description  为每个 Bilibili 直播间分别设置弹幕前缀、后缀和开关
// @match        https://live.bilibili.com/*
// @icon         https://i1.hdslb.com/bfs/face/684639af2e074b39e0f5c979e5665dbad14f8961.jpg@128w_128h_1c_1s.webp
// @license      MIT
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @noframes
// ==/UserScript==

(function () {
  "use strict";

  const pageWindow = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const storageKey = "bilibili-live-room-affixes-v1";
  const localStorageKey = `userscript:${storageKey}`;
  const defaultConfig = Object.freeze({
    enabled: true,
    prefixEnabled: true,
    prefix: "",
    suffixEnabled: true,
    suffix: "",
  });

  let ui = null;

  function getCurrentRoomId() {
    return window.location.pathname.match(/^\/(\d+)(?:\/|$)/)?.[1] ?? null;
  }

  function normalizeConfig(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ...defaultConfig };
    }

    return {
      enabled: value.enabled !== false,
      prefixEnabled: value.prefixEnabled !== false,
      prefix: typeof value.prefix === "string" ? value.prefix : "",
      suffixEnabled: value.suffixEnabled !== false,
      suffix: typeof value.suffix === "string" ? value.suffix : "",
    };
  }

  function readConfigMap() {
    try {
      if (typeof GM_getValue === "function") {
        const value = GM_getValue(storageKey, {});
        return value && typeof value === "object" && !Array.isArray(value)
          ? value
          : {};
      }
    } catch (error) {
      console.warn("[直播间弹幕前后缀] 读取油猴配置失败，将使用本地存储。", error);
    }

    try {
      const value = JSON.parse(window.localStorage.getItem(localStorageKey) || "{}");
      return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
    } catch (error) {
      console.warn("[直播间弹幕前后缀] 读取本地配置失败。", error);
      return {};
    }
  }

  function writeConfigMap(configMap) {
    try {
      if (typeof GM_setValue === "function") {
        GM_setValue(storageKey, configMap);
        return;
      }
    } catch (error) {
      console.warn("[直播间弹幕前后缀] 写入油猴配置失败，将使用本地存储。", error);
    }

    try {
      window.localStorage.setItem(localStorageKey, JSON.stringify(configMap));
    } catch (error) {
      console.error("[直播间弹幕前后缀] 保存配置失败。", error);
      throw error;
    }
  }

  function hasRoomConfig(roomId) {
    return Boolean(
      roomId && Object.prototype.hasOwnProperty.call(readConfigMap(), roomId),
    );
  }

  function getRoomConfig(roomId) {
    if (!roomId) return { ...defaultConfig };
    return normalizeConfig(readConfigMap()[roomId]);
  }

  function saveRoomConfig(roomId, config) {
    const configMap = readConfigMap();
    configMap[roomId] = normalizeConfig(config);
    writeConfigMap(configMap);
  }

  function removeRoomConfig(roomId) {
    const configMap = readConfigMap();
    delete configMap[roomId];
    writeConfigMap(configMap);
  }

  function getActiveAffixes(config) {
    if (!config.enabled) return { prefix: "", suffix: "" };

    return {
      prefix: config.prefixEnabled ? config.prefix : "",
      suffix: config.suffixEnabled ? config.suffix : "",
    };
  }

  function applyAffixes(message, config) {
    if (typeof message !== "string" || message.trim() === "") return message;

    const { prefix, suffix } = getActiveAffixes(config);
    let result = message;

    if (prefix && !result.startsWith(prefix)) result = prefix + result;
    if (suffix && !result.endsWith(suffix)) result += suffix;

    return result;
  }

  function applyCurrentRoomAffixes(message) {
    const roomId = getCurrentRoomId();
    return roomId ? applyAffixes(message, getRoomConfig(roomId)) : message;
  }

  function isDanmakuSendUrl(value) {
    try {
      const url = new URL(String(value), window.location.href);
      return (
        /(^|\.)bilibili\.com$/i.test(url.hostname) &&
        /\/(?:msg|dM)\/send\/?$/i.test(url.pathname)
      );
    } catch {
      return false;
    }
  }

  function updateSearchParams(params) {
    if (!params.has("msg")) return null;

    const oldMessage = params.get("msg");
    const newMessage = applyCurrentRoomAffixes(oldMessage);
    if (newMessage === oldMessage) return null;

    params.set("msg", newMessage);
    return params;
  }

  function transformRequestBody(body) {
    if (typeof body === "string") {
      const params = new pageWindow.URLSearchParams(body);
      if (updateSearchParams(params)) return params.toString();

      try {
        const json = JSON.parse(body);
        if (json && typeof json === "object" && typeof json.msg === "string") {
          const message = applyCurrentRoomAffixes(json.msg);
          return message === json.msg ? body : JSON.stringify({ ...json, msg: message });
        }
      } catch {
        // The usual request body is URL encoded, so non-JSON text needs no work.
      }

      return body;
    }

    if (
      pageWindow.URLSearchParams &&
      body instanceof pageWindow.URLSearchParams
    ) {
      const params = new pageWindow.URLSearchParams(body.toString());
      return updateSearchParams(params) ?? body;
    }

    if (pageWindow.FormData && body instanceof pageWindow.FormData) {
      const message = body.get("msg");
      if (typeof message !== "string") return body;

      const newMessage = applyCurrentRoomAffixes(message);
      if (newMessage === message) return body;

      const formData = new pageWindow.FormData();
      for (const [key, value] of body.entries()) formData.append(key, value);
      formData.set("msg", newMessage);
      return formData;
    }

    return body;
  }

  function installXhrHook() {
    const Xhr = pageWindow.XMLHttpRequest;
    if (!Xhr?.prototype) return;

    const requestUrls = new WeakMap();
    const nativeOpen = Xhr.prototype.open;
    const nativeSend = Xhr.prototype.send;

    Xhr.prototype.open = function (method, url, ...rest) {
      requestUrls.set(this, url);
      return Reflect.apply(nativeOpen, this, [method, url, ...rest]);
    };

    Xhr.prototype.send = function (body) {
      const requestBody = isDanmakuSendUrl(requestUrls.get(this))
        ? transformRequestBody(body)
        : body;
      return Reflect.apply(nativeSend, this, [requestBody]);
    };
  }

  function installFetchHook() {
    const nativeFetch = pageWindow.fetch;
    if (typeof nativeFetch !== "function") return;

    pageWindow.fetch = function (input, init) {
      const url =
        typeof input === "string"
          ? input
          : pageWindow.URL && input instanceof pageWindow.URL
            ? input.href
            : input?.url ?? input?.href;

      if (!isDanmakuSendUrl(url) || !init || !("body" in init)) {
        return Reflect.apply(nativeFetch, this, [input, init]);
      }

      const nextInit = { ...init, body: transformRequestBody(init.body) };
      return Reflect.apply(nativeFetch, this, [input, nextInit]);
    };
  }

  function configIsActive(config) {
    const { prefix, suffix } = getActiveAffixes(config);
    return Boolean(prefix || suffix);
  }

  function getFormConfig() {
    return normalizeConfig({
      enabled: ui.enabled.checked,
      prefixEnabled: ui.prefixEnabled.checked,
      prefix: ui.prefix.value,
      suffixEnabled: ui.suffixEnabled.checked,
      suffix: ui.suffix.value,
    });
  }

  function refreshForm() {
    if (!ui) return;

    const config = getFormConfig();
    ui.prefix.disabled = !config.prefixEnabled;
    ui.suffix.disabled = !config.suffixEnabled;
    ui.preview.textContent = applyAffixes("示例弹幕", config);
    ui.preview.classList.toggle("inactive", !configIsActive(config));
  }

  function refreshLauncher() {
    if (!ui) return;

    const roomId = getCurrentRoomId();
    ui.launcher.hidden = !roomId;
    ui.launcher.classList.toggle(
      "active",
      Boolean(roomId && configIsActive(getRoomConfig(roomId))),
    );
  }

  function closeSettings() {
    if (!ui) return;
    ui.overlay.hidden = true;
    ui.launcher.focus();
  }

  function openSettings() {
    const roomId = getCurrentRoomId();
    if (!roomId) {
      window.alert("请先打开一个 Bilibili 直播间。");
      return;
    }

    if (!mountUi()) {
      document.addEventListener("DOMContentLoaded", openSettings, { once: true });
      return;
    }

    const config = getRoomConfig(roomId);
    ui.roomId.textContent = roomId;
    ui.enabled.checked = config.enabled;
    ui.prefixEnabled.checked = config.prefixEnabled;
    ui.prefix.value = config.prefix;
    ui.suffixEnabled.checked = config.suffixEnabled;
    ui.suffix.value = config.suffix;
    ui.clear.disabled = !hasRoomConfig(roomId);
    refreshForm();
    ui.overlay.hidden = false;
    ui.prefix.focus();
  }

  function mountUi() {
    if (ui?.host.isConnected) return true;
    if (!document.documentElement) return false;

    const host = document.createElement("div");
    host.id = "bilibili-live-room-affixes";
    const root = host.attachShadow({ mode: "open" });

    root.innerHTML = `
      <style>
        :host {
          color: #202124;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          font-size: 14px;
          letter-spacing: 0;
        }

        *, *::before, *::after { box-sizing: border-box; }
        button, input { font: inherit; letter-spacing: 0; }

        .launcher {
          align-items: center;
          background: #ffffff;
          border: 1px solid #d8dadd;
          border-radius: 50%;
          bottom: 116px;
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
          color: #50545a;
          cursor: pointer;
          display: flex;
          height: 42px;
          justify-content: center;
          padding: 0;
          position: fixed;
          right: 20px;
          width: 42px;
          z-index: 2147483646;
        }

        .launcher:hover { background: #f5f6f7; }
        .launcher:focus-visible { outline: 3px solid rgba(0, 161, 214, 0.28); }
        .launcher.active { border-color: #00a1d6; color: #008ebc; }
        .launcher[hidden] { display: none; }
        .gear { font-size: 21px; line-height: 1; }

        .overlay {
          align-items: center;
          background: rgba(19, 21, 24, 0.48);
          display: flex;
          inset: 0;
          justify-content: center;
          padding: 16px;
          position: fixed;
          z-index: 2147483647;
        }

        .overlay[hidden] { display: none; }

        .panel {
          background: #ffffff;
          border: 1px solid #d8dadd;
          border-radius: 8px;
          box-shadow: 0 18px 50px rgba(0, 0, 0, 0.25);
          max-height: calc(100vh - 32px);
          overflow: auto;
          width: min(420px, calc(100vw - 32px));
        }

        .header {
          align-items: flex-start;
          border-bottom: 1px solid #e6e7e9;
          display: flex;
          gap: 16px;
          justify-content: space-between;
          padding: 20px 20px 16px;
        }

        h2 { font-size: 18px; line-height: 1.35; margin: 0; }
        .room { color: #73777d; font-size: 12px; margin: 5px 0 0; }

        .icon-button {
          align-items: center;
          background: transparent;
          border: 0;
          border-radius: 4px;
          color: #6a6e73;
          cursor: pointer;
          display: flex;
          flex: 0 0 32px;
          font-size: 22px;
          height: 32px;
          justify-content: center;
          padding: 0;
          width: 32px;
        }

        .icon-button:hover { background: #f0f1f2; }
        .icon-button:focus-visible,
        .button:focus-visible,
        .text-input:focus-visible {
          outline: 3px solid rgba(0, 161, 214, 0.25);
          outline-offset: 1px;
        }

        .body { padding: 4px 20px 0; }

        .master,
        .row-head,
        .toggle-label {
          align-items: center;
          display: flex;
        }

        .master {
          border-bottom: 1px solid #e6e7e9;
          cursor: pointer;
          justify-content: space-between;
          min-height: 56px;
        }

        .field { border-bottom: 1px solid #e6e7e9; padding: 16px 0; }
        .row-head { justify-content: space-between; margin-bottom: 10px; }
        .field-name { font-weight: 600; }
        .toggle-label { color: #555a60; cursor: pointer; gap: 8px; }

        .switch-input {
          height: 1px;
          opacity: 0;
          position: absolute;
          width: 1px;
        }

        .switch {
          background: #a8abb0;
          border-radius: 11px;
          display: inline-block;
          height: 22px;
          position: relative;
          transition: background 120ms ease;
          width: 38px;
        }

        .switch::after {
          background: #ffffff;
          border-radius: 50%;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.28);
          content: "";
          height: 18px;
          left: 2px;
          position: absolute;
          top: 2px;
          transition: transform 120ms ease;
          width: 18px;
        }

        .switch-input:checked + .switch { background: #00a1d6; }
        .switch-input:checked + .switch::after { transform: translateX(16px); }
        .switch-input:focus-visible + .switch { outline: 3px solid rgba(0, 161, 214, 0.25); }

        .text-input {
          background: #ffffff;
          border: 1px solid #c8cbd0;
          border-radius: 6px;
          color: #202124;
          height: 40px;
          padding: 0 11px;
          width: 100%;
        }

        .text-input:disabled { background: #f1f2f3; color: #999da2; }

        .preview-wrap { padding: 15px 0 16px; }
        .preview-label { color: #73777d; display: block; font-size: 12px; margin-bottom: 6px; }
        .preview { overflow-wrap: anywhere; white-space: pre-wrap; }
        .preview.inactive { color: #8b8f94; }

        .footer {
          align-items: center;
          border-top: 1px solid #e6e7e9;
          display: flex;
          gap: 8px;
          justify-content: flex-end;
          padding: 14px 20px;
        }

        .button {
          background: #ffffff;
          border: 1px solid #c8cbd0;
          border-radius: 6px;
          color: #34383d;
          cursor: pointer;
          min-height: 36px;
          padding: 7px 15px;
        }

        .button:hover { background: #f5f6f7; }
        .button.primary { background: #00a1d6; border-color: #00a1d6; color: #ffffff; }
        .button.primary:hover { background: #008fbe; }
        .button.clear { color: #b42318; margin-right: auto; }
        .button:disabled { cursor: not-allowed; opacity: 0.45; }

        @media (max-width: 520px) {
          .launcher { bottom: 84px; right: 12px; }
          .panel { width: 100%; }
          .header { padding: 17px 16px 14px; }
          .body { padding-left: 16px; padding-right: 16px; }
          .footer { padding: 12px 16px; }
        }
      </style>

      <button class="launcher" type="button" title="配置当前直播间的弹幕前后缀" aria-label="配置当前直播间的弹幕前后缀">
        <span class="gear" aria-hidden="true">⚙</span>
      </button>

      <div class="overlay" hidden>
        <form class="panel" aria-labelledby="affix-title">
          <header class="header">
            <div>
              <h2 id="affix-title">弹幕前后缀</h2>
              <p class="room">当前直播间：<span class="room-id"></span></p>
            </div>
            <button class="icon-button close" type="button" title="关闭" aria-label="关闭">×</button>
          </header>

          <div class="body">
            <label class="master">
              <span>启用当前直播间配置</span>
              <span>
                <input class="switch-input enabled" type="checkbox">
                <span class="switch" aria-hidden="true"></span>
              </span>
            </label>

            <section class="field">
              <div class="row-head">
                <label class="field-name" for="affix-prefix">前缀</label>
                <label class="toggle-label">
                  <span>启用</span>
                  <span>
                    <input class="switch-input prefix-enabled" type="checkbox">
                    <span class="switch" aria-hidden="true"></span>
                  </span>
                </label>
              </div>
              <input id="affix-prefix" class="text-input prefix" type="text" maxlength="100" autocomplete="off" placeholder="例如：【岁己】">
            </section>

            <section class="field">
              <div class="row-head">
                <label class="field-name" for="affix-suffix">后缀</label>
                <label class="toggle-label">
                  <span>启用</span>
                  <span>
                    <input class="switch-input suffix-enabled" type="checkbox">
                    <span class="switch" aria-hidden="true"></span>
                  </span>
                </label>
              </div>
              <input id="affix-suffix" class="text-input suffix" type="text" maxlength="100" autocomplete="off" placeholder="例如：喵">
            </section>

            <div class="preview-wrap">
              <span class="preview-label">发送预览</span>
              <div class="preview"></div>
            </div>
          </div>

          <footer class="footer">
            <button class="button clear" type="button">清除配置</button>
            <button class="button cancel" type="button">取消</button>
            <button class="button primary" type="submit">保存</button>
          </footer>
        </form>
      </div>
    `;

    document.documentElement.append(host);

    ui = {
      host,
      launcher: root.querySelector(".launcher"),
      overlay: root.querySelector(".overlay"),
      form: root.querySelector(".panel"),
      roomId: root.querySelector(".room-id"),
      enabled: root.querySelector(".enabled"),
      prefixEnabled: root.querySelector(".prefix-enabled"),
      prefix: root.querySelector(".prefix"),
      suffixEnabled: root.querySelector(".suffix-enabled"),
      suffix: root.querySelector(".suffix"),
      preview: root.querySelector(".preview"),
      clear: root.querySelector(".clear"),
    };

    ui.launcher.addEventListener("click", openSettings);
    root.querySelector(".close").addEventListener("click", closeSettings);
    root.querySelector(".cancel").addEventListener("click", closeSettings);

    for (const element of [
      ui.enabled,
      ui.prefixEnabled,
      ui.prefix,
      ui.suffixEnabled,
      ui.suffix,
    ]) {
      element.addEventListener("input", refreshForm);
      element.addEventListener("change", refreshForm);
    }

    ui.overlay.addEventListener("click", (event) => {
      if (event.target === ui.overlay) closeSettings();
    });

    root.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !ui.overlay.hidden) closeSettings();
    });

    ui.form.addEventListener("submit", (event) => {
      event.preventDefault();
      const roomId = getCurrentRoomId();
      if (!roomId) return;

      saveRoomConfig(roomId, getFormConfig());
      refreshLauncher();
      closeSettings();
    });

    ui.clear.addEventListener("click", () => {
      const roomId = getCurrentRoomId();
      if (!roomId || !hasRoomConfig(roomId)) return;
      if (!window.confirm(`确定清除直播间 ${roomId} 的前后缀配置吗？`)) return;

      removeRoomConfig(roomId);
      openSettings();
      refreshLauncher();
    });

    refreshLauncher();
    return true;
  }

  function initializeUi() {
    if (!mountUi()) {
      document.addEventListener("DOMContentLoaded", initializeUi, { once: true });
      return;
    }

    let previousRoomId = getCurrentRoomId();
    window.setInterval(() => {
      const roomId = getCurrentRoomId();
      if (roomId === previousRoomId) return;
      previousRoomId = roomId;
      if (!ui.overlay.hidden) closeSettings();
      refreshLauncher();
    }, 1000);
  }

  installXhrHook();
  installFetchHook();
  initializeUi();

  if (typeof GM_registerMenuCommand === "function") {
    GM_registerMenuCommand("配置当前直播间弹幕前后缀", openSettings);
  }
})();
