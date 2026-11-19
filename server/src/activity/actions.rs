//! How each operation that changes data reads in the activity log: its area,
//! the sentence ("editou o turno"), what kind of record it touches and where
//! that record's id comes from.

use super::snapshot::Entity;

/// Where the touched record's id is.
#[derive(Debug, Clone, Copy)]
pub enum Target {
    /// An argument of the call (camelCase, as the frontend sends it).
    Arg(&'static str),
    /// The `{id}` in a REST path (`/companies/{id}`).
    Path,
    /// What the call returns: the new record's id (a number or `{id}`).
    Reply,
    /// Looked up before the change, from an argument: e.g. the colaborador a
    /// PIX key belongs to, read before the key is removed.
    Lookup { sql: &'static str, arg: &'static str },
    None,
}

/// Where the "after" picture of the record comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum After {
    /// The same record.
    Same,
    /// The id the call returns (a turno's new version).
    Reply,
    /// The newest version of the turno the call started from.
    ShiftHead,
}

/// Bulk operations: what they created, counted and listed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bulk {
    No,
    NewShifts,
    NewEmployees,
    /// Counts an array argument ("dispensou 4 alterações").
    Count { arg: &'static str, noun: &'static str },
}

#[derive(Debug, Clone, Copy)]
pub struct Def {
    pub area: &'static str,
    pub verb: &'static str,
    pub entity: Option<Entity>,
    pub target: Target,
    pub after: After,
    pub bulk: Bulk,
}

const fn d(area: &'static str, verb: &'static str, entity: Entity, target: Target) -> Def {
    Def { area, verb, entity: Some(entity), target, after: After::Same, bulk: Bulk::No }
}

/// A turno transition: starts from `arg`, the call returns the new version.
const fn shift(verb: &'static str, arg: &'static str) -> Def {
    Def { area: PG, verb, entity: Some(Entity::Shift), target: Target::Arg(arg), after: After::Reply, bulk: Bulk::No }
}

const fn plain(area: &'static str, verb: &'static str) -> Def {
    Def { area, verb, entity: None, target: Target::None, after: After::Same, bulk: Bulk::No }
}

const PG: &str = "Pagamentos";
const TP: &str = "Templates";
const CO: &str = "Colaboradores";
const EM: &str = "Empresas";
const CL: &str = "Clientes";
const FN: &str = "Funções";
const ES: &str = "Espelhos";
const VE: &str = "Verificação";
const CF: &str = "Configurações";
const US: &str = "Usuários";

#[cfg_attr(not(test), allow(dead_code))]
/// Operations that change data but aren't worth a line: reading files to
/// build an import, internal bookkeeping, forcing a check right now.
pub const NOT_LOGGED: &[&str] = &[
    "hashFiles",
    "parseImport",
    "logSourceFile",
    "markSourceFileSaved",
    "listSpreadsheetSheets",
    "previewSpreadsheet",
    "applyPaymentTemplate",
    "hashPaymentFile",
    "readSpreadsheetAuthor",
    "downloadPaymentFileFromUrl",
    "checkRemotePaymentFile",
    "deleteImportedFiles",
    "forceCheckAll",
    "forceCheckConfig",
    "listAppUsers",
    "listAccessProfiles",
    "listActivity",
    "listActivityFilters",
];

/// The operation behind a request: the RPC name, or a name for the REST routes.
pub fn name_of(method: &axum::http::Method, path: &str) -> Option<String> {
    use axum::http::Method;
    if let Some(name) = path.strip_prefix("/rpc/") {
        return Some(name.to_owned());
    }
    match (method, path) {
        (&Method::POST, "/companies") => Some("createCompany".into()),
        (&Method::PUT, p) if p.starts_with("/companies/") => Some("updateCompany".into()),
        _ => None,
    }
}

pub fn def(name: &str) -> Option<Def> {
    use Entity::*;
    use Target::*;
    let alias_employee = Lookup { sql: "SELECT employee_id AS id FROM employee_aliases WHERE id = $1", arg: "aliasId" };
    let pix_employee = Lookup { sql: "SELECT employee_id AS id FROM employee_pix_keys WHERE id = $1", arg: "id" };
    let alias_role = Lookup { sql: "SELECT role_id AS id FROM role_aliases WHERE id = $1", arg: "aliasId" };
    Some(match name {
        // --- Empresas, Clientes, Funções ---
        "createCompany" => d(EM, "criou a empresa", Company, Reply),
        "updateCompany" => d(EM, "editou a empresa", Company, Path),
        "createClient" => d(CL, "criou o cliente", Client, Reply),
        "updateClient" => d(CL, "editou o cliente", Client, Arg("id")),
        "addClientCompany" => d(CL, "ligou uma empresa ao cliente", Client, Arg("clientId")),
        "removeClientCompany" => d(CL, "tirou uma empresa do cliente", Client, Arg("clientId")),
        "createRole" => d(FN, "criou a função", Role, Reply),
        "updateRole" => d(FN, "editou a função", Role, Arg("id")),
        "deleteRole" => d(FN, "excluiu a função", Role, Arg("roleId")),
        "addRoleAlias" => d(FN, "adicionou outro nome à função", Role, Arg("roleId")),
        "removeRoleAlias" => d(FN, "tirou um nome da função", Role, alias_role),

        // --- Colaboradores ---
        "createEmployeeManual" => d(CO, "cadastrou", Employee, Reply),
        "createEmployeesFromImport" => Def { area: CO, verb: "importou colaboradores", entity: Option::None, target: Target::None, after: After::Same, bulk: Bulk::NewEmployees },
        "updateEmployee" => d(CO, "editou", Employee, Arg("id")),
        "deleteEmployee" => d(CO, "excluiu", Employee, Arg("employeeId")),
        "addEmployeeAlias" => d(CO, "adicionou outro nome a", Employee, Arg("employeeId")),
        "removeEmployeeAlias" => d(CO, "tirou um nome de", Employee, alias_employee),
        "addEmployeePixKey" => d(CO, "adicionou uma chave PIX a", Employee, Arg("employeeId")),
        "removeEmployeePixKey" => d(CO, "tirou uma chave PIX de", Employee, pix_employee),
        "updateEmployeePixKeyType" => d(CO, "mudou o tipo de uma chave PIX de", Employee, pix_employee),
        "linkEmployeeToClientCompany" => d(CO, "vinculou a um cliente", Employee, Arg("employeeId")),
        "unlinkEmployeeClientCompany" => d(CO, "desvinculou de um cliente", Employee, Arg("employeeId")),
        "updateEmployeeClientCompanyMatricula" => d(CO, "mudou a matrícula de", Employee, Arg("employeeId")),
        "reassignEmployeeHistoryToClientCompany" => d(CO, "moveu o histórico de", Employee, Arg("employeeId")),

        // --- Templates ---
        "createPaymentTemplate" => d(TP, "criou o template de pagamento", PaymentTemplate, Reply),
        "updatePaymentTemplate" => d(TP, "editou o template de pagamento", PaymentTemplate, Arg("id")),
        "deletePaymentTemplate" => d(TP, "excluiu o template de pagamento", PaymentTemplate, Arg("id")),
        "createEmployeeTemplate" => d(TP, "criou o template de colaboradores", EmployeeTemplate, Reply),
        "updateEmployeeTemplate" => d(TP, "editou o template de colaboradores", EmployeeTemplate, Arg("id")),
        "deleteEmployeeTemplate" => d(TP, "excluiu o template de colaboradores", EmployeeTemplate, Arg("id")),
        "createPaymentExportTemplate" => d(TP, "criou o template de exportação", ExportTemplate, Reply),
        "updatePaymentExportTemplate" => d(TP, "editou o template de exportação", ExportTemplate, Arg("id")),
        "deletePaymentExportTemplate" => d(TP, "excluiu o template de exportação", ExportTemplate, Arg("id")),
        "clonePaymentExportTemplate" => d(TP, "duplicou o template de exportação", ExportTemplate, Reply),
        "createPaymentPdfTemplate" => d(TP, "criou o template de PDF", PdfTemplate, Reply),
        "updatePaymentPdfTemplate" => d(TP, "editou o template de PDF", PdfTemplate, Arg("id")),
        "deletePaymentPdfTemplate" => d(TP, "excluiu o template de PDF", PdfTemplate, Arg("id")),
        "clonePaymentPdfTemplate" => d(TP, "duplicou o template de PDF", PdfTemplate, Reply),

        // --- Pagamentos ---
        "savePaymentShifts" => Def { area: PG, verb: "importou turnos", entity: Option::None, target: Target::None, after: After::Same, bulk: Bulk::NewShifts },
        "editPaymentShift" => shift("editou o turno de", "shiftId"),
        "markPaymentShiftPaid" => shift("marcou como pago o turno de", "shiftId"),
        "revertPaymentShiftToPending" => shift("voltou para pendente o turno de", "shiftId"),
        "markPaymentShiftAuditError" => shift("marcou erro na conferência do turno de", "shiftId"),
        "undoPaymentShiftAuditError" => shift("desfez o erro da conferência do turno de", "shiftId"),
        "applyAutoSyncedFieldUpdate" => shift("atualizou com a planilha o turno de", "shiftId"),
        "acceptShiftChange" => Def { area: PG, verb: "aceitou a alteração da planilha no turno de", entity: Some(Shift), target: Arg("shiftId"), after: After::ShiftHead, bulk: Bulk::No },
        "deletePaymentShift" => d(PG, "excluiu o turno de", Shift, Arg("shiftId")),
        "recordPaymentAudit" => d(PG, "conferiu o pagamento do turno de", Shift, Arg("paymentShiftId")),
        "deletePaymentAudit" => d(PG, "desfez a conferência do turno de", Shift, Arg("paymentShiftId")),

        // --- Espelhos ---
        "saveParsedTimesheet" => d(ES, "importou o espelho de", Import, Reply),
        "deleteImport" => d(ES, "excluiu o espelho de", Import, Arg("importId")),

        // --- Verificação automática ---
        "trackUrlForAutoReimport" => plain(VE, "passou a acompanhar uma planilha por link"),
        "untrackPaymentUrl" => plain(VE, "parou de acompanhar uma planilha por link"),
        "createReimportConfig" => d(VE, "criou a verificação", ReimportConfig, Reply),
        "updateReimportConfig" => d(VE, "editou a verificação", ReimportConfig, Arg("id")),
        "deleteReimportConfig" => d(VE, "excluiu a verificação", ReimportConfig, Arg("id")),
        "setConfigCheckDisabled" => d(VE, "pausou ou retomou a verificação", ReimportConfig, Arg("id")),
        "dismissCheckDiffs" => Def { area: VE, verb: "dispensou alterações encontradas", entity: Option::None, target: Target::None, after: After::Same, bulk: Bulk::Count { arg: "ids", noun: "alterações" } },

        // --- Configurações ---
        "aiSetApiKey" => plain(CF, "trocou a chave do assistente"),
        "aiClearApiKey" => plain(CF, "removeu a chave do assistente"),

        // --- Usuários e perfis ---
        "addAppUser" => d(US, "deu acesso a", AppUser, Arg("email")),
        "setAppUserProfile" => d(US, "mudou o perfil de", AppUser, Arg("email")),
        "removeAppUser" => d(US, "tirou o acesso de", AppUser, Arg("email")),
        "createAccessProfile" => d(US, "criou o perfil", Profile, Reply),
        "updateAccessProfile" => d(US, "editou o perfil", Profile, Arg("id")),
        "deleteAccessProfile" => d(US, "excluiu o perfil", Profile, Arg("id")),

        _ => return Option::None,
    })
}
