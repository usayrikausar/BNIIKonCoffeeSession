/*! Layankan chat widget — <script src="https://YOUR-APP/widget.js" data-layankan="your-slug" async></script>
 * Renders a floating button inside a Shadow DOM (host CSS can't leak in or out)
 * and opens the chat in an iframe (fully isolated from the host page). */
(function () {
  "use strict";
  var script = document.currentScript || document.querySelector("script[data-layankan]");
  if (!script) return;
  var slug = script.getAttribute("data-layankan");
  if (!slug || !/^[a-z0-9-]{3,48}$/.test(slug)) return;
  if (window.__layankanLoaded) return;
  window.__layankanLoaded = true;
  var origin = new URL(script.src).origin;
  var color = script.getAttribute("data-color") || "#0f766e";
  if (!/^#[0-9a-fA-F]{3,8}$/.test(color)) color = "#0f766e";
  var position = script.getAttribute("data-position") === "left" ? "left" : "right";

  var host = document.createElement("div");
  host.setAttribute("data-layankan-widget", "");
  host.style.cssText = "position:fixed;bottom:0;" + position + ":0;z-index:2147483646;";
  var root = host.attachShadow ? host.attachShadow({ mode: "closed" }) : host;

  var style = document.createElement("style");
  style.textContent =
    ":host{all:initial}" +
    ".btn{position:fixed;bottom:20px;" + position + ":20px;width:60px;height:60px;border-radius:50%;border:0;cursor:pointer;" +
    "background:" + color + ";color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;transition:transform .15s}" +
    ".btn:hover{transform:scale(1.06)}.btn svg{width:28px;height:28px}" +
    ".panel{position:fixed;bottom:92px;" + position + ":20px;width:370px;height:600px;max-height:calc(100vh - 112px);max-width:calc(100vw - 40px);" +
    "border-radius:16px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.25);background:#fff;display:none}" +
    ".panel.open{display:block}.panel iframe{width:100%;height:100%;border:0}" +
    "@media (max-width:480px){.panel{bottom:0;" + position + ":0;width:100vw;height:100vh;max-height:100vh;max-width:100vw;border-radius:0}.panel.open + .btn{display:none}}";

  var panel = document.createElement("div");
  panel.className = "panel";
  var btn = document.createElement("button");
  btn.className = "btn";
  btn.setAttribute("aria-label", "Chat");
  var chatIcon = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3C6.5 3 2 6.8 2 11.5c0 2.3 1.1 4.4 2.9 5.9L4 21l4.2-2.1c1.2.4 2.5.6 3.8.6 5.5 0 10-3.8 10-8.5S17.5 3 12 3z"/></svg>';
  var closeIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  btn.innerHTML = chatIcon;

  var loaded = false;
  function toggle() {
    var open = !panel.classList.contains("open");
    if (open && !loaded) {
      var iframe = document.createElement("iframe");
      iframe.src = origin + "/c/" + encodeURIComponent(slug) + "?embed=1";
      iframe.title = "Chat";
      iframe.setAttribute("allow", "clipboard-write");
      panel.appendChild(iframe);
      loaded = true;
    }
    panel.classList.toggle("open", open);
    btn.innerHTML = open ? closeIcon : chatIcon;
  }
  btn.addEventListener("click", toggle);

  root.appendChild(style);
  root.appendChild(panel);
  root.appendChild(btn);
  (document.body || document.documentElement).appendChild(host);
})();
