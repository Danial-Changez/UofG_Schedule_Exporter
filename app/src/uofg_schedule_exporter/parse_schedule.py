import json
import re
import time
import tkinter as tk
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup
from selenium import webdriver
from selenium.webdriver.chrome.service import Service as ChromeService
from selenium.webdriver.support import expected_conditions
from selenium.webdriver.support.ui import WebDriverWait
from webdriver_manager.chrome import ChromeDriverManager


def fetch_page_info(term: str) -> str:
    url = f"https://colleague-ss.uoguelph.ca/Student/Planning/DegreePlans/PrintSchedule?termId={term}"

    root = tk.Tk()
    screen_width = root.winfo_screenwidth()
    screen_height = root.winfo_screenheight()
    root.destroy()

    percentage = 0.70
    width = int(screen_width * percentage)
    height = int(screen_height * percentage)
    x = (screen_width - width) // 2
    y = (screen_height - height) // 2

    # Configure chrome to open page as an app and reduce logging data
    options = webdriver.ChromeOptions()
    options.add_experimental_option("excludeSwitches", ["enable-automation"])
    options.add_argument(f"--window-size={width},{height}")
    options.add_argument(f"--window-position={x},{y}")
    options.add_argument(f"--app={url}")
    options.add_argument("--log-level=3")

    driver = webdriver.Chrome(
        service=ChromeService(ChromeDriverManager().install()), options=options
    )

    try:
        # The user signs in (including MFA) in this window; allow up to 10 minutes.
        WebDriverWait(driver, 600).until(
            expected_conditions.url_contains("/PrintSchedule")
        )

        cookies = driver.get_cookies()
    finally:
        driver.quit()

    # Replay the browser's session cookies so requests can fetch the raw HTML.
    sess = requests.Session()
    for ck in cookies:
        sess.cookies.set(ck["name"], ck["value"], domain=ck["domain"])

    resp = sess.get(url)
    resp.raise_for_status()
    return resp.text


def extract_courses(html: str, term: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")

    # WebAdvisor embeds the schedule in an inline script: `var result = {...};`
    script = next(
        (
            s.text
            for s in soup.find_all("script")
            if s.text and s.text.strip().startswith("var result")
        ),
        None,
    )
    if not script:
        raise RuntimeError("No result script found")

    m = re.search(r"var\s+result\s*=\s*(\{[\s\S]*?\})\s*;", script)
    if not m:
        raise RuntimeError("Could not extract JS object")

    data = json.loads(m.group(1))

    terms = data["Terms"]
    planned = next(t["PlannedCourses"] for t in terms if t["Code"] == term)
    return planned


def flatten_meetings(raw: list[dict]) -> list[dict]:
    output = []

    for entry in raw:
        sec = entry.get("Section", {})

        base = {
            "CourseName": sec.get("CourseName"),
            "SectionNumber": sec.get("Number"),
            "Credits": sec.get("MinimumCredits"),
            "Instructors": sec.get("Faculty", []),
        }

        for meeting in sec.get("PlannedMeetings", []):
            if not meeting.get("StartTime") or not meeting.get("EndTime"):
                continue
            output.append(
                {
                    **base,
                    "InstructionalMethod": meeting["InstructionalMethod"],
                    "StartTime": meeting["StartTime"],
                    "EndTime": meeting["EndTime"],
                    "FormattedTime": meeting["FormattedTime"],
                    "DaysOfWeek": meeting["DaysOfWeek"],
                    "Location": meeting["MeetingLocation"].strip(),
                    "StartDate": meeting["StartDateString"],
                    "EndDate": meeting["EndDateString"],
                }
            )
    return output


def generate_ics(events: list[dict], output_file: str):
    # A section's EndDate includes the exam period, so its weekly meetings
    # stop two weeks earlier.
    cutoff_map = {}
    for ev in events:
        if ev["InstructionalMethod"] == "EXAM":
            continue
        key = (ev["CourseName"], ev["SectionNumber"])
        end_dt = datetime.strptime(ev["EndDate"], "%m/%d/%Y")
        if key not in cutoff_map or end_dt > cutoff_map[key]:
            cutoff_map[key] = end_dt

    for key, end_dt in cutoff_map.items():
        cutoff_map[key] = (end_dt - timedelta(weeks=2)).replace(
            hour=23, minute=59, second=59
        )

    cal = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "CALSCALE:GREGORIAN",
        "PRODID:-//Danial Changez//Guelph Student Schedule Exporter v1.0//EN",
    ]

    for ev in events:
        # Skip online/no-time rows
        if not ev["StartTime"] or not ev["EndTime"]:
            continue

        start_dt = datetime.strptime(
            f"{ev['StartDate']} {ev['StartTime']}", "%m/%d/%Y %I:%M %p"
        )
        end_dt = datetime.strptime(
            f"{ev['StartDate']} {ev['EndTime']}", "%m/%d/%Y %I:%M %p"
        )

        # Consume 'Th' first so it is not also read as 'T'.
        dow = ev["DaysOfWeek"]
        days = []
        if "Th" in dow:
            days.append("TH")
            dow = dow.replace("Th", "")
        for ch, code in {"M": "MO", "T": "TU", "W": "WE", "F": "FR"}.items():
            if ch in dow:
                days.append(code)
        byday_str = ",".join(days)

        key = (ev["CourseName"], ev["SectionNumber"])
        if ev["InstructionalMethod"] != "EXAM" and key in cutoff_map:
            until_dt = cutoff_map[key]
        else:
            until_dt = datetime.strptime(ev["EndDate"], "%m/%d/%Y")
            until_dt = until_dt.replace(hour=23, minute=59, second=59)

        desc = (
            f"Instructor(s): {' | '.join(ev['Instructors'])}\\nCredits: {ev['Credits']}"
        )

        summary = (
            f"{ev['InstructionalMethod']} {ev['CourseName']}*{ev['SectionNumber']}"
        )

        cal += [
            "BEGIN:VEVENT",
            f"UID:{uuid.uuid4().hex}@schedule",
            f"DTSTAMP:{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}",
            f"DTSTART:{start_dt.strftime('%Y%m%dT%H%M%S')}",
            f"DTEND:{end_dt.strftime('%Y%m%dT%H%M%S')}",
            f"RRULE:FREQ=WEEKLY;BYDAY={byday_str};UNTIL={until_dt.strftime('%Y%m%dT%H%M%S')}",
            f"SUMMARY:{summary}",
            f"DESCRIPTION:{desc}",
            f"LOCATION:{ev['Location']}",
            "END:VEVENT",
            "",
        ]

    if cal and cal[-1] == "":
        cal.pop()
    cal.append("END:VCALENDAR")

    # The output folder is gitignored, so it is missing on a fresh clone.
    Path(output_file).parent.mkdir(parents=True, exist_ok=True)
    with open(output_file, "w", encoding="utf-8") as f:
        f.write("\n".join(cal))


def main():
    start_time = time.perf_counter()
    term = "W24"

    html = fetch_page_info(term)

    courses = extract_courses(html, term)
    meetings = flatten_meetings(courses)

    ics_path = "res/Schedule.ics"
    generate_ics(meetings, ics_path)

    end_time = time.perf_counter()
    execution_time = end_time - start_time
    print(f"Wrote {len(courses)} courses to {ics_path} in {execution_time:.2f} seconds")


if __name__ == "__main__":
    main()
