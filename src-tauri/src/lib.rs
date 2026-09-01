mod commands;
mod db;
mod hashing;
mod model;
mod parsers;
mod pdf_extract;
mod poppler;
mod report_zip;
mod settings;
mod spreadsheet;
mod storage;
mod window_glass;

use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

/// Shows and focuses the main window — shared by the tray menu's "Abrir
/// PontoScan" item and a left-click on the tray icon itself.
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// The two tray icon variants `commands::set_tray_status` swaps between —
/// precomputed once at startup (drawing the badge per pixel is cheap, but
/// there's no reason to redo it every time the check state changes) and
/// kept in managed state alongside the `TrayIcon` handle itself, since nothing
/// else needs to reach either one.
pub(crate) struct TrayIcons {
    pub(crate) normal: Image<'static>,
    pub(crate) attention: Image<'static>,
}

/// Draws a solid-color circular badge over the bottom-right corner of
/// `base` — cheap enough (a plain per-pixel distance check, no image crate
/// needed) to just do it freehand on the already-decoded RGBA buffer
/// instead of shipping a second icon asset to keep in sync with the first.
fn with_attention_badge(base: &Image<'_>) -> Image<'static> {
    let width = base.width();
    let height = base.height();
    let mut rgba = base.rgba().to_vec();

    // ~38% of the icon's shorter side — big enough to read at 16px tray
    // scale, small enough to leave the app icon recognizable underneath.
    let radius = (width.min(height) as f32 * 0.38) as i32;
    let cx = width as i32 - radius - 1;
    let cy = height as i32 - radius - 1;
    let r2 = radius * radius;
    // Solid, fully opaque orange-red — reads as "status", not "brand", at
    // this scale.
    let badge: [u8; 4] = [237, 85, 45, 255];

    for y in 0..height as i32 {
        for x in 0..width as i32 {
            let dx = x - cx;
            let dy = y - cy;
            if dx * dx + dy * dy <= r2 {
                let idx = ((y as u32 * width + x as u32) * 4) as usize;
                rgba[idx..idx + 4].copy_from_slice(&badge);
            }
        }
    }
    Image::new_owned(rgba, width, height)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Must be registered before every other plugin (Tauri's own
    // requirement — it needs to intercept as early as possible). Desktop
    // only: the plugin itself has no mobile implementation, and mobile OSes
    // already enforce single-instance on their own. A second launch just
    // re-focuses the running window instead of starting a second process —
    // two instances would otherwise both open the same SQLite file
    // (`db::DB_URL`), which is exactly the kind of thing that corrupts data
    // or throws "database is locked".
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }));
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(db::DB_URL, db::migrations())
                .build(),
        )
        .setup(|app| {
            // A database selected for import is staged by the previous app
            // process. Swap it now, before the webview can load and before
            // the SQL plugin creates its first connection pool.
            let data_dir = app.path().app_data_dir()?;
            let restoring_at = chrono::Local::now().format("%H:%M:%S%.3f").to_string();
            match storage::apply_pending_database_import(&data_dir) {
                Ok(true) => storage::write_database_import_result(&data_dir, &storage::DatabaseImportResult {
                    success: true,
                    message: "Banco de dados restaurado com sucesso.".into(),
                    events: vec![
                        storage::DatabaseImportEvent { label: "Aplicativo reiniciado".into(), occurred_at: restoring_at },
                        storage::DatabaseImportEvent { label: "Banco de dados restaurado".into(), occurred_at: chrono::Local::now().format("%H:%M:%S%.3f").to_string() },
                        storage::DatabaseImportEvent { label: "Cópia temporária removida".into(), occurred_at: chrono::Local::now().format("%H:%M:%S%.3f").to_string() },
                    ],
                }),
                Ok(false) => {}
                Err(error) => storage::write_database_import_result(&data_dir, &storage::DatabaseImportResult {
                    success: false,
                    message: format!("Não foi possível restaurar o banco. A versão anterior foi mantida. {error}"),
                    events: vec![
                        storage::DatabaseImportEvent { label: "Aplicativo reiniciado".into(), occurred_at: restoring_at },
                        storage::DatabaseImportEvent { label: "Falha na restauração; banco anterior mantido".into(), occurred_at: chrono::Local::now().format("%H:%M:%S%.3f").to_string() },
                    ],
                }),
            }

            // Built here instead of declaratively in `tauri.conf.json`
            // (whose `app.windows` is deliberately empty) so `transparent`
            // can differ by OS: Windows/macOS need it for `window_glass`'s
            // Acrylic/Vibrancy to have anything to show through, but
            // WebKitGTK on Linux has known rendering glitches (ghosted,
            // overlapping frames — see the screenshot that prompted this)
            // on transparent windows, so Linux keeps an opaque one and
            // relies solely on `.modal-overlay`'s CSS-only blur instead.
            let main_window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("PontoScan")
                .inner_size(1280.0, 800.0)
                .maximized(true)
                .transparent(cfg!(any(target_os = "windows", target_os = "macos")))
                // Same color as App.css's `--bg` — without this, the window/
                // webview's own default (opaque white) paints for the brief
                // moment between the native window appearing and the page's
                // CSS actually loading, showing as a white flash before the
                // real dark theme (or the transparent/Acrylic look) kicks in.
                .background_color(tauri::window::Color(11, 14, 20, 255))
                .build()?;

            // Applied once, for the window's whole lifetime — not toggled
            // per Modal/Drawer open — so the app has a permanent frosted-glass
            // look on Windows/macOS. Whether it actually took is reported back
            // to the frontend via `window_glass_active` (see `window_glass.rs`).
            let glass_active = window_glass::enable(&main_window).is_ok();
            app.manage(window_glass::WindowGlassState(glass_active));

            // Always present (regardless of the "Minimizar na bandeja ao
            // fechar" setting) — it's the only way back once a close has
            // been turned into a hide, and a "Sair" that actually quits.
            let show_item = MenuItem::with_id(app, "show", "Abrir PontoScan", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            // `.to_owned()` (not just `.clone()`) — `default_window_icon()`
            // borrows from `app`, whose lifetime doesn't outlive this
            // closure, but `TrayIcons` below needs a `'static` `Image` to
            // be stored in managed state.
            let normal_icon = app.default_window_icon().map(|icon| icon.clone().to_owned());

            let mut tray = TrayIconBuilder::new().menu(&menu).tooltip("PontoScan");
            if let Some(icon) = &normal_icon {
                tray = tray.icon(icon.clone());
            }
            let tray = tray
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;
            app.manage(tray);

            // Only set up if the app actually has a default icon to badge —
            // `set_tray_status` no-ops via `app.try_state()` when this was
            // never managed, same as any other "nothing to do" case.
            if let Some(normal) = normal_icon {
                let attention = with_attention_badge(&normal);
                app.manage(TrayIcons { normal, attention });
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // "Minimizar na bandeja ao fechar" (Configurações) — re-read
            // fresh off disk on every close request (not cached at
            // startup) so toggling the setting takes effect immediately,
            // without restarting the app. Only the main window matters
            // here; every other window in this app is a modal-ish child
            // that should just close normally.
            if window.label() != "main" {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                let close_to_tray = window
                    .app_handle()
                    .path()
                    .app_data_dir()
                    .ok()
                    .map(|dir| settings::load(&dir).close_to_tray)
                    .unwrap_or(false);
                if close_to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_providers,
            commands::list_dir_files,
            commands::hash_files,
            commands::parse_import,
            commands::reveal_in_file_manager,
            commands::open_app_data_dir,
            commands::read_pdf_bytes,
            commands::copy_pdf_to,
            commands::list_spreadsheet_sheets,
            commands::preview_spreadsheet,
            commands::apply_payment_template,
            commands::hash_payment_file,
            commands::generate_report_zip,
            commands::get_storage_usage,
            commands::get_imports_file_list,
            commands::delete_paths,
            commands::clear_imports_dir,
            commands::backup_app_data,
            commands::write_binary_file,
            commands::export_database,
            commands::import_database,
            commands::cancel_database_import,
            commands::take_database_import_result,
            commands::clear_database_import_result,
            commands::check_poppler_status,
            commands::set_poppler_dir,
            commands::list_recent_payment_files,
            commands::add_recent_payment_file,
            commands::download_payment_file_from_url,
            commands::check_remote_payment_file,
            commands::get_close_to_tray,
            commands::set_close_to_tray,
            commands::set_tray_status,
            commands::open_reconciliation_window,
            commands::is_reconciliation_window_open,
            window_glass::window_glass_active,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
