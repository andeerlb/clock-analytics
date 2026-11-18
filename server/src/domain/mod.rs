//! Pure domain code carried over unchanged from the old desktop app:
//! timesheet parsers, Poppler wrappers, spreadsheet
//! reading, file authorship and report ZIPs. Nothing here knows about HTTP.
#![allow(dead_code)]

pub mod file_author;
pub mod hashing;
pub mod model;
pub mod parsers;
pub mod pdf_extract;
pub mod poppler;
pub mod report_zip;
pub mod spreadsheet;
