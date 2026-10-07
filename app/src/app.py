import threading

import customtkinter as ctk

from google_calendar import (
    authenticate_google,
    get_or_create_calendar,
    import_ics_to_calendar,
)
from outlook_calendar import (
    authenticate_outlook,
    get_or_create_outlook_calendar,
    import_ics_to_outlook,
)
from parse_schedule import (
    extract_courses,
    fetch_page_info,
    generate_ics,
    sorted_courses,
)


class App(ctk.CTk):
    def __init__(self):
        super().__init__()
        ctk.set_appearance_mode("System")
        ctk.set_default_color_theme("blue")

        self.title("Schedule Importer")
        self.geometry("400x260")

        self.term_var = ctk.StringVar()
        self.import_to_gcal = ctk.BooleanVar(value=False)
        self.import_to_ocal = ctk.BooleanVar(value=False)

        ctk.CTkLabel(self, text="Enter Term Code:").pack(pady=(20, 5))
        self.term_entry = ctk.CTkEntry(
            self, textvariable=self.term_var, placeholder_text="i.e. W24"
        )
        self.term_entry.pack(pady=5)

        self.gcal_checkbox = ctk.CTkCheckBox(
            self, text="Import to Google Calendar", variable=self.import_to_gcal
        )
        self.gcal_checkbox.pack(pady=5)

        self.ocal_checkbox = ctk.CTkCheckBox(
            self, text="Import to Outlook Calendar", variable=self.import_to_ocal
        )
        self.ocal_checkbox.pack(pady=5)

        self.button = ctk.CTkButton(self, text="Run Parser", command=self.start_task)
        self.button.pack(pady=10)

        self.status_label = ctk.CTkLabel(self, text="")
        self.status_label.pack(pady=5)

    def run_schedule(self, term: str, import_to_gcal: bool, import_to_ocal: bool):
        try:
            html = fetch_page_info(term)
            courses = extract_courses(html, term)
            parsed = sorted_courses(courses)
            output_path = "../res/Schedule.ics"
            generate_ics(parsed, output_path)

            if import_to_gcal:
                service = authenticate_google()
                calendar_id = get_or_create_calendar(service)
                import_ics_to_calendar(service, calendar_id, output_path)

            if import_to_ocal:
                service = authenticate_outlook()
                calendar_id = get_or_create_outlook_calendar(service)
                import_ics_to_outlook(service, calendar_id, output_path)

            return f"✔ Parsed {len(parsed)} meetings → {output_path}"
        except Exception as e:
            return f"❌ Error: {str(e)}"

    def start_task(self):
        self.button.configure(state="disabled", text="Running...")
        self.status_label.configure(text="Running... Please log in when prompted.")

        def worker():
            term = self.term_var.get().strip().upper() or "W24"
            result = self.run_schedule(
                term, self.import_to_gcal.get(), self.import_to_ocal.get()
            )
            self.status_label.configure(text=result)
            self.button.configure(state="normal", text="Run Parser")

        threading.Thread(target=worker, daemon=True).start()


if __name__ == "__main__":
    app = App()
    app.mainloop()
