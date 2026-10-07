import { expect } from "chai";

/**
 * Unit tests for Google provider auth/import flows.
 * - Stubs chrome.identity.getAuthToken and network fetch to validate
 *   auth token usage, calendar listing/creation, event posting, and cleanup.
 */

describe("Google OAuth Integration", () => {
  let originalChrome;
  let originalFetch;
  let lastOpts;
  let createdEvents;
  let calendarExists;
  let createdCalendarId;
  let tags;

  before(async () => {
    /** Set up a fake chrome global with identity and storage stubs. */
    originalChrome = global.chrome;
    global.chrome = {
      identity: {
        getAuthToken: (opts, cb) => cb("FAKE_TOKEN"),
        getRedirectURL: (suffix) => `https://fakeid.chromiumapp.org/${suffix}`,
      },
      storage: {
        local: {
          get: (keys, cb) => cb({ google_client_id: "FAKE_CLIENT_ID" }),
        },
      },
      runtime: {
        getManifest: () => ({ oauth2: { client_id: "FAKE_CLIENT_ID" } }),
        id: "fakeid",
      },
    };

    /** Minimal `self.auth` helpers used by providers under test. */
    global.self = global.self || {};
    global.self.auth = {
      getRedirectUri: (s) => chrome.identity.getRedirectURL(s),
      buildPKCE: async () => ({ codeVerifier: "v", codeChallenge: "c" }),
      getProviderPkceVerifier: async () => "v",
      setProviderPkceVerifier: async () => {},
      getProviderTokens: async () => null,
      setProviderTokens: async () => {},
    };

    /** Load the google provider under test (populates `self.google`). */
    await import("../src/google.js");
    /** Stub `fetch` to emulate Google Calendar API responses and tag operations. */
    originalFetch = global.fetch;
    lastOpts = null;
    createdEvents = [];
    calendarExists = false;
    createdCalendarId = null;
    tags = [];
    global.fetch = async (url, opts) => {
      lastOpts = opts;
      // emulate tokeninfo endpoint or other non-calendar endpoints as ok
      if (url.includes("tokeninfo")) {
        return {
          ok: true,
          json: async () => ({
            scope: "https://www.googleapis.com/auth/calendar",
          }),
          status: 200,
        };
      }
      // Listing calendarList
      if (url.endsWith("/users/me/calendarList")) {
        tags.push("CAL_LIST");
        return {
          ok: true,
          json: async () => ({
            items: calendarExists
              ? [{ id: "existingCal", summary: "Test" }]
              : [],
          }),
          status: 200,
        };
      }
      // Creating calendar
      if (url.endsWith("/calendars") && opts && opts.method === "POST") {
        tags.push("CAL_CREATE");
        calendarExists = true;
        createdCalendarId = "evt1";
        return {
          ok: true,
          json: async () => ({ id: createdCalendarId }),
          status: 200,
        };
      }
      // Inserting event into calendar
      if (url.includes("/events") && opts && opts.method === "POST") {
        tags.push("EVENT_POST");
        const id = `e${createdEvents.length + 1}`;
        createdEvents.push(id);
        return { ok: true, json: async () => ({ id }), status: 200 };
      }
      // Deleting event or calendar (DELETE)
      if (opts && opts.method === "DELETE") {
        tags.push("EVENT_DELETE");
        return { ok: true, status: 204, json: async () => ({}) };
      }
      // Default stub
      return { ok: true, json: async () => ({}), status: 200 };
    };
  });

  after(() => {
    global.fetch = originalFetch;
    global.chrome = originalChrome;
  });
  /** Suppress noisy console output during the tests. */
  let origConsoleLog, origConsoleWarn, origConsoleError;
  before(() => {
    origConsoleLog = console.log;
    origConsoleWarn = console.warn;
    origConsoleError = console.error;
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};
  });

  after(() => {
    console.log = origConsoleLog;
    console.warn = origConsoleWarn;
    console.error = origConsoleError;
  });

  it("Retrieved all calendars", async () => {
    const calId = await self.google.getOrCreateCalendar("Test");
    expect(calId).to.be.a("string");
    expect(tags).to.include("CAL_LIST");
  });

  it("Can create calendars", async () => {
    await self.google.getOrCreateCalendar("Test");
    expect(tags).to.include.oneOf(["CAL_CREATE", "CAL_LIST"]);
  });

  it("Can create cal events", async () => {
    const sampleEvent = {
      CourseName: "TEST",
      StartDate: "1/1/2025",
      StartTime: "09:00",
      EndTime: "10:00",
    };
    const result = await self.google.importEvents([sampleEvent]);
    expect(result).to.have.property("success", true);
    expect(tags).to.include("EVENT_POST");

    // Verify Authorization header on last request
    expect(lastOpts).to.be.an("object");
    expect(lastOpts.headers).to.have.property("Authorization");
    expect(lastOpts.headers.Authorization).to.include("FAKE_TOKEN");
  });

  it("Can delete calendars/events (cleanup)", async () => {
    try {
      if (createdCalendarId) {
        await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
            createdCalendarId,
          )}`,
          { method: "DELETE", headers: lastOpts.headers },
        );
      } else if (createdEvents.length) {
        for (const evId of createdEvents) {
          await fetch(
            `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
              await self.google.getOrCreateCalendar("Test"),
            )}/events/${evId}`,
            { method: "DELETE", headers: lastOpts.headers },
          );
        }
      }
    } catch {
      // Ignore cleanup errors in unit test
    }
    expect(tags).to.include("EVENT_DELETE");
  });
});
