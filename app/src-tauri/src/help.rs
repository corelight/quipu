//! The bundled documentation window.
//!
//! Zola's output is copied into `frontendDist` at `/docs`, so it is served by
//! Tauri's application protocol and embedded in the executable with the rest of
//! the frontend. The window is built here, rather than by frontend JavaScript,
//! for two reasons: the main webview does not need general window-creation
//! permission, and only the native builder can install the navigation boundary.

use serde::Deserialize;
use tauri::{
    AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    webview::PageLoadEvent,
};
use tauri_plugin_opener::OpenerExt;

pub const LABEL: &str = "documentation";
const MAIN_LABEL: &str = "main";
const TITLE_SUFFIX: &str = "Quipu Documentation";

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HelpPage {
    Documentation,
    QuickStart,
}

impl HelpPage {
    fn route(self) -> &'static str {
        match self {
            // Explicit index files work in both Tauri's production asset
            // resolver and Vite's development static-file middleware. Vite does
            // not consistently resolve directory-style public URLs in a second
            // webview.
            Self::Documentation => "/docs/index.html",
            Self::QuickStart => "/docs/quick-start/index.html",
        }
    }

    fn title(self) -> &'static str {
        match self {
            Self::Documentation => "Documentation — Quipu Documentation",
            Self::QuickStart => "Quick Start — Quipu Documentation",
        }
    }
}

fn title_for_path(path: &str) -> &'static str {
    if path.starts_with("/docs/quick-start") {
        "Quick Start — Quipu Documentation"
    } else if path.starts_with("/docs/workspaces") {
        "Workspaces and projects — Quipu Documentation"
    } else if path.starts_with("/docs/writing-rules") {
        "Writing rules — Quipu Documentation"
    } else if path.starts_with("/docs/compiling-and-scanning") {
        "Compiling and scanning — Quipu Documentation"
    } else if path.starts_with("/docs/results-and-diagnostics") {
        "Results and diagnostics — Quipu Documentation"
    } else if path.starts_with("/docs/preferences-and-cache") {
        "Preferences and cache — Quipu Documentation"
    } else if path.starts_with("/docs/reference") {
        "Reference and troubleshooting — Quipu Documentation"
    } else {
        "Documentation — Quipu Documentation"
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Navigation {
    Documentation,
    ExternalWeb,
    Denied,
}

/// Opens one of the two fixed entry points in the singleton help window.
#[tauri::command]
pub fn show_help(app: AppHandle, page: HelpPage) -> Result<(), String> {
    let target = page_url(&app, page)?;

    if let Some(window) = app.get_webview_window(LABEL) {
        return reveal(&window, page, target);
    }

    let internal_origin = target.clone();
    let navigation_app = app.clone();
    let new_window_app = app.clone();
    let built = WebviewWindowBuilder::new(
        &app,
        LABEL,
        WebviewUrl::App(page.route().trim_start_matches('/').into()),
    )
    // WebKitGTK does not reliably deliver the initial document-title callback,
    // so set the known entry point's title eagerly. Later in-site navigation can
    // still update it through on_document_title_changed below.
    .title(page.title())
    .inner_size(900.0, 700.0)
    .min_inner_size(640.0, 480.0)
    .resizable(true)
    .center()
    .prevent_overflow()
    .on_navigation(
        move |candidate| match classify(candidate, &internal_origin) {
            Navigation::Documentation => true,
            Navigation::ExternalWeb => {
                let _ = navigation_app
                    .opener()
                    .open_url(candidate.as_str(), None::<&str>);
                false
            }
            Navigation::Denied => false,
        },
    )
    .on_new_window(move |candidate, _features| {
        // The documentation templates do not request new windows, but modifier
        // clicks and future content can. External web links still belong in the
        // system browser; no second embedded browser is ever created.
        if matches!(classify(&candidate, &target), Navigation::ExternalWeb) {
            let _ = new_window_app
                .opener()
                .open_url(candidate.as_str(), None::<&str>);
        }
        tauri::webview::NewWindowResponse::Deny
    })
    .on_page_load(|window, payload| {
        // WebKitGTK clears the builder's native title while committing a new
        // document. Restore it after each completed internal navigation from
        // the route we actually loaded. This also keeps sidebar navigation in
        // sync, not only navigation requested by the two menu commands.
        if payload.event() == PageLoadEvent::Finished {
            let _ = window.set_title(title_for_path(payload.url().path()));
        }
    })
    .on_document_title_changed(|window, document_title| {
        // WebKitGTK can notify with an empty title even when the loaded HTML has
        // one. Recover from the current, already navigation-checked URL instead
        // of allowing that transient value to blank the native title.
        let title = if document_title.ends_with(TITLE_SUFFIX) {
            document_title
        } else {
            window
                .url()
                .map(|url| title_for_path(url.path()))
                .unwrap_or(TITLE_SUFFIX)
                .to_string()
        };
        let _ = window.set_title(&title);
    })
    .build();

    match built {
        Ok(_) => Ok(()),
        Err(error) => {
            // Two rapid menu gestures can both observe no window before either
            // build finishes. If the other build won the label, reuse it rather
            // than turning an idempotent request into an error.
            if let Some(window) = app.get_webview_window(LABEL) {
                reveal(&window, page, page_url(&app, page)?)
            } else {
                Err(format!("failed to create documentation window: {error}"))
            }
        }
    }
}

fn page_url(app: &AppHandle, page: HelpPage) -> Result<Url, String> {
    let main = app
        .get_webview_window(MAIN_LABEL)
        .ok_or_else(|| "main window is unavailable".to_string())?;
    main.url()
        .map_err(|error| format!("failed to read application URL: {error}"))?
        .join(page.route())
        .map_err(|error| format!("failed to form documentation URL: {error}"))
}

fn reveal(window: &WebviewWindow, page: HelpPage, target: Url) -> Result<(), String> {
    window
        .set_title(page.title())
        .map_err(|error| format!("failed to title documentation window: {error}"))?;
    window
        .navigate(target)
        .map_err(|error| format!("failed to navigate documentation window: {error}"))?;
    window
        .unminimize()
        .map_err(|error| format!("failed to restore documentation window: {error}"))?;
    window
        .show()
        .map_err(|error| format!("failed to show documentation window: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("failed to focus documentation window: {error}"))
}

fn classify(candidate: &Url, internal: &Url) -> Navigation {
    let same_origin = candidate.scheme() == internal.scheme()
        && candidate.host_str() == internal.host_str()
        && candidate.port_or_known_default() == internal.port_or_known_default();
    let docs_path = candidate.path() == "/docs" || candidate.path().starts_with("/docs/");

    if same_origin && docs_path {
        Navigation::Documentation
    } else if !same_origin && candidate.scheme() == "https" {
        Navigation::ExternalWeb
    } else {
        Navigation::Denied
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(value: &str) -> Url {
        Url::parse(value).unwrap()
    }

    #[test]
    fn help_pages_have_fixed_routes() {
        assert_eq!(HelpPage::Documentation.route(), "/docs/index.html");
        assert_eq!(HelpPage::QuickStart.route(), "/docs/quick-start/index.html");
        assert_eq!(
            HelpPage::Documentation.title(),
            "Documentation — Quipu Documentation"
        );
        assert_eq!(
            HelpPage::QuickStart.title(),
            "Quick Start — Quipu Documentation"
        );
        assert_eq!(
            title_for_path("/docs/quick-start/index.html"),
            "Quick Start — Quipu Documentation"
        );
        assert_eq!(
            title_for_path("/docs/workspaces/index.html"),
            "Workspaces and projects — Quipu Documentation"
        );
        assert_eq!(
            title_for_path("/docs/writing-rules/index.html"),
            "Writing rules — Quipu Documentation"
        );
        assert_eq!(
            title_for_path("/docs/compiling-and-scanning/index.html"),
            "Compiling and scanning — Quipu Documentation"
        );
        assert_eq!(
            title_for_path("/docs/results-and-diagnostics/index.html"),
            "Results and diagnostics — Quipu Documentation"
        );
        assert_eq!(
            title_for_path("/docs/preferences-and-cache/index.html"),
            "Preferences and cache — Quipu Documentation"
        );
        assert_eq!(
            title_for_path("/docs/reference/index.html"),
            "Reference and troubleshooting — Quipu Documentation"
        );
        assert_eq!(
            title_for_path("/docs/unknown/index.html"),
            "Documentation — Quipu Documentation"
        );
    }

    #[test]
    fn navigation_stays_beneath_docs_on_the_application_origin() {
        let origin = url("tauri://localhost/docs/");
        assert_eq!(classify(&origin, &origin), Navigation::Documentation);
        assert_eq!(
            classify(&url("tauri://localhost/docs/quick-start/#scan"), &origin),
            Navigation::Documentation
        );
        assert_eq!(
            classify(&url("tauri://localhost/docs-not-really/"), &origin),
            Navigation::Denied
        );
        assert_eq!(
            classify(&url("tauri://localhost/"), &origin),
            Navigation::Denied
        );
    }

    #[test]
    fn web_links_are_external_and_other_schemes_are_denied() {
        let origin = url("http://tauri.localhost/docs/");
        assert_eq!(
            classify(&url("https://www.getzola.org/"), &origin),
            Navigation::ExternalWeb
        );
        assert_eq!(
            classify(&url("http://example.test/reference"), &origin),
            Navigation::Denied
        );
        assert_eq!(
            classify(&url("mailto:help@example.test"), &origin),
            Navigation::Denied
        );
        assert_eq!(
            classify(&url("javascript:alert(1)"), &origin),
            Navigation::Denied
        );
    }

    #[test]
    fn a_different_port_is_not_the_application_origin() {
        let origin = url("http://localhost:1420/docs/");
        assert_eq!(
            classify(&url("http://localhost:1421/docs/"), &origin),
            Navigation::Denied
        );
    }
}
