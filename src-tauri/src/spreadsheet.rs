use calamine::{open_workbook_auto, DataType, Reader};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

/// Extension-based dispatch — csv is read as delimited text; anything else
/// (xlsx/xls/ods) is handed to calamine, which auto-detects the exact
/// binary format from the file's own header bytes rather than trusting the
/// extension. No trait/registry needed here (unlike parsers::TimesheetParser)
/// since the variation that matters lives entirely in a template's own
/// column mapping, not in per-format parsing logic.
fn is_csv(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("csv"))
        .unwrap_or(false)
}

/// Sheet names in an xlsx/xls/ods workbook — empty for csv (no concept of
/// sheets), so the frontend can key "show tabs?" off `sheets.is_empty()`.
pub fn list_sheets(path: &str) -> Result<Vec<String>, String> {
    if is_csv(path) {
        return Ok(Vec::new());
    }
    let workbook = open_workbook_auto(path).map_err(|e| e.to_string())?;
    Ok(workbook.sheet_names())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpreadsheetPreview {
    pub rows: Vec<Vec<String>>,
    /// The delimiter actually used to split a csv into columns — `None`
    /// for xlsx/xls/ods. Always echoed back (even when the caller passed
    /// `None`, meaning "auto-detect") so the frontend can populate its
    /// delimiter selector without a second round trip.
    pub delimiter: Option<String>,
}

const DELIMITER_CANDIDATES: [u8; 4] = [b',', b';', b'\t', b'|'];

/// Guesses a csv's delimiter: whichever candidate splits the first several
/// records into the same field count (more than one field) wins; falls
/// back to comma if nothing looks consistent. Uses the real csv reader per
/// candidate (not a naive string split) so quoted fields containing a
/// delimiter character don't throw off the count.
fn detect_delimiter(path: &str) -> u8 {
    for &candidate in &DELIMITER_CANDIDATES {
        let Ok(mut reader) = csv::ReaderBuilder::new()
            .delimiter(candidate)
            .has_headers(false)
            .flexible(true)
            .from_path(path)
        else {
            continue;
        };
        let mut counts = Vec::new();
        for record in reader.records().take(5).flatten() {
            counts.push(record.len());
        }
        if !counts.is_empty() && counts[0] > 1 && counts.iter().all(|c| *c == counts[0]) {
            return candidate;
        }
    }
    b','
}

/// Raw preview rows, capped at `max_rows` — no header-row assumption; row 0
/// is whatever the file's first physical row is, so the wizard can render
/// it exactly like the source and let the user click which row is real.
pub fn preview(
    path: &str,
    sheet: Option<&str>,
    delimiter: Option<&str>,
    max_rows: u32,
) -> Result<SpreadsheetPreview, String> {
    if is_csv(path) {
        let delim_byte = delimiter
            .and_then(|d| d.as_bytes().first().copied())
            .unwrap_or_else(|| detect_delimiter(path));
        let mut reader = csv::ReaderBuilder::new()
            .delimiter(delim_byte)
            .has_headers(false)
            .flexible(true)
            .from_path(path)
            .map_err(|e| e.to_string())?;
        let rows = reader
            .records()
            .take(max_rows as usize)
            .map(|r| r.map(|record| record.iter().map(|f| f.to_string()).collect()))
            .collect::<Result<Vec<Vec<String>>, _>>()
            .map_err(|e| e.to_string())?;
        return Ok(SpreadsheetPreview {
            rows,
            delimiter: Some((delim_byte as char).to_string()),
        });
    }

    let mut workbook = open_workbook_auto(path).map_err(|e| e.to_string())?;
    let sheet_name = match sheet {
        Some(name) => name.to_string(),
        None => workbook
            .sheet_names()
            .first()
            .cloned()
            .ok_or("o arquivo não tem nenhuma aba")?,
    };
    let range = workbook
        .worksheet_range(&sheet_name)
        .map_err(|e| e.to_string())?;
    let rows = range
        .rows()
        .take(max_rows as usize)
        .map(|row| row.iter().map(|cell| cell.to_string()).collect())
        .collect();
    Ok(SpreadsheetPreview { rows, delimiter: None })
}

/// One payment template group's own slice of the config needed to read
/// it — mirrors `PaymentTemplateGroup` on the TS side, minus the parts
/// (id, header_label) that don't matter for actually reading rows. There's
/// no header-row here on purpose — which physical row is real data isn't
/// decided here, it's decided by the caller trying to parse each row's
/// "data" field as a date (see `apply_template`'s doc comment).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupSpec {
    /// Empty for csv — there's exactly one implicit group.
    pub sheet_names: Vec<String>,
    /// (columnLetter, targetField) pairs — deliberately a tuple list, not a
    /// map, since duplicate target fields across columns should never
    /// happen (the wizard already prevents it) but a tuple list doesn't
    /// need to care either way.
    pub field_mappings: Vec<(String, String)>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedPaymentRow {
    pub sheet_name: Option<String>,
    /// 1-indexed physical row in the source file — for error messages.
    pub row_number: u32,
    /// targetField -> raw text value.
    pub fields: HashMap<String, String>,
    /// columnLetter -> raw text value, for every non-blank column the
    /// template left unmapped ("Ignorar") — kept for history/audit instead
    /// of discarded, in case something worth knowing was in a column
    /// nobody thought to map. Blank cells are left out, same as a
    /// genuinely blank row never becoming an `AppliedPaymentRow` at all.
    pub extra_fields: HashMap<String, String>,
}

/// Spreadsheet-style column letter ("A", "Z", "AA") -> 0-indexed column
/// number — the inverse of the frontend's `columnLetter` (src/lib/format.ts).
fn column_index(letter: &str) -> Option<usize> {
    let mut n: usize = 0;
    for ch in letter.chars() {
        if !ch.is_ascii_alphabetic() {
            return None;
        }
        n = n * 26 + (ch.to_ascii_uppercase() as usize - 'A' as usize + 1);
    }
    n.checked_sub(1)
}

/// 0-indexed column number -> spreadsheet-style column letter — the inverse
/// of `column_index`, mirroring the frontend's `columnLetter`. Used to
/// label a column left unmapped by the template (`extra_fields`), since it
/// has no target-field name to fall back on.
fn column_letter(index0: usize) -> String {
    let mut n = index0 + 1;
    let mut letters = String::new();
    while n > 0 {
        let rem = (n - 1) % 26;
        letters.insert(0, (b'A' + rem as u8) as char);
        n = (n - 1) / 26;
    }
    letters
}

fn is_blank_row(fields: &HashMap<String, String>) -> bool {
    fields.values().all(|v| v.trim().is_empty())
}

/// Reads every non-blank row of `path` according to `groups`' column
/// mappings — the real, unbounded counterpart to `preview`. There's no
/// header-row skip: every physical row (blank ones aside) comes back as
/// an `AppliedPaymentRow`, including whatever turns out to be a title or
/// header row. It's up to the caller to decide which rows are real data —
/// in practice, by trying to parse each row's "data" field as a date and
/// discarding whichever don't, since a title/header/footer row won't have
/// one.
pub fn apply_template(
    path: &str,
    groups: &[GroupSpec],
    delimiter: Option<&str>,
) -> Result<Vec<AppliedPaymentRow>, String> {
    if is_csv(path) {
        let group = groups
            .first()
            .ok_or("nenhuma configuração de colunas definida")?;
        let mapped_indices: std::collections::HashSet<usize> = group
            .field_mappings
            .iter()
            .filter_map(|(letter, _)| column_index(letter))
            .collect();
        let delim_byte = delimiter
            .and_then(|d| d.as_bytes().first().copied())
            .unwrap_or_else(|| detect_delimiter(path));
        let mut reader = csv::ReaderBuilder::new()
            .delimiter(delim_byte)
            .has_headers(false)
            .flexible(true)
            .from_path(path)
            .map_err(|e| e.to_string())?;

        let mut out = Vec::new();
        for (i, record) in reader.records().enumerate() {
            let row_number = (i + 1) as u32;
            let record = record.map_err(|e| e.to_string())?;
            let fields: HashMap<String, String> = group
                .field_mappings
                .iter()
                .filter_map(|(letter, target_field)| {
                    let index = column_index(letter)?;
                    let value = record.get(index).unwrap_or("").trim().to_string();
                    Some((target_field.clone(), value))
                })
                .collect();
            if is_blank_row(&fields) {
                continue;
            }
            let extra_fields: HashMap<String, String> = record
                .iter()
                .enumerate()
                .filter(|(idx, _)| !mapped_indices.contains(idx))
                .map(|(idx, value)| (column_letter(idx), value.trim().to_string()))
                .filter(|(_, value)| !value.is_empty())
                .collect();
            out.push(AppliedPaymentRow { sheet_name: None, row_number, fields, extra_fields });
        }
        return Ok(out);
    }

    let mut workbook = open_workbook_auto(path).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for group in groups {
        let mapped_indices: std::collections::HashSet<usize> = group
            .field_mappings
            .iter()
            .filter_map(|(letter, _)| column_index(letter))
            .collect();
        for sheet_name in &group.sheet_names {
            let range = workbook
                .worksheet_range(sheet_name)
                .map_err(|e| e.to_string())?;
            for (i, row) in range.rows().enumerate() {
                let row_number = (i + 1) as u32;
                let fields: HashMap<String, String> = group
                    .field_mappings
                    .iter()
                    .filter_map(|(letter, target_field)| {
                        let index = column_index(letter)?;
                        let cell = row.get(index)?;
                        // A native date cell's Display impl prints the raw
                        // Excel serial number, not a usable date — convert
                        // it properly for the one field that needs a real
                        // date. Everything else (including a "data" column
                        // that's actually text, e.g. an already-ISO string)
                        // just uses the same to_string() preview() relies on.
                        let value = if target_field == "data" {
                            cell.as_datetime()
                                .map(|dt| dt.format("%Y-%m-%d").to_string())
                                .unwrap_or_else(|| cell.to_string())
                        } else {
                            cell.to_string()
                        };
                        Some((target_field.clone(), value.trim().to_string()))
                    })
                    .collect();
                if is_blank_row(&fields) {
                    continue;
                }
                let extra_fields: HashMap<String, String> = row
                    .iter()
                    .enumerate()
                    .filter(|(idx, _)| !mapped_indices.contains(idx))
                    .map(|(idx, cell)| (column_letter(idx), cell.to_string().trim().to_string()))
                    .filter(|(_, value)| !value.is_empty())
                    .collect();
                out.push(AppliedPaymentRow {
                    sheet_name: Some(sheet_name.clone()),
                    row_number,
                    fields,
                    extra_fields,
                });
            }
        }
    }
    Ok(out)
}
