// Google provider: Calendar import helpers loaded into the service worker via importScripts.

(function () {
  /**
   * Ensure the extension has a valid Google OAuth access token, validating calendar scope.
   * @async
   * @returns { Promise <{ authenticated: boolean, accessToken?: string }> } Authentication status and token if true.
   */
  async function ensureAuth() {
    // Use chrome.identity exclusively: try non-interactive first.
    if (typeof chrome !== "undefined" && chrome.identity.getAuthToken) {
      try {
        const token = await new Promise((res, rej) =>
          chrome.identity.getAuthToken({ interactive: false }, (t) => {
            if (chrome.runtime.lastError) return rej(chrome.runtime.lastError);
            res(t);
          }),
        );

        if (token) {
          // Validate token scopes via tokeninfo. If missing calendar scope, remove cached token
          try {
            const infoResp = await fetch(
              `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(
                token,
              )}`,
            );

            if (infoResp.ok) {
              const info = await infoResp.json();
              const scopes = (info.scope || "").split(" ");

              if (scopes.includes("https://www.googleapis.com/auth/calendar")) {
                return { authenticated: true, accessToken: token };
              } else {
                // Remove cached token so interactive consent is shown next
                if (chrome.identity.removeCachedAuthToken) {
                  chrome.identity.removeCachedAuthToken({ token });
                }
                return { authenticated: false };
              }
            }
          } catch {
            // Ignore tokeninfo errors and fallback to unauthenticated
            return { authenticated: false };
          }
        }
        return { authenticated: false };
      } catch {
        return { authenticated: false };
      }
    }

    // If chrome.identity is not available, fail authentication.
    return { authenticated: false };
  }

  /**
   * Remove a cached chrome.identity token to force re-consent or clear stale tokens.
   * @async
   * @returns {Promise<void>} Resolves when cache cleared.
   */
  async function clearCachedChromeToken() {
    if (typeof chrome === "undefined" || !chrome.identity.getAuthToken) return;
    try {
      const token = await new Promise((res, rej) =>
        chrome.identity.getAuthToken({ interactive: false }, (t) => {
          if (chrome.runtime.lastError) return rej(chrome.runtime.lastError);
          res(t);
        }),
      );
      if (token && chrome.identity.removeCachedAuthToken) {
        chrome.identity.removeCachedAuthToken({ token });
        console.log("Google: Cleared cached chrome token");
      }
    } catch (e) {
      console.warn("Google: clearCachedChromeToken failed", e && e.message);
    }
  }

  /**
   * Call the Google Calendar REST API with optional accessToken override.
   * @async
   * @param {string} path - API path under calendar (e.g. 'calendars/...').
   * @param {string} [method='GET'] - REST method.
   * @param {Object|null} [body=null] - Request content.
   * @param {string|null} [accessToken=null] - Explicit access token.
   * @returns {Promise<Object>} Parsed JSON.
   * @throws {Error} Error object with .status and .body for non-OK responses.
   */
  async function apiRequest(
    path,
    method = "GET",
    body = null,
    accessToken = null,
  ) {
    const token = accessToken || (await ensureAuth()).accessToken;

    if (!token) throw new Error("No access token");
    const url = `https://www.googleapis.com/calendar/v3/${path}`;

    // Mask token for logs: show first 6 and last 4 chars
    const maskToken = (t) =>
      t?.length > 10 ? `${t.slice(0, 6)}...${t.slice(-4)}` : "<No-Token>";
    console.log("Google: apiRequest", {
      url,
      method,
      body: body ? Object.keys(body) : null,
      token: maskToken(token),
    });

    // Fetch with timeout to avoid indefinite hanging
    const fetchWithTimeout = (resource, options = {}) => {
      const { timeout = 15000 } = options;
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeout);
      return fetch(resource, { ...options, signal: controller.signal })
        .then((res) => {
          clearTimeout(id);
          return res;
        })
        .catch((err) => {
          clearTimeout(id);
          throw err;
        });
    };

    const resp = await fetchWithTimeout(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : null,
      timeout: 15000,
    });

    if (!resp.ok) {
      // Attempt to parse JSON error body, fall back to text otherwise
      let bodyText = null;
      let bodyJson = null;

      try {
        bodyJson = await resp.json();
      } catch {
        try {
          bodyText = await resp.text();
        } catch {
          bodyText = "<Unable to read body>";
        }
      }

      const err = new Error(`Google API error ${resp.status}`);
      err.status = resp.status;
      err.body = bodyJson || bodyText;

      // If 401, try to fetch tokeninfo to help debug
      if (resp.status === 401) {
        try {
          const ti = await fetch(
            `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(
              token,
            )}`,
          ).then((r) => (r.ok ? r.json() : null));
          err.tokenInfo = ti;
          console.warn("Google: tokenInfo for failing token", {
            token: maskToken(token),
            tokenInfo: ti,
          });
        } catch {
          // Ignore tokeninfo failure
        }
      }
      throw err;
    }
    return resp.json();
  }

  /**
   * Convert a normalized event into a Google Calendar event resource.
   * The normalized event is expected to contain StartDate, StartTime, EndTime,
   * CourseName, Instructors, Location, DaysOfWeek, EndDate etc.
   * @param {Object} ev - Normalized event object.
   * @returns {Object} Google Calendar event resource.
   */
  function eventToGooglePayload(ev) {
    const summary = `${ev.InstructionalMethod || ""} ${ev.CourseName || ""}*${
      ev.SectionNumber || ""
    }`.trim();

    const description = `Instructor(s): ${(ev.Instructors || []).join(
      " | ",
    )}\nCredits: ${ev.Credits || ""}`;
    const location = ev.Location || "";

    // Parse the start date and calculate duration
    const [sm, sd, sy] = ev.StartDate.split("/").map((s) => parseInt(s, 10));
    let startDt = new Date(
      `${sy}-${String(sm).padStart(2, "0")}-${String(sd).padStart(2, "0")} ${ev.StartTime}`,
    );
    let endDt = new Date(
      `${sy}-${String(sm).padStart(2, "0")}-${String(sd).padStart(2, "0")} ${ev.EndTime}`,
    );
    const durationMs = endDt.getTime() - startDt.getTime();

    // If event has recurring days, advance startDt to first matching weekday
    let targetDays = [];
    if (ev.DaysOfWeek) {
      const tokenRegex = /Th|M|T|W|F/g;
      const tokenToDay = { M: 1, T: 2, W: 3, Th: 4, F: 5 }; // JS weekday numbers
      const tokens = (ev.DaysOfWeek.match(tokenRegex) || []).map((t) =>
        t.trim(),
      );
      targetDays = tokens.map((t) => tokenToDay[t]).filter((n) => n != null);

      if (targetDays.length > 0) {
        // Advance startDt up to 7 days to match one of targetDays
        let attempts = 0;
        while (!targetDays.includes(startDt.getDay()) && attempts < 7) {
          startDt = new Date(startDt.getTime() + 24 * 3600 * 1000);
          attempts++;
        }
        // Recalculate endDt to maintain the same duration
        endDt = new Date(startDt.getTime() + durationMs);
      }
    }

    // Format adjusted dates
    const formatDt = (dt) => {
      return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}T${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}:${String(dt.getSeconds()).padStart(2, "0")}`;
    };

    const start = {
      dateTime: formatDt(startDt),
      timeZone: "America/Toronto",
    };
    const end = {
      dateTime: formatDt(endDt),
      timeZone: "America/Toronto",
    };

    const resource = { summary, description, location, start, end };

    // Recurrence handling: convert DaysOfWeek + EndDate to RRULE
    if (ev.DaysOfWeek) {
      // Tokenize 'Th' before single-letter tokens so "TTh" -> ["T","Th"]
      const tokenRegex = /Th|M|T|W|F/g;
      const tokenToBy = { M: "MO", T: "TU", W: "WE", Th: "TH", F: "FR" };
      const tokens = (ev.DaysOfWeek.match(tokenRegex) || []).map((t) =>
        t.trim(),
      );
      const days = tokens.map((t) => tokenToBy[t]).filter(Boolean);

      if (ev.EndDate && days.length > 0) {
        const [em, ed, ey] = ev.EndDate.split("/").map((s) => parseInt(s, 10));
        const until = new Date(ey, em - 1, ed, 23, 59, 59);
        const untilStr = `${until.getUTCFullYear()}${String(
          until.getUTCMonth() + 1,
        ).padStart(2, "0")}${String(until.getUTCDate()).padStart(
          2,
          "0",
        )}T${String(until.getUTCHours()).padStart(2, "0")}${String(
          until.getUTCMinutes(),
        ).padStart(2, "0")}${String(until.getUTCSeconds()).padStart(2, "0")}Z`;

        resource.recurrence = [
          `RRULE:FREQ=WEEKLY;BYDAY=${days.join(",")};UNTIL=${untilStr}`,
        ];

        // Add EXDATE entries for reading weeks and exam period (UofG breaks)
        // Only exclude exam period for regular classes, not for EXAM events
        const isExamEvent = ev.InstructionalMethod === "EXAM";
        const breakDates = isExamEvent
          ? getBreakDatesForEventWithoutExams(startDt, until, targetDays)
          : getBreakDatesForEvent(startDt, until, targetDays);
        for (const breakDate of breakDates) {
          // Set the EXDATE to the same time as the event start
          const exDate = new Date(breakDate);
          exDate.setHours(startDt.getHours(), startDt.getMinutes(), 0, 0);
          const exDateStr = `${exDate.getFullYear()}${String(exDate.getMonth() + 1).padStart(2, "0")}${String(exDate.getDate()).padStart(2, "0")}T${String(exDate.getHours()).padStart(2, "0")}${String(exDate.getMinutes()).padStart(2, "0")}${String(exDate.getSeconds()).padStart(2, "0")}`;
          resource.recurrence.push(`EXDATE;TZID=America/Toronto:${exDateStr}`);
        }
      }
    }

    return resource;
  }

  /**
   * Get the Nth occurrence of a specific weekday in a given month.
   */
  function getNthWeekdayOfMonth(year, month, weekday, n) {
    const firstDay = new Date(year, month, 1);
    const firstWeekday = firstDay.getDay();
    let dayOffset = weekday - firstWeekday;
    if (dayOffset < 0) dayOffset += 7;
    const date = 1 + dayOffset + (n - 1) * 7;
    return new Date(year, month, date);
  }

  /**
   * Calculate University of Guelph reading week dates for a given academic year.
   * - Fall Study Break: Saturday before Thanksgiving through Tuesday after (Sat-Tue)
   * - Winter Reading Week: Week containing Family Day (3rd Monday of February) - Mon-Fri
   */
  function getReadingWeeks(fallYear) {
    const breaks = [];

    // Fall Study Break: 2nd Monday of October is Thanksgiving
    const thanksgiving = getNthWeekdayOfMonth(fallYear, 9, 1, 2);
    const fallBreakStart = new Date(
      thanksgiving.getFullYear(),
      thanksgiving.getMonth(),
      thanksgiving.getDate() - 2,
    );
    const fallBreakEnd = new Date(
      thanksgiving.getFullYear(),
      thanksgiving.getMonth(),
      thanksgiving.getDate() + 1,
    );
    breaks.push({ start: fallBreakStart, end: fallBreakEnd });

    // Winter Reading Week: 3rd Monday of February is Family Day
    const winterYear = fallYear + 1;
    const familyDay = getNthWeekdayOfMonth(winterYear, 1, 1, 3);
    breaks.push({
      start: new Date(
        familyDay.getFullYear(),
        familyDay.getMonth(),
        familyDay.getDate(),
      ),
      end: new Date(
        familyDay.getFullYear(),
        familyDay.getMonth(),
        familyDay.getDate() + 4,
      ),
    });

    return breaks;
  }

  /**
   * Get break dates for event excluding exam period (for EXAM events).
   * Only includes reading weeks, not the exam period itself.
   */
  function getBreakDatesForEventWithoutExams(eventStart, eventEnd, targetDays) {
    const excludeDates = [];

    // Determine academic year from event start
    const startMonth = eventStart.getMonth();
    const fallYear =
      startMonth >= 7 ? eventStart.getFullYear() : eventStart.getFullYear() - 1;

    // Get reading weeks only (no exam period)
    const breaks = [
      ...getReadingWeeks(fallYear),
      ...getReadingWeeks(fallYear + 1),
    ];

    for (const breakPeriod of breaks) {
      const current = new Date(breakPeriod.start);
      while (current <= breakPeriod.end) {
        if (
          current >= eventStart &&
          current <= eventEnd &&
          targetDays.includes(current.getDay())
        ) {
          excludeDates.push(new Date(current));
        }
        current.setDate(current.getDate() + 1);
      }
    }

    return excludeDates;
  }

  /**
   * Get exam period dates (last 2 weeks of the term) for exclusion.
   * The EndDate from WebAdvisor includes the exam period, so we need to exclude it.
   * @param {Date} termEndDate - The end date of the term (including exams)
   * @returns {{start: Date, end: Date}} The exam period to exclude
   */
  function getExamPeriod(termEndDate) {
    // Exam period is the last 2 weeks (14 days) before the term end date
    const examEnd = new Date(termEndDate);
    const examStart = new Date(termEndDate);
    examStart.setDate(examStart.getDate() - 13); // 14 days total including end date
    return { start: examStart, end: examEnd };
  }

  /**
   * Get all break dates that fall on specified weekdays between event start and end.
   * Includes reading weeks and exam periods.
   */
  function getBreakDatesForEvent(eventStart, eventEnd, targetDays) {
    const excludeDates = [];

    // Determine academic year from event start
    const startMonth = eventStart.getMonth();
    const fallYear =
      startMonth >= 7 ? eventStart.getFullYear() : eventStart.getFullYear() - 1;

    // Get reading weeks
    const breaks = [
      ...getReadingWeeks(fallYear),
      ...getReadingWeeks(fallYear + 1),
    ];

    // Add exam period (last 2 weeks of the term) to breaks
    const examPeriod = getExamPeriod(eventEnd);
    breaks.push(examPeriod);

    for (const breakPeriod of breaks) {
      const current = new Date(breakPeriod.start);
      while (current <= breakPeriod.end) {
        if (
          current >= eventStart &&
          current <= eventEnd &&
          targetDays.includes(current.getDay())
        ) {
          excludeDates.push(new Date(current));
        }
        current.setDate(current.getDate() + 1);
      }
    }

    return excludeDates;
  }

  /**
   * Get a calendar by summary or create it (optional accessToken override).
   * @async
   * @param {string} [calendarName='UofG Schedule']
   * @param {string|null} [accessToken=null]
   * @returns {Promise<string>} calendarId
   */
  async function getOrCreateCalendar(
    calendarName = "UofG Schedule",
    accessToken = null,
  ) {
    // List calendars and try to find by summary
    const list = await apiRequest(
      "users/me/calendarList",
      "GET",
      null,
      accessToken,
    );
    const existing = (list.items || []).find((c) => c.summary === calendarName);
    if (existing) return existing.id;

    // Create new calendar
    const created = await apiRequest(
      "calendars",
      "POST",
      { summary: calendarName },
      accessToken,
    );
    return created.id;
  }

  /**
   * Acquire an interactive Google OAuth access token via chrome.identity.
   *
   * @async
   * @returns {Promise<{access_token:string}>} The acquired token object.
   */
  async function authenticate() {
    // Prefer chrome.identity interactive flow when available
    if (typeof chrome !== "undefined" && chrome.identity.getAuthToken) {
      try {
        const token = await new Promise((res, rej) =>
          chrome.identity.getAuthToken({ interactive: true }, (t) => {
            if (chrome.runtime.lastError) return rej(chrome.runtime.lastError);
            res(t);
          }),
        );
        return { access_token: token };
      } catch (e) {
        throw new Error("Authentication failed: " + (e.message || e), {
          cause: e,
        });
      }
    }
    // If chrome.identity is not available, fail authentication.
    throw new Error("Google authentication not available in this environment");
  }

  /**
   * Import normalized events into the user's primary Google Calendar.
   * Ensures interactive consent if needed. Calls progressCallback with a
   * percentage (0-100) if provided.
   * @async
   * @param {Array<Object>} events
   * @param {function(number):void|null} [progressCallback=null]
   * @returns {Promise<{success:boolean,created:number,errors:Array}>}
   */
  async function importEvents(events, progressCallback = null) {
    console.log("Google: importEvents start", { count: events.length });
    // Ensure authenticated
    let auth = await ensureAuth();
    if (!auth.authenticated) {
      console.log(
        "Google: not authenticated; invoking chrome.identity interactive flow",
      );
      if (
        typeof chrome !== "undefined" &&
        chrome.identity &&
        chrome.identity.getAuthToken
      ) {
        try {
          const token = await new Promise((res, rej) =>
            chrome.identity.getAuthToken({ interactive: true }, (t) => {
              if (chrome.runtime.lastError)
                return rej(chrome.runtime.lastError);
              res(t);
            }),
          );
          auth = { authenticated: true, accessToken: token };
        } catch (e) {
          throw new Error("Authentication failed: " + (e.message || e), {
            cause: e,
          });
        }
      } else {
        throw new Error("Authentication not available in this environment");
      }
    }
    const created = [];
    const errors = [];
    let idx = 0;
    for (const ev of events) {
      idx++;
      try {
        console.log(`Google: importing event ${idx}/${events.length}`, {
          evShort: ev.CourseName + " " + ev.StartDate,
        });
        const payload = eventToGooglePayload(ev);
        // Ensure or create the target calendar named 'UofG Schedule'
        const tokenToUse = auth?.accessToken ?? null;
        const calendarId = await getOrCreateCalendar(
          "UofG Schedule",
          tokenToUse,
        );
        console.log("Google: apiRequest payload", payload);
        const resp = await apiRequest(
          `calendars/${encodeURIComponent(calendarId)}/events`,
          "POST",
          payload,
          tokenToUse,
        );
        console.log(`Google: event inserted ${idx}`, { id: resp.id });
        created.push(ev);
      } catch (e) {
        // Log the full error object (status/body) so DevTools shows details
        console.error("Google: event import error", {
          idx,
          status: e && e.status,
          body: e && e.body,
          error: e,
        });
        errors.push({ event: ev, error: e && (e.body || e.message) });
      }
      if (progressCallback) {
        try {
          progressCallback(
            Math.round((idx / events.length) * 100),
            created.length,
          );
        } catch {
          // ignore callback errors
        }
      }
    }
    console.log("Google: importEvents done", {
      created: created.length,
      errors: errors.length,
    });
    return { success: errors.length === 0, created: created.length, errors };
  }

  // Public API: exported functions (listed here for quick reference).
  // Implementations are defined above. Attach them to self.google at the end
  // so the module reads top-to-bottom with helpers first.
  self.google = {
    authenticate,
    importEvents,
    getOrCreateCalendar,
    ensureAuth,
    clearCachedChromeToken,
  };
})();
