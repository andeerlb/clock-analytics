import { Banknote, FileText, Users } from "lucide-react";
import { Link } from "react-router-dom";
import PageHeader from "../components/PageHeader";

export default function ImportChooserPage() {
  return (
    <div>
      <PageHeader title="Importar dados" subtitle="O que você deseja importar?" />

      <div className="choice-grid">
        <Link to="/import/timesheet" className="choice-card">
          <div className="choice-card-icon">
            <FileText size={22} />
          </div>
          <div>
            <h3>Espelho de ponto</h3>
            <p>Extraia dados de espelhos de ponto a partir de arquivos PDF.</p>
          </div>
        </Link>
        <Link to="/import/payments" className="choice-card">
          <div className="choice-card-icon">
            <Banknote size={22} />
          </div>
          <div>
            <h3>Pagamentos</h3>
            <p>Importe pagamentos a partir de arquivos CSV, Excel ou ODS.</p>
          </div>
        </Link>
        <Link to="/import/employees" className="choice-card">
          <div className="choice-card-icon">
            <Users size={22} />
          </div>
          <div>
            <h3>Colaboradores</h3>
            <p>Importe colaboradores a partir de arquivos CSV, Excel ou ODS.</p>
          </div>
        </Link>
      </div>
    </div>
  );
}
