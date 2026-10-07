// Lightweight auth helper shared by background providers.
// Handles PKCE pieces for Outlook and basic chrome.identity helpers.

(function () {
  const storagePrefix = "auth:";

  const storage = {
    async get(keys) {
      return new Promise((resolve, reject) =>
        chrome.storage.local.get(keys, (items) => {
          if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
          resolve(items);
        }),
      );
    },
    async set(payload) {
      return new Promise((resolve, reject) =>
        chrome.storage.local.set(payload, () => {
          if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
          resolve();
        }),
      );
    },
  };

  function base64UrlEncode(buffer) {
    return btoa(String.fromCharCode.apply(null, new Uint8Array(buffer)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  async function buildPKCE() {
    const arr = new Uint8Array(32);
    crypto.getRandomValues(arr);
    const codeVerifier = base64UrlEncode(arr);
    const encoder = new TextEncoder();
    const digest = await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(codeVerifier),
    );
    const codeChallenge = base64UrlEncode(digest);
    return { codeVerifier, codeChallenge };
  }

  function getRedirectUri(path = "oauth2") {
    const base = chrome.identity.getRedirectURL(path);
    return base;
  }

  async function setProviderPkceVerifier(provider, verifier) {
    await storage.set({ [`${storagePrefix}pkce:${provider}`]: verifier });
  }

  async function getProviderPkceVerifier(provider) {
    const res = await storage.get([`${storagePrefix}pkce:${provider}`]);
    return res[`${storagePrefix}pkce:${provider}`];
  }

  async function setProviderTokens(provider, tokens) {
    await storage.set({ [`${storagePrefix}tokens:${provider}`]: tokens });
  }

  async function getProviderTokens(provider) {
    const res = await storage.get([`${storagePrefix}tokens:${provider}`]);
    return res[`${storagePrefix}tokens:${provider}`];
  }

  async function launchAuthUrl(url) {
    return new Promise((resolve, reject) =>
      chrome.identity.launchWebAuthFlow(
        { url, interactive: true },
        (redirectUrl) => {
          if (chrome.runtime.lastError || !redirectUrl) {
            return reject(
              chrome.runtime.lastError ||
                new Error("No redirect URL returned from auth flow"),
            );
          }
          resolve(redirectUrl);
        },
      ),
    );
  }

  self.auth = {
    buildPKCE,
    getRedirectUri,
    setProviderPkceVerifier,
    getProviderPkceVerifier,
    setProviderTokens,
    getProviderTokens,
    launchAuthUrl,
  };
})();
