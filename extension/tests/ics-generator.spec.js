import fs from "node:fs";
import { expect } from "chai";
import {
  eventsToICS,
  generateEventsFromRawData,
  generateICSFromRawData,
} from "../src/ics-generator.js";

function loadFixture(name) {
  const url = new URL(`./fixtures/${name}.json`, import.meta.url);
  return JSON.parse(fs.readFileSync(url, "utf8"));
}

/** Values of every `name` property in an ICS string, in order. */
function props(ics, name) {
  return ics
    .split("\n")
    .filter((line) => line.startsWith(`${name}:`))
    .map((line) => line.slice(name.length + 1));
}

// 09/04/2025 is a Thursday, so this Mon/Wed/Fri lecture first meets on Friday.
const lecture = {
  CourseName: "CIS*2500",
  SectionNumber: "0101",
  Credits: 0.5,
  Instructors: ["Alice Example", "Bob Example"],
  InstructionalMethod: "LEC",
  StartTime: "9:00 AM",
  EndTime: "10:20 AM",
  DaysOfWeek: "MWF",
  Location: "ROZH 104",
  StartDate: "09/04/2025",
  EndDate: "12/12/2025",
};

describe("generateEventsFromRawData", () => {
  it("normalizes each timed meeting and skips meetings without times", () => {
    const events = generateEventsFromRawData(loadFixture("small"));

    expect(
      events.map((e) => `${e.InstructionalMethod} ${e.CourseName}`),
    ).to.deep.equal(["LEC CIS*2500", "LAB CIS*2500", "EXAM HIST*2100"]);
    expect(events[0]).to.deep.include({
      SectionNumber: "101",
      Credits: 0.5,
      Instructors: ["Alice Example"],
      StartTime: "9:00 AM",
      EndTime: "10:20 AM",
      DaysOfWeek: "MWF",
      Location: "ENG 120",
      StartDate: "9/8/2025",
      EndDate: "12/12/2025",
    });
  });

  it("keeps only the selected terms", () => {
    const events = generateEventsFromRawData(loadFixture("medium"), ["W26"]);

    expect(events.map((e) => e.CourseName)).to.deep.equal([
      "HIST*2100",
      "PHYS*1100",
      "CHEM*1010",
    ]);
  });

  it("keeps only registered sections when the term lists them", () => {
    const raw = loadFixture("small");
    const [cis, , hist] = raw.Terms[0].PlannedCourses;
    cis.Section.Id = "111";
    hist.Section.Id = "333";
    raw.Terms[0].ActiveSectionIds = ["333"];

    const events = generateEventsFromRawData(raw);

    expect(events.map((e) => e.CourseName)).to.deep.equal(["HIST*2100"]);
  });
});

describe("eventsToICS", () => {
  it("writes a weekly event that starts on its first meeting day", () => {
    const ics = eventsToICS([lecture]);

    expect(props(ics, "DTSTART")).to.deep.equal(["20250905T090000"]);
    expect(props(ics, "DTEND")).to.deep.equal(["20250905T102000"]);
    expect(props(ics, "RRULE")).to.deep.equal([
      "FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20251212T235959",
    ]);
    expect(props(ics, "SUMMARY")).to.deep.equal(["LEC CIS*2500*0101"]);
    expect(props(ics, "LOCATION")).to.deep.equal(["ROZH 104"]);
  });

  it("reads Th as Thursday rather than as a second Tuesday", () => {
    const ics = eventsToICS([{ ...lecture, DaysOfWeek: "TTh" }]);

    expect(props(ics, "RRULE")[0]).to.include("BYDAY=TU,TH;");
  });

  it("skips the fall study break and the exam period", () => {
    const ics = eventsToICS([lecture]);

    // Thanksgiving Monday, then the two weeks up to the section end date.
    expect(props(ics, "EXDATE")).to.deep.equal([
      "20251013T090000",
      "20251201T090000",
      "20251203T090000",
      "20251205T090000",
      "20251208T090000",
      "20251210T090000",
      "20251212T090000",
    ]);
  });

  it("does not skip the exam period for the exam itself", () => {
    const exam = {
      ...lecture,
      InstructionalMethod: "EXAM",
      DaysOfWeek: "Th",
      StartDate: "12/11/2025",
      EndDate: "12/11/2025",
    };

    const ics = eventsToICS([exam]);

    expect(props(ics, "DTSTART")).to.deep.equal(["20251211T090000"]);
    expect(props(ics, "EXDATE")).to.deep.equal([]);
  });

  it("lists every instructor on one escaped DESCRIPTION line", () => {
    const ics = eventsToICS([lecture]);

    expect(props(ics, "DESCRIPTION")).to.deep.equal([
      "Instructor(s): Alice Example | Bob Example\\nCredits: 0.5",
    ]);
    const strayLines = ics.split("\n").filter((l) => !/^[A-Z-]+[:;]/.test(l));
    expect(strayLines).to.deep.equal([]);
  });

  it("stamps events in UTC rather than local time", () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "America/Toronto";
    try {
      const [stamp] = props(eventsToICS([lecture]), "DTSTAMP");

      const [, y, mo, d, h, mi, s] = stamp.match(
        /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
      );
      const stamped = Date.UTC(y, mo - 1, d, h, mi, s);
      expect(Math.abs(Date.now() - stamped)).to.be.below(5000);
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });
});

describe("generateICSFromRawData", () => {
  it("wraps one VEVENT per normalized meeting in a VCALENDAR", () => {
    const lines = generateICSFromRawData(loadFixture("small")).split("\n");

    expect(lines[0]).to.equal("BEGIN:VCALENDAR");
    expect(lines.at(-1)).to.equal("END:VCALENDAR");
    expect(lines.filter((l) => l === "BEGIN:VEVENT")).to.have.lengthOf(3);
  });
});
