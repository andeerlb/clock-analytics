use super::utils::hhmm_to_minutes;
use super::TimesheetParser;
use crate::model::{Company, DayRecord, Employee, ParseError, ParsedTimesheet, Period};
use chrono::{Datelike, NaiveDate};
use regex::Regex;

/// Parses the "Espelho Ponto" export from Coalize (coalize.com.br).
///
/// The layout is a fixed grid: one line per day, `DD/MM (Weekday)` followed
/// by 0-4 "HH:MM" punches and always exactly 3 trailing "HH:MM" totals
/// (Total trabalhado, Horas normais, Faltas). Plain `pdftotext` (no
/// `-layout`) keeps this one-line-per-day structure, so the parser works
/// off token counts per line rather than column positions.
pub struct CoalizeParser;

impl TimesheetParser for CoalizeParser {
    fn id(&self) -> &'static str {
        "coalize"
    }

    fn label(&self) -> &'static str {
        "Coalize"
    }

    fn parse(
        &self,
        raw_text: &str,
        original_pdf_path: &str,
    ) -> Result<Vec<ParsedTimesheet>, ParseError> {
        if !raw_text.contains("ESPELHO PONTO") {
            return Err(ParseError::UnrecognizedFormat("coalize".into()));
        }

        let period_re =
            Regex::new(r"ESPELHO PONTO:\s*(\d{2}/\d{2}/\d{4})\s*-\s*(\d{2}/\d{2}/\d{4})").unwrap();
        let employee_re =
            Regex::new(r"FUNCION[ÁA]RIO:\s*(.+?)\s*\|\s*CPF:\s*([0-9.\-]+)").unwrap();
        let company_re = Regex::new(r"EMPRESA:\s*(.+?)\s*\|\s*CNPJ:\s*([0-9./\-]+)").unwrap();
        let day_row_re =
            Regex::new(r"^(\d{2})/(\d{2})\s+\(([^)]+)\)\s+((?:\d{2}:\d{2}\s*)+)$").unwrap();

        let period_caps = period_re
            .captures(raw_text)
            .ok_or(ParseError::MissingField("ESPELHO PONTO"))?;
        let period_start = parse_br_date(&period_caps[1])?;
        let period_end = parse_br_date(&period_caps[2])?;

        let employee_caps = employee_re
            .captures(raw_text)
            .ok_or(ParseError::MissingField("FUNCIONÁRIO"))?;
        let company_caps = company_re
            .captures(raw_text)
            .ok_or(ParseError::MissingField("EMPRESA"))?;

        let employee = Employee {
            name: employee_caps[1].trim().to_string(),
            cpf: employee_caps[2].trim().to_string(),
        };
        let company = Company {
            name: company_caps[1].trim().to_string(),
            cnpj: company_caps[2].trim().to_string(),
        };

        let mut days = Vec::new();
        for line in raw_text.lines() {
            let line = line.trim();
            let Some(caps) = day_row_re.captures(line) else {
                continue;
            };

            let day: u32 = caps[1].parse().unwrap();
            let month: u32 = caps[2].parse().unwrap();
            let weekday = caps[3].to_string();
            let tokens: Vec<&str> = caps[4].split_whitespace().collect();

            // A valid row always has the 3 trailing totals; anything short
            // of that isn't a data row we recognize, so skip rather than
            // fail the whole document over one stray line.
            if tokens.len() < 3 {
                continue;
            }

            let (punches, trailing) = tokens.split_at(tokens.len() - 3);
            let total_worked_minutes = hhmm_to_minutes(trailing[0]).unwrap_or(0);
            let normal_hours_minutes = hhmm_to_minutes(trailing[1]).unwrap_or(0);
            let absence_minutes = hhmm_to_minutes(trailing[2]).unwrap_or(0);

            // The row only has day/month, not year; periods span a single
            // month in this export, but guard the rollover just in case a
            // provider variant crosses a year boundary.
            let year = if month < period_start.month() {
                period_end.year()
            } else {
                period_start.year()
            };
            let date = NaiveDate::from_ymd_opt(year, month, day)
                .ok_or(ParseError::UnrecognizedFormat("coalize:date".into()))?;

            days.push(DayRecord {
                date: date.format("%Y-%m-%d").to_string(),
                weekday,
                punches: punches.iter().map(|s| s.to_string()).collect(),
                total_worked_minutes,
                normal_hours_minutes,
                absence_minutes,
                observation: None,
            });
        }

        Ok(vec![ParsedTimesheet {
            provider: self.id().to_string(),
            company,
            employee,
            period: Period {
                start: period_start.format("%Y-%m-%d").to_string(),
                end: period_end.format("%Y-%m-%d").to_string(),
            },
            days,
            original_pdf_path: original_pdf_path.to_string(),
            // Filled in by the caller (commands::parse_import) once it has
            // hashed the source file; the parser only knows about content.
            original_file_hash: String::new(),
            original_file_name: String::new(),
        }])
    }
}

fn parse_br_date(s: &str) -> Result<NaiveDate, ParseError> {
    NaiveDate::parse_from_str(s, "%d/%m/%Y")
        .map_err(|_| ParseError::UnrecognizedFormat("coalize:date".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Reading-order text as `pdftotext` (no -layout) emits it for the
    // sample "Espelho Ponto" PDF this parser targets.
    const SAMPLE: &str = "\
Emissão: 03/08/2026 13:25:03
ESPELHO PONTO: 01/07/2026 - 31/07/2026
FUNCIONÁRIO: Ademilson Oliveira Lima | CPF: 00533799260
EMPRESA: RF MERCHANDISING E PROMOCOES LTDA | CNPJ: 62489830000181
Jornada realizada Jornada
Data Ent. 1 Saí. 1 Ent. 2 Saí. 2 Total
trabalhado
Horas
normais Faltas Observação
01/07 (Qua) 00:00 00:00 00:00
02/07 (Qui) 00:00 00:00 00:00
03/07 (Sex) 00:00 00:00 00:00
04/07 (Sáb) 00:00 00:00 00:00
05/07 (Dom) 15:08 21:15 06:07 00:00 00:00
06/07 (Seg) 00:00 00:00 00:00
07/07 (Ter) 00:00 00:00 00:00
08/07 (Qua) 16:27 00:00 00:00 00:00
09/07 (Qui) 00:00 00:00 00:00
31/07 (Sex) 00:00 00:00 00:00
TOTAL 06h07min 00h00min 00h00min
Assinatura: ";

    #[test]
    fn rejects_unrecognized_documents() {
        let result = CoalizeParser.parse("not a coalize document", "/tmp/x.pdf");
        assert!(matches!(result, Err(ParseError::UnrecognizedFormat(_))));
    }

    #[test]
    fn parses_header_fields() {
        let sheets = CoalizeParser.parse(SAMPLE, "/tmp/x.pdf").unwrap();
        assert_eq!(sheets.len(), 1);
        let sheet = &sheets[0];

        assert_eq!(sheet.provider, "coalize");
        assert_eq!(sheet.employee.name, "Ademilson Oliveira Lima");
        assert_eq!(sheet.employee.cpf, "00533799260");
        assert_eq!(sheet.company.name, "RF MERCHANDISING E PROMOCOES LTDA");
        assert_eq!(sheet.company.cnpj, "62489830000181");
        assert_eq!(sheet.period.start, "2026-07-01");
        assert_eq!(sheet.period.end, "2026-07-31");
    }

    #[test]
    fn parses_day_with_no_punches() {
        let sheets = CoalizeParser.parse(SAMPLE, "/tmp/x.pdf").unwrap();
        let day = sheets[0].days.iter().find(|d| d.date == "2026-07-01").unwrap();

        assert!(day.punches.is_empty());
        assert_eq!(day.total_worked_minutes, 0);
        assert_eq!(day.weekday, "Qua");
    }

    #[test]
    fn parses_day_with_a_complete_punch_pair() {
        let sheets = CoalizeParser.parse(SAMPLE, "/tmp/x.pdf").unwrap();
        let day = sheets[0].days.iter().find(|d| d.date == "2026-07-05").unwrap();

        assert_eq!(day.punches, vec!["15:08", "21:15"]);
        assert_eq!(day.total_worked_minutes, 6 * 60 + 7);
    }

    #[test]
    fn parses_day_with_an_incomplete_punch() {
        let sheets = CoalizeParser.parse(SAMPLE, "/tmp/x.pdf").unwrap();
        let day = sheets[0].days.iter().find(|d| d.date == "2026-07-08").unwrap();

        assert_eq!(day.punches, vec!["16:27"]);
        assert_eq!(day.total_worked_minutes, 0);
    }
}
