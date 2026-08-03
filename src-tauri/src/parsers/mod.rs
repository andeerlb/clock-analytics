mod coalize;
pub mod utils;

use crate::model::{ParseError, ParsedTimesheet};

/// One implementation per timesheet export format. The user picks the
/// provider explicitly (e.g. "Coalize") before importing, so a parser never
/// needs to guess its own format against unrelated ones — it only needs to
/// validate that the text actually matches what it expects.
///
/// A single PDF can contain more than one employee (a consolidated report),
/// so `parse` returns a Vec even for providers that only ever emit one
/// employee per file.
pub trait TimesheetParser {
    fn id(&self) -> &'static str;
    fn label(&self) -> &'static str;
    fn parse(
        &self,
        raw_text: &str,
        original_pdf_path: &str,
    ) -> Result<Vec<ParsedTimesheet>, ParseError>;
}

/// Add new providers here — one line per parser. Nothing else in the app
/// needs to change: the provider dropdown and the import command both read
/// from this registry.
pub fn registry() -> Vec<Box<dyn TimesheetParser>> {
    vec![Box::new(coalize::CoalizeParser)]
}

pub fn providers() -> Vec<(&'static str, &'static str)> {
    registry().iter().map(|p| (p.id(), p.label())).collect()
}

pub fn get_parser(id: &str) -> Option<Box<dyn TimesheetParser>> {
    registry().into_iter().find(|p| p.id() == id)
}
