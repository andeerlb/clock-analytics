use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Company {
    pub name: String,
    pub cnpj: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Employee {
    pub name: String,
    pub cpf: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Period {
    /// ISO 8601 date (YYYY-MM-DD)
    pub start: String,
    /// ISO 8601 date (YYYY-MM-DD)
    pub end: String,
}

/// One row of the original timesheet grid, normalized.
/// `punches` is a loose ordered list (not fixed Ent1/Sai1/Ent2/Sai2 slots)
/// so providers with a different number of clock pairs fit the same shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayRecord {
    /// ISO 8601 date (YYYY-MM-DD)
    pub date: String,
    pub weekday: String,
    /// "HH:MM" strings, in the order they appear on the row
    pub punches: Vec<String>,
    pub total_worked_minutes: i32,
    pub normal_hours_minutes: i32,
    pub absence_minutes: i32,
    pub observation: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedTimesheet {
    pub provider: String,
    pub company: Company,
    pub employee: Employee,
    pub period: Period,
    pub days: Vec<DayRecord>,
    /// Path to the copy of the original PDF kept in the app's data dir.
    pub original_pdf_path: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ParseError {
    #[error("could not find field '{0}' in the document")]
    MissingField(&'static str),
    #[error("unrecognized document format for provider '{0}'")]
    UnrecognizedFormat(String),
    #[error("failed to extract text from PDF: {0}")]
    ExtractionFailed(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}
