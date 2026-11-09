// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if pontoscan_lib::run_tool_server_if_requested() {
        return;
    }
    pontoscan_lib::run()
}
