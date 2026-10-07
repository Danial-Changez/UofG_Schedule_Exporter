from datetime import datetime
from pathlib import Path

import pytest
from icalendar import Calendar

from uofg_schedule_exporter.parse_schedule import (
    extract_courses,
    flatten_meetings,
    generate_ics,
)

FIXTURE = Path(__file__).parent / "fixtures" / "print_schedule.html"


@pytest.fixture
def html():
    return FIXTURE.read_text(encoding="utf-8")


@pytest.fixture
def events(html, tmp_path):
    """The fixture's F25 schedule, written by generate_ics and parsed back."""
    # A nested path also checks that the output folder is created on demand.
    ics_path = tmp_path / "res" / "Schedule.ics"
    generate_ics(flatten_meetings(extract_courses(html, "F25")), str(ics_path))
    calendar = Calendar.from_ical(ics_path.read_text(encoding="utf-8"))
    return {str(event["summary"]): event for event in calendar.walk("VEVENT")}


def test_extract_courses_returns_only_the_requested_term(html):
    courses = extract_courses(html, "W26")

    assert [c["Section"]["CourseName"] for c in courses] == ["STAT*2040"]


def test_extract_courses_rejects_a_page_without_schedule_data():
    with pytest.raises(RuntimeError, match="No result script found"):
        extract_courses("<html><script>var other = {};</script></html>", "F25")


def test_flatten_meetings_gives_one_row_per_timed_meeting(html):
    meetings = flatten_meetings(extract_courses(html, "F25"))

    # The distance-education meeting has no times and is dropped.
    assert [(m["CourseName"], m["InstructionalMethod"]) for m in meetings] == [
        ("CIS*2500", "LEC"),
        ("CIS*2500", "EXAM"),
        ("MATH*1200", "LEC"),
    ]
    assert meetings[0]["Location"] == "ROZH 104"
    assert meetings[0]["Instructors"] == ["Alice Example", "Bob Example"]


def test_generate_ics_writes_one_event_per_meeting(events):
    assert sorted(events) == [
        "EXAM CIS*2500*0101",
        "LEC CIS*2500*0101",
        "LEC MATH*1200*01",
    ]

    lecture = events["LEC CIS*2500*0101"]
    assert lecture["dtstart"].dt == datetime(2025, 9, 5, 9, 0)
    assert lecture["dtend"].dt == datetime(2025, 9, 5, 10, 20)
    assert str(lecture["location"]) == "ROZH 104"
    assert str(lecture["description"]) == (
        "Instructor(s): Alice Example | Bob Example\nCredits: 0.5"
    )


def test_generate_ics_recurs_weekly_on_the_meeting_days(events):
    assert events["LEC CIS*2500*0101"]["rrule"]["BYDAY"] == ["MO", "WE", "FR"]
    assert sorted(events["LEC MATH*1200*01"]["rrule"]["BYDAY"]) == ["TH", "TU"]
    # A lone "Th" must not also be read as Tuesday.
    assert events["EXAM CIS*2500*0101"]["rrule"]["BYDAY"] == ["TH"]


def test_generate_ics_stops_classes_two_weeks_before_the_section_end(events):
    assert events["LEC CIS*2500*0101"]["rrule"]["UNTIL"] == [
        datetime(2025, 11, 28, 23, 59, 59)
    ]
    # The exam itself falls inside those two weeks and keeps its own end date.
    assert events["EXAM CIS*2500*0101"]["rrule"]["UNTIL"] == [
        datetime(2025, 12, 11, 23, 59, 59)
    ]
