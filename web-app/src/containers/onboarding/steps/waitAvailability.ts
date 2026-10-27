/**
 * Whether the wait screen (`WaitStep`) offers the email reminder. Off for
 * this release: nothing sends the email yet, and the form would promise one.
 * Turn it on once the app hands the address to the reminder API (ADR
 * 2026-10-27-hide-the-email-reminder-until-it-is-delivered).
 */
export const EMAIL_REMINDER_OFFERED: boolean = false
