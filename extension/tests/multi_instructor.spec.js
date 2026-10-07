// Integration test: ensure multiple instructors are all included in ICS DESCRIPTION
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { expect } from "chai";
import * as gen from "../src/ics-generator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sample = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "medium.json"), "utf8"),
);

describe("Multi-instructor handling", () => {
  it("includes all instructors in DESCRIPTION when multiple instructors present", () => {
    // Clone and inject a multi-instructor course into the sample
    const raw = JSON.parse(JSON.stringify(sample));
    // Add a course with multiple instructors
    raw.Terms[0].PlannedCourses.push({
      Section: {
        CourseName: "TEST*MI",
        Number: "900",
        MinimumCredits: 0.5,
        Faculty: ["Alpha, A", "Beta, B", "Gamma, G"],
        PlannedMeetings: [
          {
            InstructionalMethod: "LEC",
            StartTime: "2:00 PM",
            EndTime: "3:20 PM",
            DaysOfWeek: "TR",
            MeetingLocation: "MI ROOM",
            StartDateString: "09/02/2025",
            EndDateString: "12/12/2025",
          },
        ],
      },
    });

    const events = gen.generateEventsFromRawData(raw, ["F25"]);
    // Find our event
    const ev = events.find((e) => e.CourseName === "TEST*MI");
    expect(ev).to.exist;
    const ics = gen.eventsToICS([ev]);
    // DESCRIPTION should contain all instructors joined by ' | '
    expect(ics).to.include("Instructor(s): Alpha, A | Beta, B | Gamma, G");
  });
});
