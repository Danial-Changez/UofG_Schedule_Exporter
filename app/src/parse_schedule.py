from selenium import webdriver
from selenium.webdriver.chrome.service import Service as ChromeService
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from webdriver_manager.chrome import ChromeDriverManager
from bs4 import BeautifulSoup
import requests
import re
import json
from datetime import datetime, timedelta, timezone
import uuid
import time
import tkinter as tk


def fetch_page_info(term: str) -> str:
    url = f"https://colleague-ss.uoguelph.ca/Student/Planning/DegreePlans/PrintSchedule?termId={term}"

    # Get display resolution
    root = tk.Tk()
    screen_width = root.winfo_screenwidth()
    screen_height = root.winfo_screenheight()
    root.destroy

    # Calculate center of screen and a percentage of display resolution
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

    # Start Chrome WebDriver
    driver = webdriver.Chrome(
        service=ChromeService(ChromeDriverManager().install()), options=options
    )

    try:
        # Open the schedule URL and wait (up to 10 minutes) for MFA/login
        WebDriverWait(driver, 600).until(EC.url_contains("/PrintSchedule"))

        # Store cookies
        cookies = driver.get_cookies()
    finally:
        # Close browser
        driver.quit()

    # Create a requests session and replay the Selenium cookies into it
    sess = requests.Session()
    for ck in cookies:
        sess.cookies.set(ck["name"], ck["value"], domain=ck["domain"])

    # Fetch the same URL via requests and return HTML
    resp = sess.get(url)
    resp.raise_for_status()
    return resp.text


def extract_courses(html: str, term: str) -> list[dict]:
    # Load into BeautifulSoup for script tag extraction
    soup = BeautifulSoup(html, "html.parser")

    # Grab the script tag text with "var result"
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

    # Isolate the JS object
    m = re.search(r"var\s+result\s*=\s*(\{[\s\S]*?\})\s*;", script)
    if not m:
        raise RuntimeError("Could not extract JS object")

    # Parse via json
    data = json.loads(m.group(1))

    # Navigate to Terms array and select correct terms for PlannedCourses
    terms = data["Terms"]
    planned = next(t["PlannedCourses"] for t in terms if t["Code"] == term)
    return planned


def sorted_courses(raw: list[dict]) -> list[dict]:
    output = []

    for entry in raw:
        # Metadata under section
        sec = entry.get("Section", {})

        # Shared course fields
        base = {
            "CourseName": sec.get("CourseName"),
            "SectionNumber": sec.get("Number"),
            "Credits": sec.get("MinimumCredits"),
            "Instructors": sec.get("Faculty", []),
        }

        # Create a row per meeting
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


from datetime import datetime, timedelta, timezone
import uuid


def generate_ics(events: list[dict], output_file: str):
    # Build cutoff_map from non-exam items: end_date − 2 weeks
    cutoff_map = {}
    for ev in events:
        if ev["InstructionalMethod"] == "EXAM":
            continue
        key = (ev["CourseName"], ev["SectionNumber"])
        # Parse non-exam EndDate
        end_dt = datetime.strptime(ev["EndDate"], "%m/%d/%Y")
        # Keep latest end date per course-section
        if key not in cutoff_map or end_dt > cutoff_map[key]:
            cutoff_map[key] = end_dt

    # Subtract two weeks and set to 23:59:59
    for key, end_dt in cutoff_map.items():
        cutoff_map[key] = (end_dt - timedelta(weeks=2)).replace(
            hour=23, minute=59, second=59
        )

    # 2) VCALENDAR header
    cal = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "CALSCALE:GREGORIAN",
        "PRODID:-//Danial Changez//Guelph Student Schedule Exporter v1.0//EN",
    ]

    # 3) Build each VEVENT
    for ev in events:
        # Skip online/no-time rows
        if not ev["StartTime"] or not ev["EndTime"]:
            continue

        # Parse the event’s start/end
        start_dt = datetime.strptime(
            f"{ev['StartDate']} {ev['StartTime']}", "%m/%d/%Y %I:%M %p"
        )
        end_dt = datetime.strptime(
            f"{ev['StartDate']} {ev['EndTime']}", "%m/%d/%Y %I:%M %p"
        )

        # Build BYDAY rule
        dow = ev["DaysOfWeek"]
        days = []
        if "Th" in dow:
            days.append("TH")
            dow = dow.replace("Th", "")
        for ch, code in {"M": "MO", "T": "TU", "W": "WE", "F": "FR"}.items():
            if ch in dow:
                days.append(code)
        byday_str = ",".join(days)

        # Choose UNTIL: two-week cutoff for non-exam, otherwise fallback to term end
        key = (ev["CourseName"], ev["SectionNumber"])
        if ev["InstructionalMethod"] != "EXAM" and key in cutoff_map:
            until_dt = cutoff_map[key]
        else:
            # Fallback to original EndDate at 23:59:59
            until_dt = datetime.strptime(ev["EndDate"], "%m/%d/%Y")
            until_dt = until_dt.replace(hour=23, minute=59, second=59)

        # DESCRIPTION
        desc = (
            f"Instructor(s): {' | '.join(ev['Instructors'])}\\nCredits: {ev['Credits']}"
        )

        # Append the VEVENT
        cal += [
            "BEGIN:VEVENT",
            f"UID:{uuid.uuid4().hex}@schedule",
            f"DTSTAMP:{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}",
            f"DTSTART:{start_dt.strftime('%Y%m%dT%H%M%S')}",
            f"DTEND:{end_dt.strftime('%Y%m%dT%H%M%S')}",
            f"RRULE:FREQ=WEEKLY;BYDAY={byday_str};UNTIL={until_dt.strftime('%Y%m%dT%H%M%S')}",
            f"SUMMARY:{ev['InstructionalMethod']} {ev['CourseName']}*{ev['SectionNumber']}",
            f"DESCRIPTION:{desc}",
            f"LOCATION:{ev['Location']}",
            "END:VEVENT",
            "",
        ]

    # Close VCALENDAR
    if cal and cal[-1] == "":
        cal.pop()
    cal.append("END:VCALENDAR")

    # Write to file
    with open(output_file, "w", encoding="utf-8") as f:
        f.write("\n".join(cal))


def main():
    start_time = time.perf_counter()
    term = "W24"

    # Fetch the schedule page HTML (handles login/MFA)
    html = fetch_page_info(term)

    # Extract the raw list of course dicts
    courses = extract_courses(html, term)
    sorted_results = sorted_courses(courses)

    ics_path = "../res/Schedule.ics"
    generate_ics(sorted_results, ics_path)

    end_time = time.perf_counter()
    execution_time = end_time - start_time
    print(f"Wrote {len(courses)} courses to {ics_path} in {execution_time:.2f} seconds")


if __name__ == "__main__":
    main()
