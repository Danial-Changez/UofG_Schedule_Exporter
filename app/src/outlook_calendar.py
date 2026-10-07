import json
import os
import re
from datetime import datetime

import msal
import pytz
import requests
from icalendar import Calendar

CLIENT_ID = "3751d727-01d8-4cf3-8b3b-895f9e107b66"
AUTHORITY = "https://login.microsoftonline.com/2dc6a781-c713-4a93-8cb0-258bef89a7b3"
SCOPES = ["Calendars.ReadWrite"]
TOKEN_PATH = "../res/outlook_token.json"
ICS_PATH = "../res/Schedule.ics"
GRAPH_BASE = "https://graph.microsoft.com/v1.0"


def authenticate_outlook():
    app = msal.PublicClientApplication(CLIENT_ID, authority=AUTHORITY)
    accounts = app.get_accounts()
    token_data = app.acquire_token_silent(
        SCOPES, account=accounts[0] if accounts else None
    )

    if not token_data:
        flow = app.initiate_device_flow(scopes=SCOPES)
        if "user_code" not in flow:
            raise Exception(f"❌ Device flow error: {flow}")
        print(
            f"🔐 Visit {flow['verification_uri']} and enter code: {flow['user_code']}"
        )
        token_data = app.acquire_token_by_device_flow(flow)

    if "access_token" not in token_data:
        raise Exception("❌ Authentication failed.")

    # Written for debugging only; nothing reads this file back.
    with open(TOKEN_PATH, "w", encoding="utf-8") as f:
        json.dump(token_data, f, indent=2)

    return token_data["access_token"]


def get_or_create_outlook_calendar(token, calendar_name="UofG Schedule"):
    headers = {"Authorization": f"Bearer {token}"}
    response = requests.get(f"{GRAPH_BASE}/me/calendars", headers=headers)
    response.raise_for_status()
    calendars = response.json().get("value", [])

    for cal in calendars:
        if cal["name"].lower() == calendar_name.lower():
            return cal["id"]

    new_cal = {"name": calendar_name}
    response = requests.post(
        f"{GRAPH_BASE}/me/calendars", headers=headers, json=new_cal
    )
    response.raise_for_status()
    return response.json()["id"]


def convert_rrule(rrule_string, dtstart):
    result = {
        "pattern": {
            "type": "weekly",
            "interval": 1,
            "daysOfWeek": [],
        },
        "range": {
            "type": "endDate",
            "startDate": dtstart.date().isoformat(),
            "endDate": "",
        },
    }

    day_map = {
        "MO": "monday",
        "TU": "tuesday",
        "WE": "wednesday",
        "TH": "thursday",
        "FR": "friday",
        "SA": "saturday",
        "SU": "sunday",
    }

    match = re.search(r"BYDAY=([A-Z,]+)", rrule_string)
    if match:
        result["pattern"]["daysOfWeek"] = [
            day_map[d] for d in match.group(1).split(",") if d in day_map
        ]

    match = re.search(r"UNTIL=(\d{8})", rrule_string)
    if match:
        until = datetime.strptime(match.group(1), "%Y%m%d").date()
        result["range"]["endDate"] = until.isoformat()

    return result


def import_ics_to_outlook(token, calendar_id, ics_file_path):
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    tz = pytz.timezone("America/Toronto")
    created = 0

    with open(ics_file_path, encoding="UTF-8") as f:
        cal = Calendar.from_ical(f.read())

    for component in cal.walk():
        if component.name != "VEVENT":
            continue

        summary = str(component.get("summary", ""))
        description = str(component.get("description", ""))
        location = str(component.get("location", ""))
        dtstart = component.get("dtstart").dt
        dtend = component.get("dtend").dt

        if isinstance(dtstart, datetime) and dtstart.tzinfo is None:
            dtstart = tz.localize(dtstart)
        if isinstance(dtend, datetime) and dtend.tzinfo is None:
            dtend = tz.localize(dtend)

        event = {
            "subject": summary,
            "body": {"contentType": "text", "content": description},
            "location": {"displayName": location},
            "start": {"dateTime": dtstart.isoformat(), "timeZone": "America/Toronto"},
            "end": {"dateTime": dtend.isoformat(), "timeZone": "America/Toronto"},
        }

        rrule = component.get("rrule")
        if rrule:
            rrule_str = "RRULE:" + rrule.to_ical().decode()
            rrule_str = re.sub(r"(UNTIL=\d+T\d+)(?!Z)", r"\1Z", rrule_str)
            event["recurrence"] = convert_rrule(rrule_str, dtstart)

        res = requests.post(
            f"{GRAPH_BASE}/me/calendars/{calendar_id}/events",
            headers=headers,
            json=event,
        )

        if res.status_code == 201:
            created += 1
        else:
            print(f"❌ Error inserting '{summary}': {res.status_code} - {res.text}")

    print(
        f"✅ Successfully created {created} events in Outlook Calendar '{calendar_id}'."
    )


def main():
    if not os.path.exists(ICS_PATH):
        print(f"❌ ICS file not found at: {ICS_PATH}")
        return

    token = authenticate_outlook()
    calendar_id = get_or_create_outlook_calendar(token)
    import_ics_to_outlook(token, calendar_id, ICS_PATH)


if __name__ == "__main__":
    main()
