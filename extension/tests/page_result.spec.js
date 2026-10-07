// Integration tests: parse a sanitized page result and validate normalized events + ICS
// Fixture used: tests/fixtures/small.json
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { expect } from "chai";
import * as gen from "../src/ics-generator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "small.json"), "utf8"),
);

describe("Page result integration", function () {
  this.timeout(5000);

  it("parses sample_result.json result and normalizes events", () => {
    const pageResult = fixture;
    const events = gen.generateEventsFromRawData(pageResult);
    expect(events).to.be.an("array");
    // sanitized fixture contains 3 meetings -> 3 normalized events
    expect(events.length).to.equal(3);
  });

  it("generates ICS from sanitized fixture", () => {
    const ics = gen.generateICSFromRawData(fixture, { prodid: "-//test//" });
    expect(ics).to.be.a("string");
    expect(ics).to.include("BEGIN:VCALENDAR");
    expect(ics).to.include("END:VCALENDAR");
  });
});
