# UofG Schedule Exporter

![Extension icon](extension/icons/logo.png)

Turns a University of Guelph WebAdvisor schedule into calendar events. The repository holds two independent tools that read the same schedule data from WebAdvisor's **PrintSchedule** page:

| Tool                           | Folder       | Output                                                                      |
| ------------------------------ | ------------ | --------------------------------------------------------------------------- |
| Chrome extension (Manifest V3) | `extension/` | A `schedule.ics` download, or events in Google Calendar                     |
| Desktop app (Python, Selenium) | `app/`       | `app/res/Schedule.ics`, optionally imported into Google Calendar or Outlook |

## Chrome extension

### Install

The extension is not published on the Chrome Web Store; load it unpacked.

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select the `extension/` folder.

### Use

1. Sign in to WebAdvisor and open **Plan your Schedule > Print** (the `PrintSchedule` page).
2. Click the extension icon. The popup lists the terms found on the page; tick the ones to export, or none to export all of them.
3. Tick **Download ICS**, **Export to Google** or both, then press **Run Selected**.

### What it does

- Creates one weekly event per meeting that has a time, starting on the first meeting day on or after the section start date and repeating until the section end date.
- Exports only the sections you are registered in when the page marks them, otherwise every planned section.
- Skips the fall study break, the winter reading week and, for everything except exams, the last 14 days before the section end date. These dates are computed from fixed rules (Thanksgiving and Family Day), not read from the university calendar.
- Google export signs in through `chrome.identity` with the OAuth client ID in `manifest.json` and adds the events to a calendar named "UofG Schedule", creating it if needed.

### What it does not do

- Detect duplicates: running an export twice creates every event twice.
- Export meetings without a time, or recognise weekend meetings (only Monday to Friday day codes are handled).
- Write time zones into the ICS file: times are local "floating" times. Google events are created in `America/Toronto`.
- Outlook: the **Export to Outlook** option is unfinished and labelled "coming" in the popup. It requires your own Azure client ID saved on the options page. The options page also stores a Google client ID, which the code does not read.

### Develop

Requires Node.js (CI uses version 24).

```sh
cd extension
npm ci
npm test              # Mocha specs
npm run lint          # ESLint
npm run format:check  # Prettier
```

## Desktop app

A small window that opens Chrome on the PrintSchedule page for one term, waits up to 10 minutes for you to sign in, then writes `app/res/Schedule.ics`.

### Install and run

Requires Python 3.10 or newer with Tk, and Google Chrome. Use a virtual environment.

```sh
cd app
pip install -e .
python -m uofg_schedule_exporter.app
```

Enter a term code such as `F25` (blank means `W24`) and press **Run Parser**. The two import checkboxes are optional:

- **Google Calendar** needs your own OAuth client file saved as `app/res/credentials.json`. The token is cached in `app/res/token.json`.
- **Outlook Calendar** uses the Azure app registration set in `src/uofg_schedule_exporter/outlook_calendar.py` and prints a device sign-in code to the terminal.

Both add the events to a calendar named "UofG Schedule", creating it if needed. `app/res/` is gitignored.

### How it differs from the extension

- It exports every planned section in the term, not only registered ones.
- It has no study-break or reading-week exclusions. Weekly classes simply stop two weeks before the section end date.
- The first event is on the section start date, even when that is not a meeting day.

### Develop

```sh
cd app
pip install -e ".[dev]"
pytest
ruff check .
ruff format --check .
```
