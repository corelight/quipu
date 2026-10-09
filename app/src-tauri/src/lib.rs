// Wire shapes for a project analysis; the IPC face of `project`.
mod analysis;
mod cache;
mod commands;
// The compilation pipeline: plan in, rules and diagnostics out.
mod compile;
// Permanent opt-in JSONL troubleshooting (`quipu --debug`).
mod debug_trace;
// The packaged example projects and the editable working copies Quipu opens.
mod examples;
mod fs;
mod help;
mod lsp;
// Backend domain model for projects: `quipu.toml`, the include graph and the
// compilation plan. See docs/workspace-project-model.md.
mod project;
// Native filesystem watching for the open project, and the watch plan it derives
// from an analysis.
mod watch;

// Dependency consistency checks run alongside the backend tests on every platform.
#[cfg(test)]
mod dependency_tests;
// Temporary project trees and other helpers the test modules share.
#[cfg(test)]
mod testing;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let trace = debug_trace::DebugTrace::from_process_args();
    trace.event_lazy(
        "debug_tracing_enabled",
        || serde_json::json!({
            "notice": "Quipu debug tracing is enabled; backend JSON Lines follow and the Web Inspector will open"
        }),
    );
    let setup_trace = trace.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Hands the About box's two credit links and Help > Report an Issue to
        // the OS default browser. The capability scopes it to exactly those
        // three URLs, so this cannot become a general-purpose "open anything"
        // hole.
        .plugin(tauri_plugin_opener::init())
        .manage(commands::new_shared_rules())
        .manage(trace)
        .setup(move |app| {
            // Start the embedded LSP server and its IPC bridge, then store the
            // send-handle as managed state for the `lsp_send` command.
            use tauri::{Emitter, Manager};
            let cache = match app.path().app_config_dir() {
                Ok(config_root) => match app.path().app_cache_dir() {
                    Ok(cache_root) => commands::new_shared_cache(cache_root, config_root),
                    Err(_) => std::sync::Arc::new(cache::CacheManager::unavailable_with_config(
                        config_root,
                    )),
                },
                Err(_) => std::sync::Arc::new(cache::CacheManager::unavailable()),
            };
            let startup_cache = cache.clone();
            app.manage(cache);
            // Startup cleanup and quota are intentionally background work: the
            // first project can open immediately, and the manager's local permit
            // orders a simultaneous lookup behind or ahead of this scan safely.
            tauri::async_runtime::spawn_blocking(move || {
                let _ = startup_cache.maintain(None);
            });
            setup_trace.event_lazy("lsp_start", || serde_json::json!({}));
            let handle = lsp::start(app.handle().clone());
            app.manage(handle);
            setup_trace.event_lazy("lsp_started", || serde_json::json!({}));

            // The project watcher. Its notice sink is injected rather than baked
            // in, so the registry and its ordering rules are testable without a
            // running application; here it is one Tauri event.
            let emitter = app.handle().clone();
            let watcher_trace = setup_trace.clone();
            app.manage(watch::new_shared_watchers(move |notice| {
                // The watch registry delivers only after releasing its state and
                // notice-queue locks, so trace output introduces no lock ordering.
                watcher_trace.event_lazy("watch_notice", || match &notice {
                    watch::WatchNotice::Changed {
                        subscription,
                        paths,
                    } => serde_json::json!({
                        "kind": "changed",
                        "subscription": subscription,
                        "pathCount": paths.len(),
                    }),
                    watch::WatchNotice::Covered {
                        subscription,
                        instance,
                        paths,
                        catch_up,
                    } => serde_json::json!({
                        "kind": "covered",
                        "subscription": subscription,
                        "instance": instance,
                        "pathCount": paths.len(),
                        "catchUp": catch_up,
                    }),
                    watch::WatchNotice::Partial {
                        subscription,
                        instance,
                        paths,
                        catch_up,
                        ..
                    } => serde_json::json!({
                        "kind": "partial",
                        "subscription": subscription,
                        "instance": instance,
                        "pathCount": paths.len(),
                        "catchUp": catch_up,
                    }),
                    watch::WatchNotice::Failed {
                        subscription,
                        instance,
                        ..
                    } => serde_json::json!({
                        "kind": "failed",
                        "subscription": subscription,
                        "instance": instance,
                    }),
                });
                let _ = emitter.emit(watch::EVENT_WATCH, notice);
            }));
            if setup_trace.is_enabled() {
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                    setup_trace.event_lazy("web_inspector_opened", || serde_json::json!({}));
                } else {
                    setup_trace.event_lazy(
                        "web_inspector_unavailable",
                        || serde_json::json!({ "reason": "main_window_missing" }),
                    );
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            debug_trace::debug_status,
            debug_trace::debug_frontend_trace,
            commands::analyze_project,
            commands::cache_status,
            commands::update_cache_settings,
            commands::clear_project_cache,
            commands::clear_all_caches,
            commands::compile_scratch,
            commands::compile_project,
            commands::scan_target,
            commands::reset_rules,
            commands::read_file,
            examples::list_examples,
            examples::prepare_example,
            fs::read_text_file,
            fs::save_text_file,
            fs::create_file,
            fs::rename_file,
            help::show_help,
            lsp::lsp_send,
            watch::watch_project,
            watch::watch_release,
            watch::watch_fence,
            watch::watch_rearm
        ])
        // The close guard on `main` describes closing the application, not just
        // one of its windows. Once that guarded close is approved, destroy the
        // auxiliary documentation window as well so it cannot keep the process
        // alive on platforms that exit only after the last window closes.
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                use tauri::Manager;
                if let Some(documentation) = window.app_handle().get_webview_window(help::LABEL) {
                    let _ = documentation.destroy();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
