// Shajarah app shell: opens from the copy saved on the phone, with or without internet.
// The page is refreshed quietly in the background; server calls are never cached here.
var CACHE = "sj-v9";
var SHELL = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png", "./fonts/nastaliq-400.woff2", "./fonts/nastaliq-700.woff2"];
self.addEventListener("install", function (e) { e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL.map(function (u) { return new Request(u, { cache: "no-cache" }); })); }).then(function () { return self.skipWaiting(); })); });
self.addEventListener("activate", function (e) { e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k.indexOf("sj-") === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); })); });
self.addEventListener("fetch", function (e) {
  var req = e.request; if (req.method !== "GET") return;
  var url = new URL(req.url); if (url.origin !== self.location.origin || url.pathname.indexOf(new URL("./", self.location).pathname) !== 0) return;
  var key = new Request(url.origin + url.pathname), page = /\/$|\.html$|\.json$/.test(url.pathname);
  var get = function () { return fetch(req.url, { cache: "no-cache" }).then(function (res) { if (res && res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(key, copy); }); } return res; }); };
  var saved = caches.match(key).then(function (hit) { return hit || (/\/$/.test(url.pathname) ? caches.match(url.origin + url.pathname + "index.html") : null); });
  var net = page ? get() : null; if (net) e.waitUntil(net.catch(function () {}));
  e.respondWith(saved.then(function (hit) { return hit || net || get(); }).catch(function () { return caches.match("./index.html"); }));
});
// Notifications for the owner: shown even when the app is closed.
// A new entry comes with Approve / Reject buttons (Android); tapping the notification itself opens the entry to change its name.
self.addEventListener("push", function (e) { var d = {}; try { d = e.data ? e.data.json() : {}; } catch (x) {}
  var o = { body: d.body || "", icon: "./icon-192.png", badge: "./icon-192.png", tag: "sj-" + (d.go || "x"), renotify: true, requireInteraction: !!d.actions, data: { go: d.go || "pend", server: d.server || "", acts: d.acts || null } };
  if (d.actions && d.acts) o.actions = [{ action: "approve", title: "✓ Approve" }, { action: "reject", title: "✕ Reject" }];
  e.waitUntil(self.registration.showNotification(d.title || "Shajarah", o)); });
function openApp(go) { return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (cs) {
  for (var i = 0; i < cs.length; i++) { if ("focus" in cs[i]) { cs[i].postMessage({ go: go }); return cs[i].focus(); } }
  return self.clients.openWindow("./#" + encodeURIComponent(go)); }); }
self.addEventListener("notificationclick", function (e) { var d = e.notification.data || {}, go = d.go || "pend", act = e.action; e.notification.close();
  if ((act === "approve" || act === "reject") && d.acts && d.acts[act] && d.server) {
    e.waitUntil(fetch(d.server + "/api/act", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ t: d.acts[act] }) })
      .then(function (r) { return r.json(); })
      .then(function (j) { return self.registration.showNotification("Shajarah", { body: j.msg || "Done", icon: "./icon-192.png", tag: "sj-done" }); })
      .catch(function () { return openApp(go); }));
    return; }
  e.waitUntil(openApp(go)); });
