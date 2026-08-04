use super::utils::hhmm_to_minutes;
use super::TimesheetParser;
use crate::model::{Company, DayRecord, Employee, ParseError, ParsedTimesheet, Period};
use chrono::{Datelike, NaiveDate};
use regex::Regex;

/// Parses the "Espelho Ponto" export from Coalize (coalize.com.br).
///
/// The layout is a fixed grid: one line per day, `DD/MM (Weekday)` followed
/// by 0-4 "HH:MM" punches and a fixed run of trailing "HH:MM" totals.
/// `pdf_extract::extract_text` uses `pdftotext -layout`, which keeps this
/// one-line-per-day structure regardless of the source PDF's internal
/// text-object order, so this parser works off token counts per line
/// (trimmed first) rather than exact column positions or spacing.
///
/// Two export configurations exist, differing only in whether a "Total
/// trabalhado" column is included before "Horas normais"/"Faltas" — 3
/// trailing totals with it, 2 without. Token count alone can't tell them
/// apart (e.g. "3 trailing + 1 punch" and "2 trailing + 2 punches" both
/// produce 4 tokens), so the variant is detected once from the header via
/// the word "trabalhado", which only appears when that column exists.
/// When it's absent, worked minutes are computed from the punches
/// themselves (summing each Entrada→Saída pair) instead of trusting a
/// field the source doesn't print.
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

        // See the module doc comment: some exports omit the "Total
        // trabalhado" column entirely, leaving only 2 trailing totals
        // instead of 3.
        let has_total_worked_column = raw_text.contains("trabalhado");
        let trailing_count = if has_total_worked_column { 3 } else { 2 };

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

            // A valid row always has the trailing totals; anything short of
            // that isn't a data row we recognize, so skip rather than fail
            // the whole document over one stray line.
            if tokens.len() < trailing_count {
                continue;
            }

            let (punches, trailing) = tokens.split_at(tokens.len() - trailing_count);
            let (total_worked_minutes, normal_hours_minutes, absence_minutes) = if has_total_worked_column {
                (
                    hhmm_to_minutes(trailing[0]).unwrap_or(0),
                    hhmm_to_minutes(trailing[1]).unwrap_or(0),
                    hhmm_to_minutes(trailing[2]).unwrap_or(0),
                )
            } else {
                (
                    worked_minutes_from_punches(punches),
                    hhmm_to_minutes(trailing[0]).unwrap_or(0),
                    hhmm_to_minutes(trailing[1]).unwrap_or(0),
                )
            };

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

/// Sums each Entrada→Saída pair (punches[0]→punches[1], punches[2]→punches[3],
/// ...) — used when the source doesn't print its own "Total trabalhado"
/// column. A trailing unmatched punch (odd count) contributes nothing, same
/// as the source itself would leave that day's total incomplete.
fn worked_minutes_from_punches(punches: &[&str]) -> i32 {
    let mut total = 0;
    let mut i = 0;
    while i + 1 < punches.len() {
        if let (Some(start), Some(end)) = (hhmm_to_minutes(punches[i]), hhmm_to_minutes(punches[i + 1])) {
            total += end - start;
        }
        i += 2;
    }
    total
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

    // A real page from a Coalize batch export whose internal PDF text-object
    // order made plain `pdftotext` emit every date first and every time
    // value afterward — the day-row regex matched nothing and the parser
    // silently produced 0 days. `pdftotext -layout` (which
    // `pdf_extract::extract_text` now always uses) reconstructs rows from
    // on-page position instead, giving this wide, space-padded — but still
    // one-line-per-day — output. Also covers a `FUNCIONÁRIO` line with a
    // trailing "| Cargo: ..." field this page had that the sample didn't.
    const LAYOUT_SAMPLE: &str = "\
Emissão: 03/08/2026 13:25:03

                                                               ESPELHO PONTO: 01/07/2026 - 31/07/2026
  FUNCIONÁRIO: LUANA VIEIRA | CPF: 06485482954 | Cargo: REPOSITOR (A)
  EMPRESA: RF MERCHANDISING E PROMOCOES LTDA | CNPJ: 62489830000181

                                                  Jornada realizada                              Jornada
                                                                                       Total                Horas
                   Data               Ent. 1     Saí. 1       Ent. 2    Saí. 2                                         Faltas    Observação
                                                                                    trabalhado             normais
               01/07 (Qua)                                                             00:00                 00:00      00:00
               05/07 (Dom)            15:08       21:15                                06:07                 00:00      00:00
               31/07 (Sex)                                                             00:00                 00:00      00:00

Assinatura: ";

    #[test]
    fn parses_wide_layout_output() {
        let sheets = CoalizeParser.parse(LAYOUT_SAMPLE, "/tmp/x.pdf").unwrap();
        assert_eq!(sheets.len(), 1);
        let sheet = &sheets[0];

        assert_eq!(sheet.employee.name, "LUANA VIEIRA");
        assert_eq!(sheet.employee.cpf, "06485482954");
        assert_eq!(sheet.days.len(), 3);

        let no_punch = sheet.days.iter().find(|d| d.date == "2026-07-01").unwrap();
        assert!(no_punch.punches.is_empty());

        let with_punches = sheet.days.iter().find(|d| d.date == "2026-07-05").unwrap();
        assert_eq!(with_punches.punches, vec!["15:08", "21:15"]);
        assert_eq!(with_punches.total_worked_minutes, 6 * 60 + 7);
    }

    // A real "Espelho Ponto" export configuration with no "Total
    // trabalhado" column at all — only "Horas normais" and "Faltas". Before
    // the fix, the parser always split off the last 3 tokens as totals,
    // which on a day with a single punch (05/07) swallowed that punch
    // entirely as a bogus "total worked" value, and on a day with two
    // punches (26/07) mistook the real Saída for the same bogus total.
    const NO_TOTAL_WORKED_COLUMN_SAMPLE: &str = "\
Emissão: 03/08/2026 13:12:58
ESPELHO PONTO: 01/07/2026 - 31/07/2026
FUNCIONÁRIO: ADAO PINTO FAGUNDES | CPF: 80998852015 | Cargo: operador de caixa
EMPRESA: FC MERCHANDISING LTDA | CNPJ: 64953192000133
Jornada realizada Jornada
Data Ent. 1 Saí. 1 Ent. 2 Saí. 2 Horas
normais Faltas Observação
01/07 (Qua) 00:00 00:00
05/07 (Dom) 16:47 00:00 00:00
26/07 (Dom) 13:24 19:36 00:00 00:00
28/07 (Ter) 12:54 00:00 00:00
TOTAL 00h00min 00h00min
Assinatura: ";

    #[test]
    fn parses_variant_without_total_worked_column() {
        let sheets = CoalizeParser.parse(NO_TOTAL_WORKED_COLUMN_SAMPLE, "/tmp/x.pdf").unwrap();
        let sheet = &sheets[0];

        let no_punch = sheet.days.iter().find(|d| d.date == "2026-07-01").unwrap();
        assert!(no_punch.punches.is_empty());
        assert_eq!(no_punch.total_worked_minutes, 0);

        // A single punch is a real Entrada, not a bogus "total worked".
        let single_punch = sheet.days.iter().find(|d| d.date == "2026-07-05").unwrap();
        assert_eq!(single_punch.punches, vec!["16:47"]);
        assert_eq!(single_punch.total_worked_minutes, 0);

        // Both punches land in Ent.1/Saí.1, and worked minutes are derived
        // from that pair (19:36 - 13:24 = 6h12min) since the source prints
        // no total of its own.
        let pair = sheet.days.iter().find(|d| d.date == "2026-07-26").unwrap();
        assert_eq!(pair.punches, vec!["13:24", "19:36"]);
        assert_eq!(pair.total_worked_minutes, 6 * 60 + 12);
        assert_eq!(pair.normal_hours_minutes, 0);
        assert_eq!(pair.absence_minutes, 0);

        let trailing_single = sheet.days.iter().find(|d| d.date == "2026-07-28").unwrap();
        assert_eq!(trailing_single.punches, vec!["12:54"]);
        assert_eq!(trailing_single.total_worked_minutes, 0);
    }
}
