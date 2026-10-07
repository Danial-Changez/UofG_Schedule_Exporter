import { expect } from "chai";

const API = "https://www.googleapis.com/calendar/v3";

const lecture = {
  CourseName: "CIS*2500",
  SectionNumber: "0101",
  Credits: 0.5,
  Instructors: ["Alice Example"],
  InstructionalMethod: "LEC",
  StartTime: "9:00 AM",
  EndTime: "10:20 AM",
  DaysOfWeek: "MWF",
  Location: "ROZH 104",
  StartDate: "09/04/2025",
  EndDate: "12/12/2025",
};

describe("Google provider", () => {
  const originals = {};
  let calendars;
  let requests;
  let rejectEvents;

  const ok = (body) => ({ ok: true, status: 200, json: async () => body });

  /** Stands in for the tokeninfo and Calendar endpoints google.js calls. */
  async function fakeFetch(url, opts = {}) {
    const method = opts.method || "GET";
    const body = opts.body ? JSON.parse(opts.body) : null;
    requests.push({ url, method, body, headers: opts.headers });

    if (url.includes("tokeninfo")) {
      return ok({ scope: "https://www.googleapis.com/auth/calendar" });
    }
    if (url === `${API}/users/me/calendarList`) {
      return ok({ items: calendars });
    }
    if (url === `${API}/calendars` && method === "POST") {
      calendars.push({ id: "new-cal", summary: body.summary });
      return ok({ id: "new-cal" });
    }
    if (url.endsWith("/events") && method === "POST") {
      if (rejectEvents) {
        return { ok: false, status: 403, json: async () => "forbidden" };
      }
      return ok({ id: "event-1" });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  }

  const sent = (method, suffix) =>
    requests.filter((r) => r.method === method && r.url.endsWith(suffix));

  before(async () => {
    for (const name of ["chrome", "self", "fetch"]) {
      originals[name] = global[name];
    }
    for (const name of ["log", "warn", "error"]) {
      originals[name] = console[name];
      console[name] = () => {};
    }
    global.chrome = {
      identity: { getAuthToken: (opts, callback) => callback("FAKE_TOKEN") },
      runtime: {},
    };
    global.self = {};
    global.fetch = fakeFetch;
    // google.js is a classic script that attaches its API to `self.google`.
    await import("../src/google.js");
  });

  after(() => {
    for (const name of ["chrome", "self", "fetch"]) {
      global[name] = originals[name];
    }
    for (const name of ["log", "warn", "error"]) {
      console[name] = originals[name];
    }
  });

  beforeEach(() => {
    calendars = [];
    requests = [];
    rejectEvents = false;
  });

  it("reuses a calendar that already has the requested name", async () => {
    calendars.push({ id: "existing", summary: "UofG Schedule" });

    const id = await self.google.getOrCreateCalendar("UofG Schedule");

    expect(id).to.equal("existing");
    expect(sent("POST", "/calendars")).to.deep.equal([]);
  });

  it("creates the calendar when none has the requested name", async () => {
    calendars.push({ id: "other", summary: "Personal" });

    const id = await self.google.getOrCreateCalendar("UofG Schedule");

    expect(id).to.equal("new-cal");
    expect(sent("POST", "/calendars")[0].body).to.deep.equal({
      summary: "UofG Schedule",
    });
  });

  it("posts each event to the schedule calendar with the auth token", async () => {
    const result = await self.google.importEvents([lecture]);

    expect(result).to.deep.equal({ success: true, created: 1, errors: [] });
    const [post] = sent("POST", "/calendars/new-cal/events");
    expect(post.headers.Authorization).to.equal("Bearer FAKE_TOKEN");
    expect(post.body).to.deep.include({
      summary: "LEC CIS*2500*0101",
      location: "ROZH 104",
      description: "Instructor(s): Alice Example\nCredits: 0.5",
      // 09/04/2025 is a Thursday; the first Mon/Wed/Fri after it is Friday.
      start: { dateTime: "2025-09-05T09:00:00", timeZone: "America/Toronto" },
      end: { dateTime: "2025-09-05T10:20:00", timeZone: "America/Toronto" },
    });
    expect(post.body.recurrence[0]).to.match(
      /^RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=\d{8}T\d{6}Z$/,
    );
    expect(post.body.recurrence).to.include(
      "EXDATE;TZID=America/Toronto:20251013T090000",
    );
  });

  it("reports events the API rejects instead of counting them", async () => {
    rejectEvents = true;

    const result = await self.google.importEvents([lecture]);

    expect(result.success).to.equal(false);
    expect(result.created).to.equal(0);
    expect(result.errors).to.have.lengthOf(1);
    expect(result.errors[0].event).to.equal(lecture);
  });
});
