import os
import re
import pytz
from datetime import datetime
from icalendar import Calendar
from google.auth.transport.requests import Request
from google_auth_oauthlib.flow import InstalledAppFlow
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

# Google Calendar API scope
SCOPES = ["https://www.googleapis.com/auth/calendar"]


def authenticate_google():
    """Authenticate the user and return an authorized Google Calendar service."""
    creds = None
    CREDENTIALS_PATH = "../res/credentials.json"
    TOKEN_PATH = "../res/token.json"
    SCOPES = ["https://www.googleapis.com/auth/calendar"]

    # Check for credentials.json
    if not os.path.exists(CREDENTIALS_PATH):
        raise FileNotFoundError(
            f"credentials.json not found at {CREDENTIALS_PATH}. Please provide your Google API credentials."
        )

    # If token.json exists, load it
    if os.path.exists(TOKEN_PATH):
        creds = Credentials.from_authorized_user_file(TOKEN_PATH, SCOPES)
    # If not, run OAuth flow and save token.json
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(CREDENTIALS_PATH, SCOPES)
            creds = flow.run_local_server(port=0)
        # Save the credentials for the next run
        with open(TOKEN_PATH, "w") as token:
            token.write(creds.to_json())
    return build("calendar", "v3", credentials=creds)


def get_or_create_calendar(service, calendar_name="UofG Schedule"):
    """Return calendar ID by name, or create it if it doesn't exist."""
    calendars = service.calendarList().list().execute().get("items", [])
    for cal in calendars:
        if cal.get("summary") == calendar_name:
            return cal["id"]

    new_calendar = {"summary": calendar_name, "timeZone": "America/Toronto"}
    created_calendar = service.calendars().insert(body=new_calendar).execute()
    return created_calendar["id"]


def import_ics_to_calendar(service, calendar_id, ics_file_path):
    """Parse .ics file and insert events into the target calendar."""
    with open(ics_file_path, "r", encoding="UTF-8") as f:
        cal = Calendar.from_ical(f.read())

    tz = pytz.timezone("America/Toronto")
    created = 0

    for component in cal.walk():
        if component.name != "VEVENT":
            continue

        summary = str(component.get("summary", ""))
        description = str(component.get("description", ""))
        location = str(component.get("location", ""))
        dtstart = component.get("dtstart").dt
        dtend = component.get("dtend").dt

        # Make sure datetimes are timezone-aware
        if isinstance(dtstart, datetime) and dtstart.tzinfo is None:
            dtstart = tz.localize(dtstart)
        if isinstance(dtend, datetime) and dtend.tzinfo is None:
            dtend = tz.localize(dtend)

        event = {
            "summary": summary,
            "description": description,
            "location": location,
            "start": {
                "dateTime": dtstart.isoformat(),
                "timeZone": "America/Toronto",
            },
            "end": {
                "dateTime": dtend.isoformat(),
                "timeZone": "America/Toronto",
            },
        }

        rrule = component.get("rrule")
        if rrule:
            rrule_str = "RRULE:" + rrule.to_ical().decode()
            # Ensure UNTIL ends with Z (UTC requirement)
            rrule_str = re.sub(r"(UNTIL=\d+T\d+)(?!Z)", r"\1Z", rrule_str)
            event["recurrence"] = [rrule_str]

        try:
            service.events().insert(calendarId=calendar_id, body=event).execute()
            created += 1
        except Exception as e:
            print(f"❌ Error inserting '{summary}': {e}")

    print(f"✅ Successfully created {created} events.")


def main():
    ics_path = "../res/Schedule.ics"
    service = authenticate_google()
    calendar_id = get_or_create_calendar(service)
    import_ics_to_calendar(service, calendar_id, ics_path)


if __name__ == "__main__":
    main()
