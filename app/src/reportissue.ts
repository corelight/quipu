import { openUrl } from "@tauri-apps/plugin-opener";

// Keep this literal in sync with src-tauri/capabilities/default.json and the
// external-open acceptance scenario. A mismatch fails closed with ForbiddenUrl.
const REPORT_ISSUE_URL = "https://github.com/corelight/quipu/issues/new/choose";

/** Opens GitHub's issue chooser in the operating system's default browser. */
export function reportIssue(): Promise<void> {
  return openUrl(REPORT_ISSUE_URL);
}
