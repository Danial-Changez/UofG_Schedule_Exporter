// Outlook provider: Microsoft Graph auth, token refresh, and event import.

(function () {
  /**
   * Read outlook client_id from chrome.storage.
   * @async
   * @returns {Promise<Object>} Stored configuration object.
   */
  async function getConfig() {
    return new Promise((res) =>
      chrome.storage.local.get(["outlook_client_id"], (items) => res(items)),
    );
  }

  /**
   * Perform PKCE authorization flow for Microsoft Graph and persist tokens (uses self.auth helpers).
   * @async
   * @returns {Promise<Object>} Stored token object.
   */
  async function authenticate() {
    const cfg = await getConfig();
    const clientId = cfg.outlook_client_id;
    if (!clientId)
      throw new Error(
        "Outlook client_id not set in chrome.storage.local.outlook_client_id",
      );

    const redirectUri = self.auth.getRedirectUri("oauth2");
    const { codeVerifier, codeChallenge } = await self.auth.buildPKCE();
    await self.auth.setProviderPkceVerifier("outlook", codeVerifier);

    const scope = encodeURIComponent("offline_access Calendars.ReadWrite");
    const authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(
      redirectUri,
    )}&response_mode=query&scope=${scope}&code_challenge=${codeChallenge}&code_challenge_method=S256`;

    const redirect = await self.auth.launchAuthUrl(authUrl);
    const ru = new URL(redirect);
    const code = ru.searchParams.get("code");
    if (!code) throw new Error("Authorization code missing");

    const verifier = await self.auth.getProviderPkceVerifier("outlook");
    const body = new URLSearchParams({
      client_id: clientId,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    const tokenResp = await fetch(
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      },
    );
    if (!tokenResp.ok) throw new Error("Token exchange failed");
    const tokens = await tokenResp.json();
    const stored = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + (tokens.expires_in || 0) * 1000,
    };
    await self.auth.setProviderTokens("outlook", stored);
    return stored;
  }

  /**
   * Ensure Microsoft Graph access token is available and refresh if needed.
   * @async
   * @returns {Promise<{authenticated:boolean, accessToken?:string}>}
   */
  async function ensureAuth() {
    const data = await self.auth.getProviderTokens("outlook");
    if (!data || !data.access_token) return { authenticated: false };
    if (Date.now() > data.expires_at - 60000) {
      if (data.refresh_token) {
        try {
          const cfg = await getConfig();
          const clientId = cfg.outlook_client_id;
          const body = new URLSearchParams({
            client_id: clientId,
            grant_type: "refresh_token",
            refresh_token: data.refresh_token,
          });
          const resp = await fetch(
            "https://login.microsoftonline.com/common/oauth2/v2.0/token",
            {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: body.toString(),
            },
          );
          if (!resp.ok) throw new Error("Refresh failed");
          const t = await resp.json();
          const updated = {
            ...data,
            access_token: t.access_token,
            expires_at: Date.now() + (t.expires_in || 0) * 1000,
            refresh_token: t.refresh_token || data.refresh_token,
          };
          await self.auth.setProviderTokens("outlook", updated);
          return { authenticated: true, accessToken: updated.access_token };
        } catch (e) {
          return { authenticated: false };
        }
      }
      return { authenticated: false };
    }
    return { authenticated: true, accessToken: data.access_token };
  }

  /**
   * Wrapper to call Microsoft Graph API with optional accessToken.
   * @async
   * @param {string} path
   * @param {string} [method='GET']
   * @param {Object|null} [body=null]
   * @param {string|null} [accessToken=null]
   * @returns {Promise<Object>} Parsed JSON response.
   */
  async function apiRequest(
    path,
    method = "GET",
    body = null,
    accessToken = null,
  ) {
    const token = accessToken || (await ensureAuth()).accessToken;
    if (!token) throw new Error("No access token");
    const resp = await fetch(`https://graph.microsoft.com/v1.0/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : null,
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Graph API error ${resp.status}: ${text}`);
    }
    return resp.json();
  }

  /**
   * Convert a normalized event to a Microsoft Graph event payload.
   * @param {Object} ev
   * @returns {Object} Graph event resource.
   */
  function eventToGraphPayload(ev) {
    const subject = `${ev.InstructionalMethod || ""} ${ev.CourseName || ""}*${
      ev.SectionNumber || ""
    }`.trim();
    const body = {
      contentType: "text",
      content: `Instructor(s): ${(ev.Instructors || []).join(
        " | ",
      )}\nCredits: ${ev.Credits || ""}`,
    };
    const location = { displayName: ev.Location || "" };

    function parseLocalISO(dateStr, timeStr) {
      const [m, d, y] = dateStr.split("/").map((s) => parseInt(s, 10));
      const dt = new Date(
        `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(
          2,
          "0",
        )} ${timeStr}`,
      );
      return {
        dateTime: dt.toISOString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
    }

    const start = parseLocalISO(ev.StartDate, ev.StartTime);
    const end = parseLocalISO(ev.StartDate, ev.EndTime);

    const resource = { subject, body, start, end, location };

    if (ev.DaysOfWeek && ev.EndDate) {
      // Tokenize DaysOfWeek (handle 'Th' before 'T') and map to Graph daysOfWeek
      const tokenRegex = /Th|M|T|W|F/g;
      const tokenToGraph = {
        M: "monday",
        T: "tuesday",
        W: "wednesday",
        Th: "thursday",
        F: "friday",
      };
      const tokens = (String(ev.DaysOfWeek).match(tokenRegex) || []).map((t) =>
        t.trim(),
      );
      const days = tokens.map((t) => tokenToGraph[t]).filter(Boolean);

      resource.recurrence = {
        pattern: { type: "weekly", interval: 1, daysOfWeek: days },
        range: {
          type: "endDate",
          startDate: (() => {
            const [m, d, y] = ev.StartDate.split("/").map((s) =>
              s.padStart(2, "0"),
            );
            return `${y}-${m}-${d}`;
          })(),
          endDate: (() => {
            const [m, d, y] = ev.EndDate.split("/").map((s) =>
              s.padStart(2, "0"),
            );
            return `${y}-${m}-${d}`;
          })(),
        },
      };
    }

    return resource;
  }

  /**
   * Import an array of normalized events into the signed-in Outlook calendar.
   * @async
   * @param {Array<Object>} events
   * @param {function(number, number):void|null} [progressCallback=null]
   * @returns {Promise<{success:boolean,created:number,errors:Array}>}
   */
  async function importEvents(events, progressCallback = null) {
    const created = [];
    const errors = [];
    let idx = 0;
    for (const ev of events) {
      idx++;
      try {
        const payload = eventToGraphPayload(ev);
        await apiRequest("me/events", "POST", payload);
        created.push(ev);
      } catch (e) {
        errors.push({ event: ev, error: e.message });
      }
      if (progressCallback) {
        try {
          progressCallback(
            Math.round((idx / events.length) * 100),
            created.length,
          );
        } catch (e) {
          // ignore callback errors
        }
      }
    }
    return { success: errors.length === 0, created: created.length, errors };
  }

  self.outlook = {
    authenticate,
    importEvents,
    ensureAuth,
  };
})();
