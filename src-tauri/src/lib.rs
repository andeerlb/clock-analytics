mod commands;
mod db;
mod hashing;
mod model;
mod parsers;
mod pdf_extract;
mod report_zip;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(db::DB_URL, db::migrations())
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::list_providers,
            commands::hash_files,
            commands::parse_import,
            commands::open_original_pdf,
            commands::generate_report_zip,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
