import { Banknote, FileText } from "lucide-react";
import { Link } from "react-router-dom";

export default function ImportChooserPage() {
  return (
    <div>
      <div className="page-header">
        <h2>Importar dados</h2>
      </div>
      <p className="page-subtitle">O que você deseja importar?</p>

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
      </div>
    </div>
  );
}
