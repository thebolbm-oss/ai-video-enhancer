/*! coi-serviceworker v0.1.7 - Guido Zuidhof and contributors, licensed under MIT
    https://github.com/gzuidhof/coi-serviceworker
    Enables cross-origin isolation (COOP/COEP) on static hosts that can't set
    custom response headers, by intercepting requests via a Service Worker and
    injecting the required headers client-side. This unlocks SharedArrayBuffer,
    which is required for multi-threaded WebAssembly (used here so ONNX Runtime
    Web can use more than a single CPU core for AI inference). */

let coepCredentialless = false;

if (typeof window === 'undefined') {
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

  self.addEventListener("message", (ev) => {
    if (!ev.data) return;
    if (ev.data.type === "deregister") {
      self.registration
        .unregister()
        .then(() => self.clients.matchAll())
        .then((clients) => clients.forEach((client) => client.navigate(client.url)));
    } else if (ev.data.type === "coepCredentialless") {
      coepCredentialless = ev.data.value;
    }
  });

  self.addEventListener("fetch", function (event) {
    const r = event.request;
    if (r.cache === "only-if-cached" && r.mode !== "same-origin") {
      return;
    }

    const request = (coepCredentialless && r.mode === "no-cors")
      ? new Request(r, { credentials: "omit" })
      : r;

    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.status === 0) {
            return response;
          }

          const newHeaders = new Headers(response.headers);
          newHeaders.set("Cross-Origin-Embedder-Policy", coepCredentialless ? "credentialless" : "require-corp");
          if (!coepCredentialless) {
            newHeaders.set("Cross-Origin-Resource-Policy", "cross-origin");
          }
          newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");

          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
          });
        })
        .catch((e) => console.error('[coi-serviceworker] fetch failed:', e))
    );
  });

} else {
  (() => {
    // Already isolated, or not in a secure context (isolation requires HTTPS) — nothing to do
    if (window.crossOriginIsolated !== false || !window.isSecureContext) {
      return;
    }

    if (!window.isSecureContext) {
      console.warn('[coi-serviceworker] Not a secure context — cross-origin isolation cannot be enabled.');
      return;
    }

    navigator.serviceWorker.register(window.document.currentScript.src).then(
      (registration) => {
        console.log('[coi-serviceworker] Registered. Scope:', registration.scope);

        registration.addEventListener('updatefound', () => {
          console.log('[coi-serviceworker] Update found — reloading to apply.');
          window.location.reload();
        });

        // If a worker is already active but this page wasn't loaded under its
        // control yet, reload once so it takes effect immediately.
        if (registration.active && !navigator.serviceWorker.controller) {
          console.log('[coi-serviceworker] Reloading page to activate cross-origin isolation...');
          window.location.reload();
        }
      },
      (err) => {
        console.error('[coi-serviceworker] Registration failed:', err);
      }
    );
  })();
}

