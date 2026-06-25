// PasteType content script
// After "Start", the user clicks the field they want typed into. A hover
// highlight shows what will be picked, and a progress bar (percent + ETA)
// floats above the chosen field while typing. Guard against double-injection.
(() => {
  if (window.__pasteTypeLoaded) return;
  window.__pasteTypeLoaded = true;

  const api = typeof browser !== "undefined" ? browser : chrome;

  // This script runs in every frame (all_frames). Only the top frame shows the
  // banner; all frames can detect a click on their own editable elements. Frames
  // coordinate via postMessage so picking/cancelling applies everywhere.
  const isTop = window.top === window;
  const FRAME_TAG = "__pastetype_signal__";

  let remoteWatchdog = 0; // top frame: auto-hide remote progress if updates stop

  // Relay a downward control signal to every descendant frame of this document.
  function relayDown(payload) {
    document.querySelectorAll("iframe, frame").forEach((f) => {
      try { f.contentWindow && f.contentWindow.postMessage(payload, "*"); } catch (_) {}
    });
  }

  // Arm picking in every descendant frame (carries the typing config down).
  function fanOutStart(cfg) {
    relayDown({ tag: FRAME_TAG, dir: "down", type: "start", cfg });
  }

  // Send a control signal to all frames in the tab: hop up to the top frame,
  // which then fans it back down to every descendant (this frame included).
  function signalAll(type) {
    handleSignal(type, null); // act locally right away
    const payload = { tag: FRAME_TAG, dir: "down", type };
    try {
      window.top.postMessage(payload, "*");
    } catch (_) {
      relayDown(payload); // cross-origin top unreachable: cover our own subtree
    }
  }

  function handleSignal(type, data) {
    if (type === "cancel") cancelLocal();
    else if (type === "stoppick") {
      // Someone started typing: every other frame stops picking and tears down.
      if (state === "picking") finalCleanup();
    } else if (type === "start" && data && data.cfg) {
      if (state === "typing") return;
      if (state === "picking") finalCleanup();
      startPick(data.cfg);
    }
  }

  // Send an upward message (child -> parent -> ... -> top) for the top frame to
  // render. Rects ride along and get translated into top-frame coordinates at
  // each iframe boundary.
  function sendUp(type, extra) {
    if (isTop) { handleUp(type, extra || {}); return; }
    try {
      window.parent.postMessage(
        Object.assign({ tag: FRAME_TAG, dir: "up", type }, extra),
        "*"
      );
    } catch (_) {}
  }

  // Find the <iframe>/<frame> element in this document whose window sent a msg.
  function findFrameElement(srcWindow) {
    const frames = document.querySelectorAll("iframe, frame");
    for (const f of frames) {
      try { if (f.contentWindow === srcWindow) return f; } catch (_) {}
    }
    return null;
  }

  // Top frame: draw/update the progress bar reported from a child frame.
  function showRemoteProgress(rect, pct, eta) {
    drawProgress(rect, pct, eta);
    clearTimeout(remoteWatchdog);
    remoteWatchdog = setTimeout(hideRemoteProgress, 4000); // safety net
  }

  function hideRemoteProgress() {
    clearTimeout(remoteWatchdog);
    remoteWatchdog = 0;
    if (state === "idle") finalCleanup();
    else if (ui) ui.progress.style.display = "none";
  }

  function handleUp(type, data) {
    if (type === "progress") showRemoteProgress(data.rect, data.pct, data.eta);
    else if (type === "progressend") hideRemoteProgress();
  }

  window.addEventListener(
    "message",
    (e) => {
      const d = e.data;
      if (!d || d.tag !== FRAME_TAG) return;

      if (d.dir === "up") {
        // Translate any rect from the child's viewport into ours, then either
        // render (if we're the top frame) or keep bubbling upward.
        let payload = d;
        if (d.rect) {
          const fe = findFrameElement(e.source);
          if (fe) {
            const fr = fe.getBoundingClientRect();
            const ox = fr.left + fe.clientLeft;
            const oy = fr.top + fe.clientTop;
            payload = Object.assign({}, d, {
              rect: {
                left: d.rect.left + ox,
                top: d.rect.top + oy,
                width: d.rect.width,
                height: d.rect.height,
              },
            });
          }
        }
        if (isTop) handleUp(payload.type, payload);
        else { try { window.parent.postMessage(payload, "*"); } catch (_) {} }
        return;
      }

      // Downward control signal.
      handleSignal(d.type, d);
      relayDown(d); // continue fanning down the frame tree
    },
    true
  );

  let state = "idle"; // idle | picking | typing
  let cancelled = false;
  let pendingCfg = null;

  let hoverEl = null; // element under cursor while picking
  let typeEl = null; // chosen target while typing
  let progressPct = 0;
  let etaText = "";

  const SPINNER = ["/", "-", "\\", "|"]; // classic spinning wheel frames

  const TEXT_INPUT_TYPES = new Set([
    "text", "search", "url", "tel", "email", "password", "",
  ]);

  // --- Editable detection ----------------------------------------------------
  function isEditableInput(el) {
    if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly;
    if (el instanceof HTMLInputElement) {
      return TEXT_INPUT_TYPES.has(el.type) && !el.disabled && !el.readOnly;
    }
    return false;
  }

  function closestEditable(node) {
    let el = node instanceof Element ? node : node && node.parentElement;
    while (el) {
      if (isEditableInput(el)) return el;
      if (el.isContentEditable) {
        let root = el;
        while (root.parentElement && root.parentElement.isContentEditable) {
          root = root.parentElement;
        }
        return root;
      }
      el = el.parentElement;
    }
    return null;
  }

  // --- Floating UI (shadow DOM, zero-size host so it can never trap clicks) ---
  let ui = null;
  let rafId = 0;

  function ensureUI() {
    if (ui) return ui;
    const host = document.createElement("div");
    // Zero-size, click-through host. Children are position:fixed so they still
    // render across the viewport but the host itself can never block clicks.
    host.style.cssText =
      "all:initial;position:fixed;top:0;left:0;width:0;height:0;" +
      "z-index:2147483647;pointer-events:none;";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        .banner {
          position: fixed; top: 14px; left: 50%; transform: translateX(-50%);
          background: #080808; color: #e7e9f0; border: 1px solid AccentColor;
          border-radius: 10px; padding: 10px 14px;
          font: 13px/1.3 "Cascadia Code", ui-monospace, Consolas, monospace;
          box-shadow: 0 6px 20px rgba(0,0,0,.4); pointer-events: auto;
          display: flex; align-items: center; gap: 12px; max-width: 90vw;
        }
        .banner button {
          all: unset; cursor: pointer; background: #fff; color: #080808;
          font-weight: 600; font-family: "Cascadia Code", ui-monospace, Consolas, monospace;
          padding: 3px 10px; border-radius: 6px;
        }
        .highlight {
          position: fixed; border: 2px solid AccentColor; border-radius: 4px;
          background: color-mix(in srgb, AccentColor 14%, transparent);
          pointer-events: none; display: none; box-sizing: border-box;
        }
        .progress {
          position: fixed; pointer-events: none; display: none;
          font: 12px/1.3 "Cascadia Code", ui-monospace, Consolas, monospace; color: #fff;
          background: #080808; border: 1px solid AccentColor;
          border-radius: 8px; padding: 6px 9px;
          box-shadow: 0 4px 14px rgba(0,0,0,.45); box-sizing: border-box;
          white-space: pre;
        }
        .progress .bar { color: AccentColor; }
        .progress .bar .track { color: #555; }
        .progress .meta { color: #fff; }
      </style>
      <div class="banner" style="display:none">
        <span class="banner-text"></span>
        <button class="cancel">Cancel</button>
      </div>
      <div class="highlight"></div>
      <div class="progress"><span class="bar"></span><span class="meta"></span></div>
    `;
    // Prefer <html> so we never append into a contenteditable <body> (e.g. a
    // rich-text editor), which would turn our overlay into edited content.
    (document.documentElement || document.body).appendChild(host);
    ui = {
      host,
      banner: shadow.querySelector(".banner"),
      bannerText: shadow.querySelector(".banner-text"),
      cancelBtn: shadow.querySelector(".cancel"),
      highlight: shadow.querySelector(".highlight"),
      progress: shadow.querySelector(".progress"),
      bar: shadow.querySelector(".bar"),
      meta: shadow.querySelector(".meta"),
    };
    ui.cancelBtn.addEventListener("click", cancelAll);
    return ui;
  }

  // Render the ASCII progress bar above a rectangle (in this frame's viewport).
  function drawProgress(r, pct, eta) {
    ensureUI();
    const p = ui.progress;
    p.style.display = "block";

    // Spinning wheel + [=====-----] bar + percent/ETA.
    const done = pct >= 100;
    const spin = done ? "*" : SPINNER[Math.floor(performance.now() / 110) % SPINNER.length];
    const W = 20;
    const filled = Math.min(W, Math.round((pct / 100) * W));
    ui.bar.innerHTML =
      spin + " [" + "=".repeat(filled) +
      '<span class="track">' + "-".repeat(W - filled) + "</span>] ";
    ui.meta.textContent = Math.round(pct) + "%" + (eta ? "  " + eta : "");

    const pw = p.offsetWidth;
    const bottom = r.top + r.height;
    let top = r.top - p.offsetHeight - 4;
    if (top < 4) top = bottom + 4; // not enough room above → place below
    p.style.left = Math.max(4, Math.min(r.left, window.innerWidth - pw - 4)) + "px";
    p.style.top = top + "px";
  }

  // Glue the highlight to its target, and either draw the progress bar locally
  // (top frame) or stream it up to the top frame (child frame).
  function tick() {
    rafId = 0;

    if (ui) {
      if (state === "picking" && hoverEl && document.contains(hoverEl)) {
        const r = hoverEl.getBoundingClientRect();
        const h = ui.highlight;
        h.style.display = "block";
        h.style.left = r.left + "px";
        h.style.top = r.top + "px";
        h.style.width = r.width + "px";
        h.style.height = r.height + "px";
      } else {
        ui.highlight.style.display = "none";
      }
    }

    if (state === "typing" && typeEl && document.contains(typeEl)) {
      const r = typeEl.getBoundingClientRect();
      if (isTop) {
        drawProgress(r, progressPct, etaText);
      } else {
        sendUp("progress", {
          pct: progressPct,
          eta: etaText,
          rect: { left: r.left, top: r.top, width: r.width, height: r.height },
        });
      }
    }

    if (state !== "idle") rafId = requestAnimationFrame(tick);
  }

  function startRaf() {
    if (!rafId) rafId = requestAnimationFrame(tick);
  }

  // --- Lifecycle / cleanup ---------------------------------------------------
  function stopPicking() {
    document.removeEventListener("mousemove", onPickMove, true);
    document.removeEventListener("mouseout", onPickOut, true);
    document.removeEventListener("mousedown", onPickDown, true);
    document.removeEventListener("click", swallowClick, true);
    if (ui) {
      ui.banner.style.display = "none";
      ui.highlight.style.display = "none";
    }
  }

  // Removes absolutely everything. Safe to call multiple times.
  function finalCleanup() {
    stopPicking();
    document.removeEventListener("keydown", onKey, true);
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    if (ui && ui.host.parentNode) ui.host.parentNode.removeChild(ui.host);
    ui = null;
    hoverEl = null;
    typeEl = null;
    state = "idle";
  }

  // Cancel just this frame.
  function cancelLocal() {
    cancelled = true;
    // If we're mid-typing, the loop's finally block will clean up. Otherwise do
    // it now.
    if (state !== "typing") finalCleanup();
  }

  // Cancel everywhere (this frame plus all others in the tab).
  function cancelAll() {
    signalAll("cancel");
  }

  // --- Pick mode -------------------------------------------------------------
  function startPick(cfg) {
    pendingCfg = cfg;
    cancelled = false;
    state = "picking";
    ensureUI();
    // Only the top frame shows the instruction banner, so iframes don't each pop
    // their own. Every frame still watches for clicks on its own fields.
    if (isTop) {
      ui.banner.style.display = "flex";
      ui.bannerText.textContent =
        "PasteType: click the text field to type into, or press Esc / Cancel.";
    } else {
      ui.banner.style.display = "none";
    }
    document.addEventListener("mousemove", onPickMove, true);
    document.addEventListener("mouseout", onPickOut, true);
    document.addEventListener("mousedown", onPickDown, true);
    document.addEventListener("click", swallowClick, true);
    document.addEventListener("keydown", onKey, true);
    startRaf();
  }

  function onPickMove(e) {
    hoverEl = closestEditable(e.target);
  }

  // Clear the highlight when the cursor leaves this document (e.g. moves into a
  // different frame), so a stale highlight doesn't linger.
  function onPickOut(e) {
    if (!e.relatedTarget) hoverEl = null;
  }

  // Only intercept clicks that land on an editable field. Clicks anywhere else
  // pass through untouched, so the page stays fully usable while picking.
  function swallowClick(e) {
    if (state !== "picking") return;
    if (closestEditable(e.target)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function onPickDown(e) {
    if (state !== "picking") return;
    const el = closestEditable(e.target);
    if (!el) return; // clicked a non-editable spot: let it through, keep picking
    e.preventDefault();
    e.stopPropagation();
    stopPicking();
    // Start typing first (sets state to "typing") so the stoppick signal we
    // receive back doesn't tear down this frame; then tell other frames to stop.
    beginTyping(el, pendingCfg);
    signalAll("stoppick");
  }

  function onKey(e) {
    if (e.key === "Escape" && state !== "idle") {
      e.preventDefault();
      cancelAll();
    }
  }

  // --- Randomness & timing ---------------------------------------------------
  function gaussian() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  const rand = (min, max) => min + Math.random() * (max - min);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function charDelay(wpm, deviation) {
    const base = 12000 / wpm; // 5 chars/word => ms per char
    const sd = base * (deviation / 100);
    return Math.max(base * 0.3, base + gaussian() * sd);
  }

  function extraPause(char, scale) {
    if (scale <= 0) return 0;
    let extra = 0;
    // Finishing a sentence: a longer, multi-second "gather your thoughts" pause.
    if (".!?".includes(char)) extra += rand(1400, 3200) * scale;
    else if (",;:".includes(char)) extra += rand(120, 350) * scale;
    else if (char === "\n") extra += rand(200, 600) * scale;
    else if (char === " " && Math.random() < 0.04 * scale) extra += rand(150, 450) * scale;
    if (Math.random() < 0.012 * scale) extra += rand(350, 1100) * scale;
    return extra;
  }

  // --- Typos -----------------------------------------------------------------
  const TYPO_RATE = 0.05; // chance per letter when typos are enabled
  const KEY_NEIGHBORS = {
    a: "qwsz", b: "vghn", c: "xdfv", d: "serfcx", e: "wsdr", f: "drtgvc",
    g: "ftyhbv", h: "gyujnb", i: "ujko", j: "huiknm", k: "jiolm", l: "kop",
    m: "njk", n: "bhjm", o: "iklp", p: "ol", q: "wa", r: "edft", s: "awedxz",
    t: "rfgy", u: "yhji", v: "cfgb", w: "qase", x: "zsdc", y: "tghu", z: "asx",
  };

  // A plausible adjacent-key slip for a letter, preserving case. null if none.
  function nearbyKey(ch) {
    const lower = ch.toLowerCase();
    const n = KEY_NEIGHBORS[lower];
    if (!n) return null;
    const pick = n[Math.floor(Math.random() * n.length)];
    return ch === lower ? pick : pick.toUpperCase();
  }

  function formatEta(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    if (s >= 60) {
      const m = Math.floor(s / 60);
      return m + "m " + String(s % 60).padStart(2, "0") + "s left";
    }
    return "~" + s + "s left";
  }

  // --- Inserting characters --------------------------------------------------
  function dispatchKey(el, type, char) {
    el.dispatchEvent(
      new KeyboardEvent(type, {
        key: char === "\n" ? "Enter" : char,
        bubbles: true,
        cancelable: true,
      })
    );
  }

  function insertIntoField(el, char) {
    if (el instanceof HTMLInputElement && char === "\n") return; // single-line
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    setter.call(el, el.value.slice(0, start) + char + el.value.slice(end));
    const pos = start + char.length;
    try { el.setSelectionRange(pos, pos); } catch (_) {}
    el.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText", data: char })
    );
  }

  function insertIntoContentEditable(char) {
    if (char === "\n") {
      if (!document.execCommand("insertLineBreak")) {
        document.execCommand("insertText", false, "\n");
      }
    } else {
      document.execCommand("insertText", false, char);
    }
  }

  function typeChar(el, char) {
    dispatchKey(el, "keydown", char);
    if (el.isContentEditable) insertIntoContentEditable(char);
    else insertIntoField(el, char);
    dispatchKey(el, "keyup", char);
  }

  // Delete the character before the caret (as if pressing Backspace).
  function pressBackspace(el) {
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true })
    );
    if (el.isContentEditable) {
      document.execCommand("delete", false);
    } else {
      const proto =
        el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      const start = el.selectionStart ?? el.value.length;
      if (start > 0) {
        setter.call(el, el.value.slice(0, start - 1) + el.value.slice(start));
        const pos = start - 1;
        try { el.setSelectionRange(pos, pos); } catch (_) {}
        el.dispatchEvent(
          new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" })
        );
      }
    }
    el.dispatchEvent(
      new KeyboardEvent("keyup", { key: "Backspace", bubbles: true, cancelable: true })
    );
  }

  // --- Completion sound ------------------------------------------------------
  function playDoneSound() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      if (ctx.state === "suspended") ctx.resume();
      const now = ctx.currentTime;
      [
        { f: 660, t: 0.0 },
        { f: 880, t: 0.12 },
      ].forEach(({ f, t }) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = f;
        gain.gain.setValueAtTime(0.0001, now + t);
        gain.gain.exponentialRampToValueAtTime(0.25, now + t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.18);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now + t);
        osc.stop(now + t + 0.2);
      });
      setTimeout(() => ctx.close(), 600);
    } catch (_) {}
  }

  // --- Typing ----------------------------------------------------------------
  async function beginTyping(el, cfg) {
    state = "typing";
    cancelled = false;
    typeEl = el;
    progressPct = 0;
    etaText = "";
    el.focus();
    // The top frame draws the bar locally; child frames have no UI of their own
    // and stream progress up to the top frame to render (see tick()).
    if (isTop) {
      ensureUI();
      ui.progress.style.display = "block";
    } else if (ui) {
      // Drop the picking host so nothing renders inside this child frame.
      if (ui.host.parentNode) ui.host.parentNode.removeChild(ui.host);
      ui = null;
    }
    startRaf();

    const scale = [0, 0.5, 1, 1.8][cfg.pauseLevel] ?? 1;
    const chars = Array.from(cfg.text); // handles emoji / surrogate pairs
    const total = chars.length || 1;
    const startTime = performance.now();
    let completed = false;

    try {
      for (let i = 0; i < chars.length; i++) {
        if (cancelled) break;
        const char = chars[i];
        if (document.activeElement !== el && !el.contains(document.activeElement)) {
          el.focus();
        }

        // Occasionally fumble a letter: type a neighbouring key, leave it for a
        // beat, then backspace and carry on with the correct character.
        if (cfg.typos && /[a-z]/i.test(char) && Math.random() < TYPO_RATE) {
          const wrong = nearbyKey(char);
          if (wrong) {
            typeChar(el, wrong);
            await sleep(rand(140, 380));
            if (cancelled) break;
            pressBackspace(el);
            await sleep(rand(90, 220));
            if (cancelled) break;
          }
        }

        typeChar(el, char);

        const done = i + 1;
        progressPct = (done / total) * 100;
        const elapsed = performance.now() - startTime;
        const perChar = done > 0 ? elapsed / done : 12000 / cfg.wpm;
        etaText = formatEta(perChar * (total - done));

        await sleep(charDelay(cfg.wpm, cfg.deviation) + extraPause(char, scale));
      }
      completed = !cancelled;
    } catch (err) {
      console.error("PasteType: typing error", err);
    } finally {
      const rectNow = () => {
        const r = typeEl && document.contains(typeEl) ? typeEl.getBoundingClientRect() : null;
        return r && { left: r.left, top: r.top, width: r.width, height: r.height };
      };
      if (completed) {
        progressPct = 100;
        etaText = "done";
        if (cfg.sound) playDoneSound();
        const r = rectNow();
        if (isTop) {
          state = "idle";
          if (r) drawProgress(r, 100, "done"); // final frame (tick has stopped)
          setTimeout(finalCleanup, 1200);
        } else {
          if (r) sendUp("progress", { pct: 100, eta: "done", rect: r });
          state = "idle";
          // Let the finished bar linger, then tell the top frame to remove it.
          setTimeout(() => { sendUp("progressend"); finalCleanup(); }, 1200);
        }
      } else {
        // Cancelled. The top frame is also torn down via the cancel signal.
        state = "idle";
        if (!isTop) sendUp("progressend");
        finalCleanup();
      }
    }
  }

  // --- Messaging -------------------------------------------------------------
  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;

    if (msg.type === "ping") {
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "stop") {
      cancelAll();
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "start") {
      // Popup sends this only to the top frame; we arm here and fan the config
      // out to every child frame so a field in an iframe can also be picked.
      if (state === "typing") {
        sendResponse({ ok: false, error: "Already typing. Press Esc to stop first." });
        return;
      }
      if (state === "picking") finalCleanup(); // restart with new settings
      startPick(msg);
      fanOutStart(msg);
      sendResponse({ ok: true });
      return;
    }
  });
})();
