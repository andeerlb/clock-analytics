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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(db::DB_URL, db::migrations())
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::list_providers,
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
            commands::delete_paths,
            commands::clear_imports_dir,
            commands::backup_app_data,
            commands::write_binary_file,
            commands::check_poppler_status,
            commands::set_poppler_dir,
            commands::list_recent_payment_files,
            commands::add_recent_payment_file,
            commands::download_payment_file_from_url,
            commands::check_remote_payment_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
