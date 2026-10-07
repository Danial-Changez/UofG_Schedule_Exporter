// ICS generator: normalizes the WebAdvisor `result` object into events and
// renders them as iCalendar text.

/**
 * Parse a local date string (MM/DD/YYYY) and a time string (e.g. '9:00 AM')
 * into a JavaScript Date in the local timezone. Returns null on parse
 * failure.
 * @param {string} dateStr - Date in MM/DD/YYYY format.
 * @param {string} timeStr - Time in 'h:mm AM/PM' or 'HH:MM' format.
 * @returns {Date|null}
 */
function parseDateTime(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const parts = dateStr.split("/").map((s) => parseInt(s, 10));
  if (parts.length !== 3) return null;
  const m = parts[0];
  const d = parts[1];
  const y = parts[2];

  const t = timeStr.trim();
  const tm = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  let hour = 0,
    minute = 0;
  if (tm) {
    hour = parseInt(tm[1], 10);
    minute = parseInt(tm[2], 10);
    const ampm = (tm[3] || "").toUpperCase();
    if (ampm === "PM" && hour !== 12) hour += 12;
    if (ampm === "AM" && hour === 12) hour = 0;
  } else {
    // fallback: try HH:MM 24h
    const tm2 = t.match(/^(\d{1,2}):(\d{2})$/);
    if (tm2) {
      hour = parseInt(tm2[1], 10);
      minute = parseInt(tm2[2], 10);
    }
  }

  return new Date(y, m - 1, d, hour, minute, 0, 0);
}

/**
 * Format a Date object to an iCalendar DATE-TIME string: local wall-clock
 * time as YYYYMMDDTHHMMSS, or UTC with a trailing 'Z' when `utc` is set.
 * @param {Date} dt
 * @param {boolean} [utc=false]
 * @returns {string}
 */
function formatICSDatetime(dt, utc = false) {
  if (utc) return dt.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const pad = (n) => String(n).padStart(2, "0");
  const year = dt.getFullYear();
  const month = pad(dt.getMonth() + 1);
  const day = pad(dt.getDate());
  const hour = pad(dt.getHours());
  const min = pad(dt.getMinutes());
  const sec = pad(dt.getSeconds());
  return `${year}${month}${day}T${hour}${min}${sec}`;
}

/**
 * Get the Nth occurrence of a specific weekday in a given month.
 * @param {number} year
 * @param {number} month - 0-indexed (0 = January)
 * @param {number} weekday - 0 = Sunday, 1 = Monday, etc.
 * @param {number} n - Which occurrence (1 = first, 2 = second, etc.)
 * @returns {Date}
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
 *   Thanksgiving is the 2nd Monday of October. Break is Sat, Sun, Mon (holiday), Tue (study day).
 * - Winter Reading Week: Week containing Family Day (3rd Monday of February) - Mon-Fri
 * @param {number} fallYear - The year of the fall semester
 * @returns {Array<{start: Date, end: Date}>} Array of break periods
 */
function getReadingWeeks(fallYear) {
  const breaks = [];

  // Fall Study Break: 2nd Monday of October is Thanksgiving
  // Break runs from Saturday before Thanksgiving through Tuesday after
  // Sat, Sun, Mon (Thanksgiving Holiday), Tue (Study Break Day) - classes resume Wed
  const thanksgiving = getNthWeekdayOfMonth(fallYear, 9, 1, 2); // October, Monday, 2nd
  const fallBreakStart = new Date(
    thanksgiving.getFullYear(),
    thanksgiving.getMonth(),
    thanksgiving.getDate() - 2,
  ); // Saturday
  const fallBreakEnd = new Date(
    thanksgiving.getFullYear(),
    thanksgiving.getMonth(),
    thanksgiving.getDate() + 1,
  ); // Tuesday
  breaks.push({
    start: fallBreakStart,
    end: fallBreakEnd,
  });

  // Winter Reading Week: 3rd Monday of February is Family Day
  // Reading week is Mon-Fri of that week
  const winterYear = fallYear + 1;
  const familyDay = getNthWeekdayOfMonth(winterYear, 1, 1, 3); // February, Monday, 3rd
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
    ), // Friday
  });

  return breaks;
}

/**
 * Get exam period dates (last 2 weeks of the term) for exclusion.
 * The EndDate from WebAdvisor includes the exam period, so we need to exclude it.
 * @param {Date} termEndDate - The end date of the term (including exams)
 * @returns {{start: Date, end: Date}} The exam period to exclude
 */
function getExamPeriod(termEndDate) {
  const examEnd = new Date(termEndDate);
  const examStart = new Date(termEndDate);
  examStart.setDate(examStart.getDate() - 13); // 14 days total including end date
  return { start: examStart, end: examEnd };
}

/**
 * Get all break dates that fall on specified weekdays between event start and end.
 * Includes reading weeks and exam periods.
 * @param {Date} eventStart - Event start date
 * @param {Date} eventEnd - Event end date (UNTIL)
 * @param {Array<number>} targetDays - JS weekday numbers (0=Sun, 1=Mon, etc.)
 * @param {boolean} [includeExamPeriod=true] - Whether to include exam period in exclusions
 * @returns {Array<Date>} Dates to exclude
 */
function getBreakDatesForEvent(
  eventStart,
  eventEnd,
  targetDays,
  includeExamPeriod = true,
) {
  const excludeDates = [];

  // Determine academic year from event start
  // If event starts Aug-Dec, fall year is that year
  // If event starts Jan-Jul, fall year is previous year
  const startMonth = eventStart.getMonth();
  const fallYear =
    startMonth >= 7 ? eventStart.getFullYear() : eventStart.getFullYear() - 1;

  // Get reading weeks for this academic year and potentially the next
  const breaks = [
    ...getReadingWeeks(fallYear),
    ...getReadingWeeks(fallYear + 1),
  ];

  if (includeExamPeriod) {
    const examPeriod = getExamPeriod(eventEnd);
    breaks.push(examPeriod);
  }

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

function buildCalendarLines(events) {
  // Exam weeks are excluded with EXDATE entries rather than by shortening UNTIL.

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "PRODID:-//Danial Changez//Guelph Student Schedule Exporter v1.0//EN",
  ];

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev.StartTime || !ev.EndTime) continue;

    let startDt = parseDateTime(ev.StartDate, ev.StartTime);
    let endDt = parseDateTime(ev.StartDate, ev.EndTime);
    if (!startDt || !endDt) continue;
    const origStartTs = startDt.getTime();
    const origEndTs = endDt.getTime();
    const durationMs = origEndTs - origStartTs;

    // 'Th' is matched before the single letters so "TTh" yields TU,TH.
    const tokenRegex = /Th|M|T|W|F/g;
    const tokenToBy = { M: "MO", T: "TU", W: "WE", Th: "TH", F: "FR" };
    const tokens = (ev.DaysOfWeek.match(tokenRegex) || []).map((t) => t.trim());
    const days = tokens.map((t) => tokenToBy[t]).filter(Boolean);
    const byday = days.join(",");

    let untilDtTs;
    const ed = ev.EndDate;
    if (ed) {
      const p = ed.split("/").map((s) => parseInt(s, 10));
      if (p.length === 3) {
        untilDtTs =
          new Date(p[2], p[0] - 1, p[1]).getTime() +
          (23 * 3600 + 59 * 60 + 59) * 1000;
        endDt = new Date(startDt.getTime() + durationMs);
      } else untilDtTs = startDt.getTime();
    } else untilDtTs = startDt.getTime();

    const untilDt = new Date(untilDtTs);

    // If the event is recurring on specific weekdays, set DTSTART to the
    // first occurrence on or after the provided StartDate that matches BYDAY.
    if (byday) {
      // Map BYDAY tokens to JS weekday numbers (0=Sun..6=Sat)
      const bydayMap = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 0 };
      const targetDays = byday
        .split(",")
        .map((d) => bydayMap[d])
        .filter((n) => n != null);
      if (targetDays.length > 0) {
        let attempts = 0;
        while (!targetDays.includes(startDt.getDay()) && attempts < 7) {
          startDt = new Date(startDt.getTime() + 24 * 3600 * 1000);
          attempts++;
        }
        endDt = new Date(startDt.getTime() + durationMs);
      }
    }

    // RFC 5545 TEXT values carry a line break as the two characters "\n".
    const desc = `Instructor(s): ${(ev.Instructors || []).join(
      " | ",
    )}\\nCredits: ${ev.Credits || ""}`;

    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${cryptoRandomId()}@schedule`);
    lines.push(`DTSTAMP:${formatICSDatetime(new Date(), true)}`);
    lines.push(`DTSTART:${formatICSDatetime(startDt)}`);
    lines.push(`DTEND:${formatICSDatetime(endDt)}`);
    if (byday) {
      lines.push(
        `RRULE:FREQ=WEEKLY;BYDAY=${byday};UNTIL=${formatICSDatetime(untilDt)}`,
      );

      const bydayMap = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 0 };
      const eventTargetDays = byday
        .split(",")
        .map((d) => bydayMap[d])
        .filter((n) => n != null);
      // Regular classes skip the exam period; EXAM meetings must not.
      const includeExamPeriod = ev.InstructionalMethod !== "EXAM";
      const breakDates = getBreakDatesForEvent(
        startDt,
        untilDt,
        eventTargetDays,
        includeExamPeriod,
      );

      for (const breakDate of breakDates) {
        // Set the EXDATE to the same time as the event start
        const exDate = new Date(breakDate);
        exDate.setHours(startDt.getHours(), startDt.getMinutes(), 0, 0);
        lines.push(`EXDATE:${formatICSDatetime(exDate)}`);
      }
    }
    lines.push(
      `SUMMARY:${ev.InstructionalMethod || ""} ${ev.CourseName || ""}*${
        ev.SectionNumber || ""
      }`,
    );
    lines.push(`DESCRIPTION:${desc}`);
    lines.push(`LOCATION:${ev.Location || ""}`);
    lines.push("END:VEVENT");
    lines.push("");
  }

  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  lines.push("END:VCALENDAR");
  return lines;
}

/**
 * Return a cryptographically-random identifier suitable for use as a UID
 * in VEVENTs. Falls back to Math.random if crypto is unavailable.
 * @returns {string}
 */
function cryptoRandomId() {
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return Array.from(arr)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Normalize the page-provided raw result into an array of event objects.
 * Each event contains fields such as CourseName, SectionNumber, StartDate,
 * StartTime, EndTime, DaysOfWeek, Instructors, Location, Credits, etc.
 * @export
 * @param {Object} rawData - The page 'result' object.
 * @param {Array<string>} [selectedTermCodes] - Filter terms by these codes.
 * @returns {Array<Object>} Normalized events ready for export/import.
 */
export function generateEventsFromRawData(rawData, selectedTermCodes) {
  let terms = rawData.Terms || [];
  if (Array.isArray(selectedTermCodes) && selectedTermCodes.length > 0) {
    const set = new Set(selectedTermCodes.map(String));
    terms = terms.filter((t) => set.has(String(t.Code)));
  }
  const planned = [];
  // Prefer the student's registered/active sections when possible.
  terms.forEach((t) => {
    const pcs = t.PlannedCourses || [];
    const activeSet = new Set((t.ActiveSectionIds || []).map(String));

    // If at least one course marks HasRegisteredSection, prefer only registered ones
    const anyHasRegistered = pcs.some(
      (p) =>
        p.HasRegisteredSection || (p.Section && p.Section.HasRegisteredSection),
    );

    pcs.forEach((p) => {
      const sec = p.Section || {};
      const secId = sec.Id || sec.SectionId || p.SectionId || "";
      const secHasRegistered = !!(
        p.HasRegisteredSection || sec.HasRegisteredSection
      );

      if (activeSet.size > 0) {
        // Use ActiveSectionIds when available (these are the user's registered section ids)
        if (secId && activeSet.has(String(secId))) planned.push(p);
        else if (secHasRegistered) planned.push(p);
        // otherwise skip other sections in the same term
      } else if (anyHasRegistered) {
        if (secHasRegistered) planned.push(p);
      } else {
        // No clear registration markers — fall back to including all planned courses
        planned.push(p);
      }
    });
  });

  const events = [];
  planned.forEach((entry) => {
    const sec = entry.Section || {};
    const base = {
      CourseName: sec.CourseName,
      SectionNumber: sec.Number,
      Credits: sec.MinimumCredits,
      Instructors: sec.Faculty || [],
    };

    // Support two meeting shapes: PlannedMeetings (array) or Meetings (legacy)
    const meetings = sec.PlannedMeetings || sec.Meetings || [];
    meetings.forEach((meeting) => {
      const method =
        meeting.InstructionalMethod || meeting.InstructionalMethodCode || "";

      const loc = (
        meeting.MeetingLocation ||
        meeting.Room ||
        meeting.Location ||
        ""
      ).trim();

      // Dates: prefer StartDateString/EndDateString, otherwise ISO StartDate/EndDate
      const startDateStr =
        meeting.StartDateString ||
        (meeting.StartDate ? formatISODateForMDY(meeting.StartDate) : null);
      const endDateStr =
        meeting.EndDateString ||
        (meeting.EndDate ? formatISODateForMDY(meeting.EndDate) : null);

      // Times: some fixtures may include StartTimeHour/Minute or RawStartTime
      const startTime =
        meeting.StartTime ||
        (meeting.StartTimeHour != null
          ? `${String(meeting.StartTimeHour)}:${String(
              meeting.StartTimeMinute || 0,
            ).padStart(2, "0")}`
          : meeting.RawStartTime);
      const endTime =
        meeting.EndTime ||
        (meeting.EndTimeHour != null
          ? `${String(meeting.EndTimeHour)}:${String(
              meeting.EndTimeMinute || 0,
            ).padStart(2, "0")}`
          : meeting.RawEndTime);

      // Meetings without a time (TBD or online) cannot be placed on a calendar.
      if (!startTime || !endTime) return;

      events.push({
        ...base,
        InstructionalMethod: method,
        StartTime: startTime,
        EndTime: endTime,
        FormattedTime: meeting.FormattedTime,
        DaysOfWeek: meeting.DaysOfWeek || meeting.Days || "",
        Location: loc,
        StartDate: startDateStr,
        EndDate: endDateStr,
        Instructors: base.Instructors,
      });
    });
  });

  // Helper: convert ISO date like 2025-09-08T00:00:00 to MM/DD/YYYY used by parser
  function formatISODateForMDY(iso) {
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return null;
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      const yyyy = d.getFullYear();
      return `${mm}/${dd}/${yyyy}`;
    } catch {
      return null;
    }
  }
  return events;
}

/**
 * Build a full ICS calendar string from the page raw result by first
 * normalizing events and then formatting them into iCalendar lines.
 * @export
 * @param {Object} rawData
 * @param {Array<string>} [selectedTermCodes]
 * @returns {string} ICS file content.
 */
export function generateICSFromRawData(rawData, selectedTermCodes) {
  const events = generateEventsFromRawData(rawData, selectedTermCodes);
  const lines = buildCalendarLines(events);
  return lines.join("\n");
}

/**
 * Convert an array of already-normalized events into an ICS string.
 * @export
 * @param {Array<Object>} events
 * @returns {string}
 */
export function eventsToICS(events) {
  const lines = buildCalendarLines(events);
  return lines.join("\n");
}
