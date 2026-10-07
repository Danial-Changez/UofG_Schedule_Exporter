<h1> Guelph Schedule Exporter (Chrome Extension) </h1>

![Extension icon](extension/icons/logo.png)

Export your University of Guelph WebAdvisor schedule to ICS or send it straight into Google calendars (outlook import coming soon).

---

<h2> Table of Contents </h2>

- [Setup](#setup)
- [Usage](#usage)
- [Key Features](#key-features)
- [Provider Notes](#provider-notes)
- [File Map](#file-map)
- [Testing](#testing)
- [Future Improvements](#future-improvements)

---

## Setup

1. Install dependencies for developer testing, otherwise skip to step 2 for usage:
   ```sh
   npm install
   ```
2. In Chrome/Edge, open `chrome://extensions`, toggle **Developer mode**, then **Load unpacked** pointing to this extension folder root.
3. (Optional) Open the extension **Options** page to override Google/Outlook OAuth client IDs stored in `chrome.storage.local`.

## Usage

1. Sign in to WebAdvisor and navigate "Plan your Schedule > Print", open your **PrintSchedule** page so the content script can see the embedded `result` object.
2. Click the extension icon to open the pop-up. It will auto-detect available terms and list them as toggleable cards. Reload the page if no terms show up.
3. Choose one or more actions:
   - **Download ICS** - Generates `schedule.ics` locally.
   - **Google Calendar** - Interactive `chrome.identity` OAuth, then job-based import via the Calendar REST API.
   - **Outlook Calendar** - Microsoft identity + Graph Calendar import.
4. Press **Run Selected**. Progress and per-provider results/errors show inline for debugging.
5. Need a walkthrough? Use the pop-up help link for a quick tutorial on term selection and provider flows.

## Key Features

- **Extraction** - Content script injects `src/injected-page.js` to post the page's `result` object, and falls back to inline-script parsing when needed.
- **Normalization** - Filters to registered/active sections, keeping multi-instructor listings and start/end dates consistent for recurrence rules.
- **ICS Generator** - Weekly RRULEs with cutoff handling, deterministic UIDs, and local-time DTSTART/DTEND formatted for calendar imports.
- **Direct Imports** - Google provider runs inside the service worker with progress-tracked jobs and persistent status in `chrome.storage`.
- **Inline Troubleshooting** - Popup renders provider result cards with JSON for bug reports.

## Provider Notes

- **Google** (`src/google.js`) - Uses `chrome.identity/getAuthToken`, validates scopes with `tokeninfo`, creates or reuses a dedicated calendar, and batches VEVENT payloads with recurrence when available.
- **Outlook** (`src/outlook.js`) - Mirrors the same normalized event shape, authenticates with Microsoft identity endpoints, and writes to the signed-in user's default calendar via Graph. Need to update the endpoint to complete access.
- **Auth cleanup** - The options page exposes stored client IDs, while `google.js` also includes helpers to clear cached tokens when debugging consent prompts.

## File Map

| Component           | Path                   | Purpose                                              |
| ------------------- | ---------------------- | ---------------------------------------------------- |
| Content script      | `src/content.js`       | Detects schedule pages and extracts `result`.        |
| Injected helper     | `src/injected-page.js` | Runs in page context to post schedule data.          |
| Popup UI            | `src/popup.js`         | Term selection, action toggles, job polling/results. |
| ICS + normalization | `src/ics-generator.js` | Builds normalized events and ICS text.               |
| Background worker   | `src/background.js`    | Manages import jobs and storage.                     |
| Google provider     | `src/google.js`        | Calendar REST auth + event creation.                 |
| Outlook provider    | `src/outlook.js`       | Microsoft Graph auth + event creation.               |
| Options page        | `src/options.js`       | Persist alternate client IDs and show help.          |

## Testing

- Run mocha suite: `npm test`
- Fixtures under `tests/fixtures/` cover multi-instructor cases, ICS helpers, and OAuth flow mocks.

## Future Improvements

1. Auto-detect and display overlapping meetings before export/import.
2. Allow selecting a target calendar name (rather than the hard-coded defaults) in the pop-up.
3. Adjust Outlook Calendar API endpoint.
